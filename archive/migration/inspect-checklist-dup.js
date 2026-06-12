// チェックリスト重複調査
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const snap = await db.collection("checklists").get();
  // propertyId+日付でグループ化
  const groups = {};
  for (const d of snap.docs) {
    const x = d.data();
    const date = x.checkoutDate?.toDate ? x.checkoutDate.toDate().toISOString().slice(0, 10) : String(x.checkoutDate || "?").slice(0, 10);
    const key = `${date}__${x.propertyId}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push({ id: d.id, shiftId: x.shiftId, status: x.status, propertyName: x.propertyName, templateAreas: (x.templateSnapshot || []).length });
  }
  console.log("=== 重複している日付+物件 ===");
  let dupCount = 0;
  for (const [key, arr] of Object.entries(groups)) {
    if (arr.length > 1) {
      dupCount++;
      console.log(`\n[${key}] ${arr.length}件 property="${arr[0].propertyName}"`);
      for (const x of arr) {
        console.log(`  ${x.id} shiftId=${x.shiftId} status=${x.status} templateAreas=${x.templateAreas}`);
      }
    }
  }
  console.log(`\n重複グループ: ${dupCount}件`);
  console.log(`チェックリスト総数: ${snap.size}件`);

  // YADO KOMACHI を個別確認
  const yadoCl = snap.docs.filter(d => (d.data().propertyName || "").includes("YADO"));
  console.log(`\n=== YADO KOMACHI のチェックリスト ${yadoCl.length}件 ===`);
  for (const d of yadoCl) {
    const x = d.data();
    const items = (x.templateSnapshot || []).reduce((s, a) => s + (a.items || []).length, 0);
    console.log(`  ${d.id}: areas=${(x.templateSnapshot || []).length} items=${items} status=${x.status}`);
  }

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
