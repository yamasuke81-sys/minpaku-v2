/**
 * チェックリスト laundry フィールド変更検知トリガー
 *
 * checklists/{checklistId} の laundry.{putOut|collected|stored} が
 * null/未設定 → 値あり に遷移した瞬間に対応する通知と作業実績(shift)を生成する。
 *
 * 通知 type:
 * - laundry_put_out   洗濯物を出した
 * - laundry_collected 洗濯物を回収した
 * - laundry_stored    洗濯物を収納した
 *
 * 作業実績 (workType):
 * - laundry_put_out  → shift(workType=laundry_put_out, workItemName=「ランドリー出し」)
 *                    → shift(workType=laundry_expense, workItemName=「ランドリープリカXXX」or「ランドリー現金XXX」) ※立替あり時
 * - laundry_collected → shift(workType=laundry_collected, workItemName=「ランドリー受取」)
 * - laundry_stored    → 生成なし
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
  notifyByKey,
  resolveNotifyTargets,
  getNotificationSettings_,
} = require("../utils/lineNotify");
const { workLabel } = require("../utils/workType");

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
    // JST (UTC+9) でフォーマット
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    const h = String(jst.getUTCHours()).padStart(2, "0");
    const m = String(jst.getUTCMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  } catch (e) { return ""; }
}

/**
 * by オブジェクトから staff ドキュメントの ID を解決する
 * 優先順: 1. by.staffId  2. by.uid → authUid で逆引き  3. 文字列そのまま(旧形式)
 */
async function resolveStaffDocId(db, by) {
  if (!by) return null;
  if (typeof by === "object") {
    if (by.staffId) return by.staffId;
    if (by.uid) {
      // authUid で staff doc を逆引き
      try {
        const snap = await db.collection("staff").where("authUid", "==", by.uid).limit(1).get();
        if (!snap.empty) return snap.docs[0].id;
      } catch (e) {
        console.warn(`[resolveStaffDocId] authUid 逆引き失敗:`, e.message);
      }
    }
  }
  if (typeof by === "string") return by; // 旧形式(文字列 = staffId 前提)
  return null;
}

/**
 * putOut データを laundry コレクションに同期する
 * 二重作成防止: sourceChecklistId + sourceField で既存ドキュメントを検索し、あれば update
 */
