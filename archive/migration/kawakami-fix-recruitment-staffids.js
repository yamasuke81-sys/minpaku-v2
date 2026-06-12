/**
 * recruitments.selectedStaffIds の不整合を全件修復 (DRY_RUN=1 で事前確認可)
 *
 * 背景:
 *   api.js の selectStaff が以前は selectedStaff (名前) のみ Firestore に書いて
 *   selectedStaffIds (配列) を更新しなかった。そのため古い recruitment では
 *   selectedStaff のスタッフ名の一部が selectedStaffIds から欠落している。
 *   結果として onRecruitmentChange トリガーが shift を生成できず、確定済み
 *   スタッフの請求書に反映されない。
 *
 * 動作:
 *   1. staff コレクションから name → staffId マップを構築
 *   2. 全 recruitments を走査し、selectedStaff (名前カンマ区切り) を
 *      staffId 配列に解決
 *   3. 解決結果が selectedStaffIds と違う recruitment を一覧表示 (DRY RUN)
 *   4. 本番実行時は selectedStaffIds を上書き + updatedAt 更新
 *      → onRecruitmentChange トリガーが発火し shift 自動生成
 *
 * 使い方:
 *   DRY_RUN=1 node functions/migration/kawakami-fix-recruitment-staffids.js
 *   node functions/migration/kawakami-fix-recruitment-staffids.js   (本番実行)
 */
const admin = require("firebase-admin");

admin.initializeApp({
  projectId: "minpaku-v2",
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();

const DRY_RUN = process.env.DRY_RUN === "1";

(async () => {
  console.log(`==== recruitments selectedStaffIds 整合調査 ${DRY_RUN ? "(DRY RUN)" : "(本番実行)"} ====\n`);

  // 1. staff マップ構築 (name → id)
  const staffSnap = await db.collection("staff").get();
  const nameToId = {};
  const idToName = {};
  staffSnap.forEach(d => {
    const data = d.data();
    if (data.name) {
      nameToId[data.name.trim()] = d.id;
      idToName[d.id] = data.name.trim();
    }
  });
  console.log(`staff 登録数: ${Object.keys(nameToId).length}`);

  // 2. 全 recruitments
  const recSnap = await db.collection("recruitments").get();
  console.log(`recruitments 件数: ${recSnap.size}\n`);

  const mismatches = [];
  recSnap.forEach(d => {
    const r = d.data();
    const selectedStaff = (r.selectedStaff || "").trim();
    if (!selectedStaff) return; // 未選定はスキップ

    const names = selectedStaff.split(/[,、\s]+/).map(s => s.trim()).filter(Boolean);
    const expectedIds = names.map(n => nameToId[n]).filter(Boolean);
    const actualIds = Array.isArray(r.selectedStaffIds) ? r.selectedStaffIds : [];

    const expectedSorted = [...expectedIds].sort().join(",");
    const actualSorted = [...actualIds].sort().join(",");

    if (expectedSorted !== actualSorted) {
      const missingIds = expectedIds.filter(id => !actualIds.includes(id));
      const missingNames = missingIds.map(id => idToName[id]).filter(Boolean);
      const extraIds = actualIds.filter(id => !expectedIds.includes(id));
      const extraNames = extraIds.map(id => idToName[id] || `(不明:${id})`);
      const unresolvedNames = names.filter(n => !nameToId[n]); // staff コレクションに該当なし

      mismatches.push({
        id: d.id,
        checkoutDate: r.checkoutDate,
        status: r.status,
        selectedStaff,
        expectedIds,
        actualIds,
        missingNames,
        extraNames,
        unresolvedNames,
      });
    }
  });

  console.log(`不整合 recruitments: ${mismatches.length}件\n`);

  mismatches.forEach(m => {
    console.log(`[${m.id}] ${m.checkoutDate} (${m.status})`);
    console.log(`  selectedStaff: "${m.selectedStaff}"`);
    console.log(`  actualIds: ${JSON.stringify(m.actualIds)}`);
    console.log(`  expectedIds: ${JSON.stringify(m.expectedIds)}`);
    if (m.missingNames.length) console.log(`  → 追加すべき: ${m.missingNames.join(", ")}`);
    if (m.extraNames.length) console.log(`  → 除去すべき: ${m.extraNames.join(", ")}`);
    if (m.unresolvedNames.length) console.log(`  ⚠ staff コレクションに見つからない名前: ${m.unresolvedNames.join(", ")}`);
  });

  if (DRY_RUN) {
    console.log("\n[DRY RUN] 本番実行時は各 recruitment を expectedIds で上書き + updatedAt 更新 (onRecruitmentChange 発火)");
    process.exit(0);
  }

  // 3. 本番実行: selectedStaffIds 上書き + updatedAt 更新
  console.log("\n==== 修復実行 ====");
  let updated = 0;
  for (const m of mismatches) {
    if (m.unresolvedNames.length) {
      console.log(`[SKIP] ${m.id}: 未解決名前があるため手動確認必要 (${m.unresolvedNames.join(", ")})`);
      continue;
    }
    await db.collection("recruitments").doc(m.id).update({
      selectedStaffIds: m.expectedIds,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    updated++;
    console.log(`[OK] ${m.id}: selectedStaffIds を ${m.expectedIds.length} 件に更新`);
  }
  console.log(`\n==== 完了: ${updated}件 修復 ====`);
  process.exit(0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
