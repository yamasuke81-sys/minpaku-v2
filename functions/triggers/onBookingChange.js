/**
 * 予約変更トリガー
 * 予約が作成/更新された時に、チェックアウト日の清掃シフトと募集を自動生成する
 */
const {
  notifyOwner,
  notifyGroup,
  notifyStaff,
  buildRecruitmentFlex,
  resolveNotifyTargets,
  getNotificationSettings_,
} = require("../utils/lineNotify");

module.exports = async function onBookingChange(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();

  const before = event.data.before?.data();
  const after = event.data.after?.data();

  const isCancelled = (s) => {
    const x = String(s || "").toLowerCase();
    return x.includes("cancel") || s === "キャンセル" || s === "キャンセル済み";
  };

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
          const coDate = new Date(co); coDate.setHours(0,0,0,0);
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
          for (const r of recSnap.docs) await r.ref.delete();
          console.log(`[onBookingChange] キャンセル連動削除: ${bid} (${co}, prop=${pid})`);
        } else {
          console.log(`[onBookingChange] キャンセル: ${bid} (同日別active予約あり、削除スキップ)`);
        }
      } catch (e) {
        console.error("キャンセル連動削除エラー:", e);
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
  const checkOutDate = new Date(checkOut);
  checkOutDate.setHours(0, 0, 0, 0);
  if (checkOutDate < today) {
    console.log(`予約 ${bookingId}: checkOut(${checkOut})が過去のためスキップ`);
    return;
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
    .limit(1)
    .get();

  if (existingShifts.empty) {
    // シフト自動生成
    try {
      await db.collection("shifts").add({
        date: checkOutDate,
        propertyId,
        propertyName,
        bookingId,
        staffId: null,
        staffName: null,
        startTime: "10:30",
        status: "unassigned",
        assignMethod: "auto",
        createdAt: now,
        updatedAt: now,
      });
      console.log(`予約 ${bookingId}: シフト自動生成完了 (${checkOut})`);
    } catch (e) {
      console.error("シフト生成エラー:", e);
    }
  } else {
    console.log(`予約 ${bookingId}: 同日同物件のシフトが既に存在するためスキップ`);
  }

  // ========== 募集重複チェック ==========
  const existingRecruitments = await db.collection("recruitments")
    .where("checkoutDate", "==", checkOut)
    .where("propertyId", "==", propertyId)
    .limit(1)
    .get();

  if (!existingRecruitments.empty) {
    console.log(`予約 ${bookingId}: 同日同物件の募集が既に存在するためスキップ`);
    return;
  }

  // 募集自動生成
  const memo = `ゲスト: ${guestName || "不明"} (${source || "不明"})`;
  let recruitmentId;
  try {
    const recruitmentRef = await db.collection("recruitments").add({
      checkoutDate: checkOut,
      propertyId,
      propertyName,
      bookingId,
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
  } catch (e) {
    console.error("募集生成エラー:", e);
    return;
  }

  // ========== LINE通知 ==========
  try {
    const { settings } = await getNotificationSettings_(db);
    const targets = resolveNotifyTargets(settings, "recruit_start");

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

    // 変数置換用 vars (customMessage で {date}/{property}/{url}/{memo} が置換される)
    const baseVars = {
      date: checkOut,
      property: propertyName || "",
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
        baseVars
      );
    }

    // グループLINE通知
    if (targets.groupLine) {
      await notifyGroup(
        db,
        "recruit_start",
        `清掃スタッフ募集: ${checkOut}`,
        flexMessage,
        baseVars
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
          baseVars
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

    const checkInDate = new Date(checkIn); checkInDate.setHours(0,0,0,0);
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
        startTime: "10:00",
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
    if (insRecSnap.empty) {
      await db.collection("recruitments").add({
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
      console.log(`予約 ${bookingId}: 直前点検募集生成 (${checkIn})`);
    }
  } catch (e) {
    console.error("直前点検 処理エラー:", e);
  }
};
