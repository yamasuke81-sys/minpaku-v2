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
// CORS はホスティングドメインのみ許可 (GAS等のサーバー間通信は Origin ヘッダが無いため影響なし)
app.use(cors({
  origin: [
    "https://v2-5-relay.web.app",
    "https://v2-5-relay.firebaseapp.com",
    "https://minpaku-v2.web.app",
    "https://minpaku-v2.firebaseapp.com",
    /^http:\/\/localhost(:\d+)?$/, // firebase serve / ローカル検証用
  ],
}));
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

// ========== 臨時スタッフ向けチェックリスト API（認証不要） ==========
const helperChecklistApi = require("./api/helper-checklist");
app.use("/helper-checklist", helperChecklistApi(db));

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

// ========== 収支管理 API ==========
const pnlApi = require("./api/pnl");
app.use("/pnl", pnlApi(db));

// ========== スキャン自動仕分け API ==========
const scanSorterApi = require("./api/scan-sorter");
app.use("/scan-sorter", scanSorterApi(db));

// ========== 税理士資料管理 API ==========
const taxDocsApi = require("./api/tax-docs");
app.use("/tax-docs", taxDocsApi(db));

// ========== 通知テスト API ==========
const notificationsApi = require("./api/notifications");
app.use("/notifications", notificationsApi(db));

// ========== 英訳 API (Gemini, scan-sorter キー流用) ==========
const translateApi = require("./api/translate");
app.use("/translate", translateApi(db));

// ========== 手動同期 API ==========
const syncApi = require("./api/sync");
app.use("/sync", syncApi(db));

// ========== メール照合機能 API (Step 2) ==========
const emailVerificationApi = require("./api/email-verification");
app.use("/email-verification", emailVerificationApi(db));

// ========== Timee メール照合 API ==========
const timeeApi = require("./api/timee");
app.use("/timee", timeeApi(db));

// ========== 予約履歴タイムライン API (オーナー専用) ==========
const bookingTimelineApi = require("./api/booking-timeline");
app.use("/booking-timeline", bookingTimelineApi(db));

// ========== キーボックス確認API ==========
const keyboxApi = require("./api/keybox");
app.use("/keybox", keyboxApi(db));

const dispatchApi = require("./api/dispatch");
app.use("/dispatch", dispatchApi(db));

// ========== LINE プロフィール取得 API ==========
const lineProfileApi = require("./api/line-profile");
app.use("/line-profile", lineProfileApi(db));

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
// memory 256→1GiB に増量 (2026-05-28 OOM 多発のため)
// /email-verification/run や /confirm の同時実行で 278 MiB 超過、staff_confirm 通知の
// 非同期処理が完了せず通知不達になっていた事例を踏まえ十分な余裕を持たせる
// (過去に別 fn で 512 MiB でも不足した経緯があり、1GiB に設定)
exports.api = onRequest({ region: "asia-northeast1", invoker: "public", memory: "1GiB" }, app);

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

// alertUnconfirmed (未確定アラート) は 2026-06-12 廃止。
// staffUndecidedRemind (物件別 channelOverrides.staff_undecided.timings) に完全に重複しており、
// 通知キー "alert" はどの物件にも未定義のため一度も送信実績がなかった
// (notifications type+sentAt インデックス不足で毎時クラッシュもしていた)。

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

// 募集リマインド（毎時実行 — 物件別タイミング設定に従って発火）
exports.recruitReminder = onSchedule({
  schedule: "0 * * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/recruitReminder"));

// Cloud Functions の OOM (Memory limit exceeded) を検知して error_alert で通知 (毎10分)
// recruitment confirm 中の OOM で staff_confirm が完走せず不達になった事例 (2026-05-27) の対策
exports.monitorOOM = onSchedule({
  schedule: "*/10 * * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/monitorOOM"));

// Firebase Hosting の古いリリース版を自動削除 + 容量超過前警告 (毎日 03:00 JST)
// 背景: 2026-05-29 に 989 versions / 16.67GB まで膨らみ運用上の懸念に
exports.cleanupHostingVersions = onSchedule({
  schedule: "0 3 * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
  timeoutSeconds: 540,
  memory: "512MiB",
}, require("./scheduled/cleanupHostingVersions"));

