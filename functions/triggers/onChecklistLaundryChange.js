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
const { FieldValue } = require("firebase-admin/firestore");
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

/**
 * putOut データを laundry コレクションに同期する
 * 二重作成防止: sourceChecklistId + sourceField で既存ドキュメントを検索し、あれば update
 */
async function syncPutOutToLaundry(db, checklistId, after, putOut) {
  const paymentMethod = putOut.paymentMethod || "";
  // cash/credit は立替あり、prepaid/invoice は立替なし
  const isReimbursable = ["cash", "credit"].includes(paymentMethod);

  // putOut.by は { uid, staffId, name } のオブジェクト形式 (my-checklist.js)。
  // 古い by が文字列で入っている互換性も維持。staffId を優先し、なければ uid を fallback
  const byObj = putOut.by;
  const staffIdStr = (byObj && typeof byObj === "object")
    ? (byObj.staffId || byObj.uid || "")
    : (typeof byObj === "string" ? byObj : "");

  const laundryData = {
    date: after.checkoutDate || after.date || null,
    propertyId: after.propertyId || "",
    staffId: staffIdStr,
    depot: putOut.depot || "",
    depotOther: putOut.depotOther || "",
    depotKind: putOut.depotKind || "",
    paymentMethod,
    sheets: 0,
    amount: Number(putOut.amount) || 0,
    memo: putOut.note || "",
    isReimbursable,
    sourceChecklistId: checklistId,
    sourceField: "putOut",
    updatedAt: FieldValue.serverTimestamp(),
  };

  // 既存ドキュメントを検索
  const existing = await db.collection("laundry")
    .where("sourceChecklistId", "==", checklistId)
    .where("sourceField", "==", "putOut")
    .limit(1)
    .get();

  if (!existing.empty) {
    // 既存あり: update
    await existing.docs[0].ref.update(laundryData);
    console.log(`[syncPutOutToLaundry] update docId=${existing.docs[0].id} checklistId=${checklistId}`);
  } else {
    // 新規作成
    await db.collection("laundry").add({
      ...laundryData,
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log(`[syncPutOutToLaundry] create checklistId=${checklistId}`);
  }
}

/**
 * putOut が削除された (null に戻された) 場合、対応する laundry ドキュメントも削除
 */
async function deleteLaundryByChecklist(db, checklistId) {
  const snap = await db.collection("laundry")
    .where("sourceChecklistId", "==", checklistId)
    .where("sourceField", "==", "putOut")
    .get();
  const deletes = snap.docs.map(d => d.ref.delete());
  await Promise.all(deletes);
  if (deletes.length > 0) {
    console.log(`[deleteLaundryByChecklist] deleted ${deletes.length} docs for checklistId=${checklistId}`);
  }
}

module.exports = async (event) => {
  const db = admin.firestore();
  const before = event.data?.before?.data();
  const after = event.data?.after?.data();
  if (!before || !after) return;

  const checklistId = event.params.checklistId;
  const beforeLaundry = before.laundry || {};
  const afterLaundry = after.laundry || {};

  // --- putOut の同期処理 ---
  const beforePutOut = beforeLaundry.putOut;
  const afterPutOut = afterLaundry.putOut;
  const wasSet = isLaundrySet(beforePutOut);
  const nowSet = isLaundrySet(afterPutOut);

  if (!wasSet && nowSet) {
    // 新規セット → laundry コレクションに作成/更新
    try {
      await syncPutOutToLaundry(db, checklistId, after, afterPutOut);
    } catch (e) {
      console.error(`[onChecklistLaundryChange] syncPutOutToLaundry エラー:`, e);
      try {
        await db.collection("error_logs").add({
          type: "onChecklistLaundryChange_syncPutOut",
          message: e.message,
          checklistId,
          createdAt: new Date(),
        });
      } catch (_) { /* ignore */ }
    }
  } else if (wasSet && !nowSet) {
    // putOut が削除された → laundry コレクションからも削除
    try {
      await deleteLaundryByChecklist(db, checklistId);
    } catch (e) {
      console.error(`[onChecklistLaundryChange] deleteLaundryByChecklist エラー:`, e);
    }
  }

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

      // 通知設定から対象チャネルと appUrl を取得（物件別オーバーライド適用）
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

      // 物件別オーバーライドを取得
      let propertyOverrides = {};
      if (after.propertyId) {
        const propDoc = await db.collection("properties").doc(after.propertyId).get();
        if (propDoc.exists) propertyOverrides = propDoc.data().channelOverrides || {};
      }
      const targets = resolveNotifyTargets(settings, type, propertyOverrides);
      if (!targets.enabled) {
        console.log(`[onChecklistLaundryChange] ${type} 無効化されているためスキップ`);
        continue;
      }

      // オーナーLINE
      if (targets.ownerLine) {
        await notifyOwner(db, type, title, body, vars, propertyOverrides);
      }
      // グループLINE
      if (targets.groupLine) {
        await notifyGroup(db, type, title, body, vars, propertyOverrides);
      }
      // スタッフ個別LINE (割当済みスタッフ全員)
      if (targets.staffLine) {
        const staffIds = Array.isArray(after.staffIds) && after.staffIds.length
          ? after.staffIds
          : (after.staffId ? [after.staffId] : []);
        for (const sid of staffIds) {
          try {
            await notifyStaff(db, sid, type, title, body, vars, propertyOverrides);
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
