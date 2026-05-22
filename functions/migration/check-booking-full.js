#!/usr/bin/env node
const a = require("firebase-admin");
a.initializeApp({ projectId: "minpaku-v2" });
const db = a.firestore();
(async () => {
  const d = await db.collection("bookings").doc("ical_30ae68575282331af1f1aac535cbca16@booking.com").get();
  console.log("=== booking 全フィールド ===");
  console.log(JSON.stringify(d.data(), null, 2));
  // guestRegistrations も
  console.log("\n=== guestRegistrations (bookingId 紐付け or 同日) ===");
  const gSnap = await db.collection("guestRegistrations")
    .where("bookingId", "==", "ical_30ae68575282331af1f1aac535cbca16@booking.com")
    .get();
  console.log(`bookingId 紐付け: ${gSnap.size}件`);
  gSnap.forEach(d => {
    console.log(JSON.stringify(d.data(), null, 2));
  });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
