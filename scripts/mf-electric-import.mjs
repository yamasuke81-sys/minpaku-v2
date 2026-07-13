#!/usr/bin/env node
// マネーフォワードME から the Terrace のクレカ払い電気代(エネパル/アプラス/スマートビリング)を取込み、
// v2 pnl API (import-credit-card-electric の payments 直接モード) へ冪等計上する。
//
//   使い方: NODE_PATH=../minpaku-v2-yadozei/scripts/node_modules node scripts/mf-electric-import.mjs [--month 2026-07] [--dry]
//     --month: 走査する MF家計簿月(=カードに posted された月)を1ヶ月だけ指定。省略時は当月+前月の2ヶ月を走査
//              (月初に前月末 posted 分を取りこぼさないため)。
//     --dry:   API に dryRun で投げ、計上せず判定結果のみ表示。
//
//   仕組み:
//     1. 常駐デバッグChrome(CDP:9222、MFログイン済) に接続(browse.mjs と同方式・読み取りGETのみ)
//     2. MF の口座別明細CSV https://moneyforward.com/cf/csv?account_id_hash=...&year=Y&month=M を取得(Shift_JIS)
//     3. 「内容」が電気系キーワードに一致する行を抽出(厳密な採否はサーバ側 filterElectricPaymentsForProperty が判定)
//     4. 使用月 = 各行の posted 日付の前月 (エネパル系は「使用月+1ヶ月後にカード請求」の運用) として使用月ごとに API へ POST
//        冪等キー = MF取引ID(CSV「ID」列) → 何度流しても二重計上しない。overridden=true の月は上書き保護。
//     5. 計上が発生したときだけ stdout に「NOTIFY: …」を出す(常駐bun routines の command型がこの行だけ #経理 へ通知)。
//
//   前提: デバッグChrome は Startup\ClaudeDebugChrome.vbs で常駐(MFログイン済み)。落ちていれば自己修復起動。
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const requireScripts = createRequire("C:/Users/yamas/.claude/scripts/node_modules/");
const { chromium } = requireScripts("playwright-core");

const TERRACE = "tsZybhDMcPrxqgcRy7wp";
const SAISON_HASH = "et2JNC6KSatQ9pMz6fL8voH-z9t8NpFGQ2rOnN6Ntkg"; // MF セゾンアメックス(八朔)
const API = "https://api-5qrfx7ujcq-an.a.run.app";
const CDP = "http://127.0.0.1:9222";
// PC側の一次スクリーニング(broad)。厳密な採否(ソフトバンクでんき除外等)はサーバ側 allowlist が最終判定。
const ELECTRIC_HINT = /エネパル|アプラス|スマートビリング|電気|でんき|電力|ｴﾈﾊﾟﾙ|ｱﾌﾟﾗｽ|ｽﾏｰﾄﾋﾞﾘﾝｸﾞ/;

const DRY = process.argv.includes("--dry");
const mi = process.argv.indexOf("--month");
const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
const curYm = `${nowJst.getUTCFullYear()}-${String(nowJst.getUTCMonth() + 1).padStart(2, "0")}`;
const prevOf = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};
let SCAN_MONTHS;
if (mi >= 0) {
  const m = process.argv[mi + 1];
  if (!/^\d{4}-\d{2}$/.test(m || "")) { console.error("--month は YYYY-MM"); process.exit(2); }
  SCAN_MONTHS = [m];
} else {
  SCAN_MONTHS = [prevOf(curYm), curYm]; // 前月+当月(月初の取りこぼし防止)
}

