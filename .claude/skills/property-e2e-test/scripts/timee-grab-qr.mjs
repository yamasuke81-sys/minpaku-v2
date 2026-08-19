// タイミーのチェックイン/アウト管理画面からQR画像を取得して保存
// 使い方: node timee-grab-qr.mjs <clientId> <outfile>
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const requireScripts = createRequire("C:/Users/yamas/.claude/scripts/node_modules/");
const { chromium } = requireScripts("playwright-core");

const [clientId, outfile] = process.argv.slice(2);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 20000 });
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
try {
  await page.goto(`https://app-new.taimee.co.jp/clients/${clientId}/attendances`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(5000);
  const info = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll("img")].map((im) => ({ src: (im.src || "").slice(0, 150), w: im.naturalWidth, h: im.naturalHeight, alt: im.alt }));
    const canvases = document.querySelectorAll("canvas").length;
    const svgs = document.querySelectorAll("svg").length;
    const buttons = [...document.querySelectorAll("button, a")].map((b) => b.innerText.replace(/\s+/g, " ").trim()).filter((t) => t && /QR|印刷|ダウンロード|表示/.test(t));
    return { imgs: imgs.filter((i) => i.w > 50), canvases, svgs, buttons, body: document.body.innerText.replace(/\n{2,}/g, "\n").slice(0, 700) };
  });
  console.log("imgs:", JSON.stringify(info.imgs, null, 1));
  console.log("canvas数:", info.canvases, "svg数:", info.svgs);
  console.log("QR系ボタン:", JSON.stringify(info.buttons));
  console.log("--- 本文 ---\n" + info.body);

  // QRらしき img(データURL or timee CDN) があればダウンロード、canvas なら toDataURL
  const qrImg = await page.evaluate(() => {
    const cand = [...document.querySelectorAll("img")].find((im) => im.naturalWidth >= 100 && (/(qr|Qr|QR)/.test(im.src + im.alt + (im.className || "")) || im.naturalWidth === im.naturalHeight));
    if (cand) return cand.src;
    const cv = document.querySelector("canvas");
    if (cv) return cv.toDataURL("image/png");
    return null;
  });
  if (qrImg && outfile) {
    if (qrImg.startsWith("data:")) {
      writeFileSync(outfile, Buffer.from(qrImg.split(",")[1], "base64"));
      console.log("QR保存(dataURL):", outfile);
    } else {
      const resp = await ctx.request.get(qrImg);
      writeFileSync(outfile, await resp.body());
      console.log("QR保存(URL):", outfile, qrImg.slice(0, 100));
    }
  } else {
    console.log("QR画像が直接見つからず(ボタン操作が必要かも)");
  }
} finally {
  await page.close();
  await browser.close();
}
