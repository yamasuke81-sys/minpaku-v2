/**
 * 直前点検リマインド (毎時実行)
 *
 * 動作フロー:
 *   1. properties で inspection.enabled === true の物件を取得
 *   2. 各物件の bookings から「翌日チェックイン」の予約を検索
 *      ※タイミングは channelOverrides.inspection_reminder.beforeDays (デフォルト1) を使用
 *   3. 重複防止フラグ (inspectionReminderSentAt) がなければ notifyByKey で送信
 *   4. 送信後 bookings に inspectionReminderSentAt を記録
 */
const { notifyByKey } = require("../utils/lineNotify");

function getJSTDateString(date) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

function fmtDate(s) {
  if (!s) return "";
  try {
    const d = typeof s === "string"
      ? new Date(s + "T00:00:00")
      : (s && typeof s.toDate === "function" ? s.toDate() : new Date(s));
    if (isNaN(d.getTime())) return String(s);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}/${mo}/${da}`;
  } catch (_) { return String(s); }
}

module.exports = async function sendInspectionReminder(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  // inspection.enabled = true の物件を全取得
  const propsSnap = await db.collection("properties")
    .where("inspection.enabled", "==", true)
    .get();

  if (propsSnap.empty) return;

  const now = new Date();
  const todayStr = getJSTDateString(now);

  for (const propDoc of propsSnap.docs) {
    const prop = propDoc.data();
    const propertyId = propDoc.id;
    const propertyName = prop.name || "";

    // チャネルオーバーライドからタイミング設定を取得 (デフォルト: 1日前)
    const ov = (prop.channelOverrides || {}).inspection_reminder || {};
    // タイミング設定: beforeDays (送信するタイミング: チェックイン N日前)
    // 「N日前のHH:MM」形式を想定。未設定なら前日 (1日前) とする
    const beforeDays = typeof ov.beforeDays === "number" ? ov.beforeDays : 1;
    // 送信時刻は「翌朝6時〜7時の実行」を想定 (Scheduler毎時実行で1時間以内に必ず1回通る)

    // 送信タイミング当日 = チェックイン日 - beforeDays
    const targetSendDate = getJSTDateString(addDays(now, beforeDays));
    if (targetSendDate !== todayStr) {
      // 今日が「送信すべき日」でなければスキップ
      // (beforeDays=1 なら今日=チェックイン前日のみ実行)
      // 注: 現時点の簡易実装では「今日=送信日」のみ対応
      // 将来は「チェックイン日 - beforeDays === today」をブッキング単位で判定
    }

    // 該当物件の bookings で checkIn が (today + beforeDays) のものを取得
    const targetCheckIn = getJSTDateString(addDays(now, beforeDays));

    let bookingsSnap;
    try {
      bookingsSnap = await db.collection("bookings")
        .where("propertyId", "==", propertyId)
        .where("status", "in", ["confirmed", "completed"])
        .get();
    } catch (e) {
      console.error(`[inspectionReminder] bookings取得エラー (${propertyId}):`, e.message);
      continue;
    }

    for (const bDoc of bookingsSnap.docs) {
      const booking = bDoc.data();

      // checkIn を文字列に変換して比較
      let checkInStr = "";
      try {
        const ci = booking.checkIn;
        if (ci) {
          const d = (ci && typeof ci.toDate === "function") ? ci.toDate() : new Date(ci);
          checkInStr = getJSTDateString(d);
        }
      } catch (_) { continue; }

      if (checkInStr !== targetCheckIn) continue;

      // 既送信チェック
      if (booking.inspectionReminderSentAt) continue;

      // 通知変数
      const vars = {
        date: fmtDate(booking.checkIn),
        property: propertyName,
        guest: booking.guestName || "ゲスト",
        checkin: fmtDate(booking.checkIn),
        checkout: fmtDate(booking.checkOut),
      };
      const body = `🔍 直前点検リマインド\n\n${fmtDate(booking.checkIn)} チェックイン前の点検をお忘れなく\n物件: ${propertyName}\nゲスト: ${booking.guestName || ""}`;

      try {
        await notifyByKey(db, "inspection_reminder", {
          title: "直前点検リマインド",
          body,
          vars,
          propertyId,
        });

        // 送信済みフラグを記録 (重複防止)
        await db.collection("bookings").doc(bDoc.id).update({
          inspectionReminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`[inspectionReminder] 送信完了: bookingId=${bDoc.id} property=${propertyName} checkIn=${checkInStr}`);
      } catch (e) {
        console.error(`[inspectionReminder] 送信エラー: bookingId=${bDoc.id}`, e.message);
        try {
          await db.collection("error_logs").add({
            type: "sendInspectionReminder",
            bookingId: bDoc.id,
            propertyId,
            message: e.message,
            createdAt: new Date(),
          });
        } catch (_) { /* ログ失敗は無視 */ }
      }
    }
  }
};
