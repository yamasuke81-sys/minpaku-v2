const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const GHOST_ID = "ical_2e707c2f1501414227ebf02b54cc09ef@booking.com";
(async () => {
  const ref = db.collection("bookings").doc(GHOST_ID);
  const snap = await ref.get();
  if (!snap.exists) { console.log("既に存在しない"); process.exit(0); }
  const x = snap.data();
  console.log(`削除対象: CI=${x.checkIn} CO=${x.checkOut} guestName=${x.guestName} unverified=${x.unverified}`);
  await ref.delete();
  console.log("削除完了");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
