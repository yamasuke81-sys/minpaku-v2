#!/usr/bin/env node
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  const ids = [
    "ical_1418fb94e984-aa5930758810eab7bc5a5645f70d7dd4@airbnb.com",
    "ical_1418fb94e984-cbb5aa4627ee6b6205fe929e2d48be99@airbnb.com",
  ];
  for (const id of ids) {
    const snap = await db.collection("bookings").doc(id).get();
    if (!snap.exists) { console.log(`${id} → 存在しません`); continue; }
    const d = snap.data();
    console.log(`\n${id}`);
    console.log(`  propertyId: ${JSON.stringify(d.propertyId)}`);
    console.log(`  propertyName: ${JSON.stringify(d.propertyName)}`);
    console.log(`  guestName: ${JSON.stringify(d.guestName)}`);
    console.log(`  checkIn: ${JSON.stringify(d.checkIn)}`);
    console.log(`  checkOut: ${JSON.stringify(d.checkOut)}`);
    console.log(`  status: ${JSON.stringify(d.status)}`);
    console.log(`  source: ${JSON.stringify(d.source)}`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
