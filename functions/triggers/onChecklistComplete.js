/**
 * チェックリスト完了トリガー
 * status が "completed" に変わった瞬間だけ実行される
 * 処理A: 紐付くシフトを completed に更新
 * 処理B: Webアプリ管理者に清掃完了LINE通知 (通知 type: cleaning_done)
 * 処理C: スタッフにランドリー入力リマインドLINE通知 (通知 type: laundry_reminder)
 */
const { notifyOwner, notifyStaff, notifyByKey, getNotificationSettings_ } = require("../utils/lineNotify");
const { workLabel } = require("../utils/workType");

function fmtDate(s) {
  if (!s) return "";
  try {
    const d = typeof s === "string" ? new Date(s + "T00:00:00")
      : (s && typeof s.toDate === "function" ? s.toDate() : new Date(s));
    if (isNaN(d.getTime())) return String(s);
    // JST (UTC+9) でフォーマット — Cloud Functions の実行 TZ は UTC のため
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    const y = jst.getUTCFullYear();
    const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
    const day = String(jst.getUTCDate()).padStart(2, "0");
    return `${y}/${m}/${day}`;
  } catch (e) { return String(s); }
}
function fmtTime(ts) {
  if (!ts) return "";
  try {
    const d = ts && typeof ts.toDate === "function" ? ts.toDate() : new Date(ts);
    if (isNaN(d.getTime())) return "";
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    const h = String(jst.getUTCHours()).padStart(2, "0");
    const m = String(jst.getUTCMinutes()).padStart(2, "0");
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

  // ---- 処理B: Webアプリ管理者に清掃完了通知 (type: cleaning_done) ----
  try {
    // (1) ゲスト評価★: checklist.bookingId → shift.bookingId の順で booking 解決 → cleanlinessRating
    let rating = null;
    try {
      let bookingId = after.bookingId || null;
      if (!bookingId && shiftId) {
        const sDoc = await db.collection("shifts").doc(shiftId).get();
        if (sDoc.exists) bookingId = sDoc.data().bookingId || null;
      }
      if (bookingId) {
        const bDoc = await db.collection("bookings").doc(bookingId).get();
        if (bDoc.exists) {
          const r = bDoc.data().cleanlinessRating;
          if (typeof r === "number") rating = r;
        }
      }
    } catch (_) { /* 評価取得失敗は無視 */ }

    // (2) メモ抽出
    const notes = Array.isArray(after.notes) ? after.notes : [];
    const memoLines = notes
      .map(n => (n && n.text || "").toString().trim())
      .filter(s => s.length > 0)
      .map(s => `・${s}`);

    // (3) 在庫切れかけ抽出 (itemStates[id].needsRestock=true)
    const itemStates = after.itemStates || {};
    const items = Array.isArray(after.items) ? after.items : [];
    const lowStockNames = items
      .filter(it => it && it.id && itemStates[it.id] && itemStates[it.id].needsRestock)
      .map(it => it.name || it.title || it.id || "")
      .filter(Boolean);

    // (4) 写真URL集約 (before/after + メモ写真)、上位5枚を本文に
    const photoUrlsAll = [
      ...(Array.isArray(after.beforePhotos) ? after.beforePhotos : []),
      ...(Array.isArray(after.afterPhotos) ? after.afterPhotos : []),
      ...notes.flatMap(n => Array.isArray(n && n.photoUrls) ? n.photoUrls : []),
    ].filter(u => typeof u === "string" && u.startsWith("http"));
    const PHOTO_LIMIT = 5;
    const photoUrlsTrim = photoUrlsAll.slice(0, PHOTO_LIMIT);
    const photoMore = photoUrlsAll.length > PHOTO_LIMIT ? `\n... 他${photoUrlsAll.length - PHOTO_LIMIT}枚` : "";

    // (5) ★評価テキスト
    const ratingText = (typeof rating === "number" && rating >= 0)
      ? "★".repeat(rating) + "☆".repeat(Math.max(0, 5 - rating)) + ` (${rating}/5)`
      : "未評価";

    // (6) 本文構築
    let ownerMsg = `✨ 清掃完了\n\n${dateStr} ${propertyName || ""}\n${staffName || "スタッフ"}さんが${timeStr}に清掃を完了しました。`;
    ownerMsg += `\n\nゲストの使い方: ${ratingText}`;
    if (lowStockNames.length > 0) {
      ownerMsg += `\n\n📦 在庫切れかけ:\n${lowStockNames.map(n => `・${n}`).join("\n")}`;
    }
    if (memoLines.length > 0) {
      ownerMsg += `\n\n📝 メモ:\n${memoLines.join("\n")}`;
    }
    if (photoUrlsTrim.length > 0) {
      ownerMsg += `\n\n📷 写真 (${photoUrlsAll.length}枚):\n${photoUrlsTrim.join("\n")}${photoMore}`;
    }
    ownerMsg += `\n\n詳細: ${checklistUrl}`;

    const vars = {
      date: dateStr,
      property: propertyName || "",
      staff: staffName || "",
      time: timeStr,
      work: workLabel(after.workType),
      workType: after.workType || "cleaning",
      url: checklistUrl,
      rating: ratingText,
      memos: memoLines.join("\n"),
      lowStock: lowStockNames.map(n => `・${n}`).join("\n"),
      photos: photoUrlsTrim.join("\n") + photoMore,
      photoCount: String(photoUrlsAll.length),
    };
    // notifyByKey でチャネル別に発射 (ownerLine/groupLine/staffLine/ownerEmail/discord/...)
    await notifyByKey(db, "cleaning_done", {
      title: "清掃完了",
      body: ownerMsg,
      vars,
      propertyId: propertyId || null,
    });
  } catch (e) {
    console.error("Webアプリ管理者通知エラー:", e);
    try {
      await db.collection("error_logs").add({
        type: "onChecklistComplete_ownerNotify",
        message: e.message,
        createdAt: new Date(),
      });
    } catch (_) { /* ログ書き込み失敗は無視 */ }
  }

  // ---- 処理C: ランドリー入力リマインド (物件別設定対応) ----
  // notifyByKey で物件別 channelOverrides.laundry_reminder を読み ON/OFFを判定
  try {
    const vars = {
      date: dateStr,
      property: propertyName || "",
      staff: staffName || "",
      work: workLabel(after.workType),
      workType: after.workType || "cleaning",
      url: checklistUrl,
    };
    const staffMsg = `🧺 ランドリーを使用した場合は記録をお願いします\n\n${dateStr} ${propertyName || ""}\n入力: ${checklistUrl}`;
    // staffId が特定できる場合はそのスタッフのみ、不明なら active 全員に staffLine 送信
    const staffIds = staffId ? [staffId] : null;
    await notifyByKey(db, "laundry_reminder", {
      title: "ランドリー入力リマインド",
      body: staffMsg,
      vars,
      propertyId: propertyId || null,
      staffIds,
    });
  } catch (e) {
    console.error("ランドリーリマインド通知エラー:", e);
    try {
      await db.collection("error_logs").add({
        type: "onChecklistComplete_laundryReminder",
        message: e.message,
        staffId: staffId || null,
        createdAt: new Date(),
      });
    } catch (_) { /* ログ書き込み失敗は無視 */ }
  }
};
