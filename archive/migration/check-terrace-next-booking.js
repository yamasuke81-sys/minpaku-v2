#!/usr/bin/env node
// the Terrace 長浜の 2026-05-23 入りの booking と関連 recruitment/staff を確認
const a = require("firebase-admin");
a.initializeApp({ projectId: "minpaku-v2" });
const db = a.firestore();
(async () => {
  const pid = "tsZybhDMcPrxqgcRy7wp";
  // 2026-05-23 周辺の booking
  const bSnap = await db.collection("bookings")
    .where("propertyId", "==", pid)
    .where("checkIn", ">=", "2026-05-20")
    .where("checkIn", "<=", "2026-05-30")
    .get();
  console.log("=== the Terrace 長浜 2026-05-20〜30 の bookings ===");
  for (const d of bSnap.docs) {
    const x = d.data();
    console.log(`\n--- ${d.id} ---`);
    console.log(`  checkIn=${x.checkIn} / checkOut=${x.checkOut}`);
    console.log(`  guestName=${x.guestName || "(なし)"}`);
    console.log(`  guestCount=${JSON.stringify(x.guestCount)}`);
    console.log(`  guestCountInfants=${JSON.stringify(x.guestCountInfants)}`);
    console.log(`  source=${x.source}`);
    console.log(`  status=${x.status}`);
  }
  // 2026-05-23 の shifts (清掃日 = 5/24 の shift) と関連 recruitment
  console.log("\n\n=== shifts (date=2026-05-24) ===");
  const sSnap = await db.collection("shifts").where("propertyId", "==", pid).get();
  for (const d of sSnap.docs) {
    const s = d.data();
    const sd = s.date && s.date.toDate ? s.date.toDate() : null;
    const ds = sd ? sd.toISOString().slice(0, 10) : "(不明)";
    if (ds < "2026-05-23" || ds > "2026-05-25") continue;
    console.log(`\n--- shift ${d.id} (${ds}) ---`);
    console.log(`  staffIds: ${JSON.stringify(s.staffIds)}`);
    console.log(`  staffName: ${s.staffName}`);
    console.log(`  bookingId: ${s.bookingId}`);
    // staff 解決
    if (Array.isArray(s.staffIds)) {
      for (const sid of s.staffIds) {
        const stf = await db.collection("staff").doc(sid).get();
        if (stf.exists) {
          const sd = stf.data();
          console.log(`    staff[${sid}]: name=${sd.name} isTimee=${sd.isTimee}`);
        }
      }
    }
  }
  // 同期間の recruitment
  console.log("\n\n=== recruitments (checkoutDate=2026-05-24) ===");
  const rSnap = await db.collection("recruitments")
    .where("propertyId", "==", pid)
    .where("checkoutDate", "==", "2026-05-24")
    .get();
  for (const d of rSnap.docs) {
    const r = d.data();
    console.log(`\n--- recruitment ${d.id} ---`);
    console.log(`  status: ${r.status}`);
    console.log(`  selectedStaff: ${r.selectedStaff}`);
    console.log(`  selectedStaffIds: ${JSON.stringify(r.selectedStaffIds)}`);
    console.log(`  timeeOverrideNames: ${JSON.stringify(r.timeeOverrideNames)}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
