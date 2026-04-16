/**
 * 全スタッフに assignedPropertyIds: [] を初期化 (既にあれば保持)
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const snap = await db.collection("staff").get();
  console.log(`staff 総数: ${snap.size}`);
  let updated = 0, kept = 0;
  for (const d of snap.docs) {
    const x = d.data();
    if (Array.isArray(x.assignedPropertyIds)) { kept++; continue; }
    await d.ref.update({
      assignedPropertyIds: [],
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    updated++;
  }
  console.log(`初期化: ${updated}件 / 既存保持: ${kept}件`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
