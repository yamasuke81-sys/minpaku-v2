/**
 * キャンセル予約の整合性確保
 *  - 各 recruitment/shift の bookingId が cancelled、かつ
 *    同日同物件に他の active 予約が無い → その recruitment/shift を削除
 *  - 対応する checklist も削除
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const isCancelled = (s) => {
  const x = String(s || "").toLowerCase();
  return x.includes("cancel") || s === "キャンセル" || s === "キャンセル済み";
};

(async () => {
  const [bookings, recruitments, shifts, checklists] = await Promise.all([
    db.collection("bookings").get(),
    db.collection("recruitments").get(),
    db.collection("shifts").get(),
    db.collection("checklists").get(),
  ]);

  // (propertyId, checkOut) → [active booking]
  const activeByKey = {};
  bookings.docs.forEach(d => {
    const x = d.data();
    if (isCancelled(x.status)) return;
    if (!x.propertyId || !x.checkOut) return;
    const k = `${x.propertyId}|${x.checkOut}`;
    (activeByKey[k] = activeByKey[k] || []).push({ id: d.id, ...x });
  });

  let recDel = 0, shiftDel = 0, checklistDel = 0;

  // recruitments の整合
  for (const d of recruitments.docs) {
    const r = d.data();
    if (!r.propertyId || !r.checkoutDate) continue;
    const k = `${r.propertyId}|${r.checkoutDate}`;
    const actives = activeByKey[k] || [];
    if (actives.length === 0) {
      console.log(`[rec削除] id=${d.id} prop=${r.propertyId} date=${r.checkoutDate} (関連bookingキャンセル)`);
      await d.ref.delete();
      recDel++;
    } else if (r.bookingId && !actives.some(b => b.id === r.bookingId)) {
      // 元 booking はキャンセルだが、同日同物件の別 active booking が存在 → bookingId を付け替え
      const newBooking = actives[0];
      console.log(`[rec更新] id=${d.id} bookingId 付替 ${r.bookingId} → ${newBooking.id}`);
      await d.ref.update({
        bookingId: newBooking.id,
        memo: `ゲスト: ${newBooking.guestName || "不明"} (${newBooking.source || "不明"})`,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  // shifts の整合
  for (const d of shifts.docs) {
    const s = d.data();
    if (!s.propertyId || !s.date) continue;
    const dt = s.date?.toDate ? s.date.toDate() : new Date(s.date);
    const coDate = dt.toISOString().slice(0, 10);
    const k = `${s.propertyId}|${coDate}`;
    const actives = activeByKey[k] || [];
    if (actives.length === 0) {
      console.log(`[shift削除] id=${d.id} prop=${s.propertyId} date=${coDate}`);
      await d.ref.delete();
      shiftDel++;
      // 対応 checklist も削除
      const cs = checklists.docs.filter(c => c.data().shiftId === d.id);
      for (const c of cs) { await c.ref.delete(); checklistDel++; }
    } else if (s.bookingId && !actives.some(b => b.id === s.bookingId)) {
      const newBooking = actives[0];
      console.log(`[shift更新] id=${d.id} bookingId 付替`);
      await d.ref.update({
        bookingId: newBooking.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  console.log(`\n=== 完了 ===`);
  console.log(`削除: recruitments=${recDel} / shifts=${shiftDel} / checklists=${checklistDel}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
