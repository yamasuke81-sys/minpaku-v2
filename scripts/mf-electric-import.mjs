#!/usr/bin/env node
// マネーフォワードME から the Terrace のクレカ払い電気代(エネパル/アプラス/スマートビリング)を取込み、
// v2 pnl API (import-credit-card-electric の payments 直接モード) へ冪等計上する。
//
//   使い方: NODE_PATH=../minpaku-v2-yadozei/scripts/node_modules node scripts/mf-electric-import.mjs [--month 2026-07] [--dry]
//     --month: MF家計簿の対象月(=カードに posted された月)。省略時は当月(JST)。
//     --dry:   API に dryRun で投げ、計上せず判定結果のみ表示。
//
//   仕組み:
//     1. 常駐デバッグChrome(CDP:9222、MFログイン済) に接続(browse.mjs と同方式・読み取りGETのみ)
//     2. MF の口座別明細CSV https://moneyforward.com/cf/csv?account_id_hash=...&year=Y&month=M を取得(Shift_JIS)
//     3. 「内容」が電気系キーワードに一致する行を抽出(厳密な採否はサーバ側 filterElectricPaymentsForProperty が判定)
//     4. 使用月 = posted月の前月 (エネパル系は「使用月+1ヶ月後にカード請求」の運用) として API へ POST
//        冪等キー = MF取引ID(CSV最終列) → 何度流しても二重計上しない。overridden=true の月は上書き保護。
//
//   前提: デバッグChrome は Startup\ClaudeDebugChrome.vbs で常駐(MFログイン済み)。落ちていれば自己修復起動。
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const requireScripts = createRequire("C:/Users/yamas/.claude/scripts/node_modules/");
const { chromium } = requireScripts("playwright-core");
const admin = (await import("firebase-admin")).default;

const TERRACE = "tsZybhDMcPrxqgcRy7wp";
const SAISON_HASH = "et2JNC6KSatQ9pMz6fL8voH-z9t8NpFGQ2rOnN6Ntkg"; // MF セゾンアメックス(八朔)
const API = "https://api-5qrfx7ujcq-an.a.run.app";
const CDP = "http://127.0.0.1:9222";
// PC側の一次スクリーニング(broad)。厳密な採否(ソフトバンクでんき除外等)はサーバ側 allowlist が最終判定。
const ELECTRIC_HINT = /エネパル|アプラス|スマートビリング|電気|でんき|電力|ｴﾈﾊﾟﾙ|ｱﾌﾟﾗｽ|ｽﾏｰﾄﾋﾞﾘﾝｸﾞ/;

const DRY = process.argv.includes("--dry");
const mi = process.argv.indexOf("--month");
const now = new Date(Date.now() + 9 * 3600 * 1000); // JST
const monthArg = mi >= 0 ? process.argv[mi + 1] : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
if (!/^\d{4}-\d{2}$/.test(monthArg)) { console.error("--month は YYYY-MM"); process.exit(2); }
const [Y, M] = monthArg.split("-").map(Number);
const prevYm = M === 1 ? `${Y - 1}-12` : `${Y}-${String(M - 1).padStart(2, "0")}`;

const withTimeout = (p, ms, l) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(l + " timeout")), ms))]);
function launchDebugChrome() {
  const cp = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ["--remote-debugging-port=9222", "--user-data-dir=C:\\Users\\yamas\\.claude\\chrome-debug-profile", "--no-first-run", "--no-default-browser-check"],
    { detached: true, stdio: "ignore" });
  cp.on("error", () => {}); cp.unref();
}
async function connectCdp() {
  for (let i = 0; i < 12; i++) {
    try { return await withTimeout(chromium.connectOverCDP(CDP), 6000, "cdp"); } catch {}
    if (i === 1) launchDebugChrome();
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error("CDP接続不可(debug Chrome起動失敗)");
}

// MF CSV(RFC4180風・全フィールド引用符付き)の簡易パース
function parseCsv(text) {
  const rows = [];
  let cur = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { cur.push(field); field = ""; }
      else if (c === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; }
      else if (c === "\r") {}
      else field += c;
    }
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}

(async () => {
  console.log(`MF電気代取込: posted月=${monthArg} → 使用月=${prevYm} ${DRY ? "[dry]" : ""}`);

  // ---- 1. MF CSV 取得(読み取りGETのみ) ----
  const browser = await connectCdp();
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  let csvText;
  try {
    await page.goto("https://moneyforward.com/accounts", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    // ログイン確認(未ログインならサインイン画面に飛ぶ)
    if (/sign_in|login/.test(page.url())) throw new Error("MF未ログイン(debug ChromeでMFに再ログインが必要)");
    const url = `https://moneyforward.com/cf/csv?account_id_hash=${SAISON_HASH}&from=${Y}%2F${String(M).padStart(2, "0")}%2F01&month=${M}&service_id=27&year=${Y}`;
    const buf = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: "include" });
      if (!r.ok) throw new Error("csv fetch " + r.status);
      return Array.from(new Uint8Array(await r.arrayBuffer()));
    }, url);
    csvText = new TextDecoder("shift_jis").decode(new Uint8Array(buf));
  } finally {
    await page.close();
    await browser.close();
  }

  // ---- 2. 電気系行の抽出 ----
  const rows = parseCsv(csvText);
  const head = rows[0] || [];
  const iDate = head.indexOf("日付"), iDesc = head.indexOf("内容"), iAmt = head.indexOf("金額（円）"), iId = head.indexOf("ID");
  if (iDesc < 0) throw new Error("MF CSVのヘッダが想定外: " + head.join(","));
  const candidates = rows.slice(1)
    .filter((r) => r.length > iId && ELECTRIC_HINT.test(r[iDesc] || ""))
    .map((r) => ({
      date: String(r[iDate] || "").replace(/\//g, "-"),
      description: r[iDesc],
      amount: Math.abs(Number(String(r[iAmt]).replace(/,/g, "")) || 0),
      vendor: "",
      mfId: r[iId],
    }))
    .filter((p) => p.amount > 0);

  console.log(`CSV ${rows.length - 1}行中、電気候補 ${candidates.length}件:`);
  for (const c of candidates) console.log(`  ${c.date} ${c.description} ¥${c.amount.toLocaleString()} (mfId=${c.mfId.slice(0, 12)}…)`);
  if (!candidates.length) { console.log("電気候補なし。終了。"); process.exit(0); }

  // ---- 3. API へ POST(採否の最終判定・冪等・overridden保護はサーバ側) ----
  if (!admin.apps.length) admin.initializeApp({ projectId: "minpaku-v2" });
  const db = admin.firestore();
  const secret = (await db.collection("settings").doc("taxDocs").get()).data().gasSecret;
  const r = await fetch(`${API}/pnl/${TERRACE}/${prevYm}/import-credit-card-electric`, {
    method: "POST",
    headers: { "authorization": `Bearer gas-${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ payments: candidates, targetYm: monthArg, dryRun: DRY }),
  });
  const j = await r.json();
  console.log(`\nAPI status=${r.status}`);
  if (j.skipped) console.log("skipped:", j.skipped);
  if (j.error) console.log("error:", j.error);
  console.log("採用(サーバallowlist通過):", JSON.stringify(j.adopted || [], null, 2));
  console.log(`採用合計: ¥${(j.adoptedTotal || 0).toLocaleString()}`);
  if (j.computed) console.log(`計上後: 水道光熱含む経費計 ¥${(j.computed.expensesTotal || 0).toLocaleString()} / 利益 ¥${(j.computed.profit || 0).toLocaleString()}`);
  process.exit(0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
