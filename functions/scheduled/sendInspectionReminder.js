/**
 * 直前点検リマインド (毎時実行 JST)
 *
 * 物件別 channelOverrides.inspection_reminder.timings[] に従って発火。
 *
 * timings 構造例:
 *   [{ mode:"event", timing:"beforeEvent", beforeDays:5, beforeTime:"08:00" }, ...]
 *
 * → JST 08時に走った時、各物件で beforeDays=5 のタイミングを抽出し、
 *   `checkIn = todayJST + 5日` の bookings (status=confirmed/completed)
 *   かつ inspection.enabled=true の物件 のみ通知。
 *
 * 重複防止: bookings.inspectionReminderSentKeys[] に
 *   "YYYY-MM-DD_HH_dN" を記録
 */
const admin = require("firebase-admin");
const { notifyByKey } = require("../utils/lineNotify");

const NOTIFY_TYPE = "inspection_reminder";

function nowJst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmtDate(s) {
  if (!s) return "";
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : String(s);
}

module.exports = async function sendInspectionReminder() {
  const db = admin.firestore();
  const { date: todayJst, hour: hourJst } = nowJst();
  console.log(`[inspectionReminder] 起動 JST=${todayJst} ${String(hourJst).padStart(2, "0")}:00`);

  try {
    // inspection.enabled=true の物件のみ対象
    const propsSnap = await db.collection("properties")
      .where("inspection.enabled", "==", true)
      .get();
    if (propsSnap.empty) return;

    // (propertyId, beforeDays, targetCheckIn) の集合を作る
    const targets = [];
    for (const pd of propsSnap.docs) {
      const prop = pd.data() || {};
      if (prop.active === false) continue;
      const ov = (prop.channelOverrides || {})[NOTIFY_TYPE] || {};
      if (ov.enabled === false) continue;
      // timings[] が無ければ後方互換で beforeDays/beforeTime 単一値を採用
      let timings = Array.isArray(ov.timings) ? ov.timings : [];
      if (timings.length === 0 && (ov.beforeDays !== undefined || ov.beforeTime !== undefined)) {
        timings = [{
          timing: "beforeEvent",
          beforeDays: ov.beforeDays ?? 1,
          beforeTime: ov.beforeTime || "08:00",
        }];
      }
      for (const t of timings) {
        if (t.timing !== "beforeEvent") continue;
        const beforeDays = parseInt(t.beforeDays, 10);
        if (!Number.isFinite(beforeDays) || beforeDays < 0) continue;
        const m = String(t.beforeTime || "").match(/^(\d{1,2}):(\d{2})$/);
        if (!m) continue;
        if (parseInt(m[1], 10) !== hourJst) continue;
        targets.push({
          propertyId: pd.id,
          propertyName: prop.name || pd.id,
          beforeDays,
          targetCheckIn: addDays(todayJst, beforeDays),
        });
      }
    }

    if (targets.length === 0) {
      console.log(`[inspectionReminder] このタイミング (JST ${hourJst}時) に該当物件設定なし`);
      return;
    }

    let sentCount = 0;

    for (const tgt of targets) {
      const bookingsSnap = await db.collection("bookings")
        .where("propertyId", "==", tgt.propertyId)
        .where("checkIn", "==", tgt.targetCheckIn)
        .where("status", "in", ["confirmed", "completed"])
        .get();
      if (bookingsSnap.empty) continue;

      for (const bd of bookingsSnap.docs) {
        const b = bd.data();
        if (b.pendingApproval === true) continue;

        const key = `${todayJst}_${String(hourJst).padStart(2, "0")}_d${tgt.beforeDays}`;
        const sentKeys = Array.isArray(b.inspectionReminderSentKeys) ? b.inspectionReminderSentKeys : [];
        if (sentKeys.includes(key)) continue;

        const vars = {
          date: fmtDate(b.checkIn),
          property: tgt.propertyName,
          guest: b.guestName || "ゲスト",
          checkin: fmtDate(b.checkIn),
          checkout: fmtDate(b.checkOut),
        };
        const body = `🔍 直前点検リマインド (${tgt.beforeDays}日前)\n\n${fmtDate(b.checkIn)} チェックイン前の点検をお忘れなく\n物件: ${tgt.propertyName}\nゲスト: ${b.guestName || ""}`;

        try {
          const result = await notifyByKey(db, NOTIFY_TYPE, {
            title: `直前点検リマインド (${tgt.beforeDays}日前)`,
            body,
            vars,
            propertyId: tgt.propertyId,
          });
          const anySuccess = Object.values(result.sent || {}).some(v => v && v !== 0);
          if (anySuccess) {
            sentCount++;
            await bd.ref.update({
              inspectionReminderSentKeys: admin.firestore.FieldValue.arrayUnion(key),
            });
          }
        } catch (e) {
          console.error(`[inspectionReminder] 送信エラー bookingId=${bd.id}:`, e.message);
        }
      }
    }

    console.log(`[inspectionReminder] 完了: ${sentCount}件送信`);
  } catch (e) {
    console.error("[inspectionReminder] エラー:", e);
    try {
      await db.collection("error_logs").add({
        functionName: "sendInspectionReminder",
        error: e.message,
        stack: e.stack?.slice(0, 500),
        severity: "warning",
        createdAt: new Date(),
      });
    } catch (_) { /* 無視 */ }
  }
};
