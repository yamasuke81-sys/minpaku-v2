/**
 * 民泊管理v2 — Cloud Functions エントリポイント
 * Express APIをFirebase Functionsとしてエクスポート
 */
const { onRequest, onCall } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentWritten, onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");

admin.initializeApp();
const db = admin.firestore();

// Express アプリ
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Firebase Hosting rewrite 経由で来る URL は /api/** が保持されるので、
// Express ルーティング前に /api プレフィックスを剥がす (Gen2 Functions 対応)
app.use((req, res, next) => {
  if (req.url.startsWith("/api/")) {
    req.url = req.url.slice(4);
  } else if (req.url === "/api") {
    req.url = "/";
  }
  next();
});

// 認証ミドルウェア（テストモード対応）
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "認証が必要です" });
  }
  const token = authHeader.split("Bearer ")[1];

  // テストモード: 環境変数で明示的に有効化した場合のみ許可
  if (process.env.ALLOW_TEST_TOKEN === "true" && token === "test-token") {
    req.user = { email: "owner@test.com", role: "owner", uid: "test-owner" };
    return next();
  }

  // GAS連携: "gas-{secret}" トークンでGASからの呼び出しを認証
  if (token.startsWith("gas-")) {
    try {
      const settingsDoc = await db.collection("settings").doc("taxDocs").get();
      const gasSecret = settingsDoc.exists ? settingsDoc.data().gasSecret : null;
      if (gasSecret && token === `gas-${gasSecret}`) {
        req.user = { email: "gas-collector@system", role: "owner", uid: "gas-collector" };
        return next();
      }
    } catch (e) { /* GAS認証失敗→通常認証へフォールスルー */ }
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: "無効なトークンです" });
  }
}

// Webアプリ管理者権限チェック
function requireOwner(req, res, next) {
  if (req.user.role !== "owner") {
    return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
  }
  next();
}

// ========== 公開API（認証不要 — ゲストフォーム用設定取得） ==========
const publicApi = require("./api/public");
app.use("/public", publicApi);

// ========== Gmail OAuth2認証（認証不要 — ブラウザから直接アクセス） ==========
const gmailAuthApi = require("./api/gmail-auth");
app.use("/gmail-auth", gmailAuthApi(db));

// ========== 宿泊者名簿 編集API（トークンベース・認証不要） ==========
const guestEditApi = require("./api/guest-edit");
app.use("/guest-edit", guestEditApi(db));

// ========== 認証API（招待・LINEログイン・ロール管理） ==========
// 一部エンドポイントは認証不要（line-callback, accept-invite, invite-info）
// invite, set-role, link-line は内部で認証チェック
const authApi = require("./api/auth");
app.use("/auth", authApi(db));

app.use(authenticate);

// ========== スタッフ API ==========
const staffApi = require("./api/staff");
app.use("/staff", staffApi(db));

// ========== 物件 API ==========
const propertiesApi = require("./api/properties");
app.use("/properties", propertiesApi(db));

// ========== シフト API ==========
const shiftsApi = require("./api/shifts");
app.use("/shifts", shiftsApi(db));

// ========== コインランドリー API ==========
const laundryApi = require("./api/laundry");
app.use("/laundry", laundryApi(db));

// ========== 請求書 API ==========
const invoicesApi = require("./api/invoices");
app.use("/invoices", invoicesApi(db));

// ========== 募集管理 API ==========
const recruitmentApi = require("./api/recruitment");
app.use("/recruitment", recruitmentApi(db));

// ========== 宿泊者名簿 API ==========
const guestsApi = require("./api/guests");
app.use("/guests", guestsApi(db));

// ========== チェックリスト API ==========
const checklistApi = require("./api/checklist");
app.use("/checklist", checklistApi(db));

// ========== 定期報告 API ==========
const reportsApi = require("./api/reports");
app.use("/reports", reportsApi(db));

// ========== スキャン自動仕分け API ==========
const scanSorterApi = require("./api/scan-sorter");
app.use("/scan-sorter", scanSorterApi(db));

// ========== 税理士資料管理 API ==========
const taxDocsApi = require("./api/tax-docs");
app.use("/tax-docs", taxDocsApi(db));

// ========== 通知テスト API ==========
const notificationsApi = require("./api/notifications");
app.use("/notifications", notificationsApi(db));

// ========== 手動同期 API ==========
const syncApi = require("./api/sync");
app.use("/sync", syncApi(db));

// ========== メール照合機能 API (Step 2) ==========
const emailVerificationApi = require("./api/email-verification");
app.use("/email-verification", emailVerificationApi(db));

// ========== キーボックス確認API ==========
const keyboxApi = require("./api/keybox");
app.use("/keybox", keyboxApi(db));

// gmail-auth は authenticate の前に登録済み（認証不要）

