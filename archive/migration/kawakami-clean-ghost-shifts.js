// 対応する active booking がない未来 shift を削除
// 併せて checklist, recruitment も連動削除
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const PID = "tsZybhDMcPrxqgcRy7wp";
const DRY = !process.argv.includes("--execute");

function isCancelled(s) {
  const x = String(s || "").toLowerCase();
  return x.includes("cancel") || s === "キャンセル" || s === "キャンセル済み";
}

(async () => {
  console.log(`モード: ${DRY ? "確認のみ" : "実行"}\n`);

  const today = new Date().toISOString().slice(0, 10);

  // 1. 未来 shift 一覧
  const shSnap = await db.collection("shifts").where("propertyId", "==", PID).get();
  const futureShifts = shSnap.docs.filter(d => {
    const s = d.data();
    const dstr = s.date?.toDate ? s.date.toDate().toISOString().slice(0, 10) : String(s.date).slice(0, 10);
    return dstr >= today;
  });
  console.log(`未来 shifts: ${futureShifts.length}件`);

  // 2. bookings のマップを作成 (id → active)
  const bSnap = await db.collection("bookings").where("propertyId", "==", PID).get();
  const bookingMap = new Map();
  for (const d of bSnap.docs) {
    const b = d.data();
    bookingMap.set(d.id, { active: !isCancelled(b.status), checkOut: b.checkOut, checkIn: b.checkIn });
  }

  // 3. ghost shift 判定: bookingId が存在しない or その booking が cancelled
  const ghosts = [];
  for (const d of futureShifts) {
    const s = d.data();
    const dstr = s.date?.toDate ? s.date.toDate().toISOString().slice(0, 10) : String(s.date).slice(0, 10);
    const b = s.bookingId ? bookingMap.get(s.bookingId) : null;
    let ghost = false;
    let reason = "";
    if (!s.bookingId) { ghost = true; reason = "bookingId 未設定"; }
    else if (!b) { ghost = true; reason = `booking ${s.bookingId} 不在`; }
    else if (!b.active) { ghost = true; reason = `booking cancelled`; }
    else {
      // shift.date が booking.checkOut (or checkIn for pre_inspection) と一致すべき
      const expectDate = s.workType === "pre_inspection" ? b.checkIn : b.checkOut;
      if (dstr !== expectDate) { ghost = true; reason = `日付不整合 (shift=${dstr}, booking.${s.workType === "pre_inspection" ? "checkIn" : "checkOut"}=${expectDate})`; }
    }
    if (ghost) {
      ghosts.push({ id: d.id, ref: d.ref, dstr, reason, data: s });
    }
  }

  console.log(`\nghost shift: ${ghosts.length}件\n`);
  for (const g of ghosts) {
    console.log(`  [${g.dstr}] ${g.id} workType=${g.data.workType} staff=${g.data.staffName || "?"}`);
    console.log(`    理由: ${g.reason}`);
    console.log(`    bookingId: ${g.data.bookingId || "(なし)"}`);
  }

  if (ghosts.length === 0 || DRY) {
    console.log(`\n${DRY ? "→ --execute で削除" : "削除対象なし"}`);
    process.exit(0);
  }

  console.log(`\n--- 削除実行 ---`);
  for (const g of ghosts) {
    // 対応 checklist
    const clSnap = await db.collection("checklists").where("shiftId", "==", g.id).get();
    for (const c of clSnap.docs) {
      await c.ref.delete();
      console.log(`  checklist ${c.id} 削除`);
    }
    await g.ref.delete();
    console.log(`  shift ${g.id} 削除`);
  }

  // 4. 対応する recruitments で ghost を同様に削除
  console.log(`\n--- ghost recruitments 探索 ---`);
  const recSnap = await db.collection("recruitments").where("propertyId", "==", PID).get();
  const futureRecs = recSnap.docs.filter(d => (d.data().checkoutDate || "") >= today);
  const recGhosts = [];
  for (const d of futureRecs) {
    const r = d.data();
    const b = r.bookingId ? bookingMap.get(r.bookingId) : null;
    let ghost = false;
    let reason = "";
    if (!r.bookingId) { ghost = true; reason = "bookingId 未設定"; }
    else if (!b) { ghost = true; reason = `booking ${r.bookingId} 不在`; }
    else if (!b.active) { ghost = true; reason = `booking cancelled`; }
    else {
      const expectDate = r.workType === "pre_inspection" ? b.checkIn : b.checkOut;
      if (r.checkoutDate !== expectDate) { ghost = true; reason = `日付不整合 (rec=${r.checkoutDate}, booking.${r.workType === "pre_inspection" ? "checkIn" : "checkOut"}=${expectDate})`; }
    }
    if (ghost) recGhosts.push({ id: d.id, ref: d.ref, data: r, reason });
  }
  console.log(`ghost recruitments: ${recGhosts.length}件`);
  for (const g of recGhosts) {
    console.log(`  [${g.data.checkoutDate}] rec ${g.id} ${g.reason}`);
    await g.ref.delete();
    console.log(`    削除完了`);
  }

  console.log(`\n削除完了: shift ${ghosts.length}件, rec ${recGhosts.length}件`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
