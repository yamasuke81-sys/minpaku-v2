/**
 * チェックイン当日朝 — キーボックス番号メール送信
 * 毎朝7:00 JST に実行
 * checkIn == 今日 && status == confirmed && keyboxEmailSentAt == null の名簿に送信
 */
const { sendNotificationEmail_ } = require("../utils/lineNotify");
const { renderTemplate, getTemplates } = require("../utils/emailTemplates");

module.exports = async function sendKeyboxEmail() {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  // 今日の日付（JST）
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const today = new Date(now.getTime() + jstOffset).toISOString().slice(0, 10);

  console.log(`キーボックスメール送信チェック: ${today}`);

  // キーボックス番号を取得
  const settingsDoc = await db.collection("settings").doc("guestForm").get();
  const keyboxNumber = settingsDoc.exists ? settingsDoc.data().keyboxNumber : null;
  if (!keyboxNumber) {
    console.warn("キーボックス番号が未設定です（settings/guestForm.keyboxNumber）");
    return;
  }

  // 対象の名簿を検索
  const snap = await db.collection("guestRegistrations")
    .where("checkIn", "==", today)
    .where("status", "==", "confirmed")
    .get();

  if (snap.empty) {
    console.log("本日チェックインの確認済み名簿なし");
    return;
  }

  const templates = await getTemplates(db);
  let sentCount = 0;
  let skipCount = 0;

  for (const doc of snap.docs) {
    const data = doc.data();

    // 送信済みスキップ
    if (data.keyboxEmailSentAt) {
      skipCount++;
      continue;
    }

    const guestEmail = data.email;
    if (!guestEmail) {
      console.warn(`メールアドレスなし（${data.guestName || doc.id}）— スキップ`);
      skipCount++;
      continue;
    }

    const vars = {
      guestName: data.guestName || "ゲスト",
      checkIn: data.checkIn || today,
      checkOut: data.checkOut || "?",
      checkInTime: data.checkInTime || "",
      checkOutTime: data.checkOutTime || "",
      keyboxNumber,
    };

    try {
      const subject = renderTemplate(templates.keyboxDelivery.subject, vars);
      const body = renderTemplate(templates.keyboxDelivery.body, vars);
      await sendNotificationEmail_(guestEmail, subject, body);

      // 送信済みフラグ
      await doc.ref.update({
        keyboxEmailSentAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`キーボックスメール送信成功: ${guestEmail} (${data.guestName})`);
      sentCount++;
    } catch (e) {
      console.error(`キーボックスメール送信失敗 (${guestEmail}):`, e.message);
    }
  }

  console.log(`キーボックスメール完了: 送信${sentCount}件, スキップ${skipCount}件`);
};
