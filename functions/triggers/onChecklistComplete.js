/**
 * チェックリスト完了トリガー
 * status が "completed" に変わった瞬間だけ実行される
 * 処理A: 紐付くシフトを completed に更新
 * 処理B: オーナーに清掃完了LINE通知
 * 処理C: スタッフにランドリー入力リマインドLINE通知
 */
const { notifyOwner, notifyStaff } = require("../utils/lineNotify");

module.exports = async function onChecklistComplete(event) {
  const before = event.data.before.data();
  const after = event.data.after.data();

  // 完了遷移でなければスキップ
  if (!before || !after) return;
  if (before.status === "completed" || after.status !== "completed") return;

  const admin = require("firebase-admin");
  const db = admin.firestore();

  const { shiftId, staffId, date, propertyName, staffName } = after;

  // ---- 処理A: シフトを completed に更新 ----
  if (shiftId) {
    try {
      await db.collection("shifts").doc(shiftId).update({
        status: "completed",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error("シフト更新エラー:", e);
      try {
        await db.collection("error_logs").add({
          type: "onChecklistComplete_shiftUpdate",
          message: e.message,
          shiftId,
          createdAt: new Date(),
        });
      } catch (_) { /* ログ書き込み失敗は無視 */ }
    }
  }

  // ---- 処理B: オーナーに清掃完了通知 ----
  try {
    const ownerMsg = `✨ 清掃完了\n\n${date || ""} ${propertyName || ""}\n${staffName || "スタッフ"}さんが清掃を完了しました。`;
    await notifyOwner(db, "checklist_completed", "清掃完了", ownerMsg);
  } catch (e) {
    console.error("オーナー通知エラー:", e);
    try {
      await db.collection("error_logs").add({
        type: "onChecklistComplete_ownerNotify",
        message: e.message,
        createdAt: new Date(),
      });
    } catch (_) { /* ログ書き込み失敗は無視 */ }
  }

  // ---- 処理C: スタッフにランドリー入力リマインド ----
  if (staffId) {
    try {
      const staffMsg = `🧺 ランドリーの入力をお願いします\n\n${date || ""} ${propertyName || ""}\n清掃お疲れさまでした。ランドリーの使用がある場合は入力をお願いします。`;
      await notifyStaff(db, staffId, "laundry_reminder", "ランドリー入力リマインド", staffMsg);
    } catch (e) {
      console.error("スタッフ通知エラー:", e);
      try {
        await db.collection("error_logs").add({
          type: "onChecklistComplete_staffNotify",
          message: e.message,
          staffId,
          createdAt: new Date(),
        });
      } catch (_) { /* ログ書き込み失敗は無視 */ }
    }
  }
};
