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

// 2つのデータオブジェクトの差分テキストを生成
function buildDiffText(previous, current) {
  if (!previous || !current) return "（前回データなし）";

  // 比較するフィールド（表示名付き）
  const fields = [
    { key: "guestName", label: "代表者名" },
    { key: "nationality", label: "国籍" },
    { key: "address", label: "住所" },
    { key: "phone", label: "電話番号" },
    { key: "email", label: "メール" },
    { key: "checkIn", label: "チェックイン日" },
    { key: "checkOut", label: "チェックアウト日" },
    { key: "checkInTime", label: "チェックイン時間" },
    { key: "checkOutTime", label: "チェックアウト時間" },
    { key: "guestCount", label: "宿泊人数" },
    { key: "guestCountInfants", label: "乳幼児" },
    { key: "bookingSite", label: "予約サイト" },
    { key: "transport", label: "交通手段" },
    { key: "carCount", label: "車の台数" },
    { key: "paidParking", label: "有料駐車場" },
    { key: "bbq", label: "BBQ" },
    { key: "bedChoice", label: "ベッドの希望" },
    { key: "purpose", label: "旅の目的" },
    { key: "previousStay", label: "前泊地" },
    { key: "nextStay", label: "後泊地" },
    { key: "emergencyName", label: "緊急連絡先 氏名" },
    { key: "emergencyPhone", label: "緊急連絡先 電話番号" },
  ];

  const changes = [];
  for (const f of fields) {
    const oldVal = String(previous[f.key] || "");
    const newVal = String(current[f.key] || "");
    if (oldVal !== newVal) {
      changes.push(`・${f.label}: 「${oldVal}」→「${newVal}」`);
    }
  }

  // 同行者の変更（簡易比較）
  const oldGuests = JSON.stringify(previous.guests || []);
  const newGuests = JSON.stringify(current.guests || []);
  if (oldGuests !== newGuests) {
    changes.push("・同行者情報に変更あり");
  }

  // 車種の変更
  const oldVT = JSON.stringify(previous.vehicleTypes || []);
  const newVT = JSON.stringify(current.vehicleTypes || []);
  if (oldVT !== newVT) {
    changes.push("・車種に変更あり");
  }

  if (changes.length === 0) return "（変更なし）";
  return changes.join("\n");
}

// 宿泊者名簿の全データをテキストにまとめる
function buildGuestSummaryText(data) {
  const lines = [];
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push("【宿泊情報】");
  lines.push(`チェックイン: ${data.checkIn || "?"} ${data.checkInTime || ""}`);
  lines.push(`チェックアウト: ${data.checkOut || "?"} ${data.checkOutTime || ""}`);
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
const DEFAULT_TEMPLATES = {
  guestConfirmation: {
    subject: "【宿泊者名簿】ご記入ありがとうございます - {guestName}様",
    body: `{guestName} 様

宿泊者名簿のご記入ありがとうございます。
以下の内容で受け付けました。

{summary}

内容に修正がある場合は、以下のリンクから修正できます:
{editUrl}

※ オーナーが確認済みにすると修正できなくなります。

詳しいご案内はゲストガイドをご覧ください:
{guideUrl}

ご不明な点がございましたらお気軽にご連絡ください。
ご宿泊を楽しみにお待ちしております。`,
  },
  ownerNotification: {
    subject: "【名簿受信】{guestName} ({checkIn}〜{checkOut})",
    body: `宿泊者名簿が届きました。

{summary}

確認して問題がなければ、管理画面から「確認済み」ボタンを押してください。
{confirmUrl}

宿泊者の修正リンク:
{editUrl}`,
  },
  editNotification: {
    subject: "【名簿修正】{guestName}様が名簿を修正しました",
    body: `{guestName}様が宿泊者名簿を修正しました。

【変更点】
{changes}

【最新の全データ】
{summary}

確認して問題がなければ「確認済み」にしてください。
{confirmUrl}`,
  },
  ownerConfirmed: {
    subject: "【確認完了】宿泊者名簿を確認しました - {guestName}様",
    body: `{guestName} 様

宿泊者名簿の内容を確認いたしました。
ご宿泊当日の朝に、キーボックスの番号をメールでお伝えいたします。

チェックイン: {checkIn} {checkInTime}
チェックアウト: {checkOut} {checkOutTime}

ご宿泊を楽しみにお待ちしております。`,
  },
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
