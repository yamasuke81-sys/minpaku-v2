// リスト表示に切替→8/11の求人を開いて取り消しボタンを調査/実行(--do)
import { createRequire } from "node:module";
const requireScripts = createRequire("C:/Users/yamas/.claude/scripts/node_modules/");
const { chromium } = requireScripts("playwright-core");
const DO = process.argv.includes("--do");

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 20000 });
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
page.setDefaultTimeout(10000);
try {
  await page.goto("https://app-new.taimee.co.jp/clients/510988/offerings", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(5000);
  await page.locator('button:has-text("リスト表示")').click();
  await page.waitForTimeout(3000);
  const rows = await page.evaluate(() => {
    const links = [];
    document.querySelectorAll("a[href]").forEach((a) => {
      const h = a.getAttribute("href") || "";
      if (/offerings\/\d+/.test(h)) links.push({ href: h, text: (a.innerText || "").replace(/\s+/g, " ").slice(0, 70) });
    });
    const body = document.body.innerText.replace(/\n{2,}/g, "\n");
    const i = body.indexOf("リスト表示");
    return { links, tail: body.slice(i, i + 900) };
  });
  console.log("リンク:", JSON.stringify(rows.links.slice(0, 6), null, 1));
  console.log("--- リスト ---\n" + rows.tail);
  let opened = false;
  if (rows.links.length) {
    await page.goto("https://app-new.taimee.co.jp" + rows.links[0].href, { waitUntil: "domcontentloaded", timeout: 30000 });
    opened = true;
  } else {
    // 行クリック(リンクでない場合): 8月11日を含む行
    const row = page.locator('tr:has-text("8月11日"), div:has-text("8月11日")').last();
    await row.click();
    await page.waitForTimeout(2500);
    opened = true;
  }
  if (opened) {
    await page.waitForTimeout(3000);
    const detail = await page.evaluate(() => ({
      url: location.href,
      buttons: [...document.querySelectorAll("button")].map((b) => b.innerText.replace(/\s+/g, " ").trim()).filter(Boolean).slice(-15),
      body: document.body.innerText.replace(/\n{2,}/g, "\n").slice(0, 700),
    }));
    console.log("詳細URL:", detail.url);
    console.log("ボタン:", JSON.stringify(detail.buttons));
    if (DO) {
      const cancelBtn = page.locator('button:has-text("募集を取り消す"), button:has-text("求人を取り消す"), button:has-text("取り消し"), button:has-text("取消")').first();
      await cancelBtn.click();
      await page.waitForTimeout(1500);
      const dlgTxt = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        return d ? d.innerText.replace(/\s+/g, " ").slice(0, 300) : "(ダイアログなし)";
      });
      console.log("ダイアログ:", dlgTxt);
      const confirmBtn = page.locator('[role="dialog"] button').filter({ hasText: /取り消|はい|OK|確定/ }).last();
      await confirmBtn.click().catch((e) => console.log("確認クリック失敗:", e.message.slice(0, 100)));
      await page.waitForTimeout(3500);
      const after = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, "\n").slice(0, 400));
      console.log("--- 取消後 ---\n" + after);
      await page.screenshot({ path: "ujina_offering_cancelled.png" });
    }
  }
} finally {
  await page.close();
  await browser.close();
}
