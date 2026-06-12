// 5/18 YADO KOMACHI Hiroshima ゲスト kimjay の keybox 送信状況を確認
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

(async () => {
  const snap = await db.collection("guestRegistrations")
    .where("checkIn", "==", "2026-05-18")
    .get();
  console.log(`5/18 CI の guestRegistrations: ${snap.size}件`);
  for (const d of snap.docs) {
    const x = d.data();
    console.log("---", d.id);
    console.log("  guestName:", x.guestName);
    console.log("  email:", x.email);
    console.log("  propertyId:", x.propertyId);
    console.log("  status:", x.status);
    console.log("  checkIn:", x.checkIn);
    console.log("  keyboxConfirmedAt:", x.keyboxConfirmedAt ? x.keyboxConfirmedAt.toDate?.().toISOString() : x.keyboxConfirmedAt);
    console.log("  keyboxSentAt:", x.keyboxSentAt ? x.keyboxSentAt.toDate?.().toISOString() : x.keyboxSentAt);
    console.log("  keyboxConfirmToken:", x.keyboxConfirmToken ? "(set)" : "(none)");

    if (x.propertyId) {
      const p = await db.collection("properties").doc(x.propertyId).get();
      if (p.exists) {
        const pd = p.data();
        console.log("  property.name:", pd.name);
        console.log("  property.keyboxSend:", JSON.stringify(pd.keyboxSend, null, 2));
      }
    }
  }
  process.exit(0);
})();
