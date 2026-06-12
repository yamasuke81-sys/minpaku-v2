/**
 * 直前点検 shift に対応する recruitment が存在しないものを補完
 * (backfill-inspection-shifts.js で生成された shift 用)
 *
 * 使い方:
 *   node migration/backfill-inspection-recruitments.js --dry-run
 *   node migration/backfill-inspection-recruitments.js --execute
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const { addRecruitmentToActiveStaff } = require("../utils/inactiveStaff");

const isDryRun = !process.argv.includes("--execute");

(async () => {
  console.log(`=== 直前点検 recruitment バックフィル (${isDryRun ? "DRY RUN" : "EXECUTE"}) ===\n`);

  const shiftsSnap = await db.collection("shifts")
    .where("workType", "==", "pre_inspection")
    .where("assignMethod", "==", "auto_backfill").get();

  console.log(`auto_backfill 直前点検 shift: ${shiftsSnap.size}件`);

  const bookingsSnap = await db.collection("bookings").get();
  const bookingMap = new Map(bookingsSnap.docs.map(d => [d.id, d.data()]));

  const propsSnap = await db.collection("properties").get();
  const propMap = new Map(propsSnap.docs.map(d => [d.id, d.data()]));

  const now = new Date();
  let createdCount = 0;
  let skipCount = 0;

  for (const sd of shiftsSnap.docs) {
    const s = sd.data();
    const booking = bookingMap.get(s.bookingId);
    if (!booking) {
      console.log(`  [skip] booking なし: ${s.bookingId}`);
      skipCount++;
      continue;
    }
    const checkIn = booking.checkIn;
    const propertyId = s.propertyId;
    const propertyName = s.propertyName || (propMap.get(propertyId)?.name) || propertyId;
    const guestName = booking.guestName || "不明";
    const source = booking.source || "";

    const recSnap = await db.collection("recruitments")
      .where("propertyId", "==", propertyId)
      .where("checkoutDate", "==", checkIn)
      .where("workType", "==", "pre_inspection")
      .limit(1).get();
    if (!recSnap.empty) {
      skipCount++;
      continue;
    }

    console.log(`  [生成] ${checkIn} ${propertyName} (${guestName})`);
    if (!isDryRun) {
      const insRef = await db.collection("recruitments").add({
        checkoutDate: checkIn,
        propertyId, propertyName,
        bookingId: s.bookingId,
        workType: "pre_inspection",
        status: "募集中",
        selectedStaff: "",
        selectedStaffIds: [],
        memo: `直前点検: ゲスト ${guestName} (${source})`,
        responses: [],
        createdAt: now, updatedAt: now,
      });
      try {
        await addRecruitmentToActiveStaff(db, insRef.id);
      } catch (e) {
        console.error(`    addRecruitmentToActiveStaff エラー: ${e.message}`);
      }
      createdCount++;
    }
  }

  console.log(`\n--- 結果 ---`);
  console.log(`既存recruitmentあり (skip): ${skipCount}件`);
  if (!isDryRun) console.log(`生成: ${createdCount}件`);
  else console.log(`(dry-run: 実際の生成は --execute で実行)`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
