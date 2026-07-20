#!/usr/bin/env node
// マネーフォワードME の楽天口座から OTA 入金を検知し、v2 API で帳簿と自動突合する。
//   A) Booking.com 入金(ドイツギンコウ BOOKING.COMブン、楽天第三):
//      /pnl/:pid/verify-booking-payout — 前月チェックアウト分バッチの期待値と突合。
//      一致=💰✅通知 / 残差=🚨通知(キャンセル料 or 予約エクスポート欠落の可能性)。
//   B) Airbnb 入金(ペイオニア ジヤパン、楽天第三=the Terrace / 楽天ハープ=宿小町):
//      /pnl/:pid/verify-airbnb-payout — 予約CSVの「収入」との単独/2件合算一致を確認。
//      一致=無音(件数が多いため) / 不一致=🚨通知(予約エクスポート欠落・金額相違・他物件入金の可能性)。
//      口座と物件の対応が違う期間があるため、割当物件で不一致なら他物件でも照合してから通知。
//      CSV未着(月次取得前)の場合は保留し翌日以降に再試行(stateに載せない)。
//
//   使い方: node scripts/mf-booking-monitor.mjs [--month 2026-07] [--replay]
//     --month:  走査する MF家計簿月を1ヶ月だけ指定。省略時は前月+当月。
//     --replay: 処理済みでも再突合(検算やり直し用)。
//
//   state=~/.claude/channels/discord/mf-booking-monitor-state.json (MF取引IDで冪等)
//   実証: Booking=2025-11〜2026-07 の全9入金一致 / Airbnb=3月ペイオニア9件合計¥631,664=帳簿3月売上と一致
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const requireScripts = createRequire("C:/Users/yamas/.claude/scripts/node_modules/");
const { chromium } = requireScripts("playwright-core");

const TERRACE = "tsZybhDMcPrxqgcRy7wp";
const KOMACHI = "RZV9IwtQgMAsvrdM3j8J";
const RAKUTEN3_HASH = "64SwijL8nXXCHReKyZpAbA"; // MF ㊇楽天第3(八朔) → Booking + Airbnb(the Terrace)
const HARP_HASH = "tXfU3weteHfPaOksh_Kf_g";      // MF ㉂楽天ハープ    → Airbnb(宿小町)
const RAKUTEN3_SERVICE = "1331";
const API = "https://api-5qrfx7ujcq-an.a.run.app";
const CDP = "http://127.0.0.1:9222";
const STATE = "C:/Users/yamas/.claude/channels/discord/mf-booking-monitor-state.json";
const HIT = /ブッキング|BOOKING|Booking|ﾌﾞﾂｷﾝｸﾞ|ﾌﾞｯｷﾝｸﾞ/;
const PAYONEER = /ペイオニア|ﾍﾟｲｵﾆｱ|PAYONEER/i;

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
    ["--remote-debugging-port=9222", "--user-data-dir=C:\\Users\\yamas\\.claude\\chrome-debug-profile", "--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble"],
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

async function fetchAccountRows(page, hash, ym) {
  const [Y, M] = ym.split("-").map(Number);
  const url = `https://moneyforward.com/cf/csv?account_id_hash=${hash}&from=${Y}%2F${String(M).padStart(2, "0")}%2F01&month=${M}&service_id=${RAKUTEN3_SERVICE}&year=${Y}`;
  const buf = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: "include" });
    if (!r.ok) throw new Error("csv fetch " + r.status);
    return Array.from(new Uint8Array(await r.arrayBuffer()));
  }, url);
  const rows = parseCsv(new TextDecoder("shift_jis").decode(new Uint8Array(buf)));
  const head = rows[0] || [];
  const iDate = head.indexOf("日付"), iDesc = head.indexOf("内容"), iAmt = head.indexOf("金額（円）"), iId = head.indexOf("ID");
  return rows.slice(1)
    .filter((r) => r.length > iId)
    .map((r) => ({
      date: String(r[iDate] || "").replace(/\//g, "-"),
      desc: r[iDesc] || "",
      amount: Number(String(r[iAmt]).replace(/,/g, "")) || 0,
      mfId: r[iId],
    }));
}

