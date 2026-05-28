/**
 * Dispatch Listener — 常時起動 PC で動かす Firestore queue 監視デーモン
 *
 * 動作:
 *   1. dispatchQueue.where("status","==","pending") を onSnapshot で監視
 *   2. 新規 pending を検知 → status="processing" にロック
 *   3. command の種別 (kind) に応じて処理を実行
 *      - timee_post: Tampermonkey 自動入力 URL を構築 → 既定ブラウザで開く
 *   4. 完了したら status="done" (or "failed") + completedAt 記録
 *
 * 前提:
 *   - Firebase Admin SDK で認証
 *     → 環境変数 GOOGLE_APPLICATION_CREDENTIALS にサービスアカウント JSON のパスをセット
 *       例 (PowerShell): $env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\serviceAccount.json"
 *     または Firebase CLI ログイン状態 (firebase login:ci で取得した認証情報) でも可
 *   - Chrome / 既定ブラウザに Tampermonkey + timee-autofill.user.js が導入済
 *
 * 起動:
 *   cd C:\Users\yamas\AI_Workspace\minpaku-v2
 *   node scripts/dispatch-listener.js
 *   (バックグラウンド化: pm2 start scripts/dispatch-listener.js --name dispatch-listener)
 */

const admin = require("firebase-admin");
const { spawn } = require("child_process");
const path = require("path");
const { chromium } = require("playwright");

if (!admin.apps.length) {
  admin.initializeApp({ projectId: "minpaku-v2" });
}
const db = admin.firestore();

// Playwright 用専用 user-data-dir (タイミーログインセッション保持用)
// 初回はこのプロファイルで Chromium 起動してタイミー手動ログイン → 以降は自動継続
const PLAYWRIGHT_USER_DATA_DIR = path.join(process.env.USERPROFILE || process.env.HOME || ".", ".dispatch-playwright-chrome");
// ヘッドフル (画面表示) を強制 (デバッグ + ユーザー視認用)
const PLAYWRIGHT_HEADLESS = process.env.PLAYWRIGHT_HEADLESS === "1";

// ================== タイミー URL 構築 (Cloud Functions の buildTimeeAutofillUrl_ と同等) ==================
function buildTimeeAutofillUrl(tf, checkOut, visibility) {
  if (!tf || !tf.baseUrl || !checkOut) return null;
  const url = new URL(tf.baseUrl);
  url.searchParams.set("openExternalBrowser", "1");
  const params = new URLSearchParams();
  params.set("date", checkOut);
  if (tf.start) params.set("start", tf.start);
  if (tf.end) params.set("end", tf.end);
  if (tf.restMin != null) params.set("restMin", String(tf.restMin));
  if (tf.workers) params.set("workers", String(tf.workers));
  params.set("visibility", visibility);
  if (visibility === "group_limited" && tf.groupIds) params.set("groupIds", tf.groupIds);
  if (tf.wage) params.set("wage", String(tf.wage));
  if (tf.transport != null) params.set("transport", String(tf.transport));
  if (tf.autoMsg != null) params.set("autoMsg", tf.autoMsg ? "true" : "false");
  if (tf.autoMsgTarget) params.set("autoMsgTarget", tf.autoMsgTarget);
  return `${url.toString()}#${params.toString()}`;
}

// ================== 既定ブラウザで URL を開く ==================
function openInBrowser(url) {
  // shell:true で OS デフォルトシェル経由 (Windows: cmd.exe, *nix: sh)
  // URL を直接シェルに渡すので簡単。引用符のエスケープは Windows の "" + 二重引用符で対応
  let cmdline;
  if (process.platform === "win32") {
    // start の第1引数 "" はタイトル指定 (省略不可)。URL は引用符で囲む
    cmdline = `start "" "${url}"`;
  } else if (process.platform === "darwin") {
    cmdline = `open "${url}"`;
  } else {
    cmdline = `xdg-open "${url}"`;
  }
  const child = spawn(cmdline, [], { detached: true, stdio: "ignore", shell: true });
  child.unref();
}

