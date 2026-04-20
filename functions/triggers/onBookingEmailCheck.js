/**
 * 予約新規作成時の即時 Gmail 巡回トリガー
 *
 * iCal 同期 (syncIcal) や手動登録で bookings/{id} が作成された瞬間に
 * メール照合機能を起動し、OTA から届いている予約確認メールを即時取得する。
 *
 * 既存の onBookingChange (清掃シフト生成) とは独立したトリガー。
 * Firestore は同一パスに複数トリガー登録可能なため、双方が並行発火する。
 */
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { emailVerificationCore } = require("../scheduled/emailVerification");

module.exports = onDocumentCreated(
  {
    document: "bookings/{bookingId}",
    region: "asia-northeast1",
    concurrency: 10,
  },
  async (event) => {
    const admin = require("firebase-admin");
    const bookingId = event.params && event.params.bookingId;
    try {
      const res = await emailVerificationCore(admin.firestore(), {
        scopedBookingId: bookingId,
        log: console,
      });
      console.log(`[onBookingEmailCheck] booking=${bookingId}`, JSON.stringify(res));
    } catch (e) {
      console.error(`[onBookingEmailCheck] booking=${bookingId} エラー:`, e.message);
    }
  }
);