// ========== グローバルエラーハンドラ (HTMLレスポンス漏れ防止) ==========
app.use((err, req, res, next) => {
  console.error("Unhandled API error:", err && (err.stack || err.message || err));
  if (res.headersSent) return next(err);
  res.status(500).json({ error: `サーバーエラー: ${err && err.message ? err.message : "unknown"}` });
});

// ========== 404ハンドラ (JSON で返す) ==========
app.use((req, res) => {
  res.status(404).json({ error: `APIパスが見つかりません: ${req.method} ${req.path}` });
});

// API エクスポート
// invoker: "public" → Cloud Runの「未認証の呼び出しを許可」を恒久設定（デプロイ時にリセットされない）
exports.api = onRequest({ region: "asia-northeast1", invoker: "public" }, app);

// ========== LINE Bot Webhook ==========
// LINE Developers ConsoleのWebhook URLにこのエンドポイントを設定
// URL: https://asia-northeast1-minpaku-v2.cloudfunctions.net/lineWebhook
const { handleLineWebhook } = require("./api/line-webhook");
exports.lineWebhook = onRequest(
  { region: "asia-northeast1", invoker: "public" },
  handleLineWebhook
);

// ========== 定期実行ジョブ ==========

// 朝ブリーフィング（毎朝6:00 JST）— AI秘書「黒子」
exports.morningBriefing = onSchedule({
  schedule: "0 6 * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/morningBriefing"));

// 未確定アラート（毎時チェック）— 当日/翌日の清掃スタッフ未確定を即時通知
exports.alertUnconfirmed = onSchedule({
  schedule: "0 * * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/alertUnconfirmed"));

// 税理士資料Gmail収集（毎月3日 9:00 JST）
exports.collectTaxDocs = onSchedule({
  schedule: "0 9 3 * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/collectTaxDocs"));

