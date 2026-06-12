// 全スタッフの pendingRecruitmentIds に孤児IDが存在しないことを確認する
// 使い方: node verify-pending-integrity.js
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  // 実在する recruitment ID のセット
  const recSnap = await db.collection("recruitments").get();
  const realIds = new Set(recSnap.docs.map(d => d.id));
  console.log(`実在する recruitment: ${realIds.size}件`);

  const staffSnap = await db.collection("staff").get();
  let orphanTotal = 0;
  let problemCount = 0;

  for (const d of staffSnap.docs) {
    const s = d.data();
    const pending = Array.isArray(s.pendingRecruitmentIds) ? s.pendingRecruitmentIds : [];
    const orphans = pending.filter(id => !realIds.has(id));
    if (orphans.length > 0) {
      console.log(`  NG: ${d.id} (${s.name}) — 孤児ID ${orphans.length}件: ${orphans.join(", ")}`);
      orphanTotal += orphans.length;
      problemCount++;
    }
  }

  console.log(`\n--- 結果 ---`);
  if (orphanTotal === 0) {
    console.log(`OK: 孤児IDは 0 件。全スタッフの pendingRecruitmentIds は整合しています。`);
  } else {
    console.log(`NG: ${problemCount}名のスタッフに 合計 ${orphanTotal} 件の孤児IDが存在します。`);
    process.exit(1);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
