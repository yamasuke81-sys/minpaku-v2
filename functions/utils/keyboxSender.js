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

/** デフォルトメール本文 (ポストON時は {{#if postEnabled}}〜{{/if}} ブロックを展開) */
const DEFAULT_BODY = [
  "{{guestName}} 様",
  "",
  "ご予約ありがとうございます。{{propertyName}} のキーボックス情報をお送りします。",
  "",
  "■ チェックイン情報",
  "日時: {{checkIn}}",
  "ご案内ページ: {{guideUrl}}",
  "",
  "{{#if postEnabled}}",
  "■ ポスト",
  "暗証番号: {{postCode}}",
  "",
  "{{/if}}",
  "■ キーボックス",
  "暗証番号: {{keyboxCode}}",
  "場所: {{keyboxLocation}}",
  "",
  "■ 施設のご案内",
  "住所: {{propertyAddress}}",
  "地図: {{addressMapUrl}}",
  "Wi-Fi SSID: {{wifiSSID}}",
  "Wi-Fi パスワード: {{wifiPassword}}",
  "",
  "ご不明な点がございましたら、本メールにご返信ください。",
  "どうぞよろしくお願いいたします。",
].join("\n");

/**
 * タスク8-(A): テンプレート内の {{#if X}}...{{/if}} 条件ブロックを展開する
 * @param {string} tmpl  テンプレート文字列
 * @param {object} flags 条件フラグ { key: boolean }
 * @returns {string} 展開済み文字列
 */
function resolveIfBlocks(tmpl, flags) {
  return tmpl.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, content) => {
    return flags[key] ? content : "";
  });
}

/**
 * キーボックスメールを送信する
 * @param {object} guest    - guestRegistrations ドキュメントデータ
 * @param {object} property - properties ドキュメントデータ
 */
async function sendKeyboxEmail(guest, property) {
  const guestEmail = guest.email || "";
  if (!guestEmail) throw new Error("ゲストのメールアドレスが未設定");

  const keyboxSend = property.keyboxSend || {};
  const postEnabled = !!(property.post && property.post.enabled);

  // タスク8-1: guideUrl / addressMapUrl
  const rawAddress = property.address || "";
  const addressMapUrl = rawAddress
    ? `https://maps.google.com/?q=${encodeURIComponent(rawAddress)}`
    : "";
  const guideUrl = property.guideUrl || "";

  // タスク8-2: Wi-Fi を SSID / パスワードに分割 (旧 wifiInfo は後方互換フォールバック)
  const wifiSSID     = property.wifiSSID     || (property.wifiInfo ? property.wifiInfo.split("/")[0]?.trim() : "") || "";
  const wifiPassword = property.wifiPassword || (property.wifiInfo ? property.wifiInfo.split("/").slice(1).join("/").trim() : "") || "";

  // 日付を「YYYY年M月D日(曜)」共通フォーマットに整形 (英訳用は YYYY-MM-DD のまま)
  const _ja = ["日","月","火","水","木","金","土"];
  const fmtDateJa = (s) => {
    if (!s) return "";
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return s;
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
    if (isNaN(d.getTime())) return s;
    return `${m[1]}年${parseInt(m[2],10)}月${parseInt(m[3],10)}日(${_ja[d.getDay()]})`;
  };
  const checkInTime = guest.checkInTime || property.checkInTime || "";
  const checkInDateJa = fmtDateJa(guest.checkIn);
  const checkInJa = checkInTime ? `${checkInDateJa} ${checkInTime}` : checkInDateJa;

  const vars = {
    guestName:       guest.guestName || "ゲスト",
    propertyName:    property.name || "",
    keyboxCode:      property.keyboxCode || property.keyboxNumber || "",
    keyboxLocation:  property.keyboxLocation || "",
    // 日本語向け: 共通日付フォーマット + 時間
    checkIn:         checkInJa || "?",
    checkInDate:     checkInDateJa || "?",
    checkInTime:     checkInTime || "",
    // 英訳向け: ISO 形式 (テンプレ側で別変数として使える)
    checkInIso:      guest.checkIn || "",
    wifiSSID,
    wifiPassword,
    propertyAddress: rawAddress,
    addressMapUrl,
    // 住所と地図URLをセットで使う変数 (テンプレ側で {addressBlock} として埋め込める)
    addressBlock:    rawAddress
      ? `${rawAddress}${addressMapUrl ? "\n地図: " + addressMapUrl : ""}`
      : "",
    addressBlockEn:  rawAddress
      ? `${rawAddress}${addressMapUrl ? "\nMap: " + addressMapUrl : ""}`
      : "",
    guideUrl,
    // タスク8-3: ポスト情報
    postCode:        (property.post && property.post.code) || "",
  };

  // テンプレートを取得し、条件ブロック → 変数置換の順で展開
  const rawSubject = keyboxSend.subject || DEFAULT_SUBJECT;
  const rawBody    = keyboxSend.body    || DEFAULT_BODY;

  const flags = { postEnabled };
  const subject = renderTemplate(resolveIfBlocks(rawSubject, flags), vars);
  const body    = renderTemplate(resolveIfBlocks(rawBody,    flags), vars);

  // 英訳併記 (keyboxSend.subjectEn / bodyEn)
  const rawSubjectEn = keyboxSend.subjectEn || "";
  const rawBodyEn    = keyboxSend.bodyEn    || "";
  const subjectEn = rawSubjectEn ? renderTemplate(resolveIfBlocks(rawSubjectEn, flags), vars) : "";
  const bodyEn    = rawBodyEn    ? renderTemplate(resolveIfBlocks(rawBodyEn,    flags), vars) : "";
  const finalSubject = subjectEn ? `${subject} / ${subjectEn}` : subject;
  const finalBody    = bodyEn
    ? `${body}\n\n--------------------------------\n--- English follows ---\n--------------------------------\n\n${bodyEn}`
    : body;

  await sendNotificationEmail_(guestEmail, finalSubject, finalBody);
}

module.exports = { computeScheduledSendAt, formatScheduledSendAt, sendKeyboxEmail };
