/**
 * 有料駐車場 請求メール自動送信
 * 毎朝8:00 JST に実行
 *
 * 対象: paidParking が "1台利用" or "2台利用" で、
 *       parkingInvoiceSentAt が未設定、
 *       checkIn が 2日後以降（前日までに支払えるよう余裕を持って送信）
 *
 * 催促: checkIn 前日で parkingPaymentConfirmed が false → 催促メール
 */
const { sendNotificationEmail_ } = require("../utils/lineNotify");
const { renderTemplate, getTemplates } = require("../utils/emailTemplates");

module.exports = async function sendParkingInvoice() {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  // 今日の日付（JST）
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const todayDate = new Date(now.getTime() + jstOffset);
  const today = todayDate.toISOString().slice(0, 10);
  const tomorrow = new Date(todayDate.getTime() + 86400000).toISOString().slice(0, 10);

  // 設定取得
  const settingsDoc = await db.collection("settings").doc("guestForm").get();
  const settings = settingsDoc.exists ? settingsDoc.data() : {};
  const paymentSettings = settings.parkingPayment || {};
  const paypayId = paymentSettings.paypayId || "";
  const rakutenPayId = paymentSettings.rakutenPayId || "";
  const paypayNote = paymentSettings.paypayNote || "";
  const rakutenPayNote = paymentSettings.rakutenPayNote || "";

  if (!paypayId && !rakutenPayId) {
    console.warn("PayPay/楽天ペイのアカウント情報が未設定です（settings/guestForm.parkingPayment）");
    return;
  }

  console.log(`駐車場請求メール処理: ${today}`);

  // === 1. 新規請求メール送信 ===
  // checkIn が明後日以降 かつ parkingInvoiceSentAt が未設定
  const newInvoiceSnap = await db.collection("guestRegistrations")
    .where("status", "==", "confirmed")
    .get();

  let sentCount = 0, reminderCount = 0;

  for (const doc of newInvoiceSnap.docs) {
    const data = doc.data();
    const paidParking = data.paidParking || "";
    if (paidParking === "利用しない" || paidParking === "No thanks" || !paidParking) continue;

    const guestEmail = data.email;
    if (!guestEmail) continue;

    const checkIn = data.checkIn;
    if (!checkIn) continue;

    // 台数
    const paidCount = paidParking.includes("2") ? 2 : 1;
    // 泊数
    const checkOut = data.checkOut;
    if (!checkOut) continue;
    const nights = Math.max(1, Math.round(
      (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000
    ));
    const totalAmount = paidCount * nights * 2000;

    // 支払期限 = チェックイン前日
    const deadlineDate = new Date(new Date(checkIn).getTime() - 86400000);
    const deadline = deadlineDate.toISOString().slice(0, 10);

    // --- 新規請求 ---
    if (!data.parkingInvoiceSentAt && checkIn > today) {
      try {
        const vars = {
          guestName: data.guestName || "ゲスト",
          checkIn, checkOut,
          paidCount, nights, totalAmount: totalAmount.toLocaleString(),
          deadline,
          paypayId, rakutenPayId, paypayNote, rakutenPayNote,
        };

        const subject = `【駐車場料金のご案内】${vars.guestName}様 — ${totalAmount.toLocaleString()}円`;
        const body = buildParkingInvoiceBody(vars);

        await sendNotificationEmail_(guestEmail, subject, body);
        await doc.ref.update({
          parkingInvoiceSentAt: admin.firestore.FieldValue.serverTimestamp(),
          parkingAmount: totalAmount,
          parkingPaymentConfirmed: false,
        });
        console.log(`駐車場請求メール送信: ${guestEmail} (${totalAmount}円)`);
        sentCount++;
      } catch (e) {
        console.error(`駐車場請求メール送信失敗 (${guestEmail}):`, e.message);
      }
    }

    // --- 催促メール（チェックイン前日 & 未入金） ---
    if (data.parkingInvoiceSentAt && !data.parkingPaymentConfirmed && checkIn === tomorrow) {
      // 催促済みチェック
      if (data.parkingReminderSentAt) continue;

      try {
        const vars = {
          guestName: data.guestName || "ゲスト",
          checkIn, checkOut,
          paidCount, nights, totalAmount: totalAmount.toLocaleString(),
          deadline: today,
          paypayId, rakutenPayId, paypayNote, rakutenPayNote,
        };

        const subject = `【リマインド】駐車場料金のお支払いについて — ${vars.guestName}様`;
        const body = buildParkingReminderBody(vars);

        await sendNotificationEmail_(guestEmail, subject, body);
        await doc.ref.update({
          parkingReminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`駐車場催促メール送信: ${guestEmail}`);
        reminderCount++;
      } catch (e) {
        console.error(`駐車場催促メール送信失敗 (${guestEmail}):`, e.message);
      }
    }
  }

  console.log(`駐車場請求処理完了: 新規${sentCount}件, 催促${reminderCount}件`);
};

// 請求メール本文
function buildParkingInvoiceBody(v) {
  let body = `${v.guestName} 様\n\nご宿泊のご予約ありがとうございます。\n有料駐車場のご利用料金についてご案内いたします。\n\n`;
  body += `━━━━━━━━━━━━━━━━━━━━\n`;
  body += `【有料駐車場 ご利用料金】\n`;
  body += `  台数: ${v.paidCount}台\n`;
  body += `  泊数: ${v.nights}泊\n`;
  body += `  料金: 2,000円 × ${v.paidCount}台 × ${v.nights}泊 = ${v.totalAmount}円\n`;
  body += `  お支払い期限: ${v.deadline}（チェックイン前日）\n`;
  body += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  body += `【お支払い方法】\n`;
  body += `以下のいずれかの方法でお支払いください。\n\n`;
  if (v.paypayId) {
    body += `■ PayPay\n`;
    body += `  送金先: ${v.paypayId}\n`;
    if (v.paypayNote) body += `  ${v.paypayNote}\n`;
    body += `\n`;
  }
  if (v.rakutenPayId) {
    body += `■ 楽天ペイ\n`;
    body += `  送金先: ${v.rakutenPayId}\n`;
    if (v.rakutenPayNote) body += `  ${v.rakutenPayNote}\n`;
    body += `\n`;
  }
  body += `送金時、メッセージ欄に「お名前」と「チェックイン日（${v.checkIn}）」をご記入ください。\n\n`;
  body += `ご不明な点がございましたらお気軽にご連絡ください。\n`;
  body += `ご宿泊を楽しみにお待ちしております。\n`;
  return body;
}

// 催促メール本文
function buildParkingReminderBody(v) {
  let body = `${v.guestName} 様\n\nいつもありがとうございます。\n有料駐車場のご利用料金について、お支払いの確認ができておりません。\n\n`;
  body += `明日がチェックイン日のため、本日中のお支払いをお願いいたします。\n\n`;
  body += `━━━━━━━━━━━━━━━━━━━━\n`;
  body += `  料金: ${v.totalAmount}円（${v.paidCount}台 × ${v.nights}泊）\n`;
  body += `  お支払い期限: 本日中\n`;
  body += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  body += `【お支払い方法】\n`;
  if (v.paypayId) body += `■ PayPay: ${v.paypayId}\n`;
  if (v.rakutenPayId) body += `■ 楽天ペイ: ${v.rakutenPayId}\n`;
  body += `\n送金時、メッセージ欄に「お名前」と「チェックイン日（${v.checkIn}）」をご記入ください。\n\n`;
  body += `既にお支払い済みの場合は、本メールをお見逃しください。\n`;
  body += `ご不明な点がございましたらお気軽にご連絡ください。\n`;
  return body;
}
