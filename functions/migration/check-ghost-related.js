const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const GHOST_ID = "ical_2e707c2f1501414227ebf02b54cc09ef@booking.com";
(async () => {
  const sh = await db.collection("shifts").where("bookingId", "==", GHOST_ID).get();
  console.log(`shifts: ${sh.size}件`);
  sh.docs.forEach(d => console.log(`  [${d.id}] date=${d.data().date} workType=${d.data().workType} status=${d.data().status}`));
  const re = await db.collection("recruitments").where("bookingId", "==", GHOST_ID).get();
  console.log(`recruitments: ${re.size}件`);
  re.docs.forEach(d => console.log(`  [${d.id}] checkoutDate=${d.data().checkoutDate} status=${d.data().status}`));
  const cl = await db.collection("checklists").where("bookingId", "==", GHOST_ID).get();
  console.log(`checklists: ${cl.size}件`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
