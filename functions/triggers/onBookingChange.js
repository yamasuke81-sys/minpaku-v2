/**
 * 予約変更トリガー
 * 予約が作成/更新された時に、チェックアウト日の清掃シフトと募集を自動生成する
 */
const admin_module = require("firebase-admin");
const {
  notifyOwner,
  notifyGroup,
  notifyStaff,
  buildRecruitmentFlex,
  resolveNotifyTargets,
  getNotificationSettings_,
} = require("../utils/lineNotify");
const { addRecruitmentToActiveStaff, removeRecruitmentFromAllStaff } = require("../utils/inactiveStaff");

// YYYY-MM-DD 文字列から UTC midnight の Date を作成 (JST ズレなし)
function toUtcMidnight(dateStr) {
  if (!dateStr) return null;
  return new Date(dateStr + "T00:00:00.000Z");
}

// キャンセル済みステータス判定（module スコープで共有）
function isCancelled(s) {
  const x = String(s || "").toLowerCase();
  return x.includes("cancel") || s === "キャンセル" || s === "キャンセル済み";
}

// before/after のどちらかがキャンセル状態なら日程変更処理は行わない
function wasCancelledShortcut(before, after) {
  return isCancelled(before.status) || isCancelled(after.status);
}

// 指定物件+日付の清掃 shift/recruitment/checklist を削除(同日の他active予約があればスキップ)
async function cancelCleaningForDate_(db, propertyId, dateStr, excludeBookingId) {
  if (!propertyId || !dateStr) return;
  const others = await db.collection("bookings")
    .where("propertyId", "==", propertyId)
    .where("checkOut", "==", dateStr)
    .get();
  const stillHasActive = others.docs.some(d => {
    if (d.id === excludeBookingId) return false;
    return !isCancelled(d.data().status);
  });
  if (stillHasActive) {
    console.log(`[cancelCleaningForDate_] ${dateStr} に他active予約あり、キャンセルスキップ`);
    return;
  }
  const dObj = toUtcMidnight(dateStr);
  const shiftSnap = await db.collection("shifts")
    .where("propertyId", "==", propertyId)
    .where("date", "==", dObj)
    .get();
  for (const s of shiftSnap.docs) {
    const cls = await db.collection("checklists").where("shiftId", "==", s.id).get();
    for (const c of cls.docs) await c.ref.delete();
    await s.ref.delete();
  }
  const recSnap = await db.collection("recruitments")
    .where("propertyId", "==", propertyId)
    .where("checkoutDate", "==", dateStr)
    .get();
  for (const r of recSnap.docs) {
    await removeRecruitmentFromAllStaff(db, r.id);
    await r.ref.delete();
  }
}

// ========== D-1: ダブルブッキング検知 ==========

/**
 * 同物件・日程重複の予約を検出してオーナーに通知する
 * 重複条件: new.checkIn < existing.checkOut && existing.checkIn < new.checkOut
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} bookingId
 * @param {object} after - 変更後の予約データ
 */
