/**
 * C: 予約 → 直前点検作業実績 欠落バックフィル
 *
 * inspection.enabled=true の物件かつ期間内の未来予約に対し、
 * workType="pre_inspection" の shift がなければ生成する。
 * 同日に他予約の checkOut があれば清掃が兼ねるのでスキップ。
 *
 * 使い方:
 *   node backfill-inspection-shifts.js --dry-run   # 確認のみ
 *   node backfill-inspection-shifts.js --execute   # 実際に生成
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const isDryRun = !process.argv.includes("--execute");

function isCancelled(s) {
  const x = String(s || "").toLowerCase();
  return x.includes("cancel") || s === "キャンセル" || s === "キャンセル済み";
}

function toUtcMidnight(dateStr) {
  if (!dateStr) return null;
  return new Date(dateStr + "T00:00:00.000Z");
}

/** inspection 期間判定 */
function isInInspectionPeriod(checkIn, inspection) {
  if (!inspection.enabled) return false;
  if (!checkIn) return false;
  if (inspection.recurYearly) {
    const md = checkIn.slice(5); // "MM-DD"
    const s = inspection.recurStart || "01-01";
    const e = inspection.recurEnd || "12-31";
    if (s <= e) {
      return md >= s && md <= e;
    } else {
      return md >= s || md <= e;
    }
  } else {
    if (inspection.periodStart && checkIn < inspection.periodStart) return false;
    if (inspection.periodEnd && checkIn > inspection.periodEnd) return false;
    return true;
  }
}

(async () => {
  console.log(`=== 直前点検作業実績バックフィル (${isDryRun ? "DRY RUN" : "EXECUTE"}) ===\n`);

  const today = new Date().toISOString().slice(0, 10);

  // 物件データ取得
  const propSnap = await db.collection("properties").get();
  const propMap = new Map(propSnap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));

  // inspection.enabled=true の物件を絞り込み
  const inspectionProps = new Set(
    [...propMap.entries()]
      .filter(([, p]) => p.inspection?.enabled)
      .map(([id]) => id)
  );

  if (inspectionProps.size === 0) {
    console.log("inspection.enabled=true の物件なし。終了。");
    process.exit(0);
  }

  console.log(`inspection.enabled 物件: ${[...inspectionProps].join(", ")}`);

  // 予約を取得
  const bookingsSnap = await db.collection("bookings").get();
  const allBookings = bookingsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const futureActive = allBookings.filter(
    b => !isCancelled(b.status) && (b.checkIn || "") >= today && inspectionProps.has(b.propertyId)
  );

  console.log(`対象予約数: ${futureActive.length}`);

  // 既存 shift を bookingId+workType で索引化
  const shiftsSnap = await db.collection("shifts").get();
  const shiftsByBooking = new Map();
  shiftsSnap.docs.forEach(d => {
    const s = d.data();
    if (!s.bookingId) return;
    if (!shiftsByBooking.has(s.bookingId)) shiftsByBooking.set(s.bookingId, []);
    shiftsByBooking.get(s.bookingId).push({ id: d.id, ...s });
  });

  let missingCount = 0;
  let createdCount = 0;
  const now = new Date();

  for (const booking of futureActive) {
    const property = propMap.get(booking.propertyId);
    const inspection = property?.inspection || {};

    // 期間チェック
    if (!isInInspectionPeriod(booking.checkIn, inspection)) continue;

    // 同日に他予約の checkOut があれば清掃が兼ねる → スキップ
    const sameDayOut = allBookings.find(b =>
      b.propertyId === booking.propertyId &&
      b.checkOut === booking.checkIn &&
      !isCancelled(b.status) &&
      b.id !== booking.id
    );
    if (sameDayOut) continue;

    // 既存の直前点検 shift を確認
    const shifts = shiftsByBooking.get(booking.id) || [];
    const hasInspShift = shifts.some(s => s.workType === "pre_inspection");
    if (hasInspShift) continue;

    missingCount++;
    console.log(`  [欠落] ${booking.checkIn} ${booking.guestName || "不明"} (bookingId=${booking.id})`);

    if (!isDryRun) {
      const checkInDate = toUtcMidnight(booking.checkIn);
      // 同日同物件に直前点検 shift が別 bookingId で存在しないか確認
      const sameDaySnap = await db.collection("shifts")
        .where("date", "==", checkInDate)
        .where("propertyId", "==", booking.propertyId)
        .where("workType", "==", "pre_inspection")
        .limit(1).get();
      if (!sameDaySnap.empty) {
        console.log(`    → 同日同物件に直前点検シフト既存のためスキップ`);
        continue;
      }
      await db.collection("shifts").add({
        date: checkInDate,
        propertyId: booking.propertyId,
        propertyName: property?.name || booking.propertyId,
        bookingId: booking.id,
        workType: "pre_inspection",
        staffId: null,
        staffName: null,
        staffIds: [],
        startTime: property?.inspectionStartTime || "10:00",
        status: "unassigned",
        assignMethod: "auto_backfill",
        createdAt: now,
        updatedAt: now,
      });
      createdCount++;
      console.log(`    → 直前点検シフト生成完了`);
    }
  }

  console.log(`\n--- 結果 ---`);
  console.log(`欠落: ${missingCount}件`);
  if (!isDryRun) console.log(`生成: ${createdCount}件`);
  else console.log(`(dry-run: 実際の生成は --execute で実行)`);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
