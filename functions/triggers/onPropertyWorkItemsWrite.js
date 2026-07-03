const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const { jstYm, prevYmOf } = require("../utils/workItemsMonth");

/**
 * propertyWorkItems 変更時: 月をまたいだ最初の変更で、変更前の状態を
 * history/{前月} に「前月末時点のスナップショット」として自動保存する。
 *
 * これにより締め済み月 (過去月) の請求書計算は当時の単価で固定され、
 * 翌月以降に報酬単価を変更しても過去月の請求書金額は変化しない。
 * (参照側: utils/workItemsMonth.js getWorkItemsForMonth)
 */
module.exports = async (event) => {
  const before = event.data && event.data.before;
  if (!before || !before.exists) return; // 新規作成はアーカイブ対象なし

  const beforeData = before.data() || {};
  const nowYm = jstYm();

  // 変更前の最終更新が今月なら、前月末時点の状態は既に history 化済み (or 今月分の変更のみ) → 何もしない
  const bu = beforeData.updatedAt;
  const buDate = bu && bu.toDate ? bu.toDate() : null;
  if (buDate && jstYm(buDate) >= nowYm) return;

  const targetYm = prevYmOf(nowYm);
  const propertyId = event.params.propertyId;
  try {
    await admin.firestore()
      .collection("propertyWorkItems").doc(propertyId)
      .collection("history").doc(targetYm)
      .create({
        propertyId,
        items: beforeData.items || [],
        sourceUpdatedAt: bu || null,
        archivedAt: FieldValue.serverTimestamp(),
        archivedBy: "onPropertyWorkItemsWrite",
      });
    console.log(`[workItemsHistory] ${propertyId} の単価を history/${targetYm} に保存 (月またぎ変更検知)`);
  } catch (e) {
    // 既に存在 = 同月内で先にアーカイブ済み → 正常 (冪等)
    if (e.code === 6 || e.code === "already-exists") return;
    console.error(`[workItemsHistory] アーカイブ失敗 property=${propertyId}:`, e.message);
  }
};