// Hosting 復活検知 (一時的) — 2026-05-29 Google Cloud Trust & Safety による suspension からの復帰を毎時 :30 にチェック
// 復活通知が来たら index.js から外して削除する
exports.watchHostingRecovery = onSchedule({
  schedule: "30 * * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/watchHostingRecovery"));

// 30日繰延された募集の自動発火 (毎日 JST 08:00)
// 予約時点で 30日より先だった募集が、日付経過で 30日以内に入ったら recruit_start を発射する
exports.dispatchDeferredRecruits = onSchedule({
  schedule: "0 8 * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/dispatchDeferredRecruits"));

// 過去日付のまま残った「募集中」の自動クローズ → 期限切れ (毎日 JST 08:10)
exports.expireStaleRecruitments = onSchedule({
  schedule: "10 8 * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/expireStaleRecruitments"));

// 蓄積ログの日次クリーンアップ (毎日 03:30 JST)
// notifications/error_logs/notificationQueue/client_errors の保持期間超過分をバッチ削除
exports.logCleanup = onSchedule({
  schedule: "30 3 * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/logCleanup"));

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

// Timee メール巡回（10 分おき）
exports.syncTimeeEmails = onSchedule({
  schedule: "every 10 minutes",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, async () => {
  const admin = require("firebase-admin");
  if (!admin.apps.length) admin.initializeApp();
  const syncCore = require("./scheduled/syncTimeeEmails");
  await syncCore(admin.firestore(), { log: console });
});

// iCal同期（5分おき）— Beds24導入後はこちらを無効化
exports.syncIcal = onSchedule({
  schedule: "every 5 minutes",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
  memory: "512MiB", // bookings 全件 × 3 種類クエリ + iCal バッファで OOM リスク高 (2026-05-28)
}, require("./scheduled/syncIcal"));

// OAuth トークン期限リマインダー（毎日 9:00 JST、6日経過で LINE+メール通知）
exports.oauthReminder = require("./scheduled/oauthReminder").oauthReminder;

// GAS版予約データ差分比較は廃止 (2026-05-27)
// 民泊 v2 へ移行完了のため compareGasReservations は不要。
// onGuestRegistrationToGas (リバース連携) は引き続き settings/gasComparison.gasUrl/gasToken を参照する。

// 孤児データクリーンアップ（毎日 2:00 JST）
exports.orphanCleanup = require("./scheduled/orphanCleanup").orphanCleanup;

// チェックリスト写真 30日超過削除（毎日 3:00 JST）
exports.photoCleanup = require("./scheduled/photoCleanup").photoCleanup;

// scan-sorter 受信BOX自動処理（5分おき / Firestore で ON/OFF と間隔を制御）
exports.scanSorterProcess = require("./scheduled/scanSorterProcess").scanSorterProcess;

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

// testGasComparison (onCall) も廃止 (2026-05-27)

// ========== Firestoreトリガー ==========

// 募集変更→回答通知（AI秘書「黒子」）
exports.onRecruitmentChange = onDocumentWritten(
  { document: "recruitments/{recruitmentId}", region: "asia-northeast1" },
  require("./triggers/onRecruitmentChange")
);

// 宿泊者名簿受信→通知（AI秘書「黒子」）
exports.onGuestFormSubmit = onDocumentCreated(
  { document: "guestRegistrations/{guestId}", region: "asia-northeast1" },
  require("./triggers/onGuestFormSubmit")
);

// 宿泊者名簿 更新→修正完了メール + 更新通知
exports.onGuestFormUpdate = onDocumentUpdated(
  { document: "guestRegistrations/{guestId}", region: "asia-northeast1" },
  require("./triggers/onGuestFormUpdate")
);

// 宿泊者名簿 新規作成→GAS版スプシへ自動転記（リバース連携）
exports.onGuestRegistrationToGas = onDocumentCreated(
  { document: "guestRegistrations/{guestId}", region: "asia-northeast1" },
  require("./triggers/onGuestRegistrationToGas")
);

// 予約変更時→清掃スケジュール自動生成
// メモリ 256→512→1024MiB に増量
//   512MiB でも 529MB 使用で OOM していたため (iCal大量同期 + notifyByKey累積で肥大)
exports.onBookingChange = onDocumentWritten(
  {
    document: "bookings/{bookingId}",
    region: "asia-northeast1",
    memory: "1GiB",
    timeoutSeconds: 540,
  },
  require("./triggers/onBookingChange")
);

// onGuestRegistrationCreate は onGuestFormSubmit.js に統合済み (2026-04-26)、
// ファイル本体も削除済み (2026-06-13。履歴は git 参照)。

// シフト作成時→物件テンプレートをスナップショットしてチェックリスト自動生成
exports.onShiftCreated = onDocumentCreated(
  { document: "shifts/{shiftId}", region: "asia-northeast1" },
  require("./triggers/onShiftCreated")
);

// チェックリスト原紙更新→該当物件の未着手 checklist を最新化 (方針B自動同期)
// テンプレ全文を含むイベントペイロード+一括差し替えでメモリを食うため 512MiB (OOM 対策)
exports.onChecklistTemplateUpdate = onDocumentUpdated(
  { document: "checklistTemplates/{propertyId}", region: "asia-northeast1", memory: "512MiB" },
  require("./triggers/onChecklistTemplateUpdate")
);

// チェックリスト完了→シフト完了+通知
exports.onChecklistComplete = onDocumentUpdated(
  { document: "checklists/{checklistId}", region: "asia-northeast1" },
  require("./triggers/onChecklistComplete")
);

// チェックリスト laundry フィールド変更→対応する通知 type を送信
// (laundry_put_out / laundry_collected / laundry_stored)
exports.onChecklistLaundryChange = onDocumentUpdated(
  { document: "checklists/{checklistId}", region: "asia-northeast1" },
  require("./triggers/onChecklistLaundryChange")
);

// エラーログ作成→AI翻訳+LINE通知（情シス機能）
exports.onErrorLogCreated = onDocumentCreated(
  { document: "error_logs/{logId}", region: "asia-northeast1" },
  require("./triggers/onErrorLogCreated")
);

// LINE Channel Access Token 変更検知 → Bot Info (displayName/basicId) 自動取得
exports.onPropertyLineTokenChange = onDocumentWritten(
  { document: "properties/{propertyId}", region: "asia-northeast1" },
  require("./triggers/onLineTokenChange").onPropertyChange
);
exports.onNotificationsLineTokenChange = onDocumentWritten(
  { document: "settings/notifications", region: "asia-northeast1" },
  require("./triggers/onLineTokenChange").onNotificationsSettingsChange
);

// ========== 通知スケジュール (未実装通知の発火) ==========

// 名簿未入力リマインド（毎時実行 — 物件別タイミング設定に従って発火）
exports.rosterRemind = onSchedule({
  schedule: "0 * * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/rosterRemind"));

// 直前予約リマインド: cron 廃止。urgent_remind は onBookingChange の即時送信に統合
// (timings=[{timing:"immediate"}] 設定で動作。新規予約 + CI=今日/明日 + 名簿未提出で即時通知)
// exports.urgentRemind = ...

// スタッフ未確定リマインド（毎時実行 — 物件別タイミング設定に従って発火、未設定物件は朝11時に従来動作）
exports.staffUndecidedRemind = onSchedule({
  schedule: "0 * * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/staffUndecidedRemind"));

// バッチ通知キュー処理（毎時実行 — JST 8時/20時 のみ稼働）
// 「朝バッチ(8時)」「夜バッチ(20時)」プリセットでキューイングされた通知を一括配信
exports.processBatchNotificationQueue = onSchedule({
  schedule: "0 * * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/processBatchNotificationQueue"));

// 日付モード (mode=date) 通知の毎時発火 — monthEnd/monthlyDay/weekly/daily に対応
exports.runDateScheduledNotifications = onSchedule({
  schedule: "0 * * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/runDateScheduledNotifications"));

// 直前点検リマインド（毎時実行）— inspection.enabled=true 物件のチェックイン前日に通知
exports.sendInspectionReminder = onSchedule({
  schedule: "0 * * * *",
  region: "asia-northeast1",
  timeZone: "Asia/Tokyo",
}, require("./scheduled/sendInspectionReminder"));

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
