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
 *
 * ★退避が必要なのに退避できなかったときは削除しない。
 *   ここで削除してしまうと「退避機能が必要なまさにその場面で回答が消える」ため、
 *   データを守る側に倒す。残ったドキュメントは後続のトリガー発火時に
 *   孤児として再度この関数に入るので、退避が復旧すれば自然に解消する
 *   (＝消えるより残るほうが安全で、かつ自己修復する)。
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {FirebaseFirestore.QueryDocumentSnapshot} doc - 削除対象
 * @param {"recruitment"|"shift"} kind
 * @param {{reason?:string, bookingId?:string, propertyId?:string}} ctx
 * @returns {Promise<boolean>} 削除したら true / 退避失敗で削除を見送ったら false
 */
async function archiveAndDelete(db, doc, kind, ctx) {
  const admin = require("firebase-admin");
  const data = doc.data() || {};

  // 人の入力が無いものは退避不要 → そのまま削除
  if (!isWorthArchiving(kind, data)) {
    await doc.ref.delete();
    return true;
  }

  const entry = buildArchiveEntry(kind, doc.id, data, ctx);
  entry.deletedAt = admin.firestore.FieldValue.serverTimestamp();
  const ref = db.collection("recruitmentArchives").doc(`${kind}__${doc.id}`);

  // 一過性の失敗に備えて1回だけ再試行する
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await ref.set(entry);
      console.log(
        `[recruitmentArchive] 退避: ${kind} ${doc.id} ` +
        `(回答${entry.responseCount}件, 確定${entry.selectedStaffIds.length}名, reason=${entry.reason})`
      );
      await doc.ref.delete();
      return true;
    } catch (e) {
      lastErr = e;
      console.error(`[recruitmentArchive] 退避失敗(${attempt}/2) ${kind} ${doc.id}:`, e.message);
    }
  }

  // 退避できなかった → 削除しない (回答を失わないことを最優先)
  console.error(
    `[recruitmentArchive] ★退避できなかったため削除を中止: ${kind} ${doc.id} ` +
    `(回答${entry.responseCount}件, reason=${entry.reason}) — ${lastErr && lastErr.message}`
  );
  return false;
}

module.exports = { archiveAndDelete, buildArchiveEntry, isWorthArchiving };
