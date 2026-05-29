/**
 * チェックリスト完了トリガー
 * status が "completed" に変わった瞬間だけ実行される
 * 処理A: 紐付くシフトを completed に更新
 * 処理B: Webアプリ管理者に完了LINE通知 (workType により cleaning_done / pre_inspection_done を使い分け)
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

/**
 * スタッフ名を解決する
 * 優先順: after.staffName → completedBy → staffId → staffIds[0] → "スタッフ"
 * staffIds が複数の場合は全員分をカンマ連結して返す
 */
async function resolveStaffName(db, after) {
  // (1) staffName が直接存在する場合はそれを使う
  if (after.staffName) return after.staffName;

  /**
   * Firestore から staff/{id}.name を取得するヘルパー
   * 取得失敗時は null を返す
   */
  const lookupName = async (staffId) => {
    if (!staffId) return null;
    try {
      const doc = await db.collection("staff").doc(staffId).get();
      if (doc.exists && doc.data().name) return doc.data().name;
    } catch (_) { /* lookup 失敗は無視 */ }
    return null;
  };

  // (2) completedBy オブジェクトの staffId / name を試みる
  if (after.completedBy) {
    if (after.completedBy.name) return after.completedBy.name;
    const name = await lookupName(after.completedBy.staffId || after.completedBy.uid);
    if (name) return name;
  }

  // (3) staffIds 配列が複数スタッフを持つ場合は全員の名前を連結
  if (Array.isArray(after.staffIds) && after.staffIds.length > 0) {
    const names = await Promise.all(after.staffIds.map(id => lookupName(id)));
    const resolved = names.filter(Boolean);
    if (resolved.length > 0) return resolved.join(", ");
  }

  // (4) staffId (単一) で lookup
  if (after.staffId) {
    const name = await lookupName(after.staffId);
    if (name) return name;
  }

  // (5) 最終フォールバック
  return "スタッフ";
}

module.exports = async function onChecklistComplete(event) {
  const before = event.data.before.data();
  const after = event.data.after.data();

  // 完了遷移でなければスキップ
  if (!before || !after) return;
  if (before.status === "completed" || after.status !== "completed") return;

  const admin = require("firebase-admin");
  const db = admin.firestore();

  const { shiftId, staffId, date, propertyName, completedAt, propertyId } = after;

  // workType により通知キーと文言を切り替える
  const isPreInspection = after.workType === "pre_inspection";
  const notifyKey = isPreInspection ? "pre_inspection_done" : "cleaning_done";
  const workLabelStr = workLabel(after.workType); // "直前点検" or "清掃" etc.

  // スタッフ名を解決 (空欄バグ修正: staffName が空でも lookup でフォールバック)
  const resolvedStaffName = await resolveStaffName(db, after);

  // 物件別オーバーライドを取得
  let propertyOverrides = {};
  try {
    if (propertyId) {
      const propDoc = await db.collection("properties").doc(propertyId).get();
      if (propDoc.exists) propertyOverrides = propDoc.data().channelOverrides || {};
    }
  } catch (_) { /* 失敗しても継続 */ }

  // 通知用の共通変数を組み立て (日付整形・URL生成)
  let appUrl = "https://v2-5-relay.web.app";
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

    // (6) 本文構築 (workType に応じてタイトルと作業名を切り替え)
    const completeTitle = isPreInspection ? "直前点検完了" : "清掃完了";
    let ownerMsg = `✨ ${completeTitle}\n\n${dateStr} ${propertyName || ""}\n${resolvedStaffName}さんが${timeStr}に${workLabelStr}を完了しました。`;
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
      staff: resolvedStaffName,
      time: timeStr,
      work: workLabelStr,
      workType: after.workType || "cleaning",
      url: checklistUrl,
      rating: ratingText,
      memos: memoLines.join("\n"),
      lowStock: lowStockNames.map(n => `・${n}`).join("\n"),
      photos: photoUrlsTrim.join("\n") + photoMore,
      photoCount: String(photoUrlsAll.length),
    };
    // notifyByKey でチャネル別に発射 (ownerLine/groupLine/staffLine/ownerEmail/discord/...)
    // workType により "pre_inspection_done" / "cleaning_done" を使い分ける
    await notifyByKey(db, notifyKey, {
      title: completeTitle,
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
      staff: resolvedStaffName,
      work: workLabelStr,
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
