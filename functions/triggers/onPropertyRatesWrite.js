const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const { jstYm, prevYmOf } = require("../utils/workItemsMonth");

/**
 * propertyRates (ゲスト宿泊料金マスタ) 変更時: 月をまたいだ最初の変更で、変更前の状態を
 * history/{前月} に「前月末時点のスナップショット」として自動保存する。
 * onPropertyWorkItemsWrite (スタッフ報酬単価) と同型の料金版。
 * 過去時点の販売料金を後から追跡できるようにする (予約時の priceBreakdown 凍結と補完関係)。
 */
module.exports = async (event) => {
  const before = event.data && event.data.before;
  if (!before || !before.exists) return; // 新規作成はアーカイブ対象なし

  const beforeData = before.data() || {};
  const nowYm = jstYm();

  // 変更前の最終更新が今月なら、前月末時点の状態は既に history 化済み → 何もしない
  const bu = beforeData.updatedAt;
  const buDate = bu && bu.toDate ? bu.toDate() : null;
  if (buDate && jstYm(buDate) >= nowYm) return;

  const targetYm = prevYmOf(nowYm);
  const propertyId = event.params.propertyId;
  try {
    await admin.firestore()
      .collection("propertyRates").doc(propertyId)
      .collection("history").doc(targetYm)
      .create({
        propertyId,
        rates: beforeData,
        sourceUpdatedAt: bu || null,
        archivedAt: FieldValue.serverTimestamp(),
        archivedBy: "onPropertyRatesWrite",
      });
    console.log(`[propertyRatesHistory] ${propertyId} の料金を history/${targetYm} に保存 (月またぎ変更検知)`);
  } catch (e) {
    // 既に存在 = 同月内で先にアーカイブ済み → 正常 (冪等)
    if (e.code === 6 || e.code === "already-exists") return;
    console.error(`[propertyRatesHistory] アーカイブ失敗 property=${propertyId}:`, e.message);
  }
};
