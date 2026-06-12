// 全スタッフを再アクティブ化 (検証用)
// 使い方:
//   node migration/kawakami-reactivate-staff.js            # 確認のみ
//   node migration/kawakami-reactivate-staff.js --execute  # 実行
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const DRY = !process.argv.includes("--execute");

(async () => {
  console.log(`モード: ${DRY ? "確認のみ" : "実行"}\n`);

  const snap = await db.collection("staff").get();
  console.log(`全スタッフ: ${snap.size}名`);

  const inactive = snap.docs.filter(d => d.data().active === false);
  const active = snap.docs.filter(d => d.data().active !== false);
  console.log(`  active: ${active.length}名 / 非アクティブ: ${inactive.length}名\n`);

  if (inactive.length === 0) {
    console.log("非アクティブスタッフなし。処理不要。");
    process.exit(0);
  }

  console.log("非アクティブ一覧:");
  for (const d of inactive) {
    const s = d.data();
    console.log(`  ${d.id}: ${s.name} (isOwner=${s.isOwner || false})`);
    console.log(`    inactiveAt: ${s.inactiveAt?.toDate ? s.inactiveAt.toDate().toISOString() : s.inactiveAt}`);
    console.log(`    inactiveReason: ${s.inactiveReason || "?"}`);
    console.log(`    pendingRecruitmentIds.length: ${(s.pendingRecruitmentIds || []).length}`);
  }

  if (DRY) {
    console.log("\n→ --execute を付けて実行すると active=true にリセット");
    process.exit(0);
  }

  // 実行
  console.log("\n--- 再アクティブ化実行 ---");
  for (const d of inactive) {
    await d.ref.update({
      active: true,
      inactiveAt: admin.firestore.FieldValue.delete(),
      inactiveReason: admin.firestore.FieldValue.delete(),
      pendingRecruitmentIds: [], // リセット
    });
    console.log(`  ✓ ${d.data().name} を active に戻した`);
  }
  console.log(`\n${inactive.length}名を再アクティブ化完了`);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
