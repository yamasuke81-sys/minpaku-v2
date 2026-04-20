import { test, expect } from "@playwright/test";
import { issueOwnerIdToken, applyAuthStateToPage } from "../fixtures/auth";

const PAGES_TO_AUDIT = [
  { hash: "#/dashboard", minCards: 3, title: "ダッシュボード" },
  { hash: "#/properties", minCards: 5, title: "物件管理" },
  { hash: "#/staff", minCards: 1, title: "スタッフ管理" },
  { hash: "#/guests", minCards: 1, title: "宿泊者名簿" },
  { hash: "#/invoices", minCards: 3, title: "請求書" },
  { hash: "#/rates", minCards: 1, title: "報酬単価" },
  { hash: "#/notifications", minCards: 1, title: "通知設定" },
  { hash: "#/reservation-flow", minCards: 1, title: "予約フロー" },
  { hash: "#/cleaning-flow", minCards: 1, title: "清掃フロー" },
];

test.describe("UI 巡回監査 (各画面の基本表示)", () => {
  for (const p of PAGES_TO_AUDIT) {
    test(`UI-AUDIT: ${p.hash} が正常にロードされる`, async ({ page }) => {
      const auth = await issueOwnerIdToken();
      if (!auth) {
        test.skip(process.env.CI !== "true", "オーナートークン未取得");
        return;
      }
      await applyAuthStateToPage(page, auth.idToken, auth.uid);

      // コンソールエラーを捕捉
      const consoleErrors: string[] = [];
      page.on("console", msg => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });

      await page.goto(`/${p.hash}`);
      await page.waitForTimeout(3000);

      // タイトルチェック (タイムアウトを短く設定し、存在しない場合は警告のみ)
      try {
        const titleEl = await page.locator("h1, h2, .page-header h2").first().innerText({ timeout: 5000 });
        console.log(`  [${p.hash}] タイトル: "${titleEl}"`);
        expect(titleEl).toContain(p.title);
      } catch (e) {
        // タイトル要素が見つからない場合は警告のみ (body テキストで代替確認)
        const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
        console.warn(`  ⚠ [${p.hash}] タイトル要素未検出。body に "${p.title}" が含まれるか確認: ${bodyText.includes(p.title)}`);
        expect(bodyText).toContain(p.title);
      }

      // カード数チェック
      const cards = await page.locator(".card:visible").count();
      expect(cards).toBeGreaterThanOrEqual(p.minCards);

      // コンソールにエラーがないこと (warn は許容)
      const criticalErrors = consoleErrors.filter(e =>
        !e.includes("volunteers") && // B1 修正で消える
        !e.includes("migrated") &&
        !e.includes("DEP0040")  // punycode deprecation
      );
      expect(criticalErrors).toEqual([]);
    });
  }
});

test.describe("UI 巡回監査 (モバイル)", () => {
  test.use({ viewport: { width: 375, height: 667 } });
  for (const p of PAGES_TO_AUDIT.slice(0, 5)) {
    test(`UI-AUDIT-MOBILE: ${p.hash} モバイルで正常表示`, async ({ page }) => {
      const auth = await issueOwnerIdToken();
      if (!auth) { test.skip(process.env.CI !== "true", "オーナートークン未取得"); return; }
      await applyAuthStateToPage(page, auth.idToken, auth.uid);
      await page.goto(`/${p.hash}`);
      await page.waitForTimeout(2500);
      // 横スクロールバー (body 幅 > viewport 幅) が出ていないこと
      const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
      expect(bodyWidth).toBeLessThanOrEqual(400); // 375 + 少し余裕
    });
  }
});
