/**
 * 直前予約リマインド（毎朝10:00 JST）
 * 今日 or 明日 checkIn の confirmed 予約で名簿未提出の場合にWebアプリ管理者へ緊急通知
 */
const admin = require("firebase-admin");
const {
  notifyOwner,
  notifyGroup,
  notifyByKey,
  resolveNotifyTargets,
  getNotificationSettings_,
} = require("../utils/lineNotify");

const APP_URL = "https://minpaku-v2.web.app";
const NOTIFY_TYPE = "urgent_remind";

module.exports = async function urgentRemind(event) {
  const db = admin.firestore();

  try {
    const { settings } = await getNotificationSettings_(db);

    // 今日・明日の日付を計算
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const tomorrowDate = new Date(now);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);

    // 今日 or 明日チェックインの confirmed 予約を取得
    const [todaySnap, tomorrowSnap] = await Promise.all([
      db.collection("bookings")
        .where("status", "==", "confirmed")
        .where("checkIn", "==", todayStr)
        .get(),
      db.collection("bookings")
        .where("status", "==", "confirmed")
        .where("checkIn", "==", tomorrowStr)
        .get(),
    ]);

    const allDocs = [...todaySnap.docs, ...tomorrowSnap.docs];

    // 名簿未提出のみフィルタ
    const targets = allDocs.filter(d => d.data().rosterStatus !== "submitted");

    if (targets.length === 0) {
      console.log("緊急リマインド: 対象予約なし（今日・明日の名簿は全提出済み）");
      return;
    }

    console.log(`緊急リマインド: ${targets.length}件対象`);

    let sentCount = 0;

    for (const doc of targets) {
      const b = doc.data();

      // 物件別オーバーライド取得
      const propDoc = b.propertyId
        ? await db.collection("properties").doc(b.propertyId).get()
        : null;
      const overrides = propDoc?.exists ? (propDoc.data().channelOverrides || {}) : {};

      const propertyName = b.propertyName || (propDoc?.exists ? propDoc.data().name : "") || b.propertyId || "";
      const guestName = b.guestName || "名前未設定";
      const checkin = b.checkIn || "";
      const isToday = checkin === todayStr;
      const urgencyLabel = isToday ? "【本日チェックイン】" : "【明日チェックイン】";
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
        `🚨 ${urgencyLabel} 名簿未提出 緊急リマインド`,
        ``,
        `物件: ${propertyName}`,
        `ゲスト: ${guestName}`,
        `チェックイン: ${checkin}`,
        ``,
        `名簿がまだ提出されていません。至急対応が必要です。`,
        `フォームURL: ${formUrl}`,
      ].join("\n");

      const title = `【緊急】名簿未提出: ${guestName} (${checkin})`;

      // notifyByKey でチャネル別 (owner/group/staff/email/discord) に発射
      const result = await notifyByKey(db, NOTIFY_TYPE, {
        title,
        body: defaultMsg,
        vars,
        propertyId: b.propertyId || null,
      });
      const anySuccess = Object.values(result.sent || {}).some(v => v && v !== 0);
      if (anySuccess) sentCount++;
    }

    console.log(`緊急リマインド完了: ${sentCount}/${targets.length}件送信`);
  } catch (e) {
    console.error("緊急リマインドエラー:", e);
    try {
      const db2 = admin.firestore();
      await db2.collection("error_logs").add({
        functionName: "urgentRemind",
        error: e.message,
        stack: e.stack?.slice(0, 500),
        severity: "warning",
        createdAt: new Date(),
      });
    } catch (logErr) { /* 無視 */ }
  }
};
