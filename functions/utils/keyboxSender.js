/**
 * キーボックスメール送信 共通ユーティリティ
 *
 * keybox.js (OKボタン即時送信) と sendKeyboxScheduled.js (スケジュール送信) の両方から使う。
 */
const { sendNotificationEmail_ } = require("./lineNotify");

const JST_OFFSET = 9 * 60 * 60 * 1000;

/** scheduleType + sendTime + checkIn 文字列 ("YYYY-MM-DD") から JST の送信予定時刻 (Date) を返す */
function computeScheduledSendAt(checkInStr, ks) {
  if (!checkInStr || !ks.scheduleType || !ks.sendTime) return null;

  let daysBefore = 0;
  if (ks.scheduleType === "day_before") daysBefore = 1;
  else if (ks.scheduleType === "2_days_before") daysBefore = 2;
  else if (ks.scheduleType === "custom") daysBefore = Number(ks.customDaysBefore) || 3;
  // day_of は 0

  // checkIn を UTC 0時として扱い、daysBefore日前の JST sendTime に変換
  const checkInUtc = new Date(checkInStr + "T00:00:00.000Z");
  const sendDate = new Date(checkInUtc.getTime() - daysBefore * 24 * 60 * 60 * 1000);
  const [hh, mm] = ks.sendTime.split(":").map(Number);

  // sendDate は UTC 0時 → JST 9時。JST HH:MM = UTC (HH-9):MM
  const scheduledAtUtc = new Date(sendDate.getTime() + hh * 3600000 + mm * 60000 - JST_OFFSET);
  return scheduledAtUtc;
}

/** 送信予定時刻を JST ロケール文字列で返す (完了画面表示用) */
function formatScheduledSendAt(scheduledAt) {
  if (!scheduledAt) return "？";
  return scheduledAt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

/** テンプレート変数 {{key}} を vars で置換 */
function renderTemplate(tmpl, vars) {
  return String(tmpl).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
}

/** デフォルトメール件名 */
const DEFAULT_SUBJECT = "【{{propertyName}}】チェックイン情報のご案内";

/** デフォルトメール本文 */
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

/**
 * キーボックスメールを送信する
 * @param {object} guest - guestRegistrations ドキュメントデータ
 * @param {object} property - properties ドキュメントデータ
 */
async function sendKeyboxEmail(guest, property) {
  const guestEmail = guest.email || "";
  if (!guestEmail) throw new Error("ゲストのメールアドレスが未設定");

  const keyboxSend = property.keyboxSend || {};
  const vars = {
    guestName: guest.guestName || "ゲスト",
    propertyName: property.name || "",
    keyboxCode: property.keyboxCode || property.keyboxNumber || "",
    keyboxLocation: property.keyboxLocation || "",
    checkIn: guest.checkIn || "?",
    wifiInfo: property.wifiInfo || "",
    propertyAddress: property.address || "",
  };

  const subject = renderTemplate(keyboxSend.subject || DEFAULT_SUBJECT, vars);
  const body    = renderTemplate(keyboxSend.body    || DEFAULT_BODY,    vars);

  await sendNotificationEmail_(guestEmail, subject, body);
}

module.exports = { computeScheduledSendAt, formatScheduledSendAt, sendKeyboxEmail };
