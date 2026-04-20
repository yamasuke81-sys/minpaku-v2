/**
 * 名簿未入力リマインド（毎朝9:00 JST）
 * 今日より未来の confirmed 予約で宿泊者名簿が未提出の予約ごとにオーナーLINE通知
 */
const admin = require("firebase-admin");
const {
  notifyOwner,
  notifyGroup,
  resolveNotifyTargets,
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

    // 今日より未来の confirmed 予約を取得
    const bookingsSnap = await db.collection("bookings")
      .where("status", "==", "confirmed")
      .where("checkIn", ">", today)
      .get();

    if (bookingsSnap.empty) {
      console.log("名簿リマインド: 対象予約なし");
      return;
    }

    // 名簿未提出のみフィルタ
    const targets = bookingsSnap.docs.filter(d => {
      const data = d.data();
      return data.rosterStatus !== "submitted";
    });

    if (targets.length === 0) {
      console.log("名簿リマインド: 全予約の名簿提出済み");
      return;
    }

    console.log(`名簿リマインド: ${targets.length}件対象`);

    let sentCount = 0;

    for (const doc of targets) {
      const b = doc.data();

      // 物件別オーバーライド取得
      const propDoc = b.propertyId
        ? await db.collection("properties").doc(b.propertyId).get()
        : null;
      const overrides = propDoc?.exists ? (propDoc.data().channelOverrides || {}) : {};

      const tgt = resolveNotifyTargets(settings, NOTIFY_TYPE, overrides);
      if (!tgt.enabled) continue;

      const propertyName = b.propertyName || b.propertyId || "";
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

      const results = [];
      if (tgt.ownerLine) {
        const r = await notifyOwner(db, NOTIFY_TYPE, title, defaultMsg, vars, overrides);
        results.push(r);
      }
      if (tgt.groupLine) {
        const r = await notifyGroup(db, NOTIFY_TYPE, title, defaultMsg, vars, overrides);
        results.push(r);
      }

      const anySuccess = results.some(r => r?.success);
      if (anySuccess) sentCount++;
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
