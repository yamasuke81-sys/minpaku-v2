// 全staffの pendingRecruitmentIds から孤児IDを除去 + 非アクティブスタッフを再アクティブ化
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const DRY = !process.argv.includes("--execute");

(async () => {
  console.log(`モード: ${DRY ? "確認のみ" : "実行"}\n`);

  // 実在する recruitment ID のセット
  const recSnap = await db.collection("recruitments").get();
  const realIds = new Set(recSnap.docs.map(d => d.id));
  console.log(`実在する recruitment: ${realIds.size}件\n`);

  // 各 staff の pendingRecruitmentIds をチェック
  const staffSnap = await db.collection("staff").get();
  let totalRemoved = 0;
  let reactivated = 0;
  for (const d of staffSnap.docs) {
    const s = d.data();
    const pending = Array.isArray(s.pendingRecruitmentIds) ? s.pendingRecruitmentIds : [];
    const valid = pending.filter(id => realIds.has(id));
    const orphanCount = pending.length - valid.length;
    if (orphanCount === 0 && s.active !== false) continue;

    console.log(`  ${d.id} (${s.name}): pending ${pending.length} → ${valid.length} (孤児 ${orphanCount}件除去) active=${s.active}`);
    const update = {
      pendingRecruitmentIds: valid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    // 非アクティブなら、除去後に 15 未満なら再アクティブ化
    if (s.active === false && valid.length < 15) {
      update.active = true;
      update.inactiveReason = admin.firestore.FieldValue.delete();
      update.inactivatedAt = admin.firestore.FieldValue.delete();
      reactivated++;
      console.log(`    → 再アクティブ化 (pending ${valid.length} < 15)`);
    } else if (s.active === false) {
      console.log(`    → 非アクティブのまま (pending ${valid.length} ≥ 15)`);
    }
    if (!DRY) {
      await d.ref.update(update);
    }
    totalRemoved += orphanCount;
  }

  console.log(`\n合計: 孤児ID ${totalRemoved}件除去 / 再アクティブ化 ${reactivated}名`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
