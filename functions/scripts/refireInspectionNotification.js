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

  // 引数 (環境変数 DATE) で日付指定があればその日付、なければ最新 1件を再発火
  // 例: DATE=2026-05-23 node functions/scripts/refireInspectionNotification.js
  const dateFilter = process.env.DATE || "";
  let targets;
  if (dateFilter) {
    targets = all.filter(({ c }) => {
      if (!c.completedAt || !c.completedAt.toDate) return false;
      return c.completedAt.toDate().toISOString().slice(0, 10) === dateFilter;
    });
    console.log(`日付フィルタ ${dateFilter} で該当: ${targets.length}件`);
  } else {
    // completedAt 降順で最新 1件
    targets = all
      .filter(({ c }) => c.completedAt && c.completedAt.toDate)
      .sort((a, b) => b.c.completedAt.toMillis() - a.c.completedAt.toMillis())
      .slice(0, 1);
    console.log(`最新の completed 1件を対象: ${targets.length}件`);
  }

  if (targets.length === 0) {
    console.log("→ 対象なし。終了。");
    return;
  }

  for (const { id, c } of targets) {
    console.log(`[再発火] id=${id}`);
    const ref = db.collection("checklists").doc(id);
    // 元の completedAt を保存しておき、後で復元する (再発火で書き換えないため)
    const originalCompletedAt = c.completedAt;
    await ref.update({ status: "in_progress", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    console.log(`  → in_progress (1.5秒待機)`);
    await new Promise(r => setTimeout(r, 1500));
    await ref.update({
      status: "completed",
      // completedAt は元の値を維持 (上書きしない)
      completedAt: originalCompletedAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`  → completed (onChecklistComplete 発火するはず)`);
  }
})().catch(e => { console.error(e); process.exit(1); });
