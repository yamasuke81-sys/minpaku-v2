#!/usr/bin/env node
// マネーフォワードME の楽天口座から OTA 入金を検知し、v2 API で帳簿と自動突合する。
//   A) Booking.com 入金(ドイツギンコウ BOOKING.COMブン、楽天第三):
//      /pnl/:pid/verify-booking-payout — 前月チェックアウト分バッチの期待値と突合。
//      一致=💰✅通知 / 残差=🚨通知(キャンセル料 or 予約エクスポート欠落の可能性)。
//   B) Airbnb 入金(ペイオニア ジヤパン、楽天第三=the Terrace / 楽天ハープ=宿小町。宇品は第3候補):
//      /pnl/:pid/verify-airbnb-payout — 予約CSVの「収入」との単独/2件合算一致を確認。
//      一致=無音(件数が多いため) / 不一致=🚨通知(予約エクスポート欠落・金額相違・他物件入金の可能性)。
//      口座と物件の対応が違う期間があるため、割当物件で不一致なら他物件でも照合してから通知。
//      CSV未着(月次取得前)の場合は保留し翌日以降に再試行(stateに載せない)。
//      【2026-08-10修正】まず apply:false の下見で missingCsvMonths を確認し、対象CI窓のCSVが
//      揃っている(=空)場合のみ一致(exact/residual問わず)を採用する。揃っていなければ副物件も
//      照合せず保留に徹する(不完全データでのクロス物件フォールバック誤解釈を根絶。詳細は下の
//      Airbnbループ直前のコメント参照)。
//
//   使い方: node scripts/mf-booking-monitor.mjs [--month 2026-07] [--replay] [--dry] [--reverify 2026-07]
//     --month:    走査する MF家計簿月を1ヶ月だけ指定。省略時は前月+当月。
//     --replay:   処理済みでも再突合(検算やり直し用)。
//     --dry:      Airbnb突合をapply:falseで行い、state保存もしない(検証用。Firestore書込・state書込なし)。
//     --reverify 2026-07: MF走査(Playwright)を行わず、指定月をCI窓に含む既存stateエントリだけを
//                 dryで再検証する。ラベルが変わる場合のみ state を書き換え(Firestoreへのapplyはしない)。
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
const UJINA = "ncUKeD4yQo0kfAoznITu"; // 2026-08-10追加: 宇品のAirbnb入金が両口座のどちらに来ても照合できるよう第3候補に置く
const PROP_NAMES = { [TERRACE]: "the Terrace", [KOMACHI]: "宿小町", [UJINA]: "宇品" };
const RAKUTEN3_HASH = "64SwijL8nXXCHReKyZpAbA"; // MF ㊇楽天第3(八朔) → Booking + Airbnb(the Terrace)
const HARP_HASH = "tXfU3weteHfPaOksh_Kf_g";      // MF ㉂楽天ハープ    → Airbnb(宿小町)
const RAKUTEN3_SERVICE = "1331";
const API = "https://api-5qrfx7ujcq-an.a.run.app";
const CDP = "http://127.0.0.1:9222";
const STATE = "C:/Users/yamas/.claude/channels/discord/mf-booking-monitor-state.json";
const HIT = /ブッキング|BOOKING|Booking|ﾌﾞﾂｷﾝｸﾞ|ﾌﾞｯｷﾝｸﾞ/;
const PAYONEER = /ペイオニア|ﾍﾟｲｵﾆｱ|PAYONEER/i;

const REPLAY = process.argv.includes("--replay");
const DRY = process.argv.includes("--dry"); // Airbnb突合をapply:falseに固定+state保存なし(検証用)
const mi = process.argv.indexOf("--month");
const ri = process.argv.indexOf("--reverify");
const REVERIFY_YM = ri >= 0 ? process.argv[ri + 1] : null;
if (REVERIFY_YM && !/^\d{4}-\d{2}$/.test(REVERIFY_YM)) { console.error("--reverify は YYYY-MM"); process.exit(2); }
const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
const curYm = `${nowJst.getUTCFullYear()}-${String(nowJst.getUTCMonth() + 1).padStart(2, "0")}`;
const prevOf = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };
// verify-airbnb-payout が照会する2ヶ月窓([入金月, 入金月の前月])。サーバ側(functions/api/pnl.js)と同じ規則
const airbnbWindowMonths = (dateStr) => {
  const m = String(dateStr || "").match(/^(\d{4})-(\d{2})/);
  if (!m) return [];
  const y = Number(m[1]), mo = Number(m[2]);
  const t = new Date(Date.UTC(y, mo - 2, 1));
  return [`${y}-${String(mo).padStart(2, "0")}`, `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`];
};
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
    ["--remote-debugging-port=9222", "--user-data-dir=C:\\Users\\yamas\\.claude\\chrome-debug-profile", "--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble", "--enable-unsafe-extension-debugging"],
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

