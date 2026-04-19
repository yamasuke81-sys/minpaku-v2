/**
 * キーボックス番号メール送信（前日 + 当日）
 * 毎朝7:00 JST に実行
 *
 * 対象条件:
 *   - checkIn == 今日 または checkIn == 明日
 *   - status in ["submitted", "confirmed"]
 *   - keyboxEmailSentAt が当日でない（重複防止）
 *
 * キーボックス番号の優先順位:
 *   1. properties/{propertyId}.keyboxNumber
 *   2. settings/guestForm.keyboxNumber（フォールバック）
 */
const { sendNotificationEmail_ } = require("../utils/lineNotify");
const { renderTemplate, getTemplates } = require("../utils/emailTemplates");

module.exports = async function sendKeyboxEmail() {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  // 今日・明日の日付（JST）
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const todayDate = new Date(now.getTime() + jstOffset);
  const today = todayDate.toISOString().slice(0, 10);
  const tomorrowDate = new Date(todayDate.getTime() + 24 * 60 * 60 * 1000);
  const tomorrow = tomorrowDate.toISOString().slice(0, 10);

  console.log(`キーボックスメール送信チェック: 今日=${today}, 明日=${tomorrow}`);

  // グローバルフォールバック用キーボックス番号を取得
  const settingsDoc = await db.collection("settings").doc("guestForm").get();
  const globalKeyboxNumber = settingsDoc.exists ? settingsDoc.data().keyboxNumber : null;

  // 物件ごとのキーボックス番号をキャッシュ
  const propertyKeyboxCache = {};
  async function getKeyboxNumber(propertyId) {
    if (!propertyId) return globalKeyboxNumber;
    if (propertyKeyboxCache[propertyId] !== undefined) return propertyKeyboxCache[propertyId];
    try {
      const propDoc = await db.collection("properties").doc(propertyId).get();
      const num = propDoc.exists ? (propDoc.data().keyboxNumber || null) : null;
      // 物件に設定がなければグローバルフォールバック
      propertyKeyboxCache[propertyId] = num || globalKeyboxNumber;
    } catch (e) {
      console.warn(`物件キーボックス番号取得失敗 (${propertyId}):`, e.message);
      propertyKeyboxCache[propertyId] = globalKeyboxNumber;
    }
    return propertyKeyboxCache[propertyId];
  }

  // 今日・明日チェックインの名簿を取得
  const [snapToday, snapTomorrow] = await Promise.all([
    db.collection("guestRegistrations")
      .where("checkIn", "==", today)
      .where("status", "in", ["submitted", "confirmed"])
      .get(),
    db.collection("guestRegistrations")
      .where("checkIn", "==", tomorrow)
      .where("status", "in", ["submitted", "confirmed"])
      .get(),
  ]);

  const allDocs = [...snapToday.docs, ...snapTomorrow.docs];
  if (allDocs.length === 0) {
    console.log("送信対象の名簿なし（今日・明日チェックイン、submitted/confirmed）");
    return;
  }

  const templates = await getTemplates(db);
  let sentCount = 0;
  let skipCount = 0;
  const ownerAlertDocs = []; // submitted 状態のゲスト（オーナー確認促進）

  for (const doc of allDocs) {
    const data = doc.data();

    // 重複送信防止: keyboxEmailSentAt が当日なら skip
    if (data.keyboxEmailSentAt) {
      const sentAt = data.keyboxEmailSentAt.toDate
        ? data.keyboxEmailSentAt.toDate()
        : new Date(data.keyboxEmailSentAt);
      const sentDay = new Date(sentAt.getTime() + jstOffset).toISOString().slice(0, 10);
      if (sentDay === today) {
        skipCount++;
        continue;
      }
    }

    const guestEmail = data.email;
    if (!guestEmail) {
      console.warn(`メールアドレスなし（${data.guestName || doc.id}）— スキップ`);
      skipCount++;
      continue;
    }

    // 物件別キーボックス番号を取得
    const keyboxNumber = await getKeyboxNumber(data.propertyId || "");
    if (!keyboxNumber) {
      console.warn(`キーボックス番号未設定（物件: ${data.propertyId || "未指定"}, ゲスト: ${data.guestName}）— スキップ`);
      skipCount++;
      continue;
    }

    // submitted 状態はオーナー確認用リストに追加
    if (data.status === "submitted") {
      ownerAlertDocs.push({ id: doc.id, data });
    }

    const isEve = data.checkIn === tomorrow; // 前日送信かどうか
    const vars = {
      guestName: data.guestName || "ゲスト",
      checkIn: data.checkIn || today,
      checkOut: data.checkOut || "?",
      checkInTime: data.checkInTime || "",
      checkOutTime: data.checkOutTime || "",
      keyboxNumber,
    };

    try {
      let subject = renderTemplate(templates.keyboxDelivery.subject, vars);
      let body = renderTemplate(templates.keyboxDelivery.body, vars);

      // 前日送信の場合はタイトルに「明日のご案内」を付加
      if (isEve) {
        subject = `【明日のご案内】${subject}`;
      }

      await sendNotificationEmail_(guestEmail, subject, body);

      // 送信済みフラグ
      await doc.ref.update({
        keyboxEmailSentAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`キーボックスメール送信成功: ${guestEmail} (${data.guestName}, checkIn=${data.checkIn}, status=${data.status})`);
      sentCount++;
    } catch (e) {
      console.error(`キーボックスメール送信失敗 (${guestEmail}):`, e.message);
    }
  }

  // submitted 状態のゲストがいた場合、オーナーに確認メールを送信
  if (ownerAlertDocs.length > 0) {
    try {
      const notifDoc = await db.collection("settings").doc("notifications").get();
      const notifyEmails = notifDoc.exists ? (notifDoc.data().notifyEmails || []) : [];
      if (notifyEmails.length > 0) {
        const guestList = ownerAlertDocs
          .map(({ data: d }) => `・${d.guestName || "名前不明"} (checkIn: ${d.checkIn})`)
          .join("\n");
        const alertSubject = `【要確認】未確認ゲストにキーボックスメールを送信しました`;
        const alertBody = `以下のゲストは名簿が「submitted（提出済み・未確認）」の状態ですが、チェックイン日が迫っているためキーボックスメールを送信しました。\n\nご確認をお願いします。\n\n${guestList}\n\n名簿確認: https://minpaku-v2.web.app/#/guests`;
        for (const email of notifyEmails) {
          try {
            await sendNotificationEmail_(email, alertSubject, alertBody);
          } catch (e) {
            console.error(`オーナー確認メール送信失敗 (${email}):`, e.message);
          }
        }
      }
    } catch (e) {
      console.error("オーナー確認メール処理エラー:", e.message);
    }
  }

  console.log(`キーボックスメール完了: 送信${sentCount}件, スキップ${skipCount}件, オーナー要確認${ownerAlertDocs.length}件`);
};
