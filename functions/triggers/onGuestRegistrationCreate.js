/**
 * 宿泊者名簿 作成時トリガー
 * guestRegistrations/{id} が作成された際、propertyId 未設定なら bookings から推論して補完する。
 *
 * 推論の優先順:
 *   レベル A: CI と CO が完全一致 (単一ヒット)
 *   レベル B: CI のみ一致 (単一ヒット)
 *   レベル C: 日程オーバーラップ (単一ヒット)
 *   複数ヒット時: guest.bookingSite / guest.source のヒントで source マッチ絞り込み
 *   それでも絞れない場合: 補完しない
 *
 * GAS 側 (syncGuestFormToV2.gs) は触れない方針のため、v2 側で救済する。
 */
const admin = require("firebase-admin");

// ==============================
// 日付正規化
// ==============================
function toDateStr(v) {
  if (!v) return null;
  if (typeof v === "string") {
    // "2026-04-22" 形式想定。Timestamp 文字列なら先頭10文字だけ取る
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }
  // Firestore Timestamp
  if (typeof v.toDate === "function") {
    const d = v.toDate();
    return formatDate_(d);
  }
  if (v instanceof Date) return formatDate_(v);
  // seconds プロパティを持つ Timestamp-like
  if (typeof v.seconds === "number") {
    return formatDate_(new Date(v.seconds * 1000));
  }
  return null;
}

function formatDate_(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ==============================
// source ヒント正規化
// ==============================
function normalizeSource_(s) {
  if (!s) return "";
  const low = String(s).toLowerCase();
  if (low.includes("airbnb")) return "airbnb";
  if (low.includes("booking")) return "booking";
  if (low.includes("agoda")) return "agoda";
  if (low.includes("expedia")) return "expedia";
  if (low.includes("direct") || low.includes("直")) return "direct";
  return low;
}

// ==============================
// 推論ロジック (純粋関数)
// guest: { checkIn, checkOut, bookingSite, source }
// bookings: [{ id, checkIn, checkOut, source, propertyId }]
// returns: { propertyId, level, bookingId } or null
// ==============================
function inferPropertyId(guest, bookings) {
  const gCi = toDateStr(guest.checkIn);
  const gCo = toDateStr(guest.checkOut);
  if (!gCi) return null;

  const normalized = (bookings || [])
    .map((b) => ({
      id: b.id,
      propertyId: b.propertyId || (b.data && b.data.propertyId) || null,
      checkIn: toDateStr(b.checkIn != null ? b.checkIn : b.data && b.data.checkIn),
      checkOut: toDateStr(b.checkOut != null ? b.checkOut : b.data && b.data.checkOut),
      source: normalizeSource_(b.source || (b.data && b.data.source)),
    }))
    .filter((b) => b.propertyId && b.checkIn);

  const hint = normalizeSource_(guest.bookingSite || guest.source || "");

  function pickOrFilter(cands, level) {
    if (cands.length === 0) return null;
    if (cands.length === 1) {
      return { propertyId: cands[0].propertyId, level, bookingId: cands[0].id };
    }
    // 複数ヒット → source ヒントで絞る
    if (hint) {
      const filtered = cands.filter((b) => b.source === hint);
      if (filtered.length === 1) {
        return { propertyId: filtered[0].propertyId, level: level + "+source", bookingId: filtered[0].id };
      }
    }
    // 絞れない → 同一 propertyId に全て収まっていれば確定
    const uniqProps = [...new Set(cands.map((b) => b.propertyId))];
    if (uniqProps.length === 1) {
      return { propertyId: uniqProps[0], level: level + "+uniqProperty", bookingId: cands[0].id };
    }
    return null;
  }

  // レベル A: CI && CO 完全一致
  if (gCo) {
    const exact = normalized.filter((b) => b.checkIn === gCi && b.checkOut === gCo);
    const r = pickOrFilter(exact, "A");
    if (r) return r;
  }

  // レベル B: CI のみ一致
  const ciOnly = normalized.filter((b) => b.checkIn === gCi);
  const rB = pickOrFilter(ciOnly, "B");
  if (rB) return rB;

  // レベル C: オーバーラップ
  if (gCo) {
    const overlap = normalized.filter((b) => b.checkIn <= gCo && b.checkOut >= gCi);
    const rC = pickOrFilter(overlap, "C");
    if (rC) return rC;
  }

  return null;
}

// ==============================
// トリガー本体
// ==============================
async function handler(event) {
  const db = admin.firestore();
  const guest = event.data?.data();
  const guestId = event.params?.guestId;
  if (!guest) return;

  // 既に propertyId があれば何もしない (冪等)
  if (guest.propertyId) {
    console.log(`[onGuestRegistrationCreate] propertyId 既設定 guest=${guestId}, skip`);
    return;
  }

  const gCi = toDateStr(guest.checkIn);
  const gCo = toDateStr(guest.checkOut);
  if (!gCi) {
    console.log(`[onGuestRegistrationCreate] checkIn 未設定 guest=${guestId}, 推論不可`);
    return;
  }

  // 候補を bookings から絞り込み: checkIn が guest.checkIn ± 2日程度を含む範囲
  // Firestore は OR/範囲の複合クエリに制約があるため、checkIn ベースで広めに取る
  // 実データ量が少ないので全件走査でも問題ないが、範囲で絞ったほうがコスト低
  const snap = await db.collection("bookings")
    .where("status", "in", ["confirmed", "completed", "active"])
    .get()
    .catch(async () => db.collection("bookings").get()); // status フィールドが無い/違う値の場合は全件

  const bookings = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const result = inferPropertyId(guest, bookings);

  if (!result) {
    console.log(`[onGuestRegistrationCreate] 推論不可 guest=${guestId} ci=${gCi} co=${gCo} 候補数=${bookings.length}`);
    return;
  }

  await event.data.ref.update({
    propertyId: result.propertyId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(
    `[onGuestRegistrationCreate] 補完成功 guest=${guestId} → propertyId=${result.propertyId} ` +
    `(level=${result.level}, fromBooking=${result.bookingId})`
  );
}

module.exports = handler;
module.exports.inferPropertyId = inferPropertyId;
module.exports._toDateStr = toDateStr;
