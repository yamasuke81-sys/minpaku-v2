/**
 * 予約変更トリガー
 * 予約が作成/更新された時に、チェックアウト日の清掃シフトと募集を自動生成する
 */
const admin_module = require("firebase-admin");
const {
  notifyOwner,
  notifyGroup,
  notifyStaff,
  notifyByKey,
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
 * 同物件・日程重複の予約を検出してWebアプリ管理者に通知する
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
      let propertyDocName = "";
      if (after.propertyId) {
        const propDoc = await db.collection("properties").doc(after.propertyId).get();
        if (propDoc.exists) {
          propertyOverrides = propDoc.data().channelOverrides || {};
          propertyDocName = propDoc.data().name || "";
        }
      }
      // notifyByKey でチャネル別 (owner/group/staff/email/discord) に発射
      const resolvedPropName = after.propertyName || propertyDocName || after.propertyId;
      const title = `ダブルブッキング検出: ${after.checkIn}〜${after.checkOut}`;
      const body = `【⚠️ ダブルブッキング警告】\n物件: ${resolvedPropName}\n日程: ${after.checkIn} 〜 ${after.checkOut}\n衝突件数: ${conflicts.length}件\n\n確認: https://minpaku-v2.web.app/#/schedule`;
      await notifyByKey(db, "double_booking", {
        title,
        body,
        vars: {
          property: resolvedPropName,
          date: after.checkIn,
          checkin: after.checkIn,
          checkout: after.checkOut,
        },
        propertyId: after.propertyId || null,
      });
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

    // booking_change 通知: 「日程変更 (CI/CO)」のみで発火
    // 人数・ゲスト名の変化は emailVerification や iCal 同期で頻繁に動くため対象外
    // (誤発火を防ぐため、人数/名前の変化通知は当面なし。必要なら別 type で実装)
    try {
      const ciChanged = before.checkIn && after.checkIn && before.checkIn !== after.checkIn;
      const coChanged = before.checkOut && after.checkOut && before.checkOut !== after.checkOut;
      if (ciChanged || coChanged) {
        const changes = [];
        if (ciChanged) changes.push(`チェックイン: ${before.checkIn} → ${after.checkIn}`);
        if (coChanged) changes.push(`チェックアウト: ${before.checkOut} → ${after.checkOut}`);
        const changeSummary = changes.join("\n");

        const propName = after.propertyName || "";
        const newNights = (after.checkIn && after.checkOut)
          ? Math.max(0, (new Date(after.checkOut) - new Date(after.checkIn)) / 86400000)
          : "";
        await notifyByKey(db, "booking_change", {
          title: `予約変更: ${after.checkIn}〜${after.checkOut}`,
          body: `🔄 予約変更\n\n${propName}\n新しい日程: ${after.checkIn}〜${after.checkOut}${newNights !== "" ? `（${newNights}泊）` : ""}\nゲスト: ${after.guestName || "不明"}\n\n変更内容:\n${changeSummary}`,
          vars: {
            checkin: after.checkIn || "",
            date: after.checkOut || "",
            property: propName,
            guest: after.guestName || "",
            nights: String(newNights),
            change_summary: changeSummary,
          },
          propertyId: after.propertyId || null,
        });
      }
    } catch (e) {
      console.error("[onBookingChange] booking_change 通知エラー:", e);
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
    // booking_cancel 通知: キャンセル化時にオーナーへ通知
    // ただし「同じ propertyId の重なる期間に別の active 予約が存在する」場合は
    // 重複ドキュメントの片付け (Reserved プレースホルダ→確定降下で別 icalUid のドキュメントが
    // 新規作成され、古い方が iCal フィードから消えて自動キャンセル化される等) と判定して通知をスキップ。
    // 実キャンセル (ゲストの取消) ではない誤通知を防ぐ。
    if (nowCancelled && after) {
      try {
        let suppressCancelNotify = false;
        if (after.propertyId && after.checkIn && after.checkOut) {
          const dupSnap = await db.collection("bookings")
            .where("propertyId", "==", after.propertyId)
            .where("status", "==", "confirmed")
            .get();
          for (const d of dupSnap.docs) {
            if (d.id === event.params.bookingId) continue;
            const dd = d.data();
            if (dd.pendingApproval === true) continue;
            if (!dd.checkIn || !dd.checkOut) continue;
            // 期間重複: 1日でも重なれば重複扱い
            if (after.checkIn <= dd.checkOut && after.checkOut >= dd.checkIn) {
              suppressCancelNotify = true;
              console.log(`[onBookingChange] 重複期間に active 予約あり → cancel 通知スキップ: ${event.params.bookingId} (vs ${d.id})`);
              break;
            }
          }
        }
        if (!suppressCancelNotify) {
          const propName = after.propertyName || "";
          const nights = (after.checkIn && after.checkOut)
            ? Math.max(0, (new Date(after.checkOut) - new Date(after.checkIn)) / 86400000)
            : "";
          await notifyByKey(db, "booking_cancel", {
            title: `予約キャンセル: ${after.checkIn}〜${after.checkOut}`,
            body: `❌ 予約キャンセル\n\n${after.checkIn}〜${after.checkOut} ${propName}\nゲスト: ${after.guestName || "不明"}（${after.source || "不明"}）\n予約がキャンセルされました。`,
            vars: {
              checkin: after.checkIn || "",
              date: after.checkOut || "",
              property: propName,
              guest: after.guestName || "",
              site: after.source || "",
              nights: String(nights),
            },
            propertyId: after.propertyId || null,
          });
        }
      } catch (e) {
        console.error("[onBookingChange] booking_cancel 通知エラー:", e);
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

  // ========== メール照合保留ガード ==========
  // pendingApproval=true (Airbnbの保留中リクエスト等) の予約は募集生成・通知をスキップ
  // → 確定メール受信で emailVerificationCore が pendingApproval=false に降ろした瞬間、
  //   bookings 更新イベントとして再発火し、ここを通過して募集生成
  if (after.pendingApproval === true) {
    console.log(`予約 ${bookingId}: pendingApproval=true (メール承認待ち) のため募集生成スキップ`);
    return;
  }
  // 念のため emailVerifications 側も直接確認 (pendingApproval が立つ前にレースする場合の保険)
  // ただし、同物件・同CIに confirmed メールが既にある場合は「確定済み」とみなして再ガードしない
  // (これがないと emailVerification が pendingApproval=false に降ろした直後に再 true セット
  //  → onBookingChange 再発火 → before/after で booking_change 誤通知のループになる)
  try {
    const evSnap = await db.collection("emailVerifications")
      .where("propertyId", "==", propertyId)
      .get();
    let hasPending = false;
    let hasConfirmed = false;
    for (const d of evSnap.docs) {
      const data = d.data() || {};
      const ext = data.extractedInfo || {};
      const ci = ext.checkIn && ext.checkIn.date;
      if (ci !== checkIn) continue;
      if (data.matchStatus === "pending_request") hasPending = true;
      if (data.matchStatus === "confirmed") hasConfirmed = true;
    }
    if (hasPending && !hasConfirmed) {
      console.log(`予約 ${bookingId}: emailVerifications に pending_request あり (CI=${checkIn}) → 募集生成スキップ`);
      // bookings にもフラグを立てておく (確定メール受信で false に降ろされて再発火させるため)
      try {
        await db.collection("bookings").doc(bookingId).update({
          pendingApproval: true,
          updatedAt: admin_module.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        console.error("pendingApproval 立て直しエラー:", e);
      }
      return;
    }
    if (hasPending && hasConfirmed) {
      console.log(`予約 ${bookingId}: pending_request あるが confirmed メールも存在 → 確定済みとして処理続行`);
    }
  } catch (e) {
    console.error("emailVerifications 確認エラー:", e);
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

  // ========== urgent_remind 即時送信 (timings に "immediate" が含まれる物件向け) ==========
  // 新規予約 + CI=今日/明日(JST) + 名簿未提出 + 未送信 → 即時通知
  try {
    if (!before && after && !nowCancelled && after.pendingApproval !== true) {
      const ov = (propertyData.channelOverrides || {}).urgent_remind || {};
      if (ov.enabled !== false) {
        const timings = Array.isArray(ov.timings) ? ov.timings : [];
        const hasImmediate = timings.length === 0 || timings.some(t => t.timing === "immediate");
        if (hasImmediate) {
          const nowJ = new Date(Date.now() + 9 * 3600 * 1000);
          const todayJ = nowJ.toISOString().slice(0, 10);
          const tomorrowJ = (() => {
            const d = new Date(nowJ);
            d.setUTCDate(d.getUTCDate() + 1);
            return d.toISOString().slice(0, 10);
          })();
          if ((after.checkIn === todayJ || after.checkIn === tomorrowJ)
              && after.rosterStatus !== "submitted"
              && !after.urgentRemindSentAt) {
            const formUrl = `https://minpaku-v2.web.app/form/?propertyId=${propertyId}`;
            const isToday = after.checkIn === todayJ;
            const urgencyLabel = isToday ? "【本日チェックイン】" : "【明日チェックイン】";
            const guestNameUrgent = after.guestName || "名前未設定";
            const body = [
              `🚨 ${urgencyLabel} 名簿未提出 緊急リマインド (即時)`,
              ``,
              `物件: ${propertyName}`,
              `ゲスト: ${guestNameUrgent}`,
              `チェックイン: ${after.checkIn}`,
              ``,
              `直前予約のため至急対応が必要です。`,
              `フォームURL: ${formUrl}`,
            ].join("\n");
            try {
              await notifyByKey(db, "urgent_remind", {
                title: `【緊急】直前予約: ${guestNameUrgent} (${after.checkIn})`,
                body,
                vars: {
                  date: after.checkIn, checkin: after.checkIn,
                  property: propertyName, guest: guestNameUrgent, url: formUrl,
                },
                propertyId,
              });
              await db.collection("bookings").doc(bookingId).update({
                urgentRemindSentAt: admin.firestore.FieldValue.serverTimestamp(),
              });
              console.log(`[urgent_remind] 即時送信完了: bookingId=${bookingId}`);
            } catch (e) {
              console.error("[urgent_remind] 即時送信エラー:", e.message);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error("[urgent_remind] 処理エラー:", e);
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

  // ========== LINE通知 (recruit_start) ==========
  try {
    const { settings } = await getNotificationSettings_(db);
    const appUrl = settings?.appUrl || "https://minpaku-v2.web.app";
    const recruitUrl = `${appUrl}/#/my-recruitment`;
    // notifyByKey で ownerLine/groupLine/staffLine を一括送信
    await notifyByKey(db, "recruit_start", {
      title: `清掃スタッフ募集: ${checkOut}`,
      body: `【清掃スタッフ募集】\n${checkOut} ${propertyName}\n${memo}\n回答: ${recruitUrl}`,
      vars: {
        date: checkOut,
        property: propertyName || "",
        work: "清掃",
        url: recruitUrl,
        memo: memo || "",
      },
      propertyId: propertyId || null,
    });
  } catch (e) {
    console.error("LINE通知エラー:", e);
  }

  // ========== タイミー募集依頼通知 (timee_posting) ==========
  // 新規確定予約検知時に物件オーナー宛にタイミー求人募集を依頼
  // 重複送信防止: bookings.timeeNotifySentAt が既に立っていればスキップ
  try {
    if (after.timeeNotifySentAt) {
      // 送信済み → スキップ
    } else {
      // 物件別 channelOverrides で enabled=true の場合のみ送信
      // (notifyByKey 内部で channelOverrides を見て送信先を決定)
      const ovs = (propertyData.channelOverrides || {}).timee_posting || {};
      const NCE_default = false; // notify-channel-editor のデフォルトは false
      const enabled = (ovs.enabled !== undefined) ? !!ovs.enabled : NCE_default;
      if (enabled) {
        await notifyByKey(db, "timee_posting", {
          title: `タイミー募集依頼: ${checkOut} ${propertyName}`,
          body: `🕐 タイミー募集依頼\n\nタイミー募集が必要な予約が入りました。\nチェックアウト日時: ${checkOut}\n物件: ${propertyName}\n\nこの日の求人募集をタイミーでお願いします。\n\nタイミー: https://app-new.taimee.co.jp/account`,
          vars: {
            date: checkOut,
            checkin: checkIn || "",
            property: propertyName || "",
            guest: guestName || "",
            site: source || "",
            url: "https://app-new.taimee.co.jp/account",
          },
          propertyId: propertyId || null,
        });
        // 重複送信防止フラグ
        try {
          await db.collection("bookings").doc(bookingId).update({
            timeeNotifySentAt: admin_module.firestore.FieldValue.serverTimestamp(),
          });
        } catch (uerr) {
          console.error("timeeNotifySentAt 更新エラー:", uerr);
        }
        console.log(`予約 ${bookingId}: タイミー募集依頼通知送信 (${checkOut})`);
      }
    }
  } catch (e) {
    console.error("タイミー募集依頼通知エラー:", e);
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

    // 直前点検の募集通知 (recruit_start)
    try {
      if (!insRecruitmentId) return;
      const { settings: s2 } = await getNotificationSettings_(db);
      const appUrl2 = s2?.appUrl || "https://minpaku-v2.web.app";
      const recruitUrl2 = `${appUrl2}/#/my-recruitment`;
      const memo2 = `直前点検: ゲスト ${guestName || "不明"} (${source || ""})`;
      // notifyByKey で ownerLine/groupLine/staffLine を一括送信
      await notifyByKey(db, "recruit_start", {
        title: `直前点検スタッフ募集: ${checkIn}`,
        body: `【直前点検スタッフ募集】\n${checkIn} ${propertyName}\n${memo2}\n回答: ${recruitUrl2}`,
        vars: { date: checkIn, property: propertyName || "", work: "直前点検", url: recruitUrl2, memo: memo2 },
        propertyId: propertyId || null,
      });
    } catch (notifErr) {
      console.error("直前点検LINE通知エラー:", notifErr);
    }
  } catch (e) {
    console.error("直前点検 処理エラー:", e);
  }

};
