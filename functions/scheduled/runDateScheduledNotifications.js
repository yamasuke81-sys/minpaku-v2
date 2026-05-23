/**
 * 日付モード (mode="date") の通知を発火する汎用 scheduled 関数
 *
 * 毎時 JST 実行。 全 active 物件の channelOverrides を走査し、
 * 各 notifyType の timings から mode="date" のエントリを抽出、
 * 現在の JST 時刻が schedulePattern にマッチすれば notifyByKey を呼ぶ。
 *
 * 対応パターン:
 *   - monthEnd: 毎月月末 (scheduleTime の時刻)
 *   - monthlyDay: 毎月 scheduleDay 日 (scheduleTime の時刻)
 *   - weekly: 毎週 scheduleDow 曜日 (scheduleTime の時刻)
 *   - daily: 毎日 (scheduleTime の時刻)
 *
 * 重複防止: properties/{pid}.channelOverrides.{type}.dateSentKeys[]
 * に "YYYY-MM-DD_HH_{pattern}" を記録し、 同日同時刻同パターンの重複発火を防ぐ。
 */
const admin = require("firebase-admin");
const { notifyByKey } = require("../utils/lineNotify");

function nowJst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return {
    date: d.toISOString().slice(0, 10),       // YYYY-MM-DD
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    day: d.getUTCDate(),
    dow: d.getUTCDay(),
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
  };
}

function lastDayOfMonth(year, month1) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function timeMatches(scheduleTime, jstHour, jstMinute) {
  // 毎時実行 → 「HH:MM」の HH が一致すれば発火 (分は無視、 hourly granularity)
  const m = String(scheduleTime || "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return false;
  return parseInt(m[1], 10) === jstHour;
}

module.exports = async function runDateScheduledNotifications() {
  const db = admin.firestore();
  const t = nowJst();
  console.log(`[runDateScheduled] 起動 JST=${t.date} ${String(t.hour).padStart(2, "0")}:00`);

  const propsSnap = await db.collection("properties").where("active", "==", true).get();
  let firedCount = 0;
  for (const pDoc of propsSnap.docs) {
    const prop = pDoc.data() || {};
    const ov = prop.channelOverrides || {};
    for (const [notifyKey, ch] of Object.entries(ov)) {
      if (!ch || ch.enabled === false) continue;
      const timings = Array.isArray(ch.timings) ? ch.timings : [];
      const dateTimings = timings.filter(x => x && x.mode === "date");
      if (dateTimings.length === 0) continue;
      for (const tm of dateTimings) {
        const pat = tm.schedulePattern;
        if (!timeMatches(tm.scheduleTime, t.hour, t.minute)) continue;
        let match = false;
        if (pat === "monthEnd") {
          match = t.day === lastDayOfMonth(t.year, t.month);
        } else if (pat === "monthlyDay") {
          match = t.day === parseInt(tm.scheduleDay, 10);
        } else if (pat === "weekly") {
          match = t.dow === parseInt(tm.scheduleDow, 10);
        } else if (pat === "daily") {
          match = true;
        }
        if (!match) continue;
        // 重複防止キー
        const key = `${t.date}_${String(t.hour).padStart(2, "0")}_${pat}`;
        const sentKeys = Array.isArray(ch.dateSentKeys) ? ch.dateSentKeys : [];
        if (sentKeys.includes(key)) continue;
        // 発火
        try {
          console.log(`[runDateScheduled] 発火: ${prop.name} (${pDoc.id}) ${notifyKey} pattern=${pat}`);
          await notifyByKey(db, notifyKey, {
            title: `定期通知: ${notifyKey}`,
            body: ch.customMessage || `${prop.name || ""} の ${notifyKey} 定期通知`,
            vars: { property: prop.name || "", date: t.date },
            propertyId: pDoc.id,
          });
          firedCount++;
          // 重複防止キー記録
          try {
            await pDoc.ref.update({
              [`channelOverrides.${notifyKey}.dateSentKeys`]: admin.firestore.FieldValue.arrayUnion(key),
            });
          } catch (e) { /* ignore */ }
        } catch (e) {
          console.error(`[runDateScheduled] 発火失敗 ${notifyKey}`, e);
        }
      }
    }
  }
  console.log(`[runDateScheduled] 完了: ${firedCount}件発火`);
};
