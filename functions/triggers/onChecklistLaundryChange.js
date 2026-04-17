/**
 * チェックリスト laundry フィールド変更検知トリガー
 *
 * checklists/{checklistId} の laundry.{putOut|collected|stored} が
 * null/未設定 → 値あり に遷移した瞬間に対応する通知を送信する。
 *
 * 通知 type:
 * - laundry_put_out   洗濯物を出した
 * - laundry_collected 洗濯物を回収した
 * - laundry_stored    洗濯物を収納した
 *
 * 既存の onChecklistComplete は status=completed 遷移のみを見るので、
 * このトリガーとは干渉しない (同じ onDocumentUpdated だが別 export)。
 *
 * 通知設定 settings/notifications.channels[type] の customMessage と宛先フラグに従う。
 */
const admin = require("firebase-admin");
const {
  notifyOwner,
  notifyGroup,
  notifyStaff,
  resolveNotifyTargets,
  getNotificationSettings_,
} = require("../utils/lineNotify");

// laundry フィールド値が「設定済み」か判定
// 新形式 {at, by} / 旧形式 Timestamp / null / undefined に対応
function isLaundrySet(v) {
  if (v == null) return false;
  if (typeof v === "object") {
    if (v.at) return true;               // 新形式 {at, by}
    if (typeof v.toDate === "function") return true; // Firestore Timestamp
    if (v.seconds != null) return true;  // serialized Timestamp
  }
  return !!v;
}

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

module.exports = async (event) => {
  const db = admin.firestore();
  const before = event.data?.before?.data();
  const after = event.data?.after?.data();
  if (!before || !after) return;

  const beforeLaundry = before.laundry || {};
  const afterLaundry = after.laundry || {};

  // 各アクションの null → 値 遷移を検知
  const actions = [
    { key: "putOut",    type: "laundry_put_out",   label: "洗濯物を出した",  verb: "出しました" },
    { key: "collected", type: "laundry_collected", label: "洗濯物を回収した", verb: "回収しました" },
    { key: "stored",    type: "laundry_stored",    label: "洗濯物を収納した", verb: "収納しました" },
  ];

  for (const { key, type, label, verb } of actions) {
    const wasSet = isLaundrySet(beforeLaundry[key]);
    const nowSet = isLaundrySet(afterLaundry[key]);
    if (wasSet || !nowSet) continue; // null → 値 の遷移のみで発火

    try {
      const val = afterLaundry[key] || {};
      const staffName = val?.by?.name || "";
      const at = val?.at || val;
      const timeStr = fmtTime(at);

      const propertyName = after.propertyName || "";
      const checkoutDate = after.checkoutDate || "";
      const dateStr = fmtDate(checkoutDate);

      // 通知設定から対象チャネルと appUrl を取得
      const { settings } = await getNotificationSettings_(db);
      const appUrl = settings?.appUrl || "https://minpaku-v2.web.app";
      const shiftId = after.shiftId || "";
      const checklistUrl = shiftId ? `${appUrl}/#/my-checklist/${shiftId}` : `${appUrl}/#/my-checklist`;

      const vars = {
        date: dateStr,
        property: propertyName,
        staff: staffName,
        time: timeStr,
        url: checklistUrl,
      };

      const title = `ランドリー: ${label}`;
      const body = `🧺 ランドリー ${label}\n\n${dateStr} ${propertyName}\n${staffName}さんが${timeStr}に${verb}。\n詳細: ${checklistUrl}`;

      const targets = resolveNotifyTargets(settings, type);
      if (!targets.enabled) {
        console.log(`[onChecklistLaundryChange] ${type} 無効化されているためスキップ`);
        continue;
      }

      // オーナーLINE
      if (targets.ownerLine) {
        await notifyOwner(db, type, title, body, vars);
      }
      // グループLINE
      if (targets.groupLine) {
        await notifyGroup(db, type, title, body, vars);
      }
      // スタッフ個別LINE (割当済みスタッフ全員)
      if (targets.staffLine) {
        const staffIds = Array.isArray(after.staffIds) && after.staffIds.length
          ? after.staffIds
          : (after.staffId ? [after.staffId] : []);
        for (const sid of staffIds) {
          try {
            await notifyStaff(db, sid, type, title, body, vars);
          } catch (e) {
            console.error(`[onChecklistLaundryChange] staff ${sid} 通知エラー:`, e.message);
          }
        }
      }

      console.log(`[onChecklistLaundryChange] ${type} 送信完了 checklist=${event.params.checklistId}`);
    } catch (e) {
      console.error(`[onChecklistLaundryChange] ${type} 通知エラー:`, e);
      try {
        await db.collection("error_logs").add({
          type: `onChecklistLaundryChange_${type}`,
          message: e.message,
          checklistId: event.params.checklistId,
          createdAt: new Date(),
        });
      } catch (_) { /* ignore */ }
    }
  }
};
