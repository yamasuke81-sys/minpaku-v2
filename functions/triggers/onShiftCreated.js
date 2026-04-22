/**
 * シフト作成時トリガー
 * - shifts/{shiftId} が作成された時に、物件の checklistTemplate をスナップショットコピーして
 *   checklists/{checklistId} を自動生成する（複数スタッフが即座に共有編集できる状態にする）
 * - propertyId の checklistTemplates が未設定の場合は生成しない（ログだけ出す）
 * - 既に同 shiftId の checklist がある場合はスキップ（冪等）
 */
const admin = require("firebase-admin");

module.exports = async (event) => {
  const db = admin.firestore();
  const shift = event.data?.data();
  const shiftId = event.params.shiftId;
  if (!shift || !shift.propertyId) return;

  // workType が清掃系以外 (特に laundry_xxx) はチェックリスト生成しない
  // 清掃系: cleaning_by_count / cleaning / pre_inspection / 未設定 (デフォルト清掃)
  const CLEANING_WORK_TYPES = ["cleaning_by_count", "cleaning", "pre_inspection", "", undefined, null];
  if (!CLEANING_WORK_TYPES.includes(shift.workType)) {
    console.log(`[onShiftCreated] workType=${shift.workType} は清掃系でないため checklist 生成をスキップ shift=${shiftId}`);
    return;
  }

  // 既存チェックあり？
  const existing = await db.collection("checklists")
    .where("shiftId", "==", shiftId).limit(1).get();
  if (!existing.empty) {
    console.log(`[onShiftCreated] checklist 既存 shift=${shiftId}, skip`);
    return;
  }

  // テンプレート取得
  const tmplDoc = await db.collection("checklistTemplates").doc(shift.propertyId).get();
  if (!tmplDoc.exists) {
    console.log(`[onShiftCreated] テンプレート未設定 propertyId=${shift.propertyId}, skip`);
    return;
  }
  const tmpl = tmplDoc.data();

  // 物件名取得（なければ shift から引き継ぎ）
  let propertyName = shift.propertyName || "";
  if (!propertyName) {
    const pd = await db.collection("properties").doc(shift.propertyId).get();
    propertyName = pd.exists ? (pd.data().name || "") : "";
  }

  // チェックリスト作成（テンプレートを areas ごと丸ごとスナップショット）
  const newChecklist = {
    shiftId,
    propertyId: shift.propertyId,
    propertyName,
    checkoutDate: shift.date,
    staffIds: shift.selectedStaffIds || (shift.staffId ? [shift.staffId] : []),
    workType: shift.workType || "cleaning",
    templateVersion: tmpl.version || 1,
    templateSnapshot: tmpl.areas || [],   // 実績スナップショット（テンプレを後で編集しても影響なし）
    itemStates: {},                        // 項目ID → {checked, needsRestock, note, checkedBy, checkedAt, editingBy}
    beforePhotos: [],
    afterPhotos: [],
    laundry: {
      putOut: null,
      collected: null,
      stored: null
    },
    status: "in_progress",                 // in_progress | completed
    completedAt: null,
    completedBy: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  const ref = await db.collection("checklists").add(newChecklist);
  console.log(`[onShiftCreated] checklist 自動生成 id=${ref.id} shift=${shiftId} property=${shift.propertyId}`);
};
