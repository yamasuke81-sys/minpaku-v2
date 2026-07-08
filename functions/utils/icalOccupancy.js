/**
 * 物件の Booking.com iCal フィードで、指定日(YYYY-MM-DD)が予約済み(占有)かを裏取りする。
 *
 * 背景: Booking.com の公開 iCal は連続する複数予約を 1 つの "CLOSED - Not available"
 * ブロックに匿名統合する。syncIcal のゴースト重複ガード(syncIcal.js の overlap 判定)は、
 * この統合ブロックが既存予約とオーバーラップすると「重複配信」とみなしスキップするため、
 * マージで前泊日が加わった予約が bookings に生成されないことがある。
 * その結果、名簿照合(checkIn 完全一致 + confirmed)が「一致予約なし」に落ちるが、
 * 実際には OTA カレンダー上に予約が入っている——という食い違いが起きる。
 *
 * この関数は「名簿CI日が Booking.com カレンダー上で実際に予約済みか」を判定し、
 * 照合エラーを「未取込(=手動対応要)」と「打ち間違い(=予約なし)」に切り分けるために使う。
 * 外部フェッチを伴うため、呼び出し側は必ず try/catch で best-effort に使うこと。
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} propertyId
 * @param {string} ymd  判定対象日 (YYYY-MM-DD)
 * @returns {Promise<{occupied: boolean, block: {checkIn:string, checkOut:string, summary:string}|null}>}
 */
async function isDateOccupiedInBookingIcal(db, propertyId, ymd) {
  const out = { occupied: false, block: null };
  if (!propertyId || !ymd) return out;

  const ical = require("node-ical");

  // syncIcal.js の toDateStr と同じ規則: DATE型(UTC 00:00)はUTCの日付をそのまま使う
  const toDateStr = (d) => {
    if (!d) return "";
    const date = d instanceof Date ? d : new Date(d);
    if (isNaN(date.getTime())) return "";
    if (d.dateOnly || (date.getUTCHours() === 0 && date.getUTCMinutes() === 0)) {
      return date.toISOString().slice(0, 10);
    }
    const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    return jst.toISOString().slice(0, 10);
  };

  let ssSnap;
  try {
    ssSnap = await db.collection("syncSettings").where("propertyId", "==", propertyId).get();
  } catch (e) {
    console.warn(`[icalOccupancy] syncSettings 取得失敗: ${e.message}`);
    return out;
  }

  for (const doc of ssSnap.docs) {
    const s = doc.data() || {};
    if (s.active === false || !s.icalUrl) continue;
    const isBooking = /booking/i.test(s.platform || "") || /booking\.com/i.test(s.icalUrl);
    if (!isBooking) continue;

    let events;
    try {
      // トリガー内の外部フェッチがハングしないよう 15 秒でタイムアウト (best-effort)
      const withTimeout = (p, ms) => Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error("iCal fetch timeout")), ms)),
      ]);
      events = await withTimeout(ical.async.fromURL(s.icalUrl), 15000);
    } catch (e) {
      console.warn(`[icalOccupancy] iCal取得失敗 (${(s.icalUrl || "").slice(0, 40)}...): ${e.message}`);
      continue;
    }

    for (const k in events) {
      const ev = events[k];
      if (!ev || ev.type !== "VEVENT" || !ev.start || !ev.end) continue;
      const ci = toDateStr(ev.start);
      const co = toDateStr(ev.end);
      if (!ci || !co) continue;
      // iCal の DTEND は排他(チェックアウト日)。[ci, co) に ymd が入れば当日は予約済み
      if (ci <= ymd && ymd < co) {
        out.occupied = true;
        out.block = { checkIn: ci, checkOut: co, summary: String(ev.summary || "").trim() };
        return out;
      }
    }
  }
  return out;
}

module.exports = { isDateOccupiedInBookingIcal };
