/**
 * 宿泊者名簿受信トリガー
 * source=guest_form の場合 → 「名簿が届きました」通知
 */
const { notifyOwner } = require("../utils/lineNotify");

module.exports = async function onGuestFormSubmit(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  const data = event.data?.data();
  if (!data) return;

  // 公開フォームからの投稿のみ通知
  if (data.source !== "guest_form") return;

  const guestName = data.guestName || "名前不明";
  const checkIn = data.checkIn || "?";
  const checkOut = data.checkOut || "?";
  const guestCount = data.guestCount || "?";
  const nationality = data.nationality || "日本";

  let text = `📝 宿泊者名簿が届きました\n\n`;
  text += `代表者: ${guestName}\n`;
  text += `国籍: ${nationality}\n`;
  text += `CI: ${checkIn} → CO: ${checkOut}\n`;
  text += `人数: ${guestCount}名\n`;

  if (data.bbq && data.bbq !== "No" && data.bbq !== "なし") {
    text += `BBQ: ${data.bbq}\n`;
  }
  if (data.parking && data.parking !== "利用しない") {
    text += `駐車場: ${data.parking}\n`;
  }

  await notifyOwner(db, "guest_form", `名簿受信: ${guestName}`, text);
};