(async () => {
  console.log(`MF OTA入金監視(Booking+Airbnb): 走査月=${SCAN.join(", ")}${REPLAY ? " [replay]" : ""}`);
  const browser = await connectCdp();
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  const bookingDeposits = [];
  const airbnbDeposits = []; // { ..., primary: pid, secondary: pid }
  try {
    await page.goto("https://moneyforward.com/accounts", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    if (/sign_in|login/.test(page.url())) throw new Error("MF未ログイン(debug ChromeでMFに再ログインが必要)");
    for (const ym of SCAN) {
      const r3 = await fetchAccountRows(page, RAKUTEN3_HASH, ym);
      const harp = await fetchAccountRows(page, HARP_HASH, ym);
      const bk = r3.filter((d) => HIT.test(d.desc) && d.amount > 0);
      const abT = r3.filter((d) => PAYONEER.test(d.desc) && d.amount > 0).map((d) => ({ ...d, primary: TERRACE, secondary: KOMACHI, acct: "楽天第三" }));
      const abK = harp.filter((d) => PAYONEER.test(d.desc) && d.amount > 0).map((d) => ({ ...d, primary: KOMACHI, secondary: TERRACE, acct: "楽天ハープ" }));
      console.log(`[${ym}] Booking入金 ${bk.length}件 / Airbnb入金 第三${abT.length}+ハープ${abK.length}件`);
      bookingDeposits.push(...bk);
      airbnbDeposits.push(...abT, ...abK);
    }
  } finally {
    await page.close();
    await browser.close();
  }

  const state = loadState();
  const freshBk = bookingDeposits.filter((d) => REPLAY || !state.processed[d.mfId]);
  const freshAb = airbnbDeposits.filter((d) => REPLAY || !state.processed[d.mfId]);
  if (!freshBk.length && !freshAb.length) { console.log("新規入金なし。終了。"); process.exitCode = 0; return; }

  // API シークレットはローカルファイルから読む(firebase-admin は Windows node で終了時に
  // libuv assert クラッシュ(exit 127)するため PC 常駐スクリプトでは使わない。NotifyInbox と同方式)
  const secret = readFileSync("C:/Users/yamas/.claude/channels/discord/v2-gas-secret.txt", "utf8").trim();
  const H = { "authorization": `Bearer gas-${secret}`, "content-type": "application/json" };
  let hadError = false;

  // ---- A) Booking ----
  for (const d of freshBk) {
    console.log(`\n▼ Booking入金 ${d.date} ¥${d.amount.toLocaleString()} (${d.desc})`);
    const r = await fetch(`${API}/pnl/${TERRACE}/verify-booking-payout`, { method: "POST", headers: H, body: JSON.stringify({ amount: d.amount, date: d.date }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { hadError = true; console.log("error:", j.error || r.status); continue; }
    console.log(`  対象CO月=${j.coMonth} 期待¥${(j.expected || 0).toLocaleString()} 残差¥${(j.residual || 0).toLocaleString()} (${j.stays?.length || 0}滞在)`);
    if (!j.match && (j.missingCsvMonths || []).length) {
      console.log(`  → CSV未着(${j.missingCsvMonths.join(",")})のため保留(翌日再試行)`);
      continue; // stateに載せない=保留
    }
    if (j.match) {
      console.log(`NOTIFY: 💰 Booking入金 ¥${d.amount.toLocaleString()}(${d.date}、${j.coMonth}チェックアウト分) — 帳簿の期待値と**1円一致** ✅`);
    } else {
      console.log(`NOTIFY: 🚨 Booking入金 ¥${d.amount.toLocaleString()}(${d.date}) が帳簿の期待値 ¥${(j.expected || 0).toLocaleString()}(${j.coMonth}CO分) と **¥${(j.residual || 0).toLocaleString()} ズレ**ています。キャンセル料徴収 or 予約エクスポート欠落の可能性 → extranet の財務明細CSV(該当支払い)をDLして確認してください。`);
    }
    state.processed[d.mfId] = { kind: "booking", date: d.date, amount: d.amount, verifiedAt: new Date().toISOString(), residual: j.residual };
  }

  // ---- B) Airbnb(ペイオニア) ----
  const verifyAirbnb = async (pid, d) => {
    const r = await fetch(`${API}/pnl/${pid}/verify-airbnb-payout`, { method: "POST", headers: H, body: JSON.stringify({ amount: d.amount, date: d.date }) });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  for (const d of freshAb) {
    console.log(`\n▼ Airbnb入金 ${d.date} ¥${d.amount.toLocaleString()} (${d.acct})`);
    const p1 = await verifyAirbnb(d.primary, d);
    if (p1.status !== 200) { hadError = true; console.log("error:", p1.j.error || p1.status); continue; }
    let matched = p1.j.match ? d.primary : null;
    let matchedJson = matched ? p1.j : null;
    let missing = p1.j.missingCsvMonths || [];
    if (!matched) {
      const p2 = await verifyAirbnb(d.secondary, d);
      if (p2.status === 200 && p2.j.match) { matched = d.secondary; matchedJson = p2.j; }
      missing = [...new Set([...missing, ...(p2.j?.missingCsvMonths || [])])];
    }
    if (matched) {
      const propName = matched === TERRACE ? "the Terrace" : "宿小町";
      console.log(`  ✅ 一致(${propName})${matched !== d.primary ? " ※口座と物件の対応が通常と逆" : ""}`);
      // キャンセル料入金が絡む一致は無音にしない(pnl売上には自動計上されないため、放置すると帳簿と実入金がズレる)
      if (matchedJson?.cancelledFeeInvolved) {
        const stays = matchedJson.mode === "pair" ? matchedJson.stays : [matchedJson.stay];
        const cxl = (stays || []).filter((s) => s && s.cancelled).map((s) => `${s.name || s.code} ¥${Number(s.income).toLocaleString()}`).join("、");
        console.log(`NOTIFY: ⚠️ Airbnb入金 ¥${d.amount.toLocaleString()}(${d.date}、${propName}) に**キャンセル料入金**が含まれます(${cxl})。収支には自動計上されていません — Airbnb取引履歴で実受領(後日の返金調整の有無)を確認し、受領確定なら収支画面で売上を手修正してください。`);
      }
      state.processed[d.mfId] = { kind: "airbnb", date: d.date, amount: d.amount, matched, cancelledFeeInvolved: !!matchedJson?.cancelledFeeInvolved, verifiedAt: new Date().toISOString() };
    } else if (missing.length) {
      console.log(`  → CSV未着(${missing.join(",")})のため保留(翌日再試行)`);
    } else {
      console.log(`NOTIFY: 🚨 Airbnb入金 ¥${d.amount.toLocaleString()}(${d.date}、${d.acct}) に一致する予約が Terrace/小町 の予約CSVに見つかりません。予約エクスポート欠落・金額相違・対象外物件の入金の可能性 → Airbnb 管理画面の取引履歴で確認してください。`);
      state.processed[d.mfId] = { kind: "airbnb", date: d.date, amount: d.amount, matched: null, verifiedAt: new Date().toISOString() };
    }
  }
  saveState(state);
  process.exitCode = hadError ? 1 : 0;
})().catch((e) => { console.error("ERROR:", e.message); process.exitCode = 1; });
