#!/usr/bin/env node
// the Terrace のドコモ光を「固定額ベース＋eビリング実額の裏取り」で毎月自動計上する(冪等・毎日実行)。
//
//   使い方: node scripts/docomo-hikari-import.mjs [--month 2026-07] [--dry]
//     --month: 対象「ご利用分」月を1つ指定。省略時は前月(JST)。
//     --dry:   計上せず判定のみ。
//
//   方針(2026-07-14 やますけ決定):
//     - ドコモ光は完全定額にはしない(期間限定割引などで変動しうる)。折衷案として:
//       ①固定額をベースに月次計上(工事分割終了=2028-04ご利用分まで¥6,636、以降¥5,720)
//       ②eビリング(payment2.smt.docomo.ne.jp)で実額を毎月裏取りし、取れたら実額を優先(割引反映)
//       ③実額が取れない/固定額とズレたら通知
//     - 計上先: v2 API import-external-utility(upsert=true、sourceId=docomo-hikari:{使用月}、費目=Wi-Fi・通信費)
//     - 通知(#経理): 実額ズレ→⚠️割引検知 / 取得失敗→🚨要確認 / 固定通り新規→軽く報告 / 変化なし→無音
//
//   前提: debug Chrome(CDP:9222) に My docomo(dアカウント)ログイン済み。5/6月は手動計上済(このルーチンは前月裏取りで同額skip)。
//   ★表示状態の判定は Booking.com方式(resolveEbillState_ に集約し、確定するまでポーリング)。単発判定は描画途中をNGと誤検出する。
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const requireScripts = createRequire("C:/Users/yamas/.claude/scripts/node_modules/");
const { chromium } = requireScripts("playwright-core");

const TERRACE = "tsZybhDMcPrxqgcRy7wp";
const API = "https://api-5qrfx7ujcq-an.a.run.app";
const CDP = "http://127.0.0.1:9222";
const EBILL_URL = "https://payment2.smt.docomo.ne.jp/spguide/ebilling/gkfap001.srv?bis=lpb";
const HIKARI_LINE = "F5392930898";                       // ドコモ光の回線番号
const PULLDOWN = 'select[name="root_GKFAGS001_DENWABANGOPULLDOWN"]';
const HIKARI_OPT = "3";                                   // プルダウンの光回線 option value
const FIXED_UNTIL = "2028-04";                            // この使用月まで工事分割込み、以降 FIXED_BASE
// ★2026-08-04 更新(夜間監査の指摘): 2026-07使用分から割引適用で実額¥5,528(旧定価¥6,636との差¥1,108)。
//   静的な想定額はあくまで初期値で、実額が2か月連続で同額なら state の expectedOverride に自動追随する
//   (下の警告分岐参照)。想定と違う月だけ警告が鳴る状態を保つ。
const FIXED_WITH_KOJI = 5528;
const FIXED_BASE = 5720;
const OPEN_YM = "2026-05";                                // 開通月。これ未満は対象外

const DRY = process.argv.includes("--dry");
const OPEN_LOGIN = process.argv.includes("--open-login");   // Discordボタン用: ログイン画面を開いて終わる
// 再ログイン催促は1日1回まで(毎朝07:42に🚨が飛び続けるのを防ぐ)
const STATE_PATH = "C:/Users/yamas/.claude/channels/discord/docomo-hikari-state.json";
const loadState = () => { try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return { promptedYmd: {} }; } };
const saveState = (s) => { try { writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); } catch {} };
// ★状態は必ず「読み直してから」書く(2026-08-04)。
//   以前は各所が load した古いスナップショットをそのまま書き戻していたため、
//   先に書いた通知済みフラグを後の書き戻しが消し、同じ⚠️が毎回鳴っていた。
const updateState = (fn) => { const s = loadState(); fn(s); saveState(s); };
const mi = process.argv.indexOf("--month");
const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
const curYm = `${nowJst.getUTCFullYear()}-${String(nowJst.getUTCMonth() + 1).padStart(2, "0")}`;
const prevOf = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };
let USAGE_YM;
if (mi >= 0) {
  const m = process.argv[mi + 1];
  if (!/^\d{4}-\d{2}$/.test(m || "")) { console.error("--month は YYYY-MM"); process.exit(2); }
  USAGE_YM = m;
} else USAGE_YM = prevOf(curYm);

