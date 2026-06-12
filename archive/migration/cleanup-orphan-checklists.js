// 孤児チェックリスト削除: shiftId が実在しない checklist を削除
// 使い方:
//   node migration/cleanup-orphan-checklists.js           # dry-run
//   node migration/cleanup-orphan-checklists.js --execute # 実削除

const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const DRY = !process.argv.includes("--execute");

(async () => {
  console.log(`モード: ${DRY ? "確認のみ (削除しない)" : "実削除"}`);
  const snap = await db.collection("checklists").get();
  console.log(`チェックリスト総数: ${snap.size}件`);

  // 全 shiftId を一括取得
  const allShiftIds = new Set();
  const shiftsSnap = await db.collection("shifts").get();
  shiftsSnap.docs.forEach(d => allShiftIds.add(d.id));
  console.log(`存在する shift 数: ${allShiftIds.size}`);

  let orphanCount = 0;
  let deleted = 0;
  for (const d of snap.docs) {
    const x = d.data();
    if (!x.shiftId || !allShiftIds.has(x.shiftId)) {
      orphanCount++;
      const date = x.checkoutDate?.toDate ? x.checkoutDate.toDate().toISOString().slice(0, 10) : "?";
      console.log(`  孤児: ${d.id} [${date}] ${x.propertyName || ""} shiftId=${x.shiftId || "(未設定)"}`);
      if (!DRY) {
        await d.ref.delete();
        deleted++;
      }
    }
  }
  console.log(`\n孤児: ${orphanCount}件 / ${DRY ? "削除スキップ" : `削除: ${deleted}件`}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