// ================== ジョブ処理 ==================
async function handleJob(docId, data) {
  const ref = db.collection("dispatchQueue").doc(docId);
  console.log(`[listener] processing ${docId} kind=${data.kind} command=${data.command}`);

  // ロック (already-locked なら何もせず終了)
  try {
    await db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (!cur.exists) throw new Error("doc disappeared");
      if (cur.data().status !== "pending") throw new Error("not pending");
      tx.update(ref, {
        status: "processing",
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    console.log(`[listener] skip ${docId}: ${e.message}`);
    return;
  }

  try {
    if (data.kind === "timee_post") {
      await handleTimeePost(data);
    } else {
      throw new Error(`unknown kind: ${data.kind}`);
    }
    await ref.update({
      status: "done",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`[listener] done ${docId}`);
  } catch (e) {
    console.error(`[listener] failed ${docId}:`, e.message);
    await ref.update({
      status: "failed",
      error: String(e.message || e).slice(0, 500),
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

async function handleTimeePost(data) {
  const { bookingId, params } = data;
  const visibility = params?.visibility;
  const checkoutDate = params?.checkoutDate;
  if (!bookingId || !visibility || !checkoutDate) {
    throw new Error("missing required params (bookingId/visibility/checkoutDate)");
  }
  // 物件マスタから timeeAutofill 設定を取得
  const bDoc = await db.collection("bookings").doc(bookingId).get();
  if (!bDoc.exists) throw new Error(`booking not found: ${bookingId}`);
  const propertyId = bDoc.data().propertyId;
  if (!propertyId) throw new Error("booking has no propertyId");
  const pDoc = await db.collection("properties").doc(propertyId).get();
  if (!pDoc.exists) throw new Error(`property not found: ${propertyId}`);
  const tf = pDoc.data().timeeAutofill;
  if (!tf || !tf.baseUrl) {
    throw new Error("property.timeeAutofill 未設定 (タイミー求人テンプレ URL がない)");
  }

  const url = buildTimeeAutofillUrl(tf, checkoutDate, visibility);
  if (!url) throw new Error("buildTimeeAutofillUrl が null を返した");
  console.log(`[listener] opening with Playwright: ${url.slice(0, 80)}...`);

  // Playwright で Chromium 起動 + 求人作成ボタンまで自動押下
  // 失敗時は openInBrowser にフォールバック (手動操作で続行できる)
  let createdUrl = url;
  try {
    createdUrl = await autoSubmitTimeeJob(url);
    console.log(`[listener] timee 求人作成完了: ${createdUrl}`);
  } catch (e) {
    console.error(`[listener] Playwright 自動投稿失敗 (${e.message}) → 既定ブラウザで開いてフォールバック`);
    openInBrowser(url);
  }

  // bookings に「タイミー募集中」状態 + 開いた URL を保存 (UI のバッジから再アクセス用)
  try {
    await db.collection("bookings").doc(bookingId).update({
      timeeStatus: "posted",
      timeePostedAt: admin.firestore.FieldValue.serverTimestamp(),
      timeePostedVisibility: visibility,
      timeePostedUrl: createdUrl,
    });
  } catch (e) {
    console.warn(`[listener] timeeStatus 更新失敗 (${bookingId}):`, e.message);
  }
}

/**
 * Playwright で Chromium を起動し、Tampermonkey 相当の自動入力 + 「求人を作成」ボタン押下まで自動化
 * 戻り値: 求人作成後のページ URL (公開された求人ページの URL になる想定)
 * 注意:
 *   - 初回は専用 user-data-dir にタイミー手動ログインが必要
 *   - タイミー側 UI が変わると DOM セレクタが壊れるため、その場合は手動で開く方が安全
 */
async function autoSubmitTimeeJob(url) {
  const ctx = await chromium.launchPersistentContext(PLAYWRIGHT_USER_DATA_DIR, {
    headless: PLAYWRIGHT_HEADLESS,
    viewport: null, // フルウィンドウ
    args: ["--start-maximized"],
  });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // タイミー未ログインなら "/sign_in" 等にリダイレクトされる想定
    await page.waitForTimeout(2000); // 自動入力スクリプト相当の値反映を待つ猶予
    if (/sign_in|login/i.test(page.url())) {
      console.warn("[listener] タイミー未ログイン → 初回手動ログインが必要。ブラウザは開いたまま放置します");
      // ログイン画面を残したまま return (yamasuke が手動ログイン → 次回以降は維持される)
      return page.url();
    }

    // hash params から値を読み取り、フォームに入力 (Tampermonkey と同等処理)
    await applyTimeeHashParams(page, url);

    // 「求人を作成」ボタンを探してクリック
    // セレクタ候補 (タイミー側 UI 変更で要メンテ):
    //   1. テキストが「求人を作成」「保存」「投稿」「公開」を含むボタン
    //   2. type=submit
    const submitBtn = await page.locator(
      'button:has-text("求人を作成"), button:has-text("作成する"), button:has-text("保存"), button[type="submit"]'
    ).first();
    if (!(await submitBtn.count())) {
      throw new Error("「求人を作成」ボタンが見つからない (タイミー UI 変更の可能性)");
    }
    await submitBtn.waitFor({ state: "visible", timeout: 10000 });
    await submitBtn.click();

    // 確認ダイアログ or 公開完了画面への遷移を待つ
    // 確認モーダルが出る場合は「OK」「公開」ボタンを再度押す
    await page.waitForTimeout(2000);
    const confirmBtn = page.locator(
      'button:has-text("公開"), button:has-text("確定"), button:has-text("OK"), [role="dialog"] button:has-text("はい")'
    ).first();
    if (await confirmBtn.count()) {
      try { await confirmBtn.click({ timeout: 3000 }); } catch (_) {}
    }

    // 求人作成完了後の URL を取得
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    const finalUrl = page.url();
    // ウィンドウは閉じずに残す (yamasuke が結果を確認できるよう)
    return finalUrl;
  } finally {
    // ctx.close() は呼ばない — yamasuke が画面確認できるよう放置
  }
}

/** Tampermonkey ユーザースクリプトと同等の hash params → フォーム入力ロジック */
async function applyTimeeHashParams(page, fullUrl) {
  // hash 部分を取り出して page.evaluate に渡す
  const hashIdx = fullUrl.indexOf("#");
  if (hashIdx < 0) return;
  const hashStr = fullUrl.slice(hashIdx + 1);
  await page.evaluate((hs) => {
    const params = new URLSearchParams(hs);
    const set = (sel, value) => {
      if (value == null || value === "") return;
      const el = document.querySelector(sel);
      if (!el) return false;
      el.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      if (nativeSetter) nativeSetter.call(el, String(value));
      else el.value = String(value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.blur();
      return true;
    };
    // 主な候補セレクタ (Tampermonkey と同じ箇所、UI 変更で要メンテ)
    set('input[name="date"], input[type="date"]', params.get("date"));
    set('input[name="start_at"], input[name="start"]', params.get("start"));
    set('input[name="end_at"], input[name="end"]', params.get("end"));
    set('input[name="rest_minute"], input[name="restMin"]', params.get("restMin"));
    set('input[name="workers"], input[name="recruit_count"]', params.get("workers"));
    set('input[name="hourly_wage"], input[name="wage"]', params.get("wage"));
  }, hashStr);
}

// ================== onSnapshot 監視 ==================
console.log("[listener] starting — watching dispatchQueue (status=pending)");
db.collection("dispatchQueue")
  .where("status", "==", "pending")
  .onSnapshot(
    async (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== "added") continue;
        await handleJob(change.doc.id, change.doc.data());
      }
    },
    (err) => {
      console.error("[listener] snapshot error:", err.message);
    }
  );

// graceful shutdown
process.on("SIGINT", () => {
  console.log("[listener] SIGINT — shutting down");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("[listener] SIGTERM — shutting down");
  process.exit(0);
});
