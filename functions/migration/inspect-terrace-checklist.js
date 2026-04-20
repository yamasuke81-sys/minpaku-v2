// the Terrace 長浜 のチェックリストで 29 がどう計算されているか
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

function countItemsOld(areas) {
  let n = 0;
  const walk = (node) => {
    (node.items || []).forEach(() => n++);
    (node.taskTypes || []).forEach(walk);
    (node.subCategories || []).forEach(walk);
    (node.subSubCategories || []).forEach(walk);
  };
  areas.forEach(walk);
  return n;
}
function countItemsFixed(areas) {
  let n = 0;
  const walk = (node) => {
    (node.items || []).forEach(() => n++);
    (node.directItems || []).forEach(() => n++);
    (node.taskTypes || []).forEach(walk);
    (node.subCategories || []).forEach(walk);
    (node.subSubCategories || []).forEach(walk);
  };
  areas.forEach(walk);
  return n;
}

(async () => {
  const snap = await db.collection("checklists")
    .where("propertyId", "==", "tsZybhDMcPrxqgcRy7wp").limit(1).get();
  if (snap.empty) { console.log("なし"); process.exit(0); }
  const cl = snap.docs[0].data();
  const areas = cl.templateSnapshot || [];
  console.log(`the Terrace 長浜 チェックリスト ${snap.docs[0].id}`);
  console.log(`areas: ${areas.length}`);
  for (const a of areas) {
    const di = (a.directItems || []).length;
    const it = (a.items || []).length;
    const tt = (a.taskTypes || []).length;
    console.log(`  [${a.id}] ${a.name}: items=${it} directItems=${di} taskTypes=${tt}`);
    // taskTypes の中身を覗く
    if (tt > 0) {
      for (const t of (a.taskTypes || []).slice(0, 1)) {
        const ti = (t.items || []).length;
        const td = (t.directItems || []).length;
        console.log(`    taskType[0]: ${t.name || t.id || "?"} items=${ti} directItems=${td}`);
        console.log(`      全キー: ${Object.keys(t).join(", ")}`);
      }
    }
  }
  console.log(`\n現行ロジック countItems (items+taskTypes): ${countItemsOld(areas)}`);
  console.log(`修正案 countItems (+directItems): ${countItemsFixed(areas)}`);

  // YADO も同じ関数で
  const snap2 = await db.collection("checklists")
    .where("propertyId", "==", "RZV9IwtQgMAsvrdM3j8J").limit(1).get();
  if (!snap2.empty) {
    const cl2 = snap2.docs[0].data();
    const areas2 = cl2.templateSnapshot || [];
    console.log(`\n--- YADO KOMACHI ---`);
    console.log(`現行: ${countItemsOld(areas2)} / 修正案: ${countItemsFixed(areas2)}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