const withTimeout = (p, ms, l) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(l + " timeout")), ms))]);
function killDebugChrome() {
  try {
    const { spawnSync } = require("node:child_process");
    spawnSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoProfile", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*9222*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],
      { stdio: "ignore", timeout: 15000 });
  } catch {}
}
function launchDebugChrome() {
  const cp = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ["--remote-debugging-port=9222", "--user-data-dir=C:\\Users\\yamas\\.claude\\chrome-debug-profile", "--no-first-run", "--no-default-browser-check"],
    { detached: true, stdio: "ignore" });
  cp.on("error", () => {}); cp.unref();
}
// HTTPエンドポイントの生死確認。生きている間は chrome.exe を絶対に起動しない
// (既存インスタンスがあると Chrome のシングルトン機構で「新しいウィンドウ」が開くだけ=ウィンドウ増殖の原因)
async function cdpHttpAlive() {
  try {
    const r = await withTimeout(fetch(CDP + "/json/version"), 3000, "http");
    return r.ok;
  } catch { return false; }
}
async function connectCdp() {
  for (let i = 0; i < 8; i++) {
    try { return await withTimeout(chromium.connectOverCDP(CDP), 15000, "cdp"); } catch {}
    const alive = await cdpHttpAlive();
    if (!alive) {
      launchDebugChrome(); // 完全に死んでいる時だけ起動(新ウィンドウ増殖防止)
    } else if (i === 3) {
      // HTTPは生きているのにCDPが繋がらない = stale endpoint → 掃除してから起動
      killDebugChrome();
      await new Promise((r) => setTimeout(r, 3000));
      launchDebugChrome();
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("CDP接続不可(debug Chrome起動失敗)");
}

// MF CSV(全フィールド引用符付き)の簡易パース
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
  console.log(`MF電気代取込: 走査月=${SCAN_MONTHS.join(", ")} ${DRY ? "[dry]" : ""}`);

  // ---- 1. MF CSV 取得(読み取りGETのみ) ----
  const browser = await connectCdp();
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  const candidates = [];
  try {
    await page.goto("https://moneyforward.com/accounts", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    if (/sign_in|login/.test(page.url())) throw new Error("MF未ログイン(debug ChromeでMFに再ログインが必要)");
    for (const ym of SCAN_MONTHS) {
      const [Y, M] = ym.split("-").map(Number);
      const url = `https://moneyforward.com/cf/csv?account_id_hash=${SAISON_HASH}&from=${Y}%2F${String(M).padStart(2, "0")}%2F01&month=${M}&service_id=27&year=${Y}`;
      const buf = await page.evaluate(async (u) => {
        const r = await fetch(u, { credentials: "include" });
        if (!r.ok) throw new Error("csv fetch " + r.status);
        return Array.from(new Uint8Array(await r.arrayBuffer()));
      }, url);
      const csvText = new TextDecoder("shift_jis").decode(new Uint8Array(buf));
      const rows = parseCsv(csvText);
      const head = rows[0] || [];
      const iDate = head.indexOf("日付"), iDesc = head.indexOf("内容"), iAmt = head.indexOf("金額（円）"), iId = head.indexOf("ID");
      if (iDesc < 0) throw new Error(`MF CSV(${ym})のヘッダが想定外: ` + head.join(","));
      const hits = rows.slice(1)
        .filter((r) => r.length > iId && ELECTRIC_HINT.test(r[iDesc] || ""))
        .map((r) => ({
          date: String(r[iDate] || "").replace(/\//g, "-"),
          description: r[iDesc],
          amount: Math.abs(Number(String(r[iAmt]).replace(/,/g, "")) || 0),
          vendor: "",
          mfId: r[iId],
        }))
        .filter((p) => p.amount > 0);
      console.log(`[${ym}] CSV ${rows.length - 1}行中、電気候補 ${hits.length}件`);
      candidates.push(...hits);
    }
  } finally {
    await page.close();
    await browser.close();
  }

  // mfId で重複排除(2ヶ月走査の境界で同一行が両方に出るケース)
  const seen = new Set();
  const uniq = candidates.filter((c) => { if (seen.has(c.mfId)) return false; seen.add(c.mfId); return true; });
  for (const c of uniq) console.log(`  ${c.date} ${c.description} ¥${c.amount.toLocaleString()} (mfId=${String(c.mfId).slice(0, 12)}…)`);
  if (!uniq.length) { console.log("電気候補なし。終了。"); process.exitCode = 0; return; }

  // ---- 2. 使用月(=各行 posted 日付の前月)ごとにグループ化 ----
  const groups = {};
  for (const c of uniq) {
    const m = c.date.match(/^(\d{4})-(\d{1,2})/);
    if (!m) continue;
    const postedYm = `${m[1]}-${String(Number(m[2])).padStart(2, "0")}`;
    const usageYm = prevOf(postedYm);
    (groups[usageYm] = groups[usageYm] || { postedYm, items: [] }).items.push(c);
  }

  // ---- 3. API へ POST(採否の最終判定・冪等・overridden保護はサーバ側) ----
  // API シークレットはローカルファイルから読む(firebase-admin は Windows node で終了時に
  // libuv assert クラッシュ(exit 127)するため PC 常駐スクリプトでは使わない。NotifyInbox と同方式)
  const { readFileSync } = await import("node:fs");
  const secret = readFileSync("C:/Users/yamas/.claude/channels/discord/v2-gas-secret.txt", "utf8").trim();

  let hadError = false;
  for (const [usageYm, g] of Object.entries(groups)) {
    const r = await fetch(`${API}/pnl/${TERRACE}/${usageYm}/import-credit-card-electric`, {
      method: "POST",
      headers: { "authorization": `Bearer gas-${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ payments: g.items, targetYm: g.postedYm, dryRun: DRY }),
    });
    const j = await r.json().catch(() => ({}));
    console.log(`\n[使用月 ${usageYm}] API status=${r.status}`);
    if (!r.ok) { hadError = true; console.log("error:", j.error || "(不明)"); continue; }
    if (j.skipped) console.log("skipped:", j.skipped);
    const adopted = j.adopted || [];
    const total = Number(j.adoptedTotal) || 0;
    console.log(`採用: ${adopted.length}件 ¥${total.toLocaleString()}`);
    if (!DRY && total > 0) {
      const detail = adopted.map((a) => `${a.description} ¥${Number(a.amount).toLocaleString()}`).join(" / ");
      console.log(`NOTIFY: ⚡ MF明細から the Terrace ${usageYm} の電気代 ¥${total.toLocaleString()} を自動計上しました(${detail})。収支画面の「出典・内訳を確認」で検算できます。`);
    }
  }
  process.exitCode = hadError ? 1 : 0;
})().catch((e) => { console.error("ERROR:", e.message); process.exitCode = 1; });
