// 5/28 の Paeden Bennetts 予約に対して、直前点検 shift + recruitment を手動生成
const a = require("firebase-admin");
a.initializeApp({ projectId: "minpaku-v2" });
const db = a.firestore();
const { addRecruitmentToActiveStaff } = require("../utils/inactiveStaff");
(async () => {
  const TERRACE = "tsZybhDMcPrxqgcRy7wp";
  const BOOKING_ID = "ical_1418fb94e984-ba97cfa8adff36839975d86b6abeec25@airbnb.com";
  const checkIn = "2026-05-28";
  const checkInDate = new Date(checkIn + "T00:00:00.000Z");

  // 物件取得
  const p = await db.collection("properties").doc(TERRACE).get();
  const pd = p.data();
  // 既存 shift / recruitment 確認 (重複防止)
  const sExists = await db.collection("shifts")
    .where("propertyId","==",TERRACE).where("date","==",checkInDate).where("workType","==","pre_inspection").limit(1).get();
  const rExists = await db.collection("recruitments")
    .where("propertyId","==",TERRACE).where("checkoutDate","==",checkIn).where("workType","==","pre_inspection").limit(1).get();
  console.log(`既存 shift: ${sExists.size}件, 既存 recruitment: ${rExists.size}件`);
  // 同日 CO の予約があれば skip
  const coSame = await db.collection("bookings")
    .where("propertyId","==",TERRACE).where("checkOut","==",checkIn).limit(1).get();
  if (!coSame.empty) {
    console.log("同日 CO の予約あり → 直前点検不要 (清掃が兼ねる)");
    process.exit(0);
  }
  const now = a.firestore.FieldValue.serverTimestamp();
  const b = (await db.collection("bookings").doc(BOOKING_ID).get()).data();
  // shift 生成
  if (sExists.empty) {
    const shRef = await db.collection("shifts").add({
      date: checkInDate,
      propertyId: TERRACE, propertyName: pd.name || "",
      bookingId: BOOKING_ID,
      workType: "pre_inspection",
      staffId: null, staffName: null, staffIds: [],
      startTime: pd.inspectionStartTime || "10:00",
      status: "unassigned",
      assignMethod: "auto_backfill",
      createdAt: now, updatedAt: now,
    });
    console.log(`shift 生成: ${shRef.id}`);
  } else {
    console.log(`shift 既存: ${sExists.docs[0].id}`);
  }
  // recruitment 生成
  if (rExists.empty) {
    const recRef = await db.collection("recruitments").add({
      checkoutDate: checkIn,
      propertyId: TERRACE, propertyName: pd.name || "",
      bookingId: BOOKING_ID,
      workType: "pre_inspection",
      status: "募集中",
      selectedStaff: "",
      selectedStaffIds: [],
      memo: `直前点検: ゲスト ${b.guestName || "不明"} (${b.source || ""})`,
      responses: [],
      createdAt: now, updatedAt: now,
    });
    console.log(`recruitment 生成: ${recRef.id}`);
    try { await addRecruitmentToActiveStaff(db, recRef.id); console.log("active staff に追加完了"); } catch (e) { console.error("addRecruitmentToActiveStaff エラー:", e.message); }
  } else {
    console.log(`recruitment 既存: ${rExists.docs[0].id}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
