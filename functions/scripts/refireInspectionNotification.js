// the Terrace 長浜 の直前点検完了チェックリスト一覧 + 再発火
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const PROPERTY_ID = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜
  const TARGET_DATE = "2026-05-23"; // 再発火対象日 (空文字なら最新の completed を対象)

  const snap = await db.collection("checklists")
    .where("propertyId", "==", PROPERTY_ID)
    .get();
  console.log(`物件 ${PROPERTY_ID} の checklist 総数: ${snap.size}\n`);

  // pre_inspection + completed を全部抽出 (日付フィルタなし)
  const all = snap.docs
    .map(d => ({ id: d.id, c: d.data() }))
    .filter(({ c }) => c.workType === "pre_inspection" && c.status === "completed");

  console.log(`pre_inspection + completed の全件: ${all.length}件\n`);

  // 全件ダンプ
  for (const { id, c } of all) {
    const completedAtIso = c.completedAt && c.completedAt.toDate
      ? c.completedAt.toDate().toISOString().slice(0, 16)
      : "(なし)";
    console.log(`id=${id}`);
    console.log(`  date=${c.date}  checkoutDate=${c.checkoutDate}  shiftDate=${c.shiftDate}  inspectionDate=${c.inspectionDate}`);
    console.log(`  staffName=${c.staffName || "(空)"}  completedAt=${completedAtIso}`);
    console.log("");
  }

  // 対象日に該当するもの: completedAt (Firestore Timestamp) の YYYY-MM-DD を比較
  const targets = all.filter(({ c }) => {
    if (!c.completedAt || !c.completedAt.toDate) return false;
    const iso = c.completedAt.toDate().toISOString().slice(0, 10);
    return iso === TARGET_DATE;
  });

  console.log(`\n対象日 ${TARGET_DATE} を含むドキュメント: ${targets.length}件`);
  if (targets.length === 0) {
    console.log("→ 対象なし。終了。");
    return;
  }

  for (const { id } of targets) {
    console.log(`[再発火] id=${id}`);
    const ref = db.collection("checklists").doc(id);
    await ref.update({ status: "in_progress", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    console.log(`  → in_progress (1.5秒待機)`);
    await new Promise(r => setTimeout(r, 1500));
    await ref.update({
      status: "completed",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`  → completed (onChecklistComplete 発火するはず)`);
  }
})().catch(e => { console.error(e); process.exit(1); });
