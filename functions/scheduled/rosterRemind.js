/**
 * 名簿未入力リマインド（毎朝9:00 JST）
 * 今日以降の confirmed 予約で宿泊者名簿が未提出の予約ごとにWebアプリ管理者LINE通知
 * 同日・同予約への重複送信を bookings.rosterRemindSentDate で防止
 */
const admin = require("firebase-admin");
const {
  notifyByKey,
  getNotificationSettings_,
} = require("../utils/lineNotify");

const APP_URL = "https://minpaku-v2.web.app";
const NOTIFY_TYPE = "roster_remind";

module.exports = async function rosterRemind(event) {
  const db = admin.firestore();

  try {
    const { settings } = await getNotificationSettings_(db);

    // 今日の日付（YYYY-MM-DD）
    const today = new Date().toISOString().slice(0, 10);

    // 今日以降のチェックイン予約（今日チェックインも対象）を取得
    // checkIn >= today で当日も含める
    const bookingsSnap = await db.collection("bookings")
      .where("status", "==", "confirmed")
      .where("checkIn", ">=", today)
      .get();

    if (bookingsSnap.empty) {
      console.log("名簿リマインド: 対象予約なし");
      return;
    }

    // 名簿未提出 かつ 今日まだ未送信のもののみフィルタ
    const targets = bookingsSnap.docs.filter(d => {
      const data = d.data();
      if (data.rosterStatus === "submitted") return false;
      // 今日すでにリマインドを送った予約はスキップ（重複送信防止）
      if (data.rosterRemindSentDate === today) return false;
      return true;
    });

    if (targets.length === 0) {
      console.log("名簿リマインド: 全予約の名簿提出済みまたは本日送信済み");
      return;
    }

    console.log(`名簿リマインド: ${targets.length}件対象`);

    let sentCount = 0;

    for (const doc of targets) {
      const b = doc.data();
      const bookingId = doc.id;

      // 物件別オーバーライド取得
      const propDoc = b.propertyId
        ? await db.collection("properties").doc(b.propertyId).get()
        : null;

      const propertyName = b.propertyName || (propDoc?.exists ? propDoc.data().name : "") || b.propertyId || "";
      const guestName = b.guestName || "名前未設定";
      const checkin = b.checkIn || "";
      const formUrl = b.propertyId
        ? `${APP_URL}/form/?propertyId=${b.propertyId}`
        : `${APP_URL}/form/`;

      const vars = {
        date: checkin,
        checkin,
        property: propertyName,
        guest: guestName,
        url: formUrl,
      };

      const defaultMsg = [
        `📋 名簿未提出リマインド`,
        ``,
        `物件: ${propertyName}`,
        `ゲスト: ${guestName}`,
        `チェックイン: ${checkin}`,
        ``,
        `宿泊者名簿がまだ提出されていません。`,
        `フォームURL: ${formUrl}`,
      ].join("\n");

      const title = `名簿未提出: ${guestName} (${checkin})`;

      // notifyByKey でチャネル別 (owner/group/staff/email/discord) に発射
      const result = await notifyByKey(db, NOTIFY_TYPE, {
        title,
        body: defaultMsg,
        vars,
        propertyId: b.propertyId || null,
      });
      const anySuccess = Object.values(result.sent || {}).some(v => v && v !== 0);

      if (anySuccess) {
        sentCount++;
        // 今日の日付を記録して同日の重複送信を防止
        try {
          await db.collection("bookings").doc(bookingId).update({
            rosterRemindSentDate: today,
          });
        } catch (updateErr) {
          console.warn(`名簿リマインド: 送信日記録失敗 (${bookingId}):`, updateErr.message);
        }
      }
    }

    console.log(`名簿リマインド完了: ${sentCount}/${targets.length}件送信`);
  } catch (e) {
    console.error("名簿リマインドエラー:", e);
    try {
      const db2 = admin.firestore();
      await db2.collection("error_logs").add({
        functionName: "rosterRemind",
        error: e.message,
        stack: e.stack?.slice(0, 500),
        severity: "warning",
        createdAt: new Date(),
      });
    } catch (logErr) { /* 無視 */ }
  }
};
