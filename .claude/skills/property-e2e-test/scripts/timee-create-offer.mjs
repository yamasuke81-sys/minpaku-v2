// 宇品店舗(510988)に小町同内容のひな形を作成 v2 (実ID使用)
// node timee-create-ujina-offer2.mjs [--submit]
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const requireScripts = createRequire("C:/Users/yamas/.claude/scripts/node_modules/");
const { chromium } = requireScripts("playwright-core");

const SUBMIT = process.argv.includes("--submit");
const AUTOMSG = readFileSync("komachi_automsg.txt", "utf8");
const TITLE = "【女性スタッフ活躍中】客室清掃スタッフ募集！【UJINA Pocket House】";
const CONTENT = readFileSync("ujina_content.txt", "utf8");
const NOTES = readFileSync("ujina_notes.txt", "utf8");
const BELONGINGS = [
  "動きやすい無地のTシャツかポロシャツ",
  "動きやすいズボン(ジャージ・スウェット・ジーパンNG)",
  "靴底が綺麗な動きやすい運動靴（スニーカー等）",
  "ヘアゴム (髪の長い方)",
  "足ふきタオル（風呂掃除後にご自分の足をお拭きいただく用）",
];
const REQUIREMENTS = [
  "ドタキャンする可能性のある方は最初から応募しないでください。大変迷惑です。",
  "髪の毛１本も残さない清掃が求められます。 家事に不慣れな方の応募はご遠慮ください。",
  "清潔感のある身だしなみをしていただける方",
  "基本的なマナーを守ってコミュニケーションが取れる方",
  "駐車場はありません。コインパーキングをご利用ください。交通費の支給もありません。",
];
const QUESTIONS = [
  "職場をお気に召していただけた場合は、中長期的に継続して清掃しに来ていただける方を探していますが、可能でしょうか？",
  "応募しやすい曜日を教えてください。（土日、平日など）",
];
const CHECKS = ["未経験者歓迎", "バイク／車通勤可", "服装自由", "髪型／カラー自由", "自転車通勤可"];

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 20000 });
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
page.setDefaultTimeout(8000);
try {
  await page.goto("https://app-new.taimee.co.jp/clients/510988/offers/new", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(5000);

  await page.fill("#title", TITLE);

  // 業種/職種コンボ
  async function pickCombo(id, optionText) {
    // MUI Select: #id はダミーinput(画面外)。親のコントロールをクリックしてポップアップを開く
    const parent = page.locator("#" + id.replace(/\./g, "\\.")).locator("xpath=..");
    await parent.click();
    await page.waitForTimeout(900);
    const opt = page.locator(`[role="option"]:has-text("${optionText}"), li:has-text("${optionText}")`).first();
    await opt.click();
    await page.waitForTimeout(500);
  }
  await pickCombo("occupationCategoryId", "軽作業"); console.log("業種=軽作業 OK");
  await pickCombo("occupationId", "清掃"); console.log("職種=清掃 OK");

  await page.fill("#contents", CONTENT);
  await page.fill("#notes", NOTES);

  for (const c of CHECKS) {
    try {
      await page.locator(`label:has-text("${c}")`).first().click();
      console.log("待遇:", c, "OK");
    } catch (e) { console.log("待遇NG:", c, e.message.slice(0, 60)); }
    await page.waitForTimeout(150);
  }

  for (let i = 0; i < BELONGINGS.length; i++) await page.fill(`input[name="belongingNames.${i}"]`, BELONGINGS[i]);
  console.log("持ち物 OK");
  for (let i = 0; i < REQUIREMENTS.length; i++) await page.fill(`input[name="requirementNames.${i}"]`, REQUIREMENTS[i]);
  console.log("条件 OK");
  for (let i = 0; i < QUESTIONS.length; i++) await page.fill(`input[name="onboarding.tasks.${i}.name"]`, QUESTIONS[i]);
  console.log("質問 OK");

  await page.fill("#address", "広島県広島市南区宇品御幸5-15-16");
  await page.fill("#access", "マップよりご確認ください");
  await page.fill("#phoneNumber", "09075009595");
  console.log("住所/アクセス/連絡先 OK");

  await page.fill('textarea[name="matchingAutoChatMessageTemplate.contentTemplate"]', AUTOMSG);
  console.log("自動メッセージ OK");

  await page.locator("#images").setInputFiles("ujina_photo_0.jpg");
  await page.waitForTimeout(3000);
  console.log("写真 OK");

  await page.screenshot({ path: "ujina_offer_form.png", fullPage: true });
  console.log("スクショ: ujina_offer_form.png");

  if (SUBMIT) {
    await page.locator('button:has-text("求人のひな形の作成を完了")').click();
    await page.waitForTimeout(7000);
    console.log("送信後URL:", page.url());
    await page.screenshot({ path: "ujina_offer_after.png", fullPage: false });
    const body = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, "\n").slice(0, 500));
    console.log(body);
  }
} finally {
  await page.close();
  await browser.close();
}
