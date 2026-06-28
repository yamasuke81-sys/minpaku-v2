/**
 * メールテンプレート描画・diff生成ユーティリティ
 */

// プレースホルダーを値に置換する
function renderTemplate(templateStr, variables) {
  if (!templateStr) return "";
  return templateStr.replace(/\{(\w+)\}/g, (match, key) => {
    return variables[key] !== undefined ? String(variables[key]) : match;
  });
}

// 2つのデータオブジェクトの差分テキストを生成。lang="en" で英語ラベル/文言。
function buildDiffText(previous, current, lang) {
  const en = lang === "en";
  if (!previous || !current) return en ? "(no previous data)" : "（前回データなし）";

  // 比較するフィールド（日本語/英語ラベル付き）
  const fields = [
    { key: "guestName", label: "代表者名", labelEn: "Representative name" },
    { key: "nationality", label: "国籍", labelEn: "Nationality" },
    { key: "address", label: "住所", labelEn: "Address" },
    { key: "phone", label: "電話番号", labelEn: "Phone" },
    { key: "email", label: "メール", labelEn: "Email" },
    { key: "checkIn", label: "チェックイン日", labelEn: "Check-in date" },
    { key: "checkOut", label: "チェックアウト日", labelEn: "Check-out date" },
    { key: "checkInTime", label: "チェックイン時間", labelEn: "Check-in time" },
    { key: "checkOutTime", label: "チェックアウト時間", labelEn: "Check-out time" },
    { key: "guestCount", label: "宿泊人数", labelEn: "Number of guests" },
    { key: "guestCountInfants", label: "乳幼児", labelEn: "Infants" },
    { key: "bookingSite", label: "予約サイト", labelEn: "Booking site" },
    { key: "transport", label: "交通手段", labelEn: "Transportation" },
    { key: "carCount", label: "車の台数", labelEn: "Number of cars" },
    { key: "paidParking", label: "有料駐車場", labelEn: "Paid parking" },
    { key: "bbq", label: "BBQ", labelEn: "BBQ" },
    { key: "bedChoice", label: "ベッドの希望", labelEn: "Bed choice" },
    { key: "purpose", label: "旅の目的", labelEn: "Purpose of trip" },
    { key: "previousStay", label: "前泊地", labelEn: "Previous stay" },
    { key: "nextStay", label: "後泊地", labelEn: "Next stay" },
    { key: "emergencyName", label: "緊急連絡先 氏名", labelEn: "Emergency contact name" },
    { key: "emergencyPhone", label: "緊急連絡先 電話番号", labelEn: "Emergency contact phone" },
  ];

  const changes = [];
  for (const f of fields) {
    const oldVal = String(previous[f.key] || "");
    const newVal = String(current[f.key] || "");
    if (oldVal !== newVal) {
      const lbl = en ? f.labelEn : f.label;
      changes.push(en ? `- ${lbl}: "${oldVal}" -> "${newVal}"` : `・${lbl}: 「${oldVal}」→「${newVal}」`);
    }
  }

  // 同行者の変更（簡易比較）
  const oldGuests = JSON.stringify(previous.guests || []);
  const newGuests = JSON.stringify(current.guests || []);
  if (oldGuests !== newGuests) {
    changes.push(en ? "- Companion information changed" : "・同行者情報に変更あり");
  }

  // 車種の変更
  const oldVT = JSON.stringify(previous.vehicleTypes || []);
  const newVT = JSON.stringify(current.vehicleTypes || []);
  if (oldVT !== newVT) {
    changes.push(en ? "- Vehicle type changed" : "・車種に変更あり");
  }

  if (changes.length === 0) return en ? "(no changes)" : "（変更なし）";
  return changes.join("\n");
}

// 日付文字列を「YYYY年M月D日」形式に統一
function _formatJpDate(s) {
  if (!s) return "?";
  const m = String(s).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return s;
  return `${m[1]}年${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日`;
}

