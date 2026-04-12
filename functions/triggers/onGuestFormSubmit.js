/**
 * 宿泊者名簿受信トリガー
 * source=guest_form の場合:
 *   1. editToken生成・ステータス設定
 *   2. オーナーにメール（入力内容全文）
 *   3. 宿泊者にメール（入力内容全文 + 修正リンク）
 *   4. LINE通知（既存）
 */
const crypto = require("crypto");
const { notifyOwner, sendNotificationEmail_ } = require("../utils/lineNotify");
const { renderTemplate, buildGuestSummaryText, getTemplates } = require("../utils/emailTemplates");

const APP_URL = "https://minpaku-v2.web.app";

module.exports = async function onGuestFormSubmit(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  const data = event.data?.data();
  if (!data) return;

  // 公開フォームからの投稿のみ処理
  if (data.source !== "guest_form") return;

  const docRef = event.data.ref;
  const guestId = event.params?.guestId || docRef.id;

  // === 1. editToken生成・ステータス設定 ===
  const editToken = crypto.randomBytes(32).toString("hex");
  await docRef.update({
    editToken,
    status: "submitted",
  });

  const guestName = data.guestName || "名前不明";
  const checkIn = data.checkIn || "?";
  const checkOut = data.checkOut || "?";
  const guestCount = data.guestCount || "?";
  const guestEmail = data.email || "";

  // === 2. メール送信 ===
  const summary = buildGuestSummaryText(data);
  const editUrl = `${APP_URL}/guest-form.html?edit=${editToken}`;
  const confirmUrl = `${APP_URL}/#/guests`;

  const templates = await getTemplates(db);
  const vars = {
    guestName, checkIn, checkOut, guestCount,
    checkInTime: data.checkInTime || "",
    checkOutTime: data.checkOutTime || "",
    nationality: data.nationality || "日本",
    summary, editUrl, confirmUrl,
  };

  // 2a. オーナーへのメール
  try {
    const ownerSubject = renderTemplate(templates.ownerNotification.subject, vars);
    const ownerBody = renderTemplate(templates.ownerNotification.body, vars);

    // settings/notifications の notifyEmails に送信
    const notifDoc = await db.collection("settings").doc("notifications").get();
    const notifyEmails = notifDoc.exists ? (notifDoc.data().notifyEmails || []) : [];
    for (const email of notifyEmails) {
      try {
        await sendNotificationEmail_(email, ownerSubject, ownerBody);
        console.log(`オーナーメール送信成功: ${email}`);
      } catch (e) {
        console.error(`オーナーメール送信失敗 (${email}):`, e.message);
      }
    }
  } catch (e) {
    console.error("オーナーメール処理エラー:", e.message);
  }

  // 2b. 宿泊者へのメール
  if (guestEmail) {
    try {
      const guestSubject = renderTemplate(templates.guestConfirmation.subject, vars);
      const guestBody = renderTemplate(templates.guestConfirmation.body, vars);
      await sendNotificationEmail_(guestEmail, guestSubject, guestBody);
      console.log(`宿泊者メール送信成功: ${guestEmail}`);
    } catch (e) {
      console.error(`宿泊者メール送信失敗 (${guestEmail}):`, e.message);
    }
  } else {
    console.warn("宿泊者のメールアドレスが未入力のためメール送信スキップ");
  }

  // === 3. LINE通知（既存） ===
  let lineText = `📝 宿泊者名簿が届きました\n\n`;
  lineText += `代表者: ${guestName}\n`;
  lineText += `国籍: ${data.nationality || "日本"}\n`;
  lineText += `CI: ${checkIn} → CO: ${checkOut}\n`;
  lineText += `人数: ${guestCount}名\n`;

  if (data.bbq && data.bbq !== "No" && data.bbq !== "なし" && data.bbq !== "利用しない") {
    lineText += `BBQ: ${data.bbq}\n`;
  }
  if (data.transport === "車" || data.transport === "Car") {
    lineText += `車: ${data.carCount || "?"}台\n`;
    if (data.paidParking && data.paidParking !== "利用しない") {
      lineText += `有料駐車場: ${data.paidParking}\n`;
    }
  }

  await notifyOwner(db, "guest_form", `名簿受信: ${guestName}`, lineText);
};
