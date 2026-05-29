const a = require("firebase-admin");
a.initializeApp({ projectId: "minpaku-v2" });
const db = a.firestore();
(async () => {
  const id = "ical_1418fb94e984-cfb48d2ceaa6181fe2bab0da414b0581@airbnb.com";
  await db.collection("bookings").doc(id).update({
    pendingApproval: false,
    pendingApprovalResolvedAt: a.firestore.FieldValue.serverTimestamp(),
    unverified: false,
    unverifiedResolvedAt: a.firestore.FieldValue.serverTimestamp(),
  });
  console.log("濵田の booking pendingApproval/unverified を false に降下");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
