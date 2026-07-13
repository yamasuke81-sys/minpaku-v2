#!/usr/bin/env node
// マネーフォワードME の楽天第三口座から Booking.com 入金を検知し、
// v2 API /pnl/:pid/verify-booking-payout で「前月チェックアウト分バッチ」の期待値と自動突合する。
//
//   使い方: NODE_PATH=../minpaku-v2-yadozei/scripts/node_modules node scripts/mf-booking-monitor.mjs [--month 2026-07] [--replay]
//     --month:  走査する MF家計簿月を1ヶ月だけ指定。省略時は前月+当月。
//     --replay: 処理済みでも再通知(検算やり直し用)。
//
//   動作:
//     1. debug Chrome(CDP:9222・MFログイン済) 経由で楽天第三の月次CSVを取得(読み取りGETのみ)
//     2. 「ドイツギンコウ BOOKING.COMブン」等の入金行を抽出
//     3. 未処理の入金(MF取引IDで管理、state=~/.claude/channels/discord/mf-booking-monitor-state.json)を
//        API で突合 → NOTIFY 行を出力(常駐bun routines の command型が #経理 へ通知)
//     4. 残差0=✅一致 / 残差あり=🚨(キャンセル料 or 計上漏れの可能性、財務明細CSVの確認を促す)
//
//   実証: 2025-11〜2026-07 の全9入金で本方式の期待値が銀行実額と一致(残差はキャンセル料/欠落売上として全件解明済)
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const requireScripts = createRequire("C:/Users/yamas/.claude/scripts/node_modules/");
const { chromium } = requireScripts("playwright-core");

const TERRACE = "tsZybhDMcPrxqgcRy7wp";
const RAKUTEN3_HASH = "64SwijL8nXXCHReKyZpAbA"; // MF ㊇楽天第3(八朔)
const RAKUTEN3_SERVICE = "1331";
const API = "https://api-5qrfx7ujcq-an.a.run.app";
const CDP = "http://127.0.0.1:9222";
const STATE = "C:/Users/yamas/.claude/channels/discord/mf-booking-monitor-state.json";
const HIT = /ブッキング|BOOKING|Booking|ﾌﾞﾂｷﾝｸﾞ|ﾌﾞｯｷﾝｸﾞ/;

const REPLAY = process.argv.includes("--replay");
const mi = process.argv.indexOf("--month");
const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
const curYm = `${nowJst.getUTCFullYear()}-${String(nowJst.getUTCMonth() + 1).padStart(2, "0")}`;
const prevOf = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };
let SCAN;
if (mi >= 0) {
  const m = process.argv[mi + 1];
  if (!/^\d{4}-\d{2}$/.test(m || "")) { console.error("--month は YYYY-MM"); process.exit(2); }
  SCAN = [m];
} else SCAN = [prevOf(curYm), curYm];

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
function parseCsv(text) {
  const rows = []; let cur = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else { if (c === '"') q = true; else if (c === ",") { cur.push(f); f = ""; } else if (c === "\n") { cur.push(f); rows.push(cur); cur = []; f = ""; } else if (c !== "\r") f += c; }
  }
  if (f.length || cur.length) { cur.push(f); rows.push(cur); }
  return rows;
}
function loadState() { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return { processed: {} }; } }
function saveState(s) { try { writeFileSync(STATE, JSON.stringify({ ...s, at: new Date().toISOString() }, null, 2)); } catch {} }

(async () => {
  console.log(`MF Booking入金監視: 走査月=${SCAN.join(", ")}${REPLAY ? " [replay]" : ""}`);
  const browser = await connectCdp();
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  const deposits = [];
  try {
    await page.goto("https://moneyforward.com/accounts", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    if (/sign_in|login/.test(page.url())) throw new Error("MF未ログイン(debug ChromeでMFに再ログインが必要)");
    for (const ym of SCAN) {
      const [Y, M] = ym.split("-").map(Number);
      const url = `https://moneyforward.com/cf/csv?account_id_hash=${RAKUTEN3_HASH}&from=${Y}%2F${String(M).padStart(2, "0")}%2F01&month=${M}&service_id=${RAKUTEN3_SERVICE}&year=${Y}`;
      const buf = await page.evaluate(async (u) => {
        const r = await fetch(u, { credentials: "include" });
        if (!r.ok) throw new Error("csv fetch " + r.status);
        return Array.from(new Uint8Array(await r.arrayBuffer()));
      }, url);
      const rows = parseCsv(new TextDecoder("shift_jis").decode(new Uint8Array(buf)));
      const head = rows[0] || [];
      const iDate = head.indexOf("日付"), iDesc = head.indexOf("内容"), iAmt = head.indexOf("金額（円）"), iId = head.indexOf("ID");
      const hits = rows.slice(1)
        .filter((r) => r.length > iId && HIT.test(r[iDesc] || ""))
        .map((r) => ({
          date: String(r[iDate] || "").replace(/\//g, "-"),
          desc: r[iDesc],
          amount: Number(String(r[iAmt]).replace(/,/g, "")) || 0,
          mfId: r[iId],
        }))
        .filter((d) => d.amount > 0); // 入金のみ
      console.log(`[${ym}] Booking入金 ${hits.length}件`);
      deposits.push(...hits);
    }
  } finally {
    await page.close();
    await browser.close();
  }

  const state = loadState();
  const fresh = deposits.filter((d) => REPLAY || !state.processed[d.mfId]);
  if (!fresh.length) { console.log("新規入金なし。終了。"); process.exitCode = 0; return; }

  // API シークレットはローカルファイルから読む(firebase-admin は Windows node で終了時に
  // libuv assert クラッシュ(exit 127)するため PC 常駐スクリプトでは使わない。NotifyInbox と同方式)
  const secret = readFileSync("C:/Users/yamas/.claude/channels/discord/v2-gas-secret.txt", "utf8").trim();

  let hadError = false;
  for (const d of fresh) {
    console.log(`\n▼ 入金 ${d.date} ¥${d.amount.toLocaleString()} (${d.desc})`);
    const r = await fetch(`${API}/pnl/${TERRACE}/verify-booking-payout`, {
      method: "POST",
      headers: { "authorization": `Bearer gas-${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ amount: d.amount, date: d.date }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { hadError = true; console.log("error:", j.error || r.status); continue; }
    console.log(`  対象CO月=${j.coMonth} 期待¥${(j.expected || 0).toLocaleString()} 残差¥${(j.residual || 0).toLocaleString()} (${j.stays?.length || 0}滞在)`);
    if (j.match) {
      console.log(`NOTIFY: 💰 Booking入金 ¥${d.amount.toLocaleString()}(${d.date}、${j.coMonth}チェックアウト分) — 帳簿の期待値と**1円一致** ✅`);
    } else {
      console.log(`NOTIFY: 🚨 Booking入金 ¥${d.amount.toLocaleString()}(${d.date}) が帳簿の期待値 ¥${(j.expected || 0).toLocaleString()}(${j.coMonth}CO分) と **¥${(j.residual || 0).toLocaleString()} ズレ**ています。キャンセル料徴収 or 予約エクスポート欠落の可能性 → extranet の財務明細CSV(該当支払い)をDLして確認してください。`);
    }
    state.processed[d.mfId] = { date: d.date, amount: d.amount, verifiedAt: new Date().toISOString(), residual: j.residual };
  }
  saveState(state);
  process.exitCode = hadError ? 1 : 0;
})().catch((e) => { console.error("ERROR:", e.message); process.exitCode = 1; });
