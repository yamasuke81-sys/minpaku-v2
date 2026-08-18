/**
 * Booking 受信箱タブ判定・被せ物処理の回帰テスト（実ブラウザ + 実DOM）。
 *
 * 2026-08-15 の実障害（入江真紀様 6084082902 / the Terrace 長浜 8/22 CI）の直因は
 *   「受信箱がカスタマーサービスタブのままなのに、ゲストタブへ切替済みだと誤判定していた」
 * こと。Booking のタブは aria-selected を持たないため、旧判定
 *   `[aria-selected="true"]:has-text("カスタマーサービス")` が常に 0 件になり、
 * 「カスタマーサービスが選択中でない＝ゲストタブに居る」と読んでいた。
 *
 * モックでは再現できない（判定対象が実際のDOM属性・計算スタイルそのもの）ため、
 * 失敗スクショと同じ構造の fixtures/booking-inbox.html に対して実ブラウザで検証する。
 *
 *   node ota-message.tabdetect.test.mjs
 */
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readBookingInboxTab, selectBookingGuestTab, dismissBookingOverlays } from "./ota-message.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = pathToFileURL(path.join(HERE, "fixtures", "booking-inbox.html")).href;

let fail = 0;
const t = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};

const browser = await chromium.launch();
const page = await browser.newPage();

await page.goto(URL);

// ① 旧判定の再現: aria-selected が無いので「カスタマーサービスは非選択」と読めてしまう
const oldCsActive = await page
  .locator('[role="tab"][aria-selected="true"]:has-text("カスタマーサービス"), [aria-selected="true"]:has-text("カスタマーサービス")')
  .first()
  .count();
t("旧判定 csActive() が誤って false（＝旧コードが素通しした条件）", oldCsActive === 0);

// ② 新判定は「カスタマーサービスが選択中」を実測できる
let st = await readBookingInboxTab(page);
t("readBookingInboxTab が active=cs を検出", st.active === "cs", JSON.stringify(st));

// ③ role を持たない被せ物がクリックを飲み込む状態を再現できている
const blocked = await page
  .getByText("ゲスト", { exact: true })
  .first()
  .click({ timeout: 2000 })
  .then(() => false)
  .catch(() => true);
t("被せ物がゲストタブのクリックを飲み込む", blocked);

// ④ dismissBookingOverlays が role を持たない被せ物を閉じられる
await dismissBookingOverlays(page);
t("dismissBookingOverlays が role 無しモーダルを閉じる", (await page.locator("#modal").count()) === 0);

// ⑤ selectBookingGuestTab が実際にゲストタブへ切り替える（初期状態＝被せ物ありからやり直す）
await page.goto(URL);
const ok = await selectBookingGuestTab(page);
st = await readBookingInboxTab(page);
t("selectBookingGuestTab が true を返す", ok === true);
t("実際にゲストタブが選択されている", st.active === "guest", JSON.stringify(st));

// ⑥ ゲストタブなら目標予約番号の候補が出る（カスタマーサービスタブでは出ない＝事故時の状況）
await page.locator("#q").fill("6084082902");
await page.waitForTimeout(400);
t("ゲストタブで 6084082902 の候補が出る", (await page.locator("#sugg .opt").count()) === 1);

await browser.close();
console.log("\n" + (fail ? `${fail} 件 FAIL` : "ALL PASS (7/7)"));
process.exit(fail ? 1 : 0);
