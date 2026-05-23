/**
 * 未確定アラート（毎時チェック）
 * 当日の清掃でスタッフ未確定 → 🔴即時LINE通知
 * 同じ募集について1日1回のみ通知（重複防止）
 *
 * 修正 (2026-05-24):
 * 旧実装は notifyOwner() を一括呼び出ししており、物件別 channelOverrides.alert の
 * ON/OFF 設定が全く無視されていた（設定で OFF にしても必ず送信される）。
 * → 募集を物件単位でまとめ、notifyByKey() 経由で物件別設定を尊重して送信するよう修正。
 */
const { notifyByKey } = require("../utils/lineNotify");

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

  // 物件ごとにまとめて notifyByKey() で送信（物件別 channelOverrides を尊重）
  // propertyId が未設定の募集は propertyId=null で一括処理する
  const byProperty = new Map(); // propertyId → [recruitment, ...]
  for (const r of toNotify) {
    const pid = r.propertyId || null;
    if (!byProperty.has(pid)) byProperty.set(pid, []);
    byProperty.get(pid).push(r);
  }

  for (const [pid, recruitments] of byProperty) {
    // アラートテキスト生成（物件グループ単位）
    let text = "🔴 緊急アラート\n\n";
    for (const r of recruitments) {
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
    const propertyName = recruitments[0]?.propertyName || "";

    // notifyByKey で物件別 channelOverrides.alert を参照して送信先を決定
    // (OFF にした物件は送信されない。propertyId=null の場合はグローバル設定のみ参照)
    let result;
    try {
      result = await notifyByKey(db, "alert", {
        title: `未確定アラート${propertyName ? `: ${propertyName}` : ""}`,
        body: text,
        vars: {
          date: today,
          property: propertyName,
          url: "https://minpaku-v2.web.app/#/recruitment",
        },
        propertyId: pid,
      });
    } catch (e) {
      console.error(`[alertUnconfirmed] notifyByKey エラー (pid=${pid}):`, e.message);
      result = null;
    }

    const anySuccess = result && Object.values(result.sent || {}).some(v => v && v !== 0);

    // 通知ログにrecruitmentIdを記録（重複防止用）
    if (anySuccess) {
      for (const r of recruitments) {
        try {
          await db.collection("notifications").add({
            type: "alert",
            recruitmentId: r.id,
            propertyId: pid || null,
            title: `未確定アラート: ${r.checkoutDate}`,
            body: "",
            sentAt: new Date(),
            channel: "multi",
            success: true,
          });
        } catch (e) { /* ログ記録失敗は無視 */ }
      }
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
