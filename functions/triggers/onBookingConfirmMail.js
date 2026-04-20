/**
 * 予約確認メール送信トリガー（bookings 新規作成時）
 * confirmed かつ email あり → ゲストに宿泊者名簿フォームURLを含む確認メールを送信
 */
const {
  sendNotificationEmail_,
  resolveNotifyTargets,
  getNotificationSettings_,
} = require("../utils/lineNotify");

const APP_URL = "https://minpaku-v2.web.app";
const NOTIFY_TYPE = "booking_confirm_mail";

module.exports = async function onBookingConfirmMail(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  try {
    const b = event.data?.data();
    if (!b) return;

    // confirmed かつ email ありのみ対象
    if (b.status !== "confirmed" || !b.email) {
      console.log(`予約確認メール: スキップ (status=${b.status}, email=${b.email || "なし"})`);
      return;
    }

    // 通知設定確認
    const { settings } = await getNotificationSettings_(db);

    const propDoc = b.propertyId
      ? await db.collection("properties").doc(b.propertyId).get()
      : null;
    const overrides = propDoc?.exists ? (propDoc.data().channelOverrides || {}) : {};

    const tgt = resolveNotifyTargets(settings, NOTIFY_TYPE, overrides);
    if (!tgt.enabled) {
      console.log("予約確認メール通知: 無効化されています");
      return;
    }

    const guestName = b.guestName || "ゲスト";
    const checkIn = b.checkIn || "";
    const checkOut = b.checkOut || "";
    const propertyName = b.propertyName || b.propertyId || "";
    const formUrl = b.propertyId
      ? `${APP_URL}/form/?propertyId=${b.propertyId}`
      : `${APP_URL}/form/`;

    // customMessage 取得（設定があれば優先）
    const propOv = overrides[NOTIFY_TYPE] || {};
    const globalCh = (settings?.channels || {})[NOTIFY_TYPE] || {};
    const customMessage = propOv.customMessage !== undefined
      ? propOv.customMessage
      : globalCh.customMessage;

    let body;
    if (customMessage && String(customMessage).trim()) {
      body = String(customMessage).replace(/\{(\w+)\}/g, (_, k) => {
        const vars = { guest: guestName, checkin: checkIn, checkout: checkOut, property: propertyName, url: formUrl };
        return String(vars[k] ?? "");
      });
    } else {
      body = [
        `${guestName} 様`,
        ``,
        `この度はご予約いただきありがとうございます。`,
        ``,
        `■ご予約内容`,
        `物件: ${propertyName}`,
        `チェックイン: ${checkIn}`,
        `チェックアウト: ${checkOut}`,
        ``,
        `■宿泊者名簿のご提出をお願いします`,
        `チェックインまでに下記フォームよりご記入ください。`,
        `${formUrl}`,
        ``,
        `ご不明な点がございましたらお気軽にお問い合わせください。`,
        `よろしくお願いいたします。`,
      ].join("\n");
    }

    const subject = `ご予約確認: ${checkIn} チェックイン (${propertyName})`;

    await sendNotificationEmail_(b.email, subject, body);
    console.log(`予約確認メール送信成功: ${b.email} (checkIn: ${checkIn})`);

    // 通知ログ記録
    try {
      await db.collection("notifications").add({
        type: NOTIFY_TYPE,
        title: subject,
        body: body.slice(0, 1000),
        bookingId: event.params?.bookingId || null,
        to: b.email,
        sentAt: new Date(),
        channel: "email",
        success: true,
      });
    } catch (logErr) {
      console.error("通知ログ記録エラー:", logErr);
    }
  } catch (e) {
    console.error("予約確認メール送信エラー:", e);
    try {
      const db2 = admin.firestore();
      await db2.collection("error_logs").add({
        functionName: "onBookingConfirmMail",
        error: e.message,
        stack: e.stack?.slice(0, 500),
        severity: "warning",
        createdAt: new Date(),
      });
    } catch (logErr) { /* 無視 */ }
  }
};
