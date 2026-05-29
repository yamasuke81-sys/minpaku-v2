#!/usr/bin/env node
// the Terrace 長浜 (#1) の 5/14-5/17 周辺予約を全数列挙
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const PROP_ID = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜
(async () => {
  // CI が 5/12-5/18 範囲のものを抽出
  const snap = await db.collection("bookings")
    .where("propertyId", "==", PROP_ID)
    .where("checkIn", ">=", "2026-05-12")
    .where("checkIn", "<=", "2026-05-18")
    .get();
  console.log(`予約件数: ${snap.size}`);
  snap.docs.forEach(d => {
    const x = d.data();
    console.log(`\n[${d.id}]`);
    console.log(`  CI=${x.checkIn} CO=${x.checkOut}`);
    console.log(`  source=${x.source} status=${x.status} guestName=${x.guestName}`);
    console.log(`  unverified=${x.unverified} pendingApproval=${x.pendingApproval} manualOverride=${x.manualOverride}`);
    console.log(`  guestCount=${x.guestCount} icalUid=${x.icalUid}`);
    console.log(`  emailVerifiedAt=${x.emailVerifiedAt ? x.emailVerifiedAt.toDate?.().toISOString() : null} emailMessageId=${x.emailMessageId}`);
    console.log(`  cancelledAt=${x.cancelledAt ? x.cancelledAt.toDate?.().toISOString() : null}`);
  });
  // 関連する guestRegistrations
  const gSnap = await db.collection("guestRegistrations")
    .where("propertyId", "==", PROP_ID)
    .where("checkIn", ">=", "2026-05-12")
    .where("checkIn", "<=", "2026-05-18")
    .get();
  console.log(`\n=== guestRegistrations ${gSnap.size}件 ===`);
  gSnap.docs.forEach(d => {
    const x = d.data();
    console.log(`[${d.id}] CI=${x.checkIn} CO=${x.checkOut} name=${x.guestName} bookingId=${x.bookingId}`);
  });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
