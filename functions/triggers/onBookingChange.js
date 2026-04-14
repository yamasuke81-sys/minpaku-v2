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

  const after = event.data.after?.data();

  // 削除の場合はスキップ
  if (!after) return;

  const { checkOut, propertyId, guestName, source, bookingId: bookingIdFromData } = after;
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

  // propertiesコレクションからpropertyNameを取得
  let propertyName = "";
  try {
    const propertyDoc = await db.collection("properties").doc(propertyId).get();
    if (propertyDoc.exists) {
      propertyName = propertyDoc.data().name || "";
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

    const flexMessage = buildRecruitmentFlex(
      { checkoutDate: checkOut, propertyName, memo },
      appUrl
    );

    // オーナーLINE通知
    if (targets.ownerLine) {
      await notifyOwner(
        db,
        "recruit_start",
        `清掃スタッフ募集: ${checkOut}`,
        `【清掃スタッフ募集】\n${checkOut} ${propertyName}\n${memo}`
      );
    }

    // グループLINE通知
    if (targets.groupLine) {
      await notifyGroup(
        db,
        "recruit_start",
        `清掃スタッフ募集: ${checkOut}`,
        flexMessage
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
          flexMessage
        )
      );
      await Promise.all(notifyPromises);
    }
  } catch (e) {
    console.error("LINE通知エラー:", e);
  }
};
