/**
 * 未確定アラート（毎時チェック）
 * 当日の清掃でスタッフ未確定 → 🔴即時LINE通知
 * 同じ募集について1日1回のみ通知（重複防止）
 */
const { notifyOwner } = require("../utils/lineNotify");

module.exports = async function alertUnconfirmed(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  const today = getJSTDateString(new Date());

  // 当日 or 翌日のチェックアウト日で「募集中」のもの
  const tomorrow = getJSTDateString(addDays(new Date(), 1));

  const snap = await db.collection("recruitments")
    .where("status", "==", "募集中").get();

  const urgent = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => r.checkoutDate === today || r.checkoutDate === tomorrow);

  if (urgent.length === 0) return;

  // 今日既に通知済みの募集をチェック（重複防止）
  const todayStart = new Date(today + "T00:00:00+09:00");
  const notifSnap = await db.collection("notifications")
    .where("type", "==", "alert")
    .where("sentAt", ">=", todayStart).get();

  const alreadyNotified = new Set();
  notifSnap.docs.forEach((d) => {
    const data = d.data();
    if (data.recruitmentId) alreadyNotified.add(data.recruitmentId);
  });

  const toNotify = urgent.filter((r) => !alreadyNotified.has(r.id));
  if (toNotify.length === 0) return;

  // アラートテキスト生成
  let text = "🔴 緊急アラート\n\n";
  for (const r of toNotify) {
    const isToday = r.checkoutDate === today;
    text += `${isToday ? "【本日】" : "【明日】"} ${r.checkoutDate} 清掃スタッフ未確定\n`;
    if (r.propertyName) text += `  物件: ${r.propertyName}\n`;
    const responses = r.responses || [];
    const available = responses.filter((x) => x.response === "◎" || x.response === "△");
    if (available.length > 0) {
      text += `  回答あり: ${available.map((x) => `${x.staffName}(${x.response})`).join(", ")}\n`;
      text += "  → 選定してスタッフを確定してください\n";
    } else {
      text += "  回答なし → タイミーなどの外部手配を検討してください\n";
    }
    text += "\n";
  }

  // 送信
  const result = await notifyOwner(db, "alert", "未確定アラート", text);

  // 通知ログにrecruitmentIdを記録（重複防止用）
  if (result.success) {
    for (const r of toNotify) {
      try {
        await db.collection("notifications").add({
          type: "alert",
          recruitmentId: r.id,
          title: `未確定アラート: ${r.checkoutDate}`,
          body: "",
          sentAt: new Date(),
          channel: "line",
          success: true,
        });
      } catch (e) { /* ログ記録失敗は無視 */ }
    }
  }
};

function getJSTDateString(date) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
