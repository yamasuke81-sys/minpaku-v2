import { test, expect } from "@playwright/test";
import { issueOwnerIdToken, applyAuthStateToPage } from "../fixtures/auth";

const PAGES_TO_AUDIT = [
  { hash: "#/dashboard",        title: "ダッシュボード" },
  { hash: "#/properties",       title: "物件管理"       },
  { hash: "#/staff",            title: "スタッフ管理"   },
  { hash: "#/guests",           title: "宿泊者名簿"     },
  { hash: "#/invoices",         title: "請求書"         },
  { hash: "#/rates",            title: "報酬単価"       },
  { hash: "#/notifications",    title: "通知設定"       },
  { hash: "#/reservation-flow", title: "予約フロー"     },
  { hash: "#/cleaning-flow",    title: "清掃フロー"     },
];

let ownerIdToken: string | null = null;
let ownerUid: string | null = null;

test.describe("UI 巡回監査 (各画面の基本表示)", () => {
  test.beforeAll(async () => {
    const auth = await issueOwnerIdToken();
    if (auth) {
      ownerIdToken = auth.idToken;
      ownerUid = auth.uid;
    }
  });

  for (const p of PAGES_TO_AUDIT) {
    test(`UI-AUDIT: ${p.hash} が正常にロードされる`, async ({ page }) => {
      if (!ownerIdToken || !ownerUid) {
        test.skip(process.env.CI !== "true", "オーナートークン未取得 (ローカル SA 権限不足)");
        return;
      }
      await applyAuthStateToPage(page, ownerIdToken, ownerUid);

      // コンソールエラーを捕捉
      const consoleErrors: string[] = [];
      page.on("console", msg => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });

      await page.goto(`/${p.hash}`);
      await page.waitForTimeout(3000);

      // ログイン画面でないことを確認
      const url = page.url();
      expect(url).not.toContain("email-signin");

      // タイトル情報を収集 (情報のみ、assert はしない)
      const titleText = await page.locator("h1, h2, .page-header h2, #pageContainer h2").first()
        .innerText({ timeout: 5000 })
        .catch(() => "");
      const bodyHasTitle = await page.evaluate(
        (t) => document.body.innerText.includes(t),
        p.title
      ).catch(() => false);
      console.log(`  [${p.hash}] h2="${titleText.substring(0, 50)}" bodyHasTitle=${bodyHasTitle}`);

      // コンソールにエラーがないこと (warn は許容)
      const criticalErrors = consoleErrors.filter(e =>
        !e.includes("volunteers") &&
        !e.includes("migrated") &&
        !e.includes("DEP0040") &&
        !e.includes("punycode")
      );
      if (criticalErrors.length > 0) {
        console.error(`  [${p.hash}] コンソールエラー: ${criticalErrors.join(" | ")}`);
      }
      expect(criticalErrors).toEqual([]);
    });
  }
});

test.describe("UI 巡回監査 (モバイル)", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  let mobileOwnerToken: string | null = null;
  let mobileOwnerUid: string | null = null;

  test.beforeAll(async () => {
    const auth = await issueOwnerIdToken();
    if (auth) {
      mobileOwnerToken = auth.idToken;
      mobileOwnerUid = auth.uid;
    }
  });

  for (const p of PAGES_TO_AUDIT.slice(0, 5)) {
    test(`UI-AUDIT-MOBILE: ${p.hash} モバイルで正常表示`, async ({ page }) => {
      if (!mobileOwnerToken || !mobileOwnerUid) {
        test.skip(process.env.CI !== "true", "オーナートークン未取得 (ローカル SA 権限不足)");
        return;
      }
      await applyAuthStateToPage(page, mobileOwnerToken, mobileOwnerUid);
      await page.goto(`/${p.hash}`);
      await page.waitForTimeout(3000);
      // 横スクロールバー (body 幅 > viewport 幅) が出ていないこと
      const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
      console.log(`  [${p.hash}] mobile scrollWidth=${bodyWidth}px`);
      expect(bodyWidth).toBeLessThanOrEqual(400); // 375 + 少し余裕
    });
  }
});
