const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const PROP = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜
(async () => {
  console.log("=== Property inspection 設定 ===");
  const p = await db.collection("properties").doc(PROP).get();
  console.log(JSON.stringify(p.data().inspection, null, 2));

  console.log("\n=== 6/1 checkIn の予約 ===");
  const inBk = await db.collection("bookings").where("propertyId", "==", PROP).where("checkIn", "==", "2026-06-01").get();
  inBk.docs.forEach(d => console.log(d.id, d.data().guestName, "CI", d.data().checkIn, "CO", d.data().checkOut, "status", d.data().status));

  console.log("\n=== 6/1 checkOut の予約 (同日 CO ありなら直前点検スキップ) ===");
  const outBk = await db.collection("bookings").where("propertyId", "==", PROP).where("checkOut", "==", "2026-06-01").get();
  outBk.docs.forEach(d => console.log(d.id, d.data().guestName, "CI", d.data().checkIn, "CO", d.data().checkOut, "status", d.data().status));

  console.log("\n=== 6/1 直前点検 recruitments ===");
  const recs = await db.collection("recruitments").where("propertyId", "==", PROP).where("checkoutDate", "==", "2026-06-01").get();
  recs.docs.forEach(d => {
    const x = d.data();
    console.log(d.id, "workType=", x.workType, "status=", x.status, "bookingId=", x.bookingId, "manualCreated=", x.manualCreated);
  });

  console.log("\n=== 6/1 直前点検 shifts ===");
  const dt = new Date("2026-06-01T00:00:00.000Z");
  const sh = await db.collection("shifts").where("propertyId", "==", PROP).where("date", "==", dt).get();
  sh.docs.forEach(d => {
    const x = d.data();
    console.log(d.id, "workType=", x.workType, "status=", x.status, "bookingId=", x.bookingId);
  });
  process.exit(0);
})();