// 宿泊者名簿の全データをテキストにまとめる
function buildGuestSummaryText(data) {
  const lines = [];
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push("【宿泊情報】");
  lines.push(`チェックイン: ${_formatJpDate(data.checkIn)} ${data.checkInTime || ""}`);
  lines.push(`チェックアウト: ${_formatJpDate(data.checkOut)} ${data.checkOutTime || ""}`);
  lines.push(`宿泊人数: ${data.guestCount || "?"}名${data.guestCountInfants ? `（乳幼児 ${data.guestCountInfants}名）` : ""}`);
  lines.push(`予約サイト: ${data.bookingSite || "?"}`);
  lines.push("");

  lines.push("【代表者】");
  lines.push(`氏名: ${data.guestName || "?"}`);
  lines.push(`国籍: ${data.nationality || "日本"}`);
  lines.push(`住所: ${data.address || "?"}`);
  lines.push(`電話番号: ${data.phone || "?"}`);
  lines.push(`メール: ${data.email || "?"}`);
  if (data.passportNumber) lines.push(`旅券番号: ${data.passportNumber}`);
  lines.push("");

  // 同行者
  if (data.guests && data.guests.length > 0) {
    lines.push("【同行者】");
    data.guests.forEach((g, i) => {
      lines.push(`  ${i + 1}. ${g.name || "?"} (${g.nationality || "日本"}) 年齢: ${g.age || "?"}`);
      if (g.passportNumber) lines.push(`     旅券番号: ${g.passportNumber}`);
    });
    lines.push("");
  }

  lines.push("【施設利用】");
  lines.push(`交通手段: ${data.transport || "?"}`);
  if (data.carCount) lines.push(`車の台数: ${data.carCount}台`);
  if (data.vehicleTypes && data.vehicleTypes.length > 0) {
    lines.push(`車種: ${data.vehicleTypes.join(", ")}`);
  }
  if (data.paidParking) lines.push(`有料駐車場: ${data.paidParking}`);
  lines.push(`BBQ: ${data.bbq || "未回答"}`);
  if (data.bedChoice) lines.push(`ベッドの希望: ${data.bedChoice}`);
  lines.push("");

  lines.push("【アンケート】");
  if (data.purpose) lines.push(`旅の目的: ${data.purpose}`);
  if (data.previousStay) lines.push(`前泊地: ${data.previousStay}`);
  if (data.nextStay) lines.push(`後泊地: ${data.nextStay}`);
  lines.push("");

  lines.push("【緊急連絡先】");
  lines.push(`氏名: ${data.emergencyName || "?"}`);
  lines.push(`電話番号: ${data.emergencyPhone || "?"}`);
  lines.push("━━━━━━━━━━━━━━━━━━━━");

  return lines.join("\n");
}

// デフォルトメールテンプレート
// 注: guestConfirmation (修正受領メール) は guest-edit.js 内のビルトインに移管 (2026-05-27)
//     物件別 properties/{pid}.formUpdateMail が SSOT、未設定時はコード内デフォルト文言を使用
const DEFAULT_TEMPLATES = {
  ownerNotification: {
    subject: "【名簿受信】{guestName} ({checkIn}〜{checkOut})",
    body: `宿泊者名簿が届きました。

{summary}

確認して問題がなければ、管理画面から「確認済み」ボタンを押してください。
{confirmUrl}

宿泊者の修正リンク:
{editUrl}`,
  },
  // editNotification: 廃止 (2026-05-27) — 管理者向け名簿修正通知は onGuestFormUpdate トリガーの
  // notifyByKey("roster_updated") で発火。guest-edit.js 内の for ループ直接送信は削除済み
  // ownerConfirmed: 廃止 (2026-04-30) — 「確認済み」ボタン押下時の宿泊者宛メールは送らない
  keyboxDelivery: {
    subject: "【本日チェックイン】キーボックス番号のご案内 - {guestName}様",
    body: `{guestName} 様

本日はご宿泊日です。
キーボックスの番号をお知らせいたします。

━━━━━━━━━━━━━━━━━━━━
キーボックス番号: {keyboxNumber}
━━━━━━━━━━━━━━━━━━━━

チェックイン: {checkIn} {checkInTime}

■ ゲストガイド（Wi-Fi・施設情報）
Wi-FiのSSID・パスワード、施設のご利用方法など詳細は
ゲストガイドをご確認ください:
{guideUrl}

お気をつけてお越しください。
チェックイン後にご不明な点がございましたら、
メールまたはLINEでお気軽にお問い合わせください。`,
  },
};

// settings/guestForm からテンプレートを取得（フォールバックあり）
async function getTemplates(db) {
  try {
    const doc = await db.collection("settings").doc("guestForm").get();
    if (doc.exists && doc.data().emailTemplates) {
      // 設定にあるテンプレートをデフォルトとマージ
      const saved = doc.data().emailTemplates;
      const merged = {};
      for (const key of Object.keys(DEFAULT_TEMPLATES)) {
        merged[key] = {
          subject: saved[key]?.subject || DEFAULT_TEMPLATES[key].subject,
          body: saved[key]?.body || DEFAULT_TEMPLATES[key].body,
        };
      }
      return merged;
    }
  } catch (e) {
    console.warn("テンプレート取得エラー（デフォルト使用）:", e.message);
  }
  return DEFAULT_TEMPLATES;
}

module.exports = {
  renderTemplate,
  buildDiffText,
  buildGuestSummaryText,
  getTemplates,
  DEFAULT_TEMPLATES,
};
