/**
 * 募集・シフトの削除前退避 (recruitmentArchives)
 *
 * なぜ必要か:
 *   予約がキャンセルされると onBookingChange が募集(recruitments)・シフト(shifts)を
 *   **物理削除**する。募集の `responses` はスタッフが手で入れた回答(◎△×・△の理由)で、
 *   消えると再現できない。2026-08-12 the Terrace 8/26 でキャンセル→同日程の再予約が
 *   起きた際、確定状況は Cloud Logging から復元できたが回答は復元できず、
 *   Firestore の自動バックアップを一時DBへ復元して取り出す羽目になった。
 *   (通知にも控えは残らない。テラスは recruit_response が enabled=false のため)
 *   → 消す前に原本を退避しておく。
 *
 * 退避しないもの:
 *   checklists は templateSnapshot から再生成できるので対象外。
 *
 * ドキュメントID:
 *   `{kind}__{元のdocId}` の決定的ID。トリガーがリトライされても重複しないため。
 *   同じIDが再作成→再削除された場合は最新の退避で上書きする(直近のものを復元したいため)。
 */

/** 退避エントリを組み立てる純粋関数 */
function buildArchiveEntry(kind, docId, data, ctx) {
  const d = data || {};
  const c = ctx || {};
  const responses = Array.isArray(d.responses) ? d.responses : [];
  const staffIds = Array.isArray(d.selectedStaffIds)
    ? d.selectedStaffIds
    : (Array.isArray(d.staffIds) ? d.staffIds : []);
  return {
    kind,                                   // "recruitment" | "shift"
    sourceCollection: kind === "recruitment" ? "recruitments" : "shifts",
    sourceId: docId,
    bookingId: d.bookingId || c.bookingId || null,
    propertyId: d.propertyId || c.propertyId || null,
    workType: d.workType || null,
    // 検索・目視用の要約 (原本は data にまるごと入っている)
    checkoutDate: d.checkoutDate || null,
    status: d.status || null,
    selectedStaff: d.selectedStaff || d.staffName || null,
    selectedStaffIds: staffIds,
    responseCount: responses.length,
    reason: c.reason || "unknown",          // cancel / date_change / switch_to_cleaning / orphan_replace
    data: d,                                // 原本まるごと
  };
}

/** 退避が必要か (人の入力が入っていないものは残しても意味がない) */
function isWorthArchiving(kind, data) {
  const d = data || {};
  if (kind === "recruitment") {
    const responses = Array.isArray(d.responses) ? d.responses : [];
    const selected = Array.isArray(d.selectedStaffIds) ? d.selectedStaffIds : [];
    return responses.length > 0 || selected.length > 0;
  }
  if (kind === "shift") {
    const staffIds = Array.isArray(d.staffIds) ? d.staffIds : [];
    return staffIds.length > 0 || !!d.staffId;
  }
  return false;
}

/**
 * ドキュメントを退避してから削除する。
 * 退避に失敗しても削除は続行する (退避は保険であって、本来の後片付けを止めない)。
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {FirebaseFirestore.QueryDocumentSnapshot} doc - 削除対象
 * @param {"recruitment"|"shift"} kind
 * @param {{reason?:string, bookingId?:string, propertyId?:string}} ctx
 */
async function archiveAndDelete(db, doc, kind, ctx) {
  const admin = require("firebase-admin");
  try {
    const data = doc.data() || {};
    if (isWorthArchiving(kind, data)) {
      const entry = buildArchiveEntry(kind, doc.id, data, ctx);
      entry.deletedAt = admin.firestore.FieldValue.serverTimestamp();
      await db.collection("recruitmentArchives").doc(`${kind}__${doc.id}`).set(entry);
      console.log(
        `[recruitmentArchive] 退避: ${kind} ${doc.id} ` +
        `(回答${entry.responseCount}件, 確定${entry.selectedStaffIds.length}名, reason=${entry.reason})`
      );
    }
  } catch (e) {
    // 退避に失敗しても削除は止めない
    console.error(`[recruitmentArchive] 退避失敗 ${kind} ${doc.id}:`, e.message);
  }
  await doc.ref.delete();
}

module.exports = { archiveAndDelete, buildArchiveEntry, isWorthArchiving };