async function detectDoubleBooking(db, bookingId, after) {
  if (!after.propertyId || !after.checkIn || !after.checkOut) return;
  if (isCancelled(after.status)) return;

  const snap = await db.collection("bookings")
    .where("propertyId", "==", after.propertyId)
    .get();

  const conflicts = snap.docs.filter(d => {
    if (d.id === bookingId) return false;
    const x = d.data();
    if (isCancelled(x.status)) return false;
    // 日程重複判定（YYYY-MM-DD文字列比較）
    return after.checkIn < x.checkOut && x.checkIn < after.checkOut;
  });

  if (conflicts.length === 0) return;

  const conflictIds = conflicts.map(d => d.id);

  // conflictWithIds の Set 比較用ユーティリティ
  function sameIds(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    const sa = new Set(a), sb = new Set(b);
    for (const x of sa) if (!sb.has(x)) return false;
    return true;
  }

  // 当該予約に conflictWithIds をセット（変化がある場合のみ更新してカスケードを抑制）
  const currentDoc = await db.collection("bookings").doc(bookingId).get();
  const currentIds = currentDoc.exists ? (currentDoc.data().conflictWithIds || []) : [];
  if (!sameIds(currentIds, conflictIds)) {
    await db.collection("bookings").doc(bookingId).update({
      conflictWithIds: conflictIds,
      conflictDetectedAt: admin_module.firestore.FieldValue.serverTimestamp(),
    });
  }

  // 衝突相手の予約にも当該IDを追加（変化がある場合のみ更新してカスケードを抑制）
  for (const c of conflicts) {
    const existingConflicts = c.data().conflictWithIds || [];
    const merged = Array.from(new Set([...existingConflicts, bookingId]));
    if (!sameIds(existingConflicts, merged)) {
      await c.ref.update({
        conflictWithIds: merged,
        conflictDetectedAt: admin_module.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  // bookingConflicts コレクションに記録
  // 既に resolved: true の場合は resolved フィールドを上書きしない
  for (const c of conflicts) {
    const confId = [bookingId, c.id].sort().join("__");
    const confRef = db.collection("bookingConflicts").doc(confId);
    await db.runTransaction(async (tx) => {
      const confDoc = await tx.get(confRef);
      if (!confDoc.exists) {
        // 新規作成
        tx.set(confRef, {
          bookingIds: [bookingId, c.id].sort(),
          propertyId: after.propertyId,
          propertyName: after.propertyName || "",
          detectedAt: admin_module.firestore.FieldValue.serverTimestamp(),
          detectedBy: "realtime",
          resolved: false,
        });
      } else if (confDoc.data().resolved === true) {
        // 既に解決済み → resolved は触らず detectedAt も更新しない
        // （カスケード再発火による resolved: true 上書きを防止）
      } else {
        // 未解決 → detectedAt 等を更新（resolved は false のまま）
        tx.update(confRef, {
          bookingIds: [bookingId, c.id].sort(),
          propertyId: after.propertyId,
          propertyName: after.propertyName || "",
          detectedAt: admin_module.firestore.FieldValue.serverTimestamp(),
          detectedBy: "realtime",
        });
      }
    });
  }

  // ダブルブッキング通知: 手動予約が絡む場合のみ通知抑制 (ユーザー指示 2026-04-22)
  // 両方 iCal 由来の重複は従来通り LINE 通知する
  const isManualLike = (x) => (x && x.manualOverride === true) || (x && /manual/i.test(String(x.source || "")));
  const afterIsManual = isManualLike(after);
  const anyConflictIsManual = conflicts.some(c => isManualLike(c.data()));

  if (afterIsManual || anyConflictIsManual) {
    console.log(`[onBookingChange] ダブルブッキング検出 (手動絡みのため通知抑制): ${bookingId} と ${conflictIds.join(", ")}`);
  } else {
    // 通知設定を参照して送信先を判定（物件別オーバーライド適用）
    try {
      const { settings } = await getNotificationSettings_(db);
      let propertyOverrides = {};
      if (after.propertyId) {
        const propDoc = await db.collection("properties").doc(after.propertyId).get();
        if (propDoc.exists) propertyOverrides = propDoc.data().channelOverrides || {};
      }
      const targets = resolveNotifyTargets(settings, "double_booking", propertyOverrides);
      if (targets.enabled) {
        const title = `ダブルブッキング検出: ${after.checkIn}〜${after.checkOut}`;
        const body = `【⚠️ ダブルブッキング警告】\n物件: ${after.propertyName || after.propertyId}\n日程: ${after.checkIn} 〜 ${after.checkOut}\n衝突件数: ${conflicts.length}件\n\n確認: https://minpaku-v2.web.app/#/schedule`;
        if (targets.ownerLine) {
          await notifyOwner(db, "double_booking", title, body, {}, propertyOverrides);
        }
        if (targets.groupLine) {
          await notifyGroup(db, "double_booking", title, body, {}, propertyOverrides);
        }
      }
    } catch (e) {
      console.error("[onBookingChange] ダブルブッキング通知エラー:", e);
    }
    console.log(`[onBookingChange] ダブルブッキング検出: ${bookingId} と ${conflictIds.join(", ")}`);
  }
}

// ========== D-2: cancelled化時の conflict 解決 ==========

/**
 * 予約がキャンセルになった際、関連する conflict を解決済みにする
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} bookingId
 * @param {object} data - キャンセルされた予約データ
 */
async function resolveConflictsOnCancel(db, bookingId, data) {
  const conflictWithIds = data.conflictWithIds;
  if (!Array.isArray(conflictWithIds) || conflictWithIds.length === 0) return;

  for (const otherId of conflictWithIds) {
    // 合成ID（sorted join）で bookingConflicts ドキュメントを解決済みに更新
    const confId = [bookingId, otherId].sort().join("__");
    try {
      await db.collection("bookingConflicts").doc(confId).update({
        resolved: true,
        resolvedAt: admin_module.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      // ドキュメントが存在しない場合はスキップ
      console.warn(`[onBookingChange] bookingConflicts/${confId} 更新スキップ:`, e.message);
    }

    // 相手予約の conflictWithIds から自分を除去
    try {
      const otherDoc = await db.collection("bookings").doc(otherId).get();
      if (otherDoc.exists) {
        const otherData = otherDoc.data();
        const updatedIds = (otherData.conflictWithIds || []).filter(id => id !== bookingId);
        await otherDoc.ref.update({ conflictWithIds: updatedIds });
      }
    } catch (e) {
      console.warn(`[onBookingChange] 相手予約 ${otherId} のconflictWithIds除去エラー:`, e.message);
    }
  }

  console.log(`[onBookingChange] conflict解決完了: ${bookingId} → ${conflictWithIds.join(", ")}`);
}

module.exports = async function onBookingChange(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  const before = event.data.before?.data();
  const after = event.data.after?.data();

  // ========== D: 予約日程変更時の自動処理 ==========
  // before/after どちらも存在し、両方アクティブの場合に限って判定
  // ルール:
  //  - CI/COどちらも変更: 旧CO/新CI 両方の shift/recruitment をキャンセル→新規募集
  //  - CIのみ変更       : そのまま続行
  //  - COのみ変更       : 旧COの shift/recruitment をキャンセル→新CO日で再募集
  // (キャンセル自体は下部で after 非active扱いとしてフロー継続で処理)
  if (before && after && !wasCancelledShortcut(before, after)) {
    try {
      const ciChanged = before.checkIn && after.checkIn && before.checkIn !== after.checkIn;
      const coChanged = before.checkOut && after.checkOut && before.checkOut !== after.checkOut;
      const pid = after.propertyId || before.propertyId;
      if (pid && (coChanged || (ciChanged && coChanged))) {
        // 旧COの shift/recruitment を削除(同日他active無ければ)
        await cancelCleaningForDate_(db, pid, before.checkOut, event.params.bookingId);
        console.log(`[onBookingChange] 日程変更: ${event.params.bookingId} 旧CO=${before.checkOut} → 新CO=${after.checkOut} の清掃キャンセル完了`);
      } else if (ciChanged && !coChanged) {
        console.log(`[onBookingChange] CIのみ変更: ${event.params.bookingId} 続行 (清掃維持)`);
      }
      // 新CO日付の募集は後段の通常フローで自動生成される
    } catch (e) {
      console.error("日程変更処理エラー:", e);
    }
  }

  // 削除 or キャンセル化: 対応する shifts/recruitments/checklists を削除
  const wasCancelled = before && isCancelled(before.status);
  const nowCancelled = after && isCancelled(after.status);
  if (!after || (nowCancelled && !wasCancelled)) {
    const src = after || before;
    const pid = src?.propertyId;
    const co = src?.checkOut;
    const bid = event.params.bookingId;
    if (pid && co) {
      try {
        // 同日同物件に別の active 予約があるかチェック
        const otherActives = await db.collection("bookings")
          .where("propertyId", "==", pid)
          .where("checkOut", "==", co)
          .get();
        const stillHasActive = otherActives.docs.some(d => {
          if (d.id === bid) return false;
          return !isCancelled(d.data().status);
        });

        if (!stillHasActive) {
          // 対応するシフト削除
          const coDate = toUtcMidnight(co);
          const shiftSnap = await db.collection("shifts")
            .where("propertyId", "==", pid)
            .where("date", "==", coDate).get();
          for (const s of shiftSnap.docs) {
            const cls = await db.collection("checklists").where("shiftId", "==", s.id).get();
            for (const c of cls.docs) await c.ref.delete();
            await s.ref.delete();
          }
          // 対応する募集削除
          const recSnap = await db.collection("recruitments")
            .where("propertyId", "==", pid)
            .where("checkoutDate", "==", co).get();
          for (const r of recSnap.docs) {
            await removeRecruitmentFromAllStaff(db, r.id);
            await r.ref.delete();
          }
          console.log(`[onBookingChange] キャンセル連動削除: ${bid} (${co}, prop=${pid})`);
        } else {
          console.log(`[onBookingChange] キャンセル: ${bid} (同日別active予約あり、削除スキップ)`);
        }
      } catch (e) {
        console.error("キャンセル連動削除エラー:", e);
      }
    }
    // D-2: キャンセル化時に conflictWithIds の相手 booking / bookingConflicts を解決済みに更新
    if (nowCancelled && after) {
      try {
        await resolveConflictsOnCancel(db, event.params.bookingId, after);
      } catch (e) {
        console.error("conflict解決エラー:", e);
      }
    }
    // 削除 or キャンセル化はここで終了
    if (!after) return;
    if (nowCancelled) return;
  }

  const { checkIn, checkOut, propertyId, guestName, source, bookingId: bookingIdFromData } = after;
  // bookingId はドキュメントIDから取得
  const bookingId = event.params.bookingId;

  // propertyIdが空の場合はスキップ（物件未紐付け予約）
  if (!propertyId) {
    console.log(`予約 ${bookingId}: propertyId未設定のためスキップ`);
    return;
  }

  // checkOutが未設定の場合はスキップ
  if (!checkOut) {
    console.log(`予約 ${bookingId}: checkOut未設定のためスキップ`);
    return;
  }

  // checkOutが過去の場合はスキップ（YYYY-MM-DD形式）
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const checkOutDate = toUtcMidnight(checkOut);
  if (checkOutDate < today) {
    console.log(`予約 ${bookingId}: checkOut(${checkOut})が過去のためスキップ`);
    return;
  }

  // ========== D-1: ダブルブッキング検知 ==========
  // 新規作成 or 日程変更時に、同物件の active 予約と重複チェック
  // ※ 募集重複チェック等の早期 return より前に実行して確実に動かす
  try {
    await detectDoubleBooking(db, bookingId, after);
  } catch (e) {
    console.error("ダブルブッキング検知エラー:", e);
  }

  // propertiesコレクションからpropertyName + 設定を取得
  let propertyName = "";
  let propertyData = {};
  try {
    const propertyDoc = await db.collection("properties").doc(propertyId).get();
    if (propertyDoc.exists) {
      propertyData = propertyDoc.data();
      propertyName = propertyData.name || "";
    }
  } catch (e) {
    console.error("物件取得エラー:", e);
  }

  const now = new Date();

  // ========== シフト重複チェック ==========
  const existingShifts = await db.collection("shifts")
    .where("date", "==", checkOutDate)
    .where("propertyId", "==", propertyId)
    .get();

  // キャンセル済み予約に紐付く残留シフトを削除してから再生成する
  let shouldCreateShift = existingShifts.empty;
  if (!existingShifts.empty) {
    let allStale = true;
    for (const shiftDoc of existingShifts.docs) {
      const shiftData = shiftDoc.data();
      const linkedBookingId = shiftData.bookingId;
      if (!linkedBookingId) {
        // bookingId 未設定のシフトは古い残留物として削除対象
        console.log(`予約 ${bookingId}: シフト ${shiftDoc.id} に bookingId 未設定 → 削除対象`);
        continue;
      }
      try {
        const linkedBookingDoc = await db.collection("bookings").doc(linkedBookingId).get();
        if (!linkedBookingDoc.exists || isCancelled(linkedBookingDoc.data().status)) {
          // 紐付き予約が存在しないかキャンセル済み → 残留シフトとして削除
          console.log(`予約 ${bookingId}: シフト ${shiftDoc.id} はキャンセル済み予約(${linkedBookingId})由来 → 削除して再生成`);
        } else {
          // 有効な予約が紐付いている → スキップ
          allStale = false;
        }
      } catch (e) {
        console.error(`シフト ${shiftDoc.id} の紐付き予約確認エラー:`, e);
        allStale = false;
      }
    }

    if (allStale) {
      // 全シフトが残留物 → 削除して再生成
      for (const shiftDoc of existingShifts.docs) {
        try {
          const cls = await db.collection("checklists").where("shiftId", "==", shiftDoc.id).get();
          for (const c of cls.docs) await c.ref.delete();
          await shiftDoc.ref.delete();
          console.log(`予約 ${bookingId}: 残留シフト ${shiftDoc.id} を削除`);
        } catch (e) {
          console.error(`残留シフト ${shiftDoc.id} 削除エラー:`, e);
        }
      }
      shouldCreateShift = true;
    } else {
      console.log(`予約 ${bookingId}: 同日同物件のシフトが既に存在(有効な予約あり)のためスキップ`);
    }
  }

  if (shouldCreateShift) {
    // シフト自動生成
    try {
      await db.collection("shifts").add({
        date: checkOutDate,
        propertyId,
        propertyName,
        bookingId,
        workType: "cleaning_by_count",
        staffId: null,
        staffName: null,
        startTime: propertyData.cleaningStartTime || "10:30",
        status: "unassigned",
        assignMethod: "auto",
        createdAt: now,
        updatedAt: now,
      });
      console.log(`予約 ${bookingId}: シフト自動生成完了 (${checkOut})`);
    } catch (e) {
      console.error("シフト生成エラー:", e);
    }
  }

  // ========== 募集重複チェック ==========
  const existingRecruitments = await db.collection("recruitments")
    .where("checkoutDate", "==", checkOut)
    .where("propertyId", "==", propertyId)
    .get();

  // キャンセル済み予約に紐付く残留募集を削除してから再生成する
  let shouldCreateRecruitment = existingRecruitments.empty;
  if (!existingRecruitments.empty) {
    let allStaleRec = true;
    for (const recDoc of existingRecruitments.docs) {
      const recData = recDoc.data();
      const linkedBookingId = recData.bookingId;
      if (!linkedBookingId) {
        // bookingId 未設定の募集は残留物として削除対象
        console.log(`予約 ${bookingId}: 募集 ${recDoc.id} に bookingId 未設定 → 削除対象`);
        continue;
      }
      try {
        const linkedBookingDoc = await db.collection("bookings").doc(linkedBookingId).get();
        if (!linkedBookingDoc.exists || isCancelled(linkedBookingDoc.data().status)) {
          // 紐付き予約が存在しないかキャンセル済み → 残留募集として削除
          console.log(`予約 ${bookingId}: 募集 ${recDoc.id} はキャンセル済み予約(${linkedBookingId})由来 → 削除して再生成`);
        } else {
          // 有効な予約が紐付いている → スキップ
          allStaleRec = false;
        }
      } catch (e) {
        console.error(`募集 ${recDoc.id} の紐付き予約確認エラー:`, e);
        allStaleRec = false;
      }
    }

    if (allStaleRec) {
      // 全募集が残留物 → 削除して再生成
      for (const recDoc of existingRecruitments.docs) {
        try {
          await removeRecruitmentFromAllStaff(db, recDoc.id);
          await recDoc.ref.delete();
          console.log(`予約 ${bookingId}: 残留募集 ${recDoc.id} を削除`);
        } catch (e) {
          console.error(`残留募集 ${recDoc.id} 削除エラー:`, e);
        }
      }
      shouldCreateRecruitment = true;
    } else {
      console.log(`予約 ${bookingId}: 同日同物件の募集が既に存在(有効な予約あり)のためスキップ`);
    }
  }

  if (!shouldCreateRecruitment) return;

  // 募集自動生成
  const memo = `ゲスト: ${guestName || "不明"} (${source || "不明"})`;
  let recruitmentId;
  try {
    const recruitmentRef = await db.collection("recruitments").add({
      checkoutDate: checkOut,
      propertyId,
      propertyName,
      bookingId,
      workType: "cleaning",
      status: "募集中",
      selectedStaff: "",
      selectedStaffIds: [],
      memo,
      responses: [],
      createdAt: now,
      updatedAt: now,
    });
    recruitmentId = recruitmentRef.id;
    console.log(`予約 ${bookingId}: 募集自動生成完了 (${checkOut}) recruitmentId=${recruitmentId}`);
    // E: pendingRecruitmentIds に追加 + しきい値超過で非アクティブ化
    try { await addRecruitmentToActiveStaff(db, recruitmentId); } catch (e) { console.error("addRecruitmentToActiveStaff エラー:", e); }
  } catch (e) {
    console.error("募集生成エラー:", e);
    return;
  }

  // ========== LINE通知 ==========
  try {
    const { settings } = await getNotificationSettings_(db);
    // propertyData は既に取得済みなので再取得しない
    const propertyOverrides = (propertyData && propertyData.channelOverrides) || {};
    const targets = resolveNotifyTargets(settings, "recruit_start", propertyOverrides);

    if (!targets.enabled) {
      console.log("recruit_start通知が無効のためスキップ");
      return;
    }

    // アプリベースURL取得（settings/notifications.appUrl or デフォルト）
    const appUrl = settings?.appUrl || "https://minpaku-v2.web.app";
    const recruitUrl = `${appUrl}/#/my-recruitment`;

    const flexMessage = buildRecruitmentFlex(
      { checkoutDate: checkOut, propertyName, memo },
      appUrl
    );

    // 変数置換用 vars (customMessage で {date}/{property}/{work}/{url}/{memo} が置換される)
    const baseVars = {
      date: checkOut,
      property: propertyName || "",
      work: "清掃",
      url: recruitUrl,
      memo: memo || "",
    };

    // オーナーLINE通知
    if (targets.ownerLine) {
      await notifyOwner(
        db,
        "recruit_start",
        `清掃スタッフ募集: ${checkOut}`,
        `【清掃スタッフ募集】\n${checkOut} ${propertyName}\n${memo}\n回答: ${recruitUrl}`,
        baseVars,
        propertyOverrides
      );
    }

    // グループLINE通知
    if (targets.groupLine) {
      await notifyGroup(
        db,
        "recruit_start",
        `清掃スタッフ募集: ${checkOut}`,
        flexMessage,
        baseVars,
        propertyOverrides
      );
    }

    // スタッフ個別通知（activeなスタッフ全員）
    if (targets.staffLine) {
      const staffSnap = await db.collection("staff")
        .where("active", "==", true)
        .get();
      const notifyPromises = staffSnap.docs.map((doc) =>
        notifyStaff(
          db,
          doc.id,
          "recruit_start",
          `清掃スタッフ募集: ${checkOut}`,
          flexMessage,
          baseVars,
          propertyOverrides
        )
      );
      await Promise.all(notifyPromises);
    }
  } catch (e) {
    console.error("LINE通知エラー:", e);
  }

  // ========== 直前点検 (チェックイン日) ==========
  // 条件: 物件の inspection.enabled=true, 募集期間内, 当該物件の checkIn日に他予約のcheckOutがない
  try {
    const inspection = propertyData.inspection || {};
    if (!inspection.enabled) return;
    if (!checkIn) return;

    const checkInDate = toUtcMidnight(checkIn);
    if (checkInDate < today) return;

    // 期間フィルタ
    if (inspection.recurYearly) {
      // 毎年繰り返し: MM-DD で照合
      const md = checkIn.slice(5); // "MM-DD"
      const s = inspection.recurStart || "01-01";
      const e = inspection.recurEnd || "12-31";
      if (s <= e) {
        if (md < s || md > e) return;
      } else {
        // 年跨ぎ (例: 11-01〜02-28)
        if (md < s && md > e) return;
      }
    } else {
      if (inspection.periodStart && checkIn < inspection.periodStart) return;
      if (inspection.periodEnd && checkIn > inspection.periodEnd) return;
    }

    // 同日他予約の checkOut があれば直前点検不要(清掃が兼ねる)
    const sameDayOutSnap = await db.collection("bookings")
      .where("propertyId", "==", propertyId)
      .where("checkOut", "==", checkIn).limit(1).get();
    if (!sameDayOutSnap.empty) {
      console.log(`予約 ${bookingId}: ${checkIn} に他予約の checkOut あり → 直前点検スキップ`);
      return;
    }

    // 既存の直前点検シフトをチェック
    const insShiftSnap = await db.collection("shifts")
      .where("date", "==", checkInDate)
      .where("propertyId", "==", propertyId)
      .where("workType", "==", "pre_inspection")
      .limit(1).get();
    if (!insShiftSnap.empty) {
      console.log(`予約 ${bookingId}: 直前点検シフト既存のためスキップ`);
    } else {
      await db.collection("shifts").add({
        date: checkInDate,
        propertyId, propertyName,
        bookingId,
        workType: "pre_inspection",
        staffId: null, staffName: null, staffIds: [],
        startTime: propertyData.inspectionStartTime || "10:00",
        status: "unassigned",
        assignMethod: "auto",
        createdAt: now, updatedAt: now,
      });
      console.log(`予約 ${bookingId}: 直前点検シフト生成 (${checkIn})`);
    }

    // 既存の直前点検募集をチェック
    const insRecSnap = await db.collection("recruitments")
      .where("propertyId", "==", propertyId)
      .where("checkoutDate", "==", checkIn)
      .where("workType", "==", "pre_inspection")
      .limit(1).get();
    let insRecruitmentId = null;
    if (insRecSnap.empty) {
      const insRef = await db.collection("recruitments").add({
        checkoutDate: checkIn,           // 直前点検の実施日(=checkIn)
        propertyId, propertyName,
        bookingId,
        workType: "pre_inspection",
        status: "募集中",
        selectedStaff: "",
        selectedStaffIds: [],
        memo: `直前点検: ゲスト ${guestName || "不明"} (${source || ""})`,
        responses: [],
        createdAt: now, updatedAt: now,
      });
      insRecruitmentId = insRef.id;
      console.log(`予約 ${bookingId}: 直前点検募集生成 (${checkIn})`);
      try { await addRecruitmentToActiveStaff(db, insRecruitmentId); } catch (e) { console.error("addRecruitmentToActiveStaff(直前点検) エラー:", e); }
    }

    // 直前点検の募集通知
    try {
      const { settings: s2 } = await getNotificationSettings_(db);
      // propertyData は既に取得済みなので再取得しない
      const propOv2 = (propertyData && propertyData.channelOverrides) || {};
      const tgt2 = resolveNotifyTargets(s2, "recruit_start", propOv2);
      if (!tgt2.enabled || !insRecruitmentId) return;
      const appUrl2 = s2?.appUrl || "https://minpaku-v2.web.app";
      const recruitUrl2 = `${appUrl2}/#/my-recruitment`;
      const memo2 = `直前点検: ゲスト ${guestName || "不明"} (${source || ""})`;
      const flex2 = buildRecruitmentFlex({ checkoutDate: checkIn, propertyName, memo: memo2 }, appUrl2);
      const baseVars2 = { date: checkIn, property: propertyName || "", work: "直前点検", url: recruitUrl2, memo: memo2 };

      if (tgt2.ownerLine) {
        await notifyOwner(db, "recruit_start", `直前点検スタッフ募集: ${checkIn}`,
          `【直前点検スタッフ募集】\n${checkIn} ${propertyName}\n${memo2}\n回答: ${recruitUrl2}`, baseVars2, propOv2);
      }
      if (tgt2.groupLine) {
        await notifyGroup(db, "recruit_start", `直前点検スタッフ募集: ${checkIn}`, flex2, baseVars2, propOv2);
      }
      if (tgt2.staffLine) {
        const staffSnap2 = await db.collection("staff").where("active", "==", true).get();
        await Promise.all(staffSnap2.docs.map(doc =>
          notifyStaff(db, doc.id, "recruit_start", `直前点検スタッフ募集: ${checkIn}`, flex2, baseVars2, propOv2)
        ));
      }
    } catch (notifErr) {
      console.error("直前点検LINE通知エラー:", notifErr);
    }
  } catch (e) {
    console.error("直前点検 処理エラー:", e);
  }
};
