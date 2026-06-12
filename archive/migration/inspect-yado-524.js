const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

(async () => {
  const PID = "RZV9IwtQgMAsvrdM3j8J";
  console.log("=== YADO KOMACHI 5/24 周辺 ===");

  for (const date of ["2026-05-24", "2026-05-25"]) {
    const r = await db.collection("recruitments")
      .where("propertyId", "==", PID)
      .where("checkoutDate", "==", date).get();
    console.log(`recruitments ${date}: ${r.size}件`);
    r.forEach((d) => {
      const x = d.data();
      console.log(`  - ${d.id} status=${x.status} bookingId=${x.bookingId} workType=${x.workType || "cleaning"} prevCO=${x.previousCheckoutDate || "-"} manualDC=${x.manualDateChange || false}`);
    });
  }

  for (const ds of ["2026-05-24", "2026-05-25"]) {
    const dt = new Date(ds + "T00:00:00.000Z");
    const s = await db.collection("shifts")
      .where("propertyId", "==", PID)
      .where("date", "==", dt).get();
    console.log(`shifts ${ds}: ${s.size}件`);
    s.forEach((d) => {
      const x = d.data();
      console.log(`  - ${d.id} workType=${x.workType} bookingId=${x.bookingId} status=${x.status}`);
    });
  }

  const b = await db.collection("bookings")
    .where("propertyId", "==", PID)
    .where("checkOut", "==", "2026-05-24").get();
  console.log(`bookings checkOut=5/24: ${b.size}件`);
  b.forEach((d) => {
    const x = d.data();
    console.log(`  - ${d.id} status=${x.status} CI=${x.checkIn} guest=${x.guestName}`);
  });
  process.exit(0);
})().catch((e) => { console.error("ERR:", e); process.exit(1); });
