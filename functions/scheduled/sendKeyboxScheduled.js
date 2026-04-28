/**
 * キーボックス情報スケジュール送信 (毎時実行)
 *
 * 対象: guestRegistrations で keyboxSentAt が未設定かつ送信条件を満たすもの
 *
 * 送信モード:
 *   after_ok_click  : keyboxConfirmedAt がセット済みの場合のみ送信対象
 *   scheduled_date  : keyboxConfirmedAt 不要、設定された日時で送信
 *
 * 送信タイミング計算:
 *   scheduleType: day_of / day_before / 2_days_before / custom → checkIn からN日前 + sendTime
 *   現在時刻 ±30分 の範囲に入ったら送信
 *
 * keybox_remind 警告:
 *   mode=after_ok_click かつ送信予定時刻 -1時間 以内なのに keyboxConfirmedAt が未設定の場合、
 *   notifyByKey("keybox_remind") で管理者に警告
 */
const { notifyByKey, sendNotificationEmail_ } = require("../utils/lineNotify");

module.exports = async function sendKeyboxScheduled() {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const nowJst = new Date(now.getTime() + jstOffset);
  const todayStr = nowJst.toISOString().slice(0, 10); // "YYYY-MM-DD"

  console.log(`sendKeyboxScheduled 開始: ${nowJst.toISOString()}`);

  // 今後14日以内のチェックイン予定の名簿を取得
  const futureLimit = new Date(nowJst.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const snap = await db.collection("guestRegistrations")
    .where("checkIn", ">=", todayStr)
    .where("checkIn", "<=", futureLimit)
    .where("status", "in", ["submitted", "confirmed"])
    .get();

  if (snap.empty) {
    console.log("送信対象の名簿なし");
    return;
  }

  // 物件設定キャッシュ
  const propCache = {};
  async function getPropData(propertyId) {
    if (!propertyId) return null;
    if (propCache[propertyId] !== undefined) return propCache[propertyId];
    try {
      const p = await db.collection("properties").doc(propertyId).get();
      propCache[propertyId] = p.exists ? p.data() : null;
    } catch (_) { propCache[propertyId] = null; }
    return propCache[propertyId];
  }

  let sentCount = 0;
  let remindCount = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const guestId = doc.id;

    // 既に送信済みならスキップ
    if (data.keyboxSentAt) continue;

    const propertyId = data.propertyId || "";
    const prop = await getPropData(propertyId);
    if (!prop) continue;

    const keyboxSend = prop.keyboxSend || {};
    // keyboxSend.enabled が false ならスキップ
    if (!keyboxSend.enabled) continue;

    const mode = keyboxSend.mode || "after_ok_click";
    const scheduleType = keyboxSend.scheduleType || "day_before";
    const sendTime = keyboxSend.sendTime || "15:00";
    const customDaysBefore = Number(keyboxSend.customDaysBefore) || 3;

    // 送信予定日計算
    const checkInDate = new Date(data.checkIn + "T00:00:00.000Z");
    let daysBefore = 0;
    if (scheduleType === "day_before") daysBefore = 1;
    else if (scheduleType === "2_days_before") daysBefore = 2;
    else if (scheduleType === "custom") daysBefore = customDaysBefore;
    // day_of は 0

    const sendDate = new Date(checkInDate.getTime() - daysBefore * 24 * 60 * 60 * 1000);
    const [hh, mm] = sendTime.split(":").map(Number);
    // 送信予定時刻 (JST) を UTC に変換
    const scheduledAtUtc = new Date(sendDate.getTime() + hh * 3600000 + mm * 60000 - jstOffset);

    const diffMs = scheduledAtUtc.getTime() - now.getTime();
    const diffMinutes = diffMs / 60000;

    // ±30分の送信ウィンドウ
    const inSendWindow = diffMinutes >= -30 && diffMinutes <= 30;

    // keybox_remind 判定: 送信1時間前以内なのにOKボタン未押下
    const isRemindWindow = diffMinutes >= -60 && diffMinutes <= 60;
    if (mode === "after_ok_click" && isRemindWindow && !data.keyboxConfirmedAt) {
      try {
        await notifyByKey(db, "keybox_remind", {
          title: `キーボックス未確認: ${data.guestName || guestId}`,
          body: `OKボタンが未押下のためキーボックス情報の送信がスケジュールされていません。\n\nゲスト: ${data.guestName || "?"}\nCI: ${data.checkIn || "?"}`,
          vars: {
            guest: data.guestName || "?",
            checkin: data.checkIn || "?",
            url: `https://minpaku-v2.web.app/#/guests?id=${encodeURIComponent(guestId)}`,
          },
          propertyId,
        });
        console.log(`keybox_remind 送信: guestId=${guestId}`);
        remindCount++;
      } catch (e) {
        console.error(`keybox_remind 送信失敗 (${guestId}):`, e.message);
      }
      continue; // 送信は行わない
    }

    if (!inSendWindow) continue;

    // モード判定
    if (mode === "after_ok_click" && !data.keyboxConfirmedAt) {
      // OKボタン未押下 → 送信しない (remind は上で処理済み)
      continue;
    }

    // メールアドレス確認
    const guestEmail = data.email || "";
    if (!guestEmail) {
      console.warn(`メールアドレスなし: guestId=${guestId}, guestName=${data.guestName}`);
      continue;
    }

    // テンプレート変数を埋める
    const vars = {
      guestName: data.guestName || "ゲスト",
      propertyName: prop.name || "",
      keyboxCode: prop.keyboxCode || prop.keyboxNumber || "",
      keyboxLocation: prop.keyboxLocation || "",
      checkIn: data.checkIn || "?",
      wifiInfo: prop.wifiInfo || "",
      propertyAddress: prop.address || "",
    };

    // テンプレート未設定時はデフォルト
    const DEFAULT_SUBJECT = "【{{propertyName}}】チェックイン情報のご案内";
    const DEFAULT_BODY = [
      "{{guestName}} 様",
      "",
      "ご予約ありがとうございます。{{propertyName}} のキーボックス情報をお送りします。",
      "",
      "■ チェックイン情報",
      "日時: {{checkIn}}",
      "",
      "■ キーボックス",
      "暗証番号: {{keyboxCode}}",
      "場所: {{keyboxLocation}}",
      "",
      "■ 施設のご案内",
      "Wi-Fi: {{wifiInfo}}",
      "住所: {{propertyAddress}}",
      "",
      "ご不明な点がございましたら、本メールにご返信ください。",
      "どうぞよろしくお願いいたします。",
    ].join("\n");

    const subjectTmpl = keyboxSend.subject || DEFAULT_SUBJECT;
    const bodyTmpl    = keyboxSend.body    || DEFAULT_BODY;

    // {{変数}} 形式で置換
    const render = (tmpl) => String(tmpl).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
    const subject = render(subjectTmpl);
    const body    = render(bodyTmpl);

    try {
      await sendNotificationEmail_(guestEmail, subject, body);
      await doc.ref.update({
        keyboxSentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`キーボックスメール送信成功: guestId=${guestId} to=${guestEmail}`);
      sentCount++;
    } catch (e) {
      console.error(`キーボックスメール送信失敗 (${guestId}):`, e.message);
    }
  }

  console.log(`sendKeyboxScheduled 完了: 送信=${sentCount}件, リマインド=${remindCount}件`);
};
