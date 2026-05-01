/**
 * 名簿未入力リマインド（毎時実行 JST）
 *
 * 物件別の channelOverrides.roster_remind.timings[] に従って、各タイミングが
 * 「現在の JST 時刻」と一致したときだけ発火する。
 *
 * timings 構造例:
 *   [{ mode:"event", timing:"beforeEvent", beforeDays:6, beforeTime:"03:00" }, ...]
 *
 * → JST 03時に rosterRemind が走った時、各物件で beforeDays=6 のタイミングを抽出し、
 *   `checkIn = todayJST + 6日` の名簿未提出予約を対象に送信。
 *
 * 重複送信防止:
 *   bookings.{bookingId}.rosterRemindSentKeys[] に "YYYY-MM-DD_HH_NdaysBefore" を記録
 */
const admin = require("firebase-admin");
const { notifyByKey } = require("../utils/lineNotify");

const APP_URL = "https://minpaku-v2.web.app";
const NOTIFY_TYPE = "roster_remind";

// JST の今 → { date: "YYYY-MM-DD", hour: 0..23 }
function nowJst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return {
    date: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
  };
}

// "YYYY-MM-DD" + N → "YYYY-MM-DD" (N日後)
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = async function rosterRemind() {
  const db = admin.firestore();
  const { date: todayJst, hour: hourJst } = nowJst();

  console.log(`[rosterRemind] 起動 JST=${todayJst} ${String(hourJst).padStart(2, "0")}:00`);

  try {
    // 1) 全物件の timings を取得し、現在時刻にマッチする (propertyId, beforeDays) を収集
    const propsSnap = await db.collection("properties").get();
    const targets = []; // [{ propertyId, beforeDays, targetCheckIn }]

    for (const pd of propsSnap.docs) {
      const prop = pd.data() || {};
      if (prop.active === false) continue;
      const ov = (prop.channelOverrides || {})[NOTIFY_TYPE] || {};
      if (ov.enabled === false) continue;
      const timings = Array.isArray(ov.timings) ? ov.timings : [];
      if (timings.length === 0) continue;

      for (const t of timings) {
        // 現状サポート: mode=event / timing=beforeEvent
        if (t.timing !== "beforeEvent") continue;
        const beforeDays = parseInt(t.beforeDays, 10);
        if (!Number.isFinite(beforeDays) || beforeDays < 0) continue;
        const beforeTime = String(t.beforeTime || "").trim();
        const m = beforeTime.match(/^(\d{1,2}):(\d{2})$/);
        if (!m) continue;
        const targetHour = parseInt(m[1], 10);
        if (targetHour !== hourJst) continue;

        const targetCheckIn = addDays(todayJst, beforeDays);
        targets.push({
          propertyId: pd.id,
          propertyName: prop.name || pd.id,
          beforeDays,
          targetCheckIn,
        });
      }
    }

    if (targets.length === 0) {
      console.log(`[rosterRemind] このタイミング (JST ${hourJst}時) に該当する物件設定なし`);
      return;
    }

    console.log(`[rosterRemind] マッチした (物件×タイミング) 数: ${targets.length}`);

    let sentTotal = 0;

    // 2) 各 (propertyId, targetCheckIn) について bookings を取得して送信
    for (const tgt of targets) {
      const bookingsSnap = await db.collection("bookings")
        .where("propertyId", "==", tgt.propertyId)
        .where("checkIn", "==", tgt.targetCheckIn)
        .where("status", "==", "confirmed")
        .get();

      if (bookingsSnap.empty) continue;

      for (const bd of bookingsSnap.docs) {
        const b = bd.data();
        const bookingId = bd.id;

        // 名簿提出済み → スキップ
        if (b.rosterStatus === "submitted") continue;
        // 保留中 (Airbnb 承認待ち) → スキップ
        if (b.pendingApproval === true) continue;

        // 重複防止キー: 日付+時+beforeDays で一意
        const key = `${todayJst}_${String(hourJst).padStart(2, "0")}_d${tgt.beforeDays}`;
        const sentKeys = Array.isArray(b.rosterRemindSentKeys) ? b.rosterRemindSentKeys : [];
        if (sentKeys.includes(key)) {
          console.log(`[rosterRemind] 既送信スキップ ${bookingId} key=${key}`);
          continue;
        }

        const propertyName = b.propertyName || tgt.propertyName;
        const guestName = b.guestName || "名前未設定";
        const checkin = b.checkIn || "";
        const formUrl = `${APP_URL}/form/?propertyId=${tgt.propertyId}`;

        const vars = {
          date: checkin,
          checkin,
          property: propertyName,
          guest: guestName,
          url: formUrl,
        };

        const defaultMsg = [
          `📋 名簿未提出リマインド (${tgt.beforeDays}日前)`,
          ``,
          `物件: ${propertyName}`,
          `ゲスト: ${guestName}`,
          `チェックイン: ${checkin}`,
          ``,
          `宿泊者名簿がまだ提出されていません。`,
          `フォームURL: ${formUrl}`,
        ].join("\n");

        const title = `名簿未提出 (${tgt.beforeDays}日前): ${guestName} (${checkin})`;

        const result = await notifyByKey(db, NOTIFY_TYPE, {
          title,
          body: defaultMsg,
          vars,
          propertyId: tgt.propertyId,
        });
        const anySuccess = Object.values(result.sent || {}).some(v => v && v !== 0);

        if (anySuccess) {
          sentTotal++;
          try {
            await db.collection("bookings").doc(bookingId).update({
              rosterRemindSentKeys: admin.firestore.FieldValue.arrayUnion(key),
            });
          } catch (e) {
            console.warn(`[rosterRemind] 送信記録失敗 ${bookingId}:`, e.message);
          }
        }
      }
    }

    console.log(`[rosterRemind] 完了: ${sentTotal}件送信`);
  } catch (e) {
    console.error("[rosterRemind] エラー:", e);
    try {
      await db.collection("error_logs").add({
        functionName: "rosterRemind",
        error: e.message,
        stack: e.stack?.slice(0, 500),
        severity: "warning",
        createdAt: new Date(),
      });
    } catch (_) { /* 無視 */ }
  }
};