const fixedFor = (ym) => (ym <= FIXED_UNTIL ? FIXED_WITH_KOJI : FIXED_BASE);

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
async function cdpHttpAlive() {
  try { const r = await withTimeout(fetch(CDP + "/json/version"), 3000, "http"); return r.ok; } catch { return false; }
}
async function connectCdp() {
  for (let i = 0; i < 8; i++) {
    try { return await withTimeout(chromium.connectOverCDP({ endpointURL: CDP, timeout: 15000 }), 16000, "cdp"); } catch {}
    const alive = await cdpHttpAlive();
    if (!alive) launchDebugChrome();                         // 完全に死んでいる時だけ起動(新ウィンドウ増殖防止)
    else if (i === 2) { killDebugChrome(); await new Promise((r) => setTimeout(r, 3000)); launchDebugChrome(); } // HTTP生存+CDP無応答=Chrome更新hang等→掃除して再起動
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("CDP接続不可(debug Chrome起動失敗)");
}

// ★Booking.com方式(2026-07-25の教訓): 単発判定は「読み込み途中」を「NG」と誤検出する。
//   状態判定を1つの解決関数に集約し、確定するまでポーリングしてから取得する。
//   戻り値 state: "ready"(光×該当月×合計が揃った) / "login"(dアカウント要ログイン) / "pending"(未確定=描画途中)
async function resolveEbillState_(page, y, m) {
  const url = page.url();
  // ログイン画面のURLは複数系統ある(実測: cfg.smt.docomo.ne.jp/aif/tra/flow/v1.0/auth)。取りこぼすと pending 扱いになり
  // 「表示検証NG」と誤報して再ログインへ誘導できないため、ホスト単位で広めに判定する。
  if (/cfg\.smt\.docomo\.ne\.jp|id\.smt\.docomo\.ne\.jp|\/aif\/tra\/|sso\/|login\.account|\/sign_in|\/login/.test(url)) {
    return { state: "login", detail: `ログイン画面(${url})` };
  }
  const text = await page.evaluate(() => document.body.innerText).catch(() => "");
  const okLine = new RegExp(HIKARI_LINE).test(text);
  const okMonth = new RegExp(`${y}年${m}月ご利用分`).test(text);
  const total = text.match(/◇合計[\s　\t]*([0-9,]+)\s*円/);
  if (okLine && okMonth && total) return { state: "ready", amount: parseInt(total[1].replace(/,/g, ""), 10), text };
  // 本文側でも拾う(URLが素通りしてもログインフォームが出ていれば未ログイン)
  if (/dアカウントID|ログインしたままにする|再度ログイン|セッション.*切れ/.test(text) && !okLine) {
    return { state: "login", detail: "ログインフォーム表示" };
  }
  return { state: "pending", detail: `番号${okLine}/月${okMonth}/合計${!!total}`, text };
}

// state が ready か login に確定するまで待つ(pending のまま尽きたら pending を返す)
async function waitEbillState_(page, y, m, ms) {
  const deadline = Date.now() + ms;
  let last = { state: "pending", detail: "未取得" };
  for (;;) {
    last = await resolveEbillState_(page, y, m);
    if (last.state !== "pending") return last;
    if (Date.now() >= deadline) return last;
    await page.waitForTimeout(1500);
  }
}

// 対象月タブ→光回線選択→「表示」の一連操作
async function operateEbill_(page, m) {
  await page.evaluate((mm) => {
    const el = Array.from(document.querySelectorAll("a,button,li")).find((e) => (e.textContent || "").trim() === mm + "月" && e.offsetParent !== null);
    if (el) el.click();
  }, m);
  await page.waitForTimeout(3000);
  const has = await page.$(PULLDOWN);
  if (has) await page.selectOption(PULLDOWN, HIKARI_OPT).catch(() => {});
  else await page.evaluate((line) => {
    for (const s of document.querySelectorAll("select")) {
      const o = Array.from(s.options).find((x) => x.textContent.includes(line));
      if (o) { s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); return; }
    }
  }, HIKARI_LINE);
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("a,button,input[type=button],input[type=submit]")).filter((e) => /^表示$/.test((e.textContent || e.value || "").trim()) && e.offsetParent !== null);
    if (btns.length) btns[btns.length - 1].click();
  });
}

