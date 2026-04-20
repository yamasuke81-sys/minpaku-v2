/**
 * チェックリスト完了トリガー
 * status が "completed" に変わった瞬間だけ実行される
 * 処理A: 紐付くシフトを completed に更新
 * 処理B: オーナーに清掃完了LINE通知 (通知 type: cleaning_done)
 * 処理C: スタッフにランドリー入力リマインドLINE通知 (通知 type: laundry_reminder)
 */
const { notifyOwner, notifyStaff, getNotificationSettings_ } = require("../utils/lineNotify");

function fmtDate(s) {
  if (!s) return "";
  try {
    const d = typeof s === "string" ? new Date(s + "T00:00:00")
      : (s && typeof s.toDate === "function" ? s.toDate() : new Date(s));
    if (isNaN(d.getTime())) return String(s);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}/${m}/${day}`;
  } catch (e) { return String(s); }
}
function fmtTime(ts) {
  if (!ts) return "";
  try {
    const d = ts && typeof ts.toDate === "function" ? ts.toDate() : new Date(ts);
    if (isNaN(d.getTime())) return "";
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  } catch (e) { return ""; }
}

module.exports = async function onChecklistComplete(event) {
  const before = event.data.before.data();
  const after = event.data.after.data();

  // 完了遷移でなければスキップ
  if (!before || !after) return;
  if (before.status === "completed" || after.status !== "completed") return;

  const admin = require("firebase-admin");
  const db = admin.firestore();

  const { shiftId, staffId, date, propertyName, staffName, completedAt, propertyId } = after;

  // 物件別オーバーライドを取得
  let propertyOverrides = {};
  try {
    if (propertyId) {
      const propDoc = await db.collection("properties").doc(propertyId).get();
      if (propDoc.exists) propertyOverrides = propDoc.data().channelOverrides || {};
    }
  } catch (_) { /* 失敗しても継続 */ }

  // 通知用の共通変数を組み立て (日付整形・URL生成)
  let appUrl = "https://minpaku-v2.web.app";
  try {
    const { settings } = await getNotificationSettings_(db);
    appUrl = settings?.appUrl || appUrl;
  } catch (_) { /* 失敗してもデフォルトで続行 */ }
  const checklistUrl = shiftId ? `${appUrl}/#/my-checklist/${shiftId}` : `${appUrl}/#/my-checklist`;
  const dateStr = fmtDate(date);
  const timeStr = fmtTime(completedAt);

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

  // ---- 処理B: オーナーに清掃完了通知 (type: cleaning_done) ----
  try {
    const vars = {
      date: dateStr,
      property: propertyName || "",
      staff: staffName || "",
      time: timeStr,
      url: checklistUrl,
    };
    const ownerMsg = `✨ 清掃完了\n\n${dateStr} ${propertyName || ""}\n${staffName || "スタッフ"}さんが${timeStr}に清掃を完了しました。\n詳細: ${checklistUrl}`;
    await notifyOwner(db, "cleaning_done", "清掃完了", ownerMsg, vars, propertyOverrides);
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
      const vars = {
        date: dateStr,
        property: propertyName || "",
        staff: staffName || "",
        url: checklistUrl,
      };
      const staffMsg = `🧺 ランドリーの入力をお願いします\n\n${dateStr} ${propertyName || ""}\n清掃お疲れさまでした。ランドリーの使用がある場合は入力をお願いします。\n詳細: ${checklistUrl}`;
      await notifyStaff(db, staffId, "laundry_reminder", "ランドリー入力リマインド", staffMsg, vars, propertyOverrides);
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
