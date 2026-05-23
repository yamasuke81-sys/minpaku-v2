// 孤児データ確認用スクリプト
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const docId = "42nwQNakMYi74tJpT5uP";
  const doc = await db.collection("checklistTemplates").doc(docId).get();
  if (!doc.exists) {
    console.log("ドキュメント存在しません");
    return;
  }
  const data = doc.data();
  console.log("=== checklistTemplates/" + docId + " ===");
  console.log("propertyId:", data.propertyId);
  console.log("version:", data.version);
  console.log("updatedAt:", data.updatedAt && data.updatedAt.toDate ? data.updatedAt.toDate().toISOString() : data.updatedAt);
  console.log("areas 数:", Array.isArray(data.areas) ? data.areas.length : "なし");
  if (Array.isArray(data.areas)) {
    data.areas.forEach((a, i) => {
      const l2 = Array.isArray(a.taskTypes) ? a.taskTypes.length : 0;
      console.log(`  [${i}] ${a.name || a.id}  (L2: ${l2}件)`);
    });
  }

  // propertyId フィールドの参照先
  if (data.propertyId) {
    const propDoc = await db.collection("properties").doc(data.propertyId).get();
    console.log("\n--- propertyId が指す物件 ---");
    if (!propDoc.exists) {
      console.log("該当 properties ドキュメントなし（完全孤児）");
    } else {
      const p = propDoc.data();
      console.log("name:", p.name);
      console.log("active:", p.active);
    }
  }

  // 同じ propertyId で _cleaning が存在するか
  if (data.propertyId) {
    const altDoc = await db.collection("checklistTemplates").doc(`${data.propertyId}_cleaning`).get();
    console.log(`\n--- ${data.propertyId}_cleaning 存在: ${altDoc.exists} ---`);
    if (altDoc.exists) {
      const a = altDoc.data();
      console.log("areas 数:", Array.isArray(a.areas) ? a.areas.length : "なし");
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