async function syncPutOutToLaundry(db, checklistId, after, putOut) {
  const paymentMethod = putOut.paymentMethod || "";
  // cash/credit は立替あり、prepaid/invoice は立替なし
  const isReimbursable = ["cash", "credit"].includes(paymentMethod);

  // staff ドキュメント ID を解決 (auth uid 混入バグ対策)
  const staffIdStr = await resolveStaffDocId(db, putOut.by) || "";

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
 * 作業実績 (shift) を冪等生成する
 * sourceChecklistId + sourceAction で既存ドキュメントを検索し、あれば update、なければ新規作成
 *
 * @param {object} db
 * @param {string} checklistId
 * @param {string} sourceAction  "put_out" | "expense" | "collected"
 * @param {object} shiftData     保存するフィールド
 */
async function upsertLaundryShift(db, checklistId, sourceAction, shiftData) {
  const existing = await db.collection("shifts")
    .where("sourceChecklistId", "==", checklistId)
    .where("sourceAction", "==", sourceAction)
    .limit(1)
    .get();

  if (!existing.empty) {
    await existing.docs[0].ref.update({ ...shiftData, updatedAt: FieldValue.serverTimestamp() });
    console.log(`[upsertLaundryShift] update docId=${existing.docs[0].id} action=${sourceAction}`);
  } else {
    await db.collection("shifts").add({
      ...shiftData,
      sourceChecklistId: checklistId,
      sourceAction,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log(`[upsertLaundryShift] create action=${sourceAction} checklistId=${checklistId}`);
  }
}

/**
 * 作業実績 (shift) を削除する (sourceChecklistId + sourceAction で特定)
 */
async function deleteLaundryShift(db, checklistId, sourceAction) {
  const snap = await db.collection("shifts")
    .where("sourceChecklistId", "==", checklistId)
    .where("sourceAction", "==", sourceAction)
    .get();
  await Promise.all(snap.docs.map(d => d.ref.delete()));
  if (!snap.empty) {
    console.log(`[deleteLaundryShift] deleted ${snap.size} docs action=${sourceAction} checklistId=${checklistId}`);
  }
}

/**
 * propertyWorkItems から workItem を name で検索する
 * 見つからなければ fallback で name="ランドリー立替" の仮 workItem を返す
 */
async function findWorkItemByName(db, propertyId, name) {
  if (!propertyId) return null;
  try {
    const doc = await db.collection("propertyWorkItems").doc(propertyId).get();
    if (!doc.exists) return null;
    const items = doc.data().items || [];
    const found = items.find(wi => wi.name === name);
    if (found) return found;
  } catch (e) {
    console.warn(`[findWorkItemByName] propertyWorkItems 取得失敗:`, e.message);
  }
  return null;
}

/**
 * putOut セット時に作業実績を生成する
 * - shift1: workType=laundry_put_out (「ランドリー出し」)
 * - shift2: workType=laundry_expense (「ランドリープリカXXXX」or「ランドリー現金XXXX」) ※立替あり時
 */
async function createPutOutShifts(db, checklistId, after, putOut) {
  const propertyId = after.propertyId || "";
  const bookingId = after.bookingId || "";
  const date = after.checkoutDate || after.date || null;

  // staff ドキュメント ID を解決 (auth uid 混入バグ対策)
  const staffId = await resolveStaffDocId(db, putOut.by) || "";

  // 「ランドリー出し」 workItem を名前で検索
  const putOutItemName = "ランドリー出し";
  const putOutItem = await findWorkItemByName(db, propertyId, putOutItemName);
  const putOutAmount = putOutItem ? (Number(putOutItem.commonRate || putOutItem.commonRates?.[1] || 0)) : 0;

  const baseShiftData = {
    staffId,
    propertyId,
    propertyName: after.propertyName || "",
    bookingId,
    date: date ? (typeof date === "string" ? new Date(date + "T00:00:00.000Z") : date) : null,
    status: "completed",
    assignMethod: "auto_laundry",
  };

  // shift1: ランドリー出し
  await upsertLaundryShift(db, checklistId, "put_out", {
    ...baseShiftData,
    workType: "laundry_put_out",
    workItemName: putOutItemName,
    amount: putOutAmount,
  });

  // shift2: 立替金額がある場合のみ
  const amount = Number(putOut.amount) || 0;
  if (amount > 0) {
    const paymentMethod = putOut.paymentMethod || "";
    let expenseName;
    if (paymentMethod === "prepaid") {
      expenseName = `ランドリープリカ${amount}`;
    } else {
      expenseName = `ランドリー現金${amount}`;
    }
    // workItem を名前で検索 (なければ fallback として amount をそのまま使用)
    const expenseItem = await findWorkItemByName(db, propertyId, expenseName);
    const expenseAmount = expenseItem ? (Number(expenseItem.commonRate || expenseItem.commonRates?.[1] || amount)) : amount;

    await upsertLaundryShift(db, checklistId, "expense", {
      ...baseShiftData,
      workType: "laundry_expense",
      workItemName: expenseName,
      amount: expenseAmount,
    });
  } else {
    // 金額が 0 になった場合は expense shift を削除
    await deleteLaundryShift(db, checklistId, "expense");
  }
}

/**
 * collected セット時に作業実績を生成する
 * - shift: workType=laundry_collected (「ランドリー受取」)
 */
async function createCollectedShift(db, checklistId, after, collected) {
  const propertyId = after.propertyId || "";
  const bookingId = after.bookingId || "";
  const date = after.checkoutDate || after.date || null;

  // staff ドキュメント ID を解決 (auth uid 混入バグ対策)
  const staffId = await resolveStaffDocId(db, collected.by) || "";

  const collectedItemName = "ランドリー受取";
  const collectedItem = await findWorkItemByName(db, propertyId, collectedItemName);
  const collectedAmount = collectedItem ? (Number(collectedItem.commonRate || collectedItem.commonRates?.[1] || 0)) : 0;

  await upsertLaundryShift(db, checklistId, "collected", {
    staffId,
    propertyId,
    propertyName: after.propertyName || "",
    bookingId,
    date: date ? (typeof date === "string" ? new Date(date + "T00:00:00.000Z") : date) : null,
    status: "completed",
    assignMethod: "auto_laundry",
    workType: "laundry_collected",
    workItemName: collectedItemName,
    amount: collectedAmount,
  });
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
    // 作業実績 (shift) 自動生成
    try {
      await createPutOutShifts(db, checklistId, after, afterPutOut);
    } catch (e) {
      console.error(`[onChecklistLaundryChange] createPutOutShifts エラー:`, e);
      try {
        await db.collection("error_logs").add({
          type: "onChecklistLaundryChange_putOutShift",
          message: e.message,
          checklistId,
          createdAt: new Date(),
        });
      } catch (_) { /* ignore */ }
    }
  } else if (wasSet && !nowSet) {
    // putOut が削除された → laundry コレクションからも削除、対応 shift も削除
    try {
      await deleteLaundryByChecklist(db, checklistId);
    } catch (e) {
      console.error(`[onChecklistLaundryChange] deleteLaundryByChecklist エラー:`, e);
    }
    try {
      await deleteLaundryShift(db, checklistId, "put_out");
      await deleteLaundryShift(db, checklistId, "expense");
    } catch (e) {
      console.error(`[onChecklistLaundryChange] deleteLaundryShift(put_out/expense) エラー:`, e);
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

    // 削除時 (値あり → null): 対応する shift (報酬) も削除
    if (wasSet && !nowSet) {
      if (key === "collected") {
        try {
          await deleteLaundryShift(db, checklistId, "collected");
        } catch (e) {
          console.error(`[onChecklistLaundryChange] deleteLaundryShift(collected) エラー:`, e);
        }
      } else if (key === "putOut") {
        // 「ランドリー出し」解除 → put_out + expense (立替) 両方削除
        try {
          await deleteLaundryShift(db, checklistId, "put_out");
          await deleteLaundryShift(db, checklistId, "expense");
        } catch (e) {
          console.error(`[onChecklistLaundryChange] deleteLaundryShift(put_out/expense) エラー:`, e);
        }
      }
    }

    if (wasSet || !nowSet) continue; // null → 値 の遷移のみで通知処理

    // collected: 作業実績を生成
    if (key === "collected") {
      try {
        await createCollectedShift(db, checklistId, after, afterLaundry[key]);
      } catch (e) {
        console.error(`[onChecklistLaundryChange] createCollectedShift エラー:`, e);
        try {
          await db.collection("error_logs").add({
            type: "onChecklistLaundryChange_collectedShift",
            message: e.message,
            checklistId,
            createdAt: new Date(),
          });
        } catch (_) { /* ignore */ }
      }
    }

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
        work: workLabel(after.workType),
        workType: after.workType || "cleaning",
        url: checklistUrl,
      };

      const title = `ランドリー: ${label}`;
      const body = `🧺 ランドリー ${label}\n\n${dateStr} ${propertyName}\n${staffName}さんが${timeStr}に${verb}。\n詳細: ${checklistUrl}`;

      // notifyByKey でチャネル別 (owner/group/staff/email/discord) に発射
      // 割当済みスタッフだけに staffLine を絞るため staffIds を渡す
      const assignedStaffIds = Array.isArray(after.staffIds) && after.staffIds.length
        ? after.staffIds
        : (after.staffId ? [after.staffId] : []);
      await notifyByKey(db, type, {
        title,
        body,
        vars,
        propertyId: after.propertyId || null,
        staffIds: assignedStaffIds.length ? assignedStaffIds : null,
      });

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
