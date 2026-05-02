/**
 * スタッフ自動非アクティブ化ユーティリティ
 *
 * 仕様:
 *  - 新規募集が発行された時、active=true なスタッフ全員の pendingRecruitmentIds に追加する
 *  - スタッフが ◎/△/× いずれかの回答を送った時、該当IDを pendingRecruitmentIds から削除する
 *  - pendingRecruitmentIds の件数が THRESHOLD(15) を超えた時点で active=false に変更、
 *    inactiveReason と inactivatedAt をセットし、staff_inactive 通知を発信する
 *  - 非アクティブ解除はスタッフ管理画面からWebアプリ管理者が手動で行う(pendingRecruitmentIds もクリア)
 */
const { FieldValue } = require("firebase-admin/firestore");
const INACTIVE_THRESHOLD = 15;

async function addRecruitmentToActiveStaff(db, recruitmentId) {
  if (!recruitmentId) return;
  const staffSnap = await db.collection("staff").where("active", "==", true).get();
  const { notifyByKey } = require("./lineNotify");

  for (const doc of staffSnap.docs) {
    const data = doc.data();
    // Webアプリ管理者本人は対象外
    if (data.isOwner) continue;
    const list = Array.isArray(data.pendingRecruitmentIds) ? data.pendingRecruitmentIds : [];
    if (list.includes(recruitmentId)) continue;
    // しきい値超過による自動非アクティブ化は無効化済み (2026-05-02)
    // 追跡 (pendingRecruitmentIds 蓄積) のみ継続。active=false への自動降下と通知は行わない。
    const update = {
      pendingRecruitmentIds: FieldValue.arrayUnion(recruitmentId),
      updatedAt: FieldValue.serverTimestamp(),
    };
    await doc.ref.update(update);
  }
}

async function removeRecruitmentFromStaff(db, staffId, recruitmentId) {
  if (!staffId || !recruitmentId) return;
  const ref = db.collection("staff").doc(staffId);
  const doc = await ref.get();
  if (!doc.exists) return;
  const list = Array.isArray(doc.data().pendingRecruitmentIds) ? doc.data().pendingRecruitmentIds : [];
  if (!list.includes(recruitmentId)) return;
  await ref.update({
    pendingRecruitmentIds: FieldValue.arrayRemove(recruitmentId),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * 全スタッフの pendingRecruitmentIds から指定 recruitment ID を除去する。
 * recruitment 削除時に孤児 ID が蓄積しないよう呼び出す。
 */
async function removeRecruitmentFromAllStaff(db, recruitmentId) {
  if (!recruitmentId) return;
  const snap = await db.collection("staff")
    .where("pendingRecruitmentIds", "array-contains", recruitmentId).get();
  for (const d of snap.docs) {
    await d.ref.update({
      pendingRecruitmentIds: FieldValue.arrayRemove(recruitmentId),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
}

module.exports = {
  INACTIVE_THRESHOLD,
  addRecruitmentToActiveStaff,
  removeRecruitmentFromStaff,
  removeRecruitmentFromAllStaff,
};
