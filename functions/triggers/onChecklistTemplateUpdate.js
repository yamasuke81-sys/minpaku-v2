/**
 * チェックリスト原紙 (checklistTemplates) 更新時トリガー
 *
 * 仕様 (方針B):
 * - 該当物件の「未着手」checklist の templateSnapshot を最新版に差し替える
 * - 未着手の定義: status !== "completed" かつ itemStates が全て未チェック (checked/needsRestock いずれも false/undefined)
 * - 着手済みまたは完了済みは保持 (過去・進行中の履歴を壊さない)
 * - 項目ID 単位で smart merge (既存 itemStates は ID が新 areas に存在すれば維持、無ければ破棄)
 *
 * 発火条件: checklistTemplates/{propertyId} の areas フィールドが変更された時のみ
 */
const admin = require("firebase-admin");

function collectItemIds(areas) {
  const ids = new Set();
  const walk = (node) => {
    (node.items || node.directItems || []).forEach(it => { if (it && it.id) ids.add(it.id); });
    (node.taskTypes || []).forEach(walk);
    (node.subCategories || []).forEach(walk);
    (node.subSubCategories || []).forEach(walk);
  };
  (areas || []).forEach(walk);
  return ids;
}

function isPristine(states) {
  if (!states || typeof states !== "object") return true;
  return !Object.values(states).some(s => s && (s.checked || s.needsRestock));
}

module.exports = async (event) => {
  const db = admin.firestore();
  const propertyId = event.params.propertyId;
  const before = event.data?.before?.data();
  const after = event.data?.after?.data();

  if (!after) return;

  // areas に変更がなければスキップ (version フィールドだけの書き換え等)
  const beforeJson = JSON.stringify((before && before.areas) || []);
  const afterJson = JSON.stringify(after.areas || []);
  if (beforeJson === afterJson) {
    return;
  }

  const newAreas = after.areas || [];
  const newVersion = after.version || 1;
  const newItemIds = collectItemIds(newAreas);

  // 該当物件の全 checklist を取得
  const snap = await db.collection("checklists")
    .where("propertyId", "==", propertyId)
    .get();

  let updated = 0;
  let skippedCompleted = 0;
  let skippedInProgress = 0;

  for (const doc of snap.docs) {
    const c = doc.data();
    if (c.status === "completed") { skippedCompleted++; continue; }
    if (!isPristine(c.itemStates)) { skippedInProgress++; continue; }

    // 未着手: テンプレを最新版に差し替え
    // itemStates は pristine なので空のまま更新 (smart merge の必要なし)
    await doc.ref.update({
      templateSnapshot: newAreas,
      templateVersion: newVersion,
      templateSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    updated++;
  }

  console.log(
    `[onChecklistTemplateUpdate] property=${propertyId} ` +
    `updated=${updated} skipped(completed=${skippedCompleted}, inProgress=${skippedInProgress})`
  );
};