// MF受信BOX監視（毎週月曜 9:00 JST）
exports.processMfInbox = onSchedule({
  schedule: "0 9 * * 1",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/collectTaxDocs").processMfInbox);

// 税理士資料 Driveフォルダ日次監視（毎朝7:00 JST）
// 税理士共有フォルダにファイルが追加されたら自動でチェック入れる
exports.checkTaxDocsDrive = onSchedule({
  schedule: "0 7 * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
  timeoutSeconds: 300,
}, require("./scheduled/checkTaxDocsDrive"));

// 募集リマインド（毎日18:00 JST）— 未回答スタッフに個別LINEリマインド
exports.recruitReminder = onSchedule({
  schedule: "0 18 * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/recruitReminder"));

// Gmail受信監視（5分おき）— Gmail API有効化後にコメント解除
// 前提: settings/gmail { enabled: true, userEmail: "..." }
// exports.watchGmail = onSchedule({
//   schedule: "every 5 minutes",
//   region: "asia-northeast1",
//   timeZone: "Asia/Tokyo",
// }, require("./scheduled/watchGmail"));

// 有料駐車場 請求・催促メール（毎朝8:00 JST）
exports.sendParkingInvoice = onSchedule({
  schedule: "0 8 * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/sendParkingInvoice"));

// キーボックス情報スケジュール送信（毎時実行）- フロー設定対応の新版
exports.sendKeyboxScheduled = onSchedule({
  schedule: "0 * * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/sendKeyboxScheduled"));

// iCal同期（5分おき）— Beds24導入後はこちらを無効化
exports.syncIcal = onSchedule({
  schedule: "every 5 minutes",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/syncIcal"));

// GAS版予約データ差分比較（毎時0分）— 設定に応じて dailyTime / beforeTime で実行
exports.runGasComparisonHourly = onSchedule({
  schedule: "0 * * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/compareGasReservations"));

// 孤児データクリーンアップ（毎日 2:00 JST）
exports.orphanCleanup = require("./scheduled/orphanCleanup").orphanCleanup;

// チェックリスト写真 30日超過削除（毎日 3:00 JST）
exports.photoCleanup = require("./scheduled/photoCleanup").photoCleanup;

// BEDS24同期（5分おき）— BEDS24登録後に有効化
// exports.syncBeds24 = onSchedule({
//   schedule: "every 5 minutes",
//   region: "asia-northeast1",
//   timeZone: "Asia/Tokyo",
// }, require("./scheduled/syncBeds24"));

// シフト自動割当（毎日21:00）
// exports.autoAssignShifts = onSchedule({
//   schedule: "0 21 * * *",
//   region: "asia-northeast1",
//   timeZone: "Asia/Tokyo",
// }, require("./scheduled/autoAssignShifts"));

// 請求書自動生成（毎月1日 2:00 JST に前月分生成）
exports.generateInvoices = require("./scheduled/generateInvoices").generateInvoices;

// GAS版予約データ差分比較 テスト実行（設定画面の「テスト実行」ボタンから呼び出す）
exports.testGasComparison = onCall(
  { region: "asia-northeast1" },
  async (request) => {
    // オーナー権限チェック
    if (!request.auth) throw new Error("認証が必要です");
    const role = request.auth.token.role;
    if (role !== "owner" && role !== null && role !== undefined) {
      throw new Error("Webアプリ管理者権限が必要です");
    }
    const { runComparison } = require("./scheduled/compareGasReservations");
    // フロントから設定を直接渡すことも可能（未指定なら Firestore から読み込む）
    const configOverride = request.data?.config || null;
    return runComparison(db, configOverride);
  }
);

// ========== Firestoreトリガー ==========

// 募集変更→回答通知（AI秘書「黒子」）
exports.onRecruitmentChange = onDocumentWritten(
  "recruitments/{recruitmentId}",
  require("./triggers/onRecruitmentChange")
);

// 宿泊者名簿受信→通知（AI秘書「黒子」）
exports.onGuestFormSubmit = onDocumentCreated(
  "guestRegistrations/{guestId}",
  require("./triggers/onGuestFormSubmit")
);

// 宿泊者名簿 新規作成→GAS版スプシへ自動転記（リバース連携）
exports.onGuestRegistrationToGas = onDocumentCreated(
  "guestRegistrations/{guestId}",
  require("./triggers/onGuestRegistrationToGas")
);

// 予約変更時→清掃スケジュール自動生成
exports.onBookingChange = onDocumentWritten(
  "bookings/{bookingId}",
  require("./triggers/onBookingChange")
);

// 宿泊者名簿 作成時→propertyId 未設定なら bookings から推論して補完
// DEPRECATED: onGuestFormSubmit.js に統合済み (2026-04-26)
// 重複メール送信(管理者宛3通)を防ぐため export を停止。ファイル本体は履歴のため残置。
// exports.onGuestRegistrationCreate = onDocumentCreated(
//   { document: "guestRegistrations/{guestId}", region: "asia-northeast1" },
//   require("./triggers/onGuestRegistrationCreate")
// );

// シフト作成時→物件テンプレートをスナップショットしてチェックリスト自動生成
exports.onShiftCreated = onDocumentCreated(
  "shifts/{shiftId}",
  require("./triggers/onShiftCreated")
);

// チェックリスト原紙更新→該当物件の未着手 checklist を最新化 (方針B自動同期)
exports.onChecklistTemplateUpdate = onDocumentUpdated(
  "checklistTemplates/{propertyId}",
  require("./triggers/onChecklistTemplateUpdate")
);

// スキャンログ作成→確認待ちLINE通知（AI秘書「黒子」× 経理部連携）
exports.onScanLogCreated = onDocumentCreated(
  "scanLogs/{logId}",
  require("./triggers/onScanLogCreated")
);

// チェックリスト完了→シフト完了+通知
exports.onChecklistComplete = onDocumentUpdated(
  "checklists/{checklistId}",
  require("./triggers/onChecklistComplete")
);

// チェックリスト laundry フィールド変更→対応する通知 type を送信
// (laundry_put_out / laundry_collected / laundry_stored)
exports.onChecklistLaundryChange = onDocumentUpdated(
  "checklists/{checklistId}",
  require("./triggers/onChecklistLaundryChange")
);

// エラーログ作成→AI翻訳+LINE通知（情シス機能）
exports.onErrorLogCreated = onDocumentCreated(
  "error_logs/{logId}",
  require("./triggers/onErrorLogCreated")
);

// ========== 通知スケジュール (未実装通知の発火) ==========

// 名簿未入力リマインド（毎朝9:00 JST）
exports.rosterRemind = onSchedule({
  schedule: "0 9 * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/rosterRemind"));

// 直前予約リマインド（毎朝10:00 JST）
exports.urgentRemind = onSchedule({
  schedule: "0 10 * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/urgentRemind"));

// スタッフ未決定リマインド（毎朝11:00 JST）
exports.staffUndecidedRemind = onSchedule({
  schedule: "0 11 * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/staffUndecidedRemind"));

// 予約確認メール（bookings 新規作成時 → ゲストへ名簿フォームURL送信）
exports.onBookingConfirmMail = onDocumentCreated(
  { document: "bookings/{bookingId}", region: "asia-northeast1" },
  require("./triggers/onBookingConfirmMail")
);

// 請求書ステータス変更→PDF 自動生成 (submitted 遷移時)
exports.onInvoiceStatusChange = onDocumentUpdated(
  { document: "invoices/{invoiceId}", region: "asia-northeast1" },
  require("./triggers/onInvoiceStatusChange")
);

// ========== メール照合機能 (Step 2) ==========
// 10分おきの定期巡回 (OTA メールを Gmail API で取得 → emailVerifications/ に保存)
exports.scheduledEmailVerification = require("./scheduled/emailVerification").scheduled;

// 予約新規作成時の即時巡回トリガー (iCal 同期で新予約検出直後に Gmail を覗く)
exports.onBookingEmailCheck = require("./triggers/onBookingEmailCheck");
