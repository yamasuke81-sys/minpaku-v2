const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  const snap = await db.doc("settings/notifications").get();
  const ch = snap.data()?.channels?.booking_cancel;
  console.log("booking_cancel ch:", JSON.stringify(ch, null, 2));
})();