// --reverify YYYY-MM: MF走査(Playwright)を行わず、指定月をCI窓に含む既存stateエントリだけを
// dry(apply:false)で再検証する。TERRACE/KOMACHI 両方を独立に照合し「CSVが揃っている場合のみ」
// 結果を採用する点はメインループと同じ。Firestoreへのapplyは一切行わない(金額が動く訂正候補が
// 見つかった場合はNOTIFYで警告するだけに留め、実際の反映は通常運用のapply経路 or 手動対応に委ねる
// =過去に遡って金額が動く訂正を無人で自動確定させない設計)。
async function reverifyMonth(ym) {
  console.log(`MF OTA入金監視: --reverify ${ym} (既存stateの再検証、Firestore書込なし)`);
  const state = loadState();
  const secret = readFileSync("C:/Users/yamas/.claude/channels/discord/v2-gas-secret.txt", "utf8").trim();
  const H = { "authorization": `Bearer gas-${secret}`, "content-type": "application/json" };
  const verify = async (pid, amount, date) => {
    const r = await fetch(`${API}/pnl/${pid}/verify-airbnb-payout`, { method: "POST", headers: H, body: JSON.stringify({ amount, date, apply: false }) });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  let checked = 0, changed = 0;
  for (const [mfId, ent] of Object.entries(state.processed)) {
    if (ent.kind !== "airbnb" || !airbnbWindowMonths(ent.date).includes(ym)) continue;
    checked++;
    const r = { [TERRACE]: await verify(TERRACE, ent.amount, ent.date), [KOMACHI]: await verify(KOMACHI, ent.amount, ent.date) };
    const ok = [TERRACE, KOMACHI].filter((pid) => r[pid].status === 200 && (r[pid].j.missingCsvMonths || []).length === 0 && r[pid].j.match);
    if (ok.length > 1) { console.log(`NOTIFY: ⚠️ 再検証 ${ent.date} ¥${ent.amount.toLocaleString()}(mfId=${mfId}) が Terrace/小町 の両方に一致しました。手動確認してください。`); continue; }
    const newMatch = ok[0] || null;
    if (!newMatch) {
      const stillMissing = [TERRACE, KOMACHI].some((pid) => (r[pid].j?.missingCsvMonths || []).length > 0);
      console.log(`  ${ent.date} ¥${ent.amount.toLocaleString()}(mfId=${mfId}): ${stillMissing ? "まだCSV未着の物件がありのため再検証できません" : "変化なし(一致なし)"}`);
      continue;
    }
    const j = r[newMatch].j;
    const newCancelled = !!j.cancelledFeeInvolved;
    if (ent.matched === newMatch && !!ent.cancelledFeeInvolved === newCancelled) { console.log(`  ${ent.date} ¥${ent.amount.toLocaleString()}(mfId=${mfId}): 変化なし(既存ラベルのまま)`); continue; }
    const propName = PROP_NAMES[newMatch] || newMatch;
    if (j.interpretation?.delta) {
      console.log(`NOTIFY: ⚠️ 再検証 ${ent.date} ¥${ent.amount.toLocaleString()}(mfId=${mfId}) の一致先が ${propName}(${j.mode}) に変わり、キャンセル料調整候補(¥${j.interpretation.delta.toLocaleString()})があります。state未書換・Firestore反映は手動で確認してください。`);
      continue; // 金額が動く訂正は無人で自動確定させない
    }
    state.processed[mfId] = { ...ent, matched: newMatch, cancelledFeeInvolved: newCancelled, autoAdjust: "no_adjustment_needed", reverifiedAt: new Date().toISOString(), reverifiedFrom: { matched: ent.matched || null, cancelledFeeInvolved: !!ent.cancelledFeeInvolved } };
    changed++;
    console.log(`NOTIFY: 🔧 再検証 ${ent.date} ¥${ent.amount.toLocaleString()}(mfId=${mfId}) のラベルを訂正: ${ent.matched || "null"}→${newMatch}(${propName}/${j.mode})`);
  }
  if (changed) saveState(state);
  console.log(`--reverify ${ym} 完了: 対象${checked}件 / 訂正${changed}件`);
  process.exitCode = 0;
}

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
  if (REVERIFY_YM) { await reverifyMonth(REVERIFY_YM); return; }
  console.log(`MF OTA入金監視(Booking+Airbnb): 走査月=${SCAN.join(", ")}${REPLAY ? " [replay]" : ""}${DRY ? " [dry]" : ""}`);
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
      // fallbacks: 主物件で不一致のときに順に照合する候補。countMissing=true の候補(従来のsecondary)は
      // CSV未着を「保留」理由に数えるが、宇品は運用開始前の月のCSVが構造的に存在しないため数えない
      // (数えると宇品CSVが無いだけでテラス/小町の本物の不一致まで永久保留になる)。
      const abT = r3.filter((d) => PAYONEER.test(d.desc) && d.amount > 0).map((d) => ({ ...d, primary: TERRACE, fallbacks: [{ pid: KOMACHI, countMissing: true }, { pid: UJINA, countMissing: false }], acct: "楽天第三" }));
      const abK = harp.filter((d) => PAYONEER.test(d.desc) && d.amount > 0).map((d) => ({ ...d, primary: KOMACHI, fallbacks: [{ pid: TERRACE, countMissing: true }, { pid: UJINA, countMissing: false }], acct: "楽天ハープ" }));
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
  // apply:true = キャンセル料入金・返金調整の一意解釈が得られたら、該当CI月の売上へ自動調整まで行う
  // (全自動運用・2026-07-20やますけ決定。手修正保護月/解釈が割れる場合はAPI側が適用せず reason を返す)
  //
  // 【2026-08-10修正】まず apply:false の下見(dry)で missingCsvMonths と match を確認し、
  // 「対象物件のCI窓CSVが揃っている(missingCsvMonths=[])」場合のみ一致(exact/residual問わず)を採用、
  // 揃っていなければ副物件も照合せず保留(state未登録=翌日再試行)に徹する。
  // 理由: API側はCSVが不完全でも残っている隣接月データだけで機械的に一致を見つけてしまうことがあり
  // (match:true と missingCsvMonths非空が両立し得る)、これをそのまま信用すると「CSV未着の主物件→
  // 副物件の残骸データでのクロス物件フォールバック解釈」を誤ってmatch扱いしてしまう。
  // 実例(2026-07-20): 宿小町7月CSV未着のreplayで、テラス6月CSVのキャンセル行を使ったresidual解釈が
  // 誤ってmatch扱いになりstateに焼き付いた(mfId=do8dGsrgqRFo4i3g6bZtO30adPTRyfeVaUaKw1QfRQA 他2件)。
  // 当該月が手修正保護中で帳簿実害はゼロだったが、保護されていない月なら誤adjustmentがFirestoreへ
  // 自動適用され得た(state.processedへの誤ラベル書込だけの問題ではない)。
  const verifyAirbnb = async (pid, d, apply) => {
    const r = await fetch(`${API}/pnl/${pid}/verify-airbnb-payout`, { method: "POST", headers: H, body: JSON.stringify({ amount: d.amount, date: d.date, apply: !!apply, mfId: d.mfId }) });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  for (const d of freshAb) {
    console.log(`\n▼ Airbnb入金 ${d.date} ¥${d.amount.toLocaleString()} (${d.acct})`);
    // 1) 主口座をdry(apply:false)で下見
    const p1 = await verifyAirbnb(d.primary, d, false);
    if (p1.status !== 200) { hadError = true; console.log("error:", p1.j.error || p1.status); continue; }
    const p1Missing = p1.j.missingCsvMonths || [];
    let matchProp = (p1Missing.length === 0 && p1.j.match) ? d.primary : null;
    let missing = [...p1Missing];
    let fbAmbiguous = false;
    if (!matchProp && p1Missing.length === 0) {
      // 主口座のCSVは揃っているのに不一致 → 副物件(口座と物件の対応が逆の期間)→宇品 の順にdryで照合。
      // 各候補ともCSVが揃っている場合のみ一致を採用する(主口座のCSVが未着なら候補は照合しない)。
      for (const fb of d.fallbacks) {
        const p2 = await verifyAirbnb(fb.pid, d, false);
        const p2Missing = p2.status === 200 ? (p2.j.missingCsvMonths || []) : [];
        if (fb.countMissing) missing = [...new Set([...missing, ...p2Missing])];
        if (p2.status === 200 && p2.j.interpretation?.ambiguous) fbAmbiguous = true;
        if (p2.status === 200 && p2Missing.length === 0 && p2.j.match) { matchProp = fb.pid; break; }
      }
    }
    // 2) CSV完備での一致が確認できた物件だけに対して確定照合(apply:true。--dry指定時はapply:false)
    let matched = null, matchedJson = null;
    if (matchProp) {
      const confirm = await verifyAirbnb(matchProp, d, !DRY);
      if (confirm.status !== 200) { hadError = true; console.log("error:", confirm.j.error || confirm.status); continue; }
      matched = matchProp; matchedJson = confirm.j;
    }
    if (matched) {
      const propName = PROP_NAMES[matched] || matched;
      const aa = matchedJson.autoAdjust || {};
      console.log(`  ✅ 一致(${propName}/${matchedJson.mode})${matched !== d.primary ? " ※口座と物件の対応が通常と逆" : ""}`);
      if (DRY) console.log(`  [dry] delta=${matchedJson.interpretation?.delta ?? 0} ciYm=${matchedJson.interpretation?.ciYm ?? "-"} (applyしていません)`);
      if (aa.applied) {
        const sign = aa.delta >= 0 ? "+" : "";
        console.log(`NOTIFY: ✅💴 Airbnb入金 ¥${d.amount.toLocaleString()}(${d.date}、${propName}) にキャンセル料入金が含まれていたため、**${aa.ciYm} の売上を ${sign}¥${aa.delta.toLocaleString()} 自動調整**しました(キャンセル料 ¥${(aa.feeSum || 0).toLocaleString()} − 返金調整 ¥${(aa.clawback || 0).toLocaleString()})。調整後Airbnb売上=¥${(aa.newGross || 0).toLocaleString()}。出典・取消は収支画面から。`);
      } else if (aa.attempted && aa.reason === "manual_override") {
        console.log(`NOTIFY: ⚠️ Airbnb入金 ¥${d.amount.toLocaleString()}(${d.date}、${propName}) にキャンセル料入金が含まれますが、対象月の売上が手修正保護中のため自動調整しませんでした(調整候補: ${matchedJson.interpretation?.delta >= 0 ? "+" : ""}¥${(matchedJson.interpretation?.delta || 0).toLocaleString()})。手修正額に反映済みか収支画面で確認してください。`);
      } else if (matchedJson.cancelledFeeInvolved && aa.attempted && !["duplicate", "no_adjustment_needed"].includes(aa.reason)) {
        console.log(`NOTIFY: ⚠️ Airbnb入金 ¥${d.amount.toLocaleString()}(${d.date}、${propName}) にキャンセル料入金が含まれますが自動調整できませんでした(理由: ${aa.reason})。Airbnb取引履歴を確認し、必要なら収支画面で売上を手修正してください。`);
      }
      state.processed[d.mfId] = { kind: "airbnb", date: d.date, amount: d.amount, matched, cancelledFeeInvolved: !!matchedJson.cancelledFeeInvolved, autoAdjust: aa.applied ? { ciYm: aa.ciYm, delta: aa.delta } : (aa.reason || null), verifiedAt: new Date().toISOString() };
    } else if (missing.length) {
      console.log(`  → CSV未着(${missing.join(",")})のため保留(翌日再試行、フォールバック解釈はスキップ)`);
    } else if (p1.j.interpretation?.ambiguous || fbAmbiguous) {
      console.log(`NOTIFY: ⚠️ Airbnb入金 ¥${d.amount.toLocaleString()}(${d.date}、${d.acct}) はキャンセル料入金を含む解釈が**複数あり**自動調整できません。Airbnb取引履歴(支払い済み)で内訳を確認し、収支画面で売上を手修正してください。`);
      state.processed[d.mfId] = { kind: "airbnb", date: d.date, amount: d.amount, matched: null, ambiguous: true, verifiedAt: new Date().toISOString() };
    } else {
      console.log(`NOTIFY: 🚨 Airbnb入金 ¥${d.amount.toLocaleString()}(${d.date}、${d.acct}) に一致する予約が Terrace/小町/宇品 の予約CSVに見つかりません。予約エクスポート欠落・金額相違・対象外物件の入金の可能性 → Airbnb 管理画面の取引履歴で確認してください。`);
      state.processed[d.mfId] = { kind: "airbnb", date: d.date, amount: d.amount, matched: null, verifiedAt: new Date().toISOString() };
    }
  }
  if (!DRY) saveState(state); else console.log("\n[dry] state保存はスキップしました。");
  process.exitCode = hadError ? 1 : 0;
})().catch((e) => { console.error("ERROR:", e.message); process.exitCode = 1; });
