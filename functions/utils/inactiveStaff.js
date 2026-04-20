/**
 * スタッフ自動非アクティブ化ユーティリティ
 *
 * 仕様:
 *  - 新規募集が発行された時、active=true なスタッフ全員の pendingRecruitmentIds に追加する
 *  - スタッフが ◎/△/× いずれかの回答を送った時、該当IDを pendingRecruitmentIds から削除する
 *  - pendingRecruitmentIds の件数が THRESHOLD(15) を超えた時点で active=false に変更、
 *    inactiveReason と inactivatedAt をセットし、staff_inactive 通知を発信する
 *  - 非アクティブ解除はスタッフ管理画面からオーナーが手動で行う(pendingRecruitmentIds もクリア)
 */
const { FieldValue } = require("firebase-admin/firestore");
const INACTIVE_THRESHOLD = 15;

async function addRecruitmentToActiveStaff(db, recruitmentId) {
  if (!recruitmentId) return;
  const staffSnap = await db.collection("staff").where("active", "==", true).get();
  const {
    notifyOwner,
    notifyGroup,
    getNotificationSettings_,
    resolveNotifyTargets,
  } = require("./lineNotify");

  const { settings } = await getNotificationSettings_(db);
  const targets = resolveNotifyTargets(settings, "staff_inactive");

  for (const doc of staffSnap.docs) {
    const data = doc.data();
    // オーナー本人は対象外
    if (data.isOwner) continue;
    const list = Array.isArray(data.pendingRecruitmentIds) ? data.pendingRecruitmentIds : [];
    if (list.includes(recruitmentId)) continue;
    const newList = [...list, recruitmentId];
    const update = {
      pendingRecruitmentIds: FieldValue.arrayUnion(recruitmentId),
      updatedAt: FieldValue.serverTimestamp(),
    };
    // しきい値超過 → 非アクティブ化
    if (newList.length >= INACTIVE_THRESHOLD) {
      update.active = false;
      update.inactiveReason = `直近${INACTIVE_THRESHOLD}回の募集について回答がなかったため、非アクティブとなりました。`;
      update.inactivatedAt = FieldValue.serverTimestamp();
    }
    await doc.ref.update(update);

    // 通知
    if (update.active === false && targets.enabled) {
      try {
        const baseVars = { staff: data.name || "", reason: update.inactiveReason };
        const title = `スタッフ非アクティブ化: ${data.name}`;
        const body = `⚠️ スタッフ非アクティブ化\n\n${data.name} さんを非アクティブに変更しました。\n理由: ${update.inactiveReason}`;
        if (targets.ownerLine) await notifyOwner(db, "staff_inactive", title, body, baseVars);
        if (targets.groupLine) await notifyGroup(db, "staff_inactive", title, body, baseVars);
      } catch (e) {
        console.error("staff_inactive 通知エラー:", e);
      }
    }
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
