/**
 * 支払い期限前リマインドメール（毎時実行 JST）
 *
 * 直販予約 (source=="direct") の Stripe Checkout 決済が未完了のまま
 * 期限 (paymentSession.expiresAt) が近づいた予約に、ゲストへ再決済を促すメールを送る。
 *
 * 対象条件（すべて満たすもの）:
 *   - source === "direct"
 *   - paymentStatus === "pending"（未払い。paid/expired/refunded 等は除外）
 *   - paymentSession.expiresAt が「今から 6 時間以内、かつ 未経過」
 *   - paymentReminderSentAt 未設定（1 予約 1 回のみ送信）
 *
 * コスト配慮 (project_minpaku_v2_firestore_read_cost):
 *   where("paymentStatus","==","pending") の単一等値クエリで絞る（複合 index 不要）。
 *   source==="direct" 判定と期限判定は JS 側で行う。pending 直販予約は少数の想定。
 *
 * 送信元は resolveSenderGmail_(db, propertyId)（物件の Gmail 連携アドレス）。
 * 本文は booking-requests.js の確定メールと同じ文体・日英併記。
 */
const admin = require("firebase-admin");
const { sendNotificationEmail_, resolveSenderGmail_ } = require("../utils/lineNotify");

// Stripe の expiresAt は Unix 秒。JST 表記 "YYYY-MM-DD HH:mm" に変換する
// (booking-requests.js の確定メールと同じ簡易変換: UTC+9h して ISO 文字列を整形)
function toJstText_(expiresAtSec) {
  const d = new Date(Number(expiresAtSec) * 1000);
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16);
}

module.exports = async function paymentReminder() {
  const db = admin.firestore();
  const nowSec = Math.floor(Date.now() / 1000);
  const windowSec = 6 * 3600; // 6 時間以内

  console.log(`[paymentReminder] 起動 nowSec=${nowSec}`);

  try {
    // 未払い予約のみ取得（単一等値クエリ = 複合 index 不要）
    const snap = await db.collection("bookings")
      .where("paymentStatus", "==", "pending")
      .get();

    if (snap.empty) {
      console.log("[paymentReminder] pending 予約なし");
      return;
    }

    let sentTotal = 0;

    for (const doc of snap.docs) {
      const b = doc.data();
      const bookingId = doc.id;

      // 直販以外は対象外
      if (b.source !== "direct") continue;
      // 既にリマインド送信済み → スキップ（重複送信防止）
      if (b.paymentReminderSentAt) continue;

      const session = b.paymentSession || {};
      const expiresAt = Number(session.expiresAt);
      const payUrl = session.url;
      if (!Number.isFinite(expiresAt) || !payUrl) continue;

      // 期限が未経過、かつ 6 時間以内のもののみ対象
      //   expiresAt <= nowSec           → 既に期限切れ（対象外。webhook の expired が処理）
      //   expiresAt >  nowSec+windowSec → まだ 6 時間より先（対象外）
      if (expiresAt <= nowSec) continue;
      if (expiresAt > nowSec + windowSec) continue;

      const to = b.email;
      if (!to) {
        console.warn(`[paymentReminder] ${bookingId} メールアドレスなし、スキップ`);
        continue;
      }

      const propertyId = b.propertyId || "";
      const propertyName = b.propertyName || "";
      const guestName = b.guestName || "ゲスト";
      const jst = toJstText_(expiresAt);

      const subject = `【${propertyName || "ご予約"}】お支払い期限が近づいています / Payment reminder`;
      const bodyText = [
        `${guestName} 様`,
        ``,
        `ご予約のお支払いがまだ完了しておりません。`,
        `お支払い期限を過ぎますと、ご予約は自動的にキャンセルとなりますのでご注意ください。`,
        ``,
        `■ご予約内容`,
        `宿泊施設: ${propertyName}`,
        `チェックイン: ${b.checkIn || ""}`,
        `チェックアウト: ${b.checkOut || ""}`,
        `お支払い期限: ${jst} JST まで`,
        ``,
        `下記のお支払いページよりお手続きください：`,
        `${payUrl}`,
        ``,
        `※ お支払い期限までにご決済が確認できない場合、ご予約は自動的にキャンセルとなります。`,
        ``,
        `────────────────────`,
        ``,
        `Dear ${guestName},`,
        ``,
        `Your payment has not been completed yet.`,
        `If the payment is not received by the deadline, your reservation will be automatically cancelled.`,
        ``,
        `- Booking details`,
        `Property: ${propertyName}`,
        `Check-in: ${b.checkIn || ""}`,
        `Check-out: ${b.checkOut || ""}`,
        `Payment deadline: ${jst} (JST)`,
        ``,
        `Please complete your payment from the link below:`,
        `${payUrl}`,
        ``,
        `* If we cannot confirm your payment by the deadline, your reservation will be cancelled automatically.`,
      ].join("\n");

      try {
        const senderGmail = await resolveSenderGmail_(db, propertyId);
        await sendNotificationEmail_(to, subject, bodyText, senderGmail || null);
        // 送信成功時のみフラグを立てる（重複送信防止）
        await db.collection("bookings").doc(bookingId).update({
          paymentReminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        sentTotal++;
        console.log(`[paymentReminder] 送信: booking=${bookingId} 期限=${jst}JST`);
      } catch (e) {
        // 個別の送信失敗はバッチ全体を落とさない
        console.warn(`[paymentReminder] ${bookingId} 送信失敗:`, e.message);
      }
    }

    console.log(`[paymentReminder] 完了: ${sentTotal}件送信`);
  } catch (e) {
    console.error("[paymentReminder] エラー:", e);
    try {
      await db.collection("error_logs").add({
        functionName: "paymentReminder",
        error: e.message,
        stack: e.stack ? e.stack.slice(0, 500) : "",
        severity: "warning",
        createdAt: new Date(),
      });
    } catch (_) { /* 無視 */ }
  }
};
