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
const { reevaluateUnmatched } = require("../utils/reevaluateUnmatched");

module.exports = onDocumentCreated(
  {
    document: "bookings/{bookingId}",
    region: "asia-northeast1",
    concurrency: 10,
  },
  async (event) => {
    const admin = require("firebase-admin");
    const db = admin.firestore();
    const bookingId = event.params && event.params.bookingId;
    try {
      const res = await emailVerificationCore(db, {
        scopedBookingId: bookingId,
        log: console,
      });
      console.log(`[onBookingEmailCheck] booking=${bookingId}`, JSON.stringify(res));
    } catch (e) {
      console.error(`[onBookingEmailCheck] booking=${bookingId} エラー:`, e.message);
    }

    // P1: unmatched emailVerifications の再評価
    // 既存 emailMatchedBy 設定済みなら本処理 (Gmail 巡回) で matched 化された分は対象外。
    // 残った unmatched (= 過去に届いていてマッチしなかったメール) を当該物件スコープで再評価。
    try {
      const bookingDoc = await db.collection("bookings").doc(bookingId).get();
      if (bookingDoc.exists) {
        const propertyId = bookingDoc.data().propertyId;
        if (propertyId) {
          const r = await reevaluateUnmatched(db, { propertyId, bookingId, log: console });
          if (r.rematched > 0) {
            console.log(`[onBookingEmailCheck] 再評価で ${r.rematched} 件 matched 化 (booking=${bookingId})`);
          }
        }
      }
    } catch (e) {
      console.error(`[onBookingEmailCheck] 再評価エラー: booking=${bookingId}: ${e.message}`);
    }
  }
);
