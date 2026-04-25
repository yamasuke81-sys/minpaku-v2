#!/usr/bin/env node
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

(async () => {
  const kajimotoId = "CnMxtJe9AP3VgNlbXKry";
  // 4月の recruitments
  const snap = await db.collection("recruitments")
    .where("checkoutDate", ">=", "2026-04-01")
    .where("checkoutDate", "<=", "2026-04-30")
    .get();
  console.log(`=== 2026/4 recruitments: ${snap.size}件 ===`);
  for (const d of snap.docs) {
    const v = d.data();
    const hit = (v.selectedStaffIds || []).includes(kajimotoId);
    console.log(`\n${d.id} ${hit ? "[梶本選定]" : ""}`);
    console.log(`  checkoutDate: ${v.checkoutDate}`);
    console.log(`  status: ${v.status}`);
    console.log(`  selectedStaff: ${JSON.stringify(v.selectedStaff)}`);
    console.log(`  selectedStaffIds: ${JSON.stringify(v.selectedStaffIds)}`);
    console.log(`  propertyId: ${v.propertyId}`);
    console.log(`  confirmedAt: ${v.confirmedAt?.toDate ? v.confirmedAt.toDate().toISOString() : v.confirmedAt}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
