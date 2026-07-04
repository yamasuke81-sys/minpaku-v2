/**
 * チェックリスト原紙 (checklistTemplates) 更新時トリガー
 *
 * 仕様 (方針B):
 * - 該当物件・該当作業種別の「未着手」checklist の templateSnapshot を最新版に差し替える
 * - 未着手の定義: status !== "completed" かつ itemStates が全て未チェック (checked/needsRestock いずれも false/undefined)
 * - 着手済みまたは完了済みは保持 (過去・進行中の履歴を壊さない)
 * - 項目ID 単位で smart merge (既存 itemStates は ID が新 areas に存在すれば維持、無ければ破棄)
 *
 * 発火条件: checklistTemplates/{docId} の areas フィールドが変更された時のみ
 *
 * 注意: 原紙の docId は新スキーマで `${propertyId}_${workType}` (例 xxx_pre_inspection)。
 *       ワイルドカードはこの docId 全体を捕捉するため、物件IDと作業種別は
 *       原紙ドキュメントの propertyId / workType フィールドから取得する
 *       (フィールドが無い旧スキーマは docId から導出)。
 *       作業種別でフィルタしないと清掃原紙が直前点検 checklist を上書きする逆汚染が起きる。
 */
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

// checklist.workType には shift 由来の cleaning_by_count 等が入るため正規化して比較する
function normWt(w) {
  return w === "pre_inspection" ? "pre_inspection" : "cleaning";
}

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
  const docId = event.params.propertyId; // 新スキーマでは `${propertyId}_${workType}`
  const before = event.data?.before?.data();
  const after = event.data?.after?.data();

  if (!after) return;

  // areas に変更がなければスキップ (version フィールドだけの書き換え等)
  const beforeJson = JSON.stringify((before && before.areas) || []);
  const afterJson = JSON.stringify(after.areas || []);
  if (beforeJson === afterJson) {
    return;
  }

  // 物件IDと作業種別を解決: 原紙のフィールドを優先し、無ければ docId 末尾から導出
  let propertyId = after.propertyId;
  let workType = after.workType;
  if (!propertyId) {
    if (docId.endsWith("_pre_inspection")) {
      propertyId = docId.slice(0, -"_pre_inspection".length);
      workType = workType || "pre_inspection";
    } else if (docId.endsWith("_cleaning")) {
      propertyId = docId.slice(0, -"_cleaning".length);
      workType = workType || "cleaning";
    } else {
      propertyId = docId; // 旧スキーマ (未サフィックス = 清掃)
    }
  }
  const targetWt = normWt(workType);

  // === 上書き前スナップショットを history サブコレへ保存 (誤削除からの復元用) ===
  // バックアップ失敗時は console.error して同期処理は継続する
  // (バックアップ失敗で未着手同期まで止めると「保存したのに反映されない」誤認の温床になるため)
  // 注意: テンプレ doc 自体の削除 (オーナーのみ可) は update トリガー対象外のため履歴に残らない (既知の制限)
  if (before && Array.isArray(before.areas) && before.areas.length > 0) {
    try {
      const beforeMs = before.updatedAt?.toMillis ? before.updatedAt.toMillis() : 0;
      // 冪等ID: リトライや二重発火でも重複しない
      const histId = `v${String(before.version || 0).padStart(5, "0")}_${beforeMs}`;
      await db.collection("checklistTemplates").doc(docId)
        .collection("history").doc(histId).set({
          areas: before.areas,
          version: before.version || 0,
          _meta: before._meta || null,
          propertyId,
          workType: targetWt,
          sourceUpdatedAt: before.updatedAt || null, // この版が保存された時刻
          savedBy: before.updatedBy || null,          // この版を保存した人
          overwrittenBy: after.updatedBy || null,     // 今回上書きした人
          reason: after.saveReason || "save",         // save | copyFrom | restore
          savedAt: FieldValue.serverTimestamp(),
        });
      // 直近20世代を残して古い履歴を削除 (select() で areas を読まずメモリ節約)
      const stale = await db.collection("checklistTemplates").doc(docId)
        .collection("history").orderBy("savedAt", "desc").offset(20).select().get();
      for (const d of stale.docs) await d.ref.delete();
    } catch (e) {
      console.error("テンプレ履歴バックアップ失敗 (同期は継続):", docId, e.message);
    }
  }

  const newAreas = after.areas || [];
  const newVersion = after.version || 1;
  const newItemIds = collectItemIds(newAreas);

  // 該当物件の checklist を取得
  // templateSnapshot (数百項目の全文) を読み込むと OOM になるため、
  // 判定に必要なフィールドだけ select で取得する (差し替えは update で書くだけ)
  const snap = await db.collection("checklists")
    .where("propertyId", "==", propertyId)
    .select("workType", "status", "itemStates")
    .get();

  let updated = 0;
  let skippedCompleted = 0;
  let skippedInProgress = 0;
  let skippedWorkType = 0;

  for (const doc of snap.docs) {
    const c = doc.data();
    // 作業種別が一致するものだけ対象 (清掃原紙が直前点検 checklist を上書きするのを防ぐ)
    if (normWt(c.workType) !== targetWt) { skippedWorkType++; continue; }
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
    `[onChecklistTemplateUpdate] property=${propertyId} workType=${targetWt} ` +
    `updated=${updated} skipped(workType=${skippedWorkType}, completed=${skippedCompleted}, inProgress=${skippedInProgress})`
  );
};
