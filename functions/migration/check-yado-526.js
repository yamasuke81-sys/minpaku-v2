#!/usr/bin/env node
// YADO KOMACHI Hiroshima 5/26 CI 予約の現状を確認
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

(async () => {
  const propsSnap = await db.collection("properties")
    .where("name", "==", "YADO KOMACHI Hiroshima")
    .limit(1).get();
  const propId = propsSnap.docs[0].id;
  console.log("propertyId:", propId);

  const bkSnap = await db.collection("bookings")
    .where("propertyId", "==", propId)
    .get();
  console.log(`booking 件数 (全 status): ${bkSnap.size}`);
  const cancelled = bkSnap.docs.filter(d => d.data().status === "cancelled");
  console.log(`status=cancelled: ${cancelled.length}件`);
  cancelled.forEach(d => {
    const b = d.data();
    const ci = b.checkIn?.toDate ? b.checkIn.toDate().toISOString().slice(0,10) : String(b.checkIn).slice(0,10);
    console.log(`  ${d.id}: CI=${ci} cancelledAt=${b.cancelledAt?.toDate?.() || b.cancelledAt} typeof checkIn=${typeof b.checkIn}`);
  });

  // 同じ icalUid または 同じ CI/CO の他 doc を探す
  const targetIcalUid = "1418fb94e984-9ace522714195c3b7bb1b642b639831a@airbnb.com";
  console.log(`---\n同じ iCalUid のdoc:`);
  for (const d of bkSnap.docs) {
    const b = d.data();
    if (b.icalUid === targetIcalUid) {
      console.log(`  ${d.id}: status=${b.status} CI=${b.checkIn} CO=${b.checkOut}`);
    }
  }
  console.log(`---\n同じ CI=2026-05-26 のdoc:`);
  for (const d of bkSnap.docs) {
    const b = d.data();
    if (String(b.checkIn).slice(0,10) === "2026-05-26") {
      console.log(`  ${d.id}: status=${b.status} pendingApproval=${b.pendingApproval} icalUid=${b.icalUid?.slice(0,30)} guestName=${b.guestName}`);
    }
  }

  // 5/26 周辺を探す
  for (const d of bkSnap.docs) {
    const b = d.data();
    const ci = b.checkIn?.toDate ? b.checkIn.toDate().toISOString().slice(0,10) : String(b.checkIn).slice(0,10);
    const co = b.checkOut?.toDate ? b.checkOut.toDate().toISOString().slice(0,10) : String(b.checkOut).slice(0,10);
    if (ci >= "2026-05-25" && ci <= "2026-05-27") {
      console.log(`---\nid=${d.id}`);
      console.log(`  source=${b.source} bookingSite=${b.bookingSite}`);
      console.log(`  CI=${ci} CO=${co}`);
      console.log(`  status=${b.status} pendingApproval=${b.pendingApproval}`);
      console.log(`  guestName=${b.guestName}`);
      console.log(`  iCalUid=${b.iCalUid || "(none)"}`);
      console.log(`  cancelledAt=${b.cancelledAt?.toDate?.() || b.cancelledAt}`);
      console.log(`  syncedAt=${b.syncedAt?.toDate?.() || b.syncedAt}`);
      console.log(`  lastManualEditAt=${b.lastManualEditAt?.toDate?.() || b.lastManualEditAt}`);
      console.log(`  notes=${(b.notes || "").slice(0, 100)}`);
      console.log(`  全フィールド: ${JSON.stringify(Object.keys(b))}`);
      console.log(`  icalUid=${b.icalUid || "(none)"} | syncSource=${b.syncSource} | manualOverride=${b.manualOverride} | emailVerifiedAt=${b.emailVerifiedAt?.toDate?.() || b.emailVerifiedAt}`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