// eビリングから usageYm のドコモ光「◇合計」を取得。取れなければ null。
async function fetchHikariActual(page, usageYm) {
  const [y, m] = usageYm.split("-").map(Number);
  let last = { state: "pending", detail: "未実行" };
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(EBILL_URL, { waitUntil: "domcontentloaded", timeout: 40000 });
    // 遷移直後の判定は必ず誤る(OAuthバウンス途中)ので、まずページが落ち着くのを待つ
    last = await waitEbillState_(page, y, m, 20000);
    if (last.state === "login") throw new Error("My docomo 未ログイン(dアカウント再ログインが必要)");
    if (last.state === "ready") return { actual: last.amount, reason: "" };

    await operateEbill_(page, m);
    last = await waitEbillState_(page, y, m, 30000);
    if (last.state === "login") throw new Error("My docomo 未ログイン(dアカウント再ログインが必要)");
    if (last.state === "ready") return { actual: last.amount, reason: "" };
    console.log(`  試行${attempt}: 表示未確定(${last.detail}) → リトライ`);
  }
  await dumpDebug_(page, usageYm).catch(() => {});
  return { actual: null, reason: `表示確定せず(${last.detail})` };
}

// 失敗時だけ画面と本文を残す(原因究明用)
async function dumpDebug_(page, usageYm) {
  const dir = "C:/Users/yamas/AppData/Local/Temp/claude/docomo-hikari";
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${usageYm}.png`, fullPage: true }).catch(() => {});
  const text = await page.evaluate(() => document.body.innerText).catch(() => "");
  writeFileSync(`${dir}/${usageYm}.txt`, `url=${page.url()}\n\n${text}`, "utf8");
  console.log(`  デバッグ出力: ${dir}/${usageYm}.png / .txt`);
}

(async () => {
  // Discordの「🔑 ログイン画面を開く」ボタン用: debug Chrome に eビリングを開いて前面化し、そのまま残す
  if (OPEN_LOGIN) {
    const browser = await connectCdp();
    const page = await browser.contexts()[0].newPage();
    await page.goto(EBILL_URL, { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
    await browser.close();   // CDP接続を切るだけ(ブラウザとタブは残る)
    console.log("NOTIFY: 🖥️ PCに My docomo(dアカウント)のログイン画面を開きました。ログインが済んだら「⚡ ログインしたので取り込む」を押してください。");
    process.exitCode = 0; return;
  }

  console.log(`ドコモ光 取込: 使用月=${USAGE_YM} ${DRY ? "[dry]" : ""}`);
  if (USAGE_YM < OPEN_YM) { console.log(`開通(${OPEN_YM})前のため対象外。`); process.exitCode = 0; return; }
  // 実額確定済みの月は再取得しない(2026-08-12 夜間監査の指摘への対処)。
  // actualHistory は eビリングから実額が取れたときだけ書かれる=確定の証拠。
  // My docomo の合計欄は描画が遅く日によって取り逃すため、確定済みの月まで毎日
  // 取り直しては失敗の🚨誤警報が出ていた(実害ゼロなのに最上位絵文字)。
  const FORCE = process.argv.includes("--force");
  const confirmedActual = loadState().actualHistory?.[USAGE_YM];
  if (confirmedActual != null && !FORCE) {
    console.log(`(実額確定済み: ${USAGE_YM} ¥${confirmedActual.toLocaleString()} → 再取得しません。取り直すなら --force)`);
    process.exitCode = 0; return;
  }
  // 想定額: 実績に自動追随した値(expectedOverride) > 契約ベースの固定額。
  // 割引や料金改定で実額が恒常的に変わったとき、静的な定数を書き換えなくても警告が止まる。
  const fixed = loadState().expectedOverride?.amount ?? fixedFor(USAGE_YM);

  // 1) eビリング実額の裏取り
  let actual = null, fetchReason = "";
  const browser = await connectCdp();
  const page = await browser.contexts()[0].newPage();
  try {
    const r = await fetchHikariActual(page, USAGE_YM);
    actual = r.actual; fetchReason = r.reason;
  } catch (e) {
    fetchReason = e.message;
  } finally {
    await page.close().catch(() => {});
    await browser.close();
  }

  // 取得できた=ログインが生きている。次に切れたとき即催促できるよう催促フラグを畳む。
  // あわせて使用月ごとの実額を履歴に残す(直近2か月同額の判定材料。6か月分だけ保持)。
  if (actual != null) {
    updateState((st) => {
      if (st.promptedYmd?.[USAGE_YM]) delete st.promptedYmd[USAGE_YM];
      const hist = { ...(st.actualHistory || {}), [USAGE_YM]: actual };
      st.actualHistory = Object.fromEntries(Object.entries(hist).sort().slice(-6));
    });
  }

  const amount = actual != null ? actual : fixed;
  const usedSource = actual != null ? "eビリング実額" : "固定額(フォールバック)";
  console.log(`固定額¥${fixed.toLocaleString()} / 実額${actual != null ? "¥" + actual.toLocaleString() : "取得失敗(" + fetchReason + ")"} → 計上¥${amount.toLocaleString()} [${usedSource}]`);

  // 2) upsert 計上
  const secret = readFileSync("C:/Users/yamas/.claude/channels/discord/v2-gas-secret.txt", "utf8").trim();
  const res = await fetch(`${API}/pnl/${TERRACE}/${USAGE_YM}/import-external-utility`, {
    method: "POST",
    headers: { "authorization": `Bearer gas-${secret}`, "content-type": "application/json" },
    body: JSON.stringify({
      source: "My docomo eビリング", upsert: true, dryRun: DRY,
      items: [{ sourceId: `docomo-hikari:${USAGE_YM}`, description: `ドコモ光 ${USAGE_YM}分(${usedSource})`, amount, date: USAGE_YM, category: "Wi-Fi・通信費", vendor: "NTTドコモ" }],
    }),
  });
  const j = await res.json().catch(() => ({}));
  console.log(`API status=${res.status} 採用${(j.adopted || []).length}件 / skip${(j.skipped || []).length}件`);
  if (!res.ok) { console.log(`NOTIFY: 🚨 ドコモ光 ${USAGE_YM} の計上APIが失敗しました(${j.error || res.status})。`); process.exitCode = 1; return; }

  const changed = (j.adopted || []).length > 0;      // 新規 or 金額更新があった
  const prev = (j.adopted || [])[0]?.prevAmount || 0;

  // 3) 通知(要点だけ #経理 へ)
  if (actual == null) {
    // dアカウントのログイン切れは「異常」ではなく「やますけの一手待ち」。ボタン付きで催促し、1日1回に絞る。
    if (/未ログイン|ログイン画面|ログインフォーム/.test(fetchReason)) {
      const st = loadState();
      const ymd = `${nowJst.getUTCFullYear()}-${String(nowJst.getUTCMonth() + 1).padStart(2, "0")}-${String(nowJst.getUTCDate()).padStart(2, "0")}`;
      if (st.promptedYmd?.[USAGE_YM] === ymd) {
        console.log("(未ログイン: 本日は催促済みのため通知しない)");
        process.exitCode = 0; return;
      }
      updateState((s) => { s.promptedYmd = { ...(s.promptedYmd || {}), [USAGE_YM]: ymd }; });
      console.log(`NOTIFY: 🔑 ドコモ光 ${USAGE_YM} の実額裏取りに **My docomo の再ログイン**が必要です(dアカウントのログインが切れています)。固定額¥${fixed.toLocaleString()}で${changed ? "暫定計上" : "維持"}済みなので急ぎではありません。下のボタンでPCにログイン画面を開けます。`);
      console.log("BUTTONS: docomo_login");
      process.exitCode = 0; return;   // 催促は正常系(非0だとルーチンがエラー通知を二重に出す)
    }
    // 合計欄の描画取り逃しは異常ではなく翌日リトライで拾う(固定額で計上済みのため実害なし)。
    // 請求は翌月中旬に確定するので、翌月20日を過ぎても取れないときだけ1回通知する。
    const notifyDeadline = (() => {
      const [y, m] = USAGE_YM.split("-").map(Number);
      return m === 12 ? `${y + 1}-01-20` : `${y}-${String(m + 1).padStart(2, "0")}-20`;
    })();
    const todayYmd = `${nowJst.getUTCFullYear()}-${String(nowJst.getUTCMonth() + 1).padStart(2, "0")}-${String(nowJst.getUTCDate()).padStart(2, "0")}`;
    const st = loadState();
    if (todayYmd > notifyDeadline && !st.fetchFailNotified?.[USAGE_YM]) {
      updateState((s) => { s.fetchFailNotified = { ...(s.fetchFailNotified || {}), [USAGE_YM]: todayYmd }; });
      console.log(`NOTIFY: ⚠️ ドコモ光 ${USAGE_YM} の実額が${notifyDeadline}を過ぎても取得できていません(${fetchReason})。固定額¥${fixed.toLocaleString()}で${changed ? "暫定計上" : "維持"}中。My docomo で内訳をご確認ください。`);
    } else {
      console.log(`(取得失敗: ${fetchReason} → 通知せず翌日リトライ。${notifyDeadline}以降も未取得なら1回通知)`);
    }
    process.exitCode = 0;
  } else if (actual !== fixed) {
    const st = loadState();
    // 「この月・この額はもう知らせた」を月ごとに持つ。単一の warnedFor 文字列だと
    // 別の書き込みに巻き戻された瞬間に同じ警告がぶり返す(実測: 8/1と8/3に二度鳴った)。
    const notified = { ...(st.notifiedFor || {}) };
    if (!st.notifiedFor && typeof st.warnedFor === "string") {   // 旧形式からの移行
      const [ym, amt] = st.warnedFor.split(":");
      if (ym) notified[ym] = Number(amt);
    }
    if (st.actualHistory?.[prevOf(USAGE_YM)] === actual) {
      // 直近2か月の実額が同額 = 割引/改定による恒常変化。想定額を実績に自動追随し、以後は
      // この額と異なる月だけ警告する(毎月同じ⚠️が鳴り続けて本物の異常が埋もれるのを防ぐ)。
      updateState((s) => {
        s.expectedOverride = { amount: actual, sinceYm: USAGE_YM };
        delete s.warnedFor; delete s.notifiedFor;
      });
      console.log(`NOTIFY: 📶 ドコモ光の想定額を実績¥${actual.toLocaleString()}に自動追随しました(${prevOf(USAGE_YM)}・${USAGE_YM}の2か月連続同額。旧想定¥${fixed.toLocaleString()})。以後はこの額と異なる月だけ警告します。`);
    } else if (notified[USAGE_YM] === actual) {
      // 毎日実行のため、同じ月×同じ額のズレは初回だけ警告する(2回目以降は無音)
      console.log(`(想定額ズレは警告済み: ${USAGE_YM} ¥${actual.toLocaleString()})`);
    } else {
      updateState((s) => {
        s.notifiedFor = { ...(s.notifiedFor || {}), ...notified, [USAGE_YM]: actual };
        delete s.warnedFor;
      });
      console.log(`NOTIFY: ⚠️ ドコモ光 ${USAGE_YM} の実額¥${actual.toLocaleString()}が固定想定¥${fixed.toLocaleString()}と異なります(割引/料金変動の可能性)。実額で${changed ? (prev ? "更新" : "計上") : "一致(変更なし)"}しました。来月も同額なら想定額を自動追随して警告を止めます。`);
    }
  } else if (changed) {
    console.log(`NOTIFY: 📶 ドコモ光 ${USAGE_YM} ¥${amount.toLocaleString()}を計上しました(実額=固定額で一致)。`);
  } else {
    console.log(`(変更なし: ${USAGE_YM} は既に¥${amount.toLocaleString()}で計上済み。裏取り一致)`);
  }
  process.exitCode = 0;
})().catch((e) => { console.error("ERROR:", e.message); process.exitCode = 1; });
