const a = require("firebase-admin");
a.initializeApp({ projectId: "minpaku-v2" });
const db = a.firestore();
(async () => {
  const id = "ical_1418fb94e984-cfb48d2ceaa6181fe2bab0da414b0581@airbnb.com";
  const x = (await db.collection("bookings").doc(id).get()).data();
  console.log(JSON.stringify({
    CI: x.checkIn, CO: x.checkOut, status: x.status, guestName: x.guestName,
    guestCount: x.guestCount, source: x.source,
    pendingApproval: x.pendingApproval, unverified: x.unverified,
    emailVerifiedAt: x.emailVerifiedAt?.toDate?.()?.toISOString(),
    emailMessageId: x.emailMessageId,
  }, null, 2));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
