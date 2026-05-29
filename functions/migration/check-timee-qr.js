const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  const props = await db.collection("properties").where("active", "==", true).get();
  for (const p of props.docs) {
    const d = p.data();
    console.log(`${d.name} (${p.id}): timeeQrImageUrl = ${d.timeeQrImageUrl ? d.timeeQrImageUrl.slice(0, 80) + "..." : "(未設定)"}`);
  }
})();
