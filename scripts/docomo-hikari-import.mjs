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
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
const requireScripts = createRequire("C:/Users/yamas/.claude/scripts/node_modules/");
const { chromium } = requireScripts("playwright-core");

const TERRACE = "tsZybhDMcPrxqgcRy7wp";
const API = "https://api-5qrfx7ujcq-an.a.run.app";
const CDP = "http://127.0.0.1:9222";
const EBILL_URL = "https://payment2.smt.docomo.ne.jp/spguide/ebilling/gkfap001.srv?bis=lpb";
const HIKARI_LINE = "F5392930898";                       // ドコモ光の回線番号
const PULLDOWN = 'select[name="root_GKFAGS001_DENWABANGOPULLDOWN"]';
const HIKARI_OPT = "3";                                   // プルダウンの光回線 option value
const FIXED_UNTIL = "2028-04";                            // この使用月まで工事分割込み¥6,636、以降¥5,720
const FIXED_WITH_KOJI = 6636;
const FIXED_BASE = 5720;
const OPEN_YM = "2026-05";                                // 開通月。これ未満は対象外

const DRY = process.argv.includes("--dry");
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

// eビリングから usageYm のドコモ光「◇合計」を取得。取れなければ null。
async function fetchHikariActual(page, usageYm) {
  const [y, m] = usageYm.split("-").map(Number);
  await page.goto(EBILL_URL, { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.waitForTimeout(6000);
  if (/dアカウント|sso\/|login\.account|\/sign_in/.test(page.url())) throw new Error("My docomo 未ログイン(dアカウント再ログインが必要)");
  // 対象月タブ
  await page.evaluate((mm) => {
    const el = Array.from(document.querySelectorAll("a,button,li")).find((e) => (e.textContent || "").trim() === mm + "月" && e.offsetParent !== null);
    if (el) el.click();
  }, m);
  await page.waitForTimeout(5000);
  // 光回線を選択
  const has = await page.$(PULLDOWN);
  if (has) await page.selectOption(PULLDOWN, HIKARI_OPT).catch(() => {});
  else await page.evaluate((line) => {
    for (const s of document.querySelectorAll("select")) {
      const o = Array.from(s.options).find((x) => x.textContent.includes(line));
      if (o) { s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); return; }
    }
  }, HIKARI_LINE);
  await page.waitForTimeout(2000);
  // 「表示」
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("a,button,input[type=button],input[type=submit]")).filter((e) => /^表示$/.test((e.textContent || e.value || "").trim()) && e.offsetParent !== null);
    if (btns.length) btns[btns.length - 1].click();
  });
  await page.waitForTimeout(7000);
  const text = await page.evaluate(() => document.body.innerText);
  // 光×該当月の表示であることを確認してから ◇合計 を抽出
  const okLine = new RegExp("表示中の電話番号[：:]\\s*" + HIKARI_LINE).test(text) || new RegExp(HIKARI_LINE).test(text);
  const okMonth = new RegExp(`${y}年${m}月ご利用分`).test(text);
  if (!okLine || !okMonth) return { actual: null, reason: `表示検証NG(番号${okLine}/月${okMonth})` };
  const mm = text.match(/◇合計[\s　\t]*([0-9,]+)\s*円/);
  if (!mm) return { actual: null, reason: "◇合計が読めない" };
  return { actual: parseInt(mm[1].replace(/,/g, ""), 10), reason: "" };
}

(async () => {
  console.log(`ドコモ光 取込: 使用月=${USAGE_YM} ${DRY ? "[dry]" : ""}`);
  if (USAGE_YM < OPEN_YM) { console.log(`開通(${OPEN_YM})前のため対象外。`); process.exitCode = 0; return; }
  const fixed = fixedFor(USAGE_YM);

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
    console.log(`NOTIFY: 🚨 ドコモ光 ${USAGE_YM} の実額をeビリングから取得できませんでした(${fetchReason})。固定額¥${fixed.toLocaleString()}で${changed ? "暫定計上" : "維持"}。My docomo で内訳をご確認ください。`);
    process.exitCode = 1;
  } else if (actual !== fixed) {
    console.log(`NOTIFY: ⚠️ ドコモ光 ${USAGE_YM} の実額¥${actual.toLocaleString()}が固定想定¥${fixed.toLocaleString()}と異なります(割引/料金変動の可能性)。実額で${changed ? (prev ? "更新" : "計上") : "一致(変更なし)"}しました。`);
  } else if (changed) {
    console.log(`NOTIFY: 📶 ドコモ光 ${USAGE_YM} ¥${amount.toLocaleString()}を計上しました(実額=固定額で一致)。`);
  } else {
    console.log(`(変更なし: ${USAGE_YM} は既に¥${amount.toLocaleString()}で計上済み。裏取り一致)`);
  }
  process.exitCode = 0;
})().catch((e) => { console.error("ERROR:", e.message); process.exitCode = 1; });
