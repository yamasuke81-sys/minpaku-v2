/**
 * B: 予約 → 清掃作業実績 欠落バックフィル
 *
 * 未来のアクティブな予約をループし、対応する workType="cleaning_by_count" の
 * shift がなければ生成する。
 *
 * 使い方:
 *   node backfill-cleaning-shifts.js --dry-run   # 確認のみ
 *   node backfill-cleaning-shifts.js --execute   # 実際に生成
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

(async () => {
  console.log(`=== 清掃作業実績バックフィル (${isDryRun ? "DRY RUN" : "EXECUTE"}) ===\n`);

  const today = new Date().toISOString().slice(0, 10);

  // 未来のアクティブな予約を取得
  const bookingsSnap = await db.collection("bookings").get();
  const futureActive = bookingsSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(b => !isCancelled(b.status) && (b.checkOut || "") >= today && b.propertyId);

  console.log(`対象予約数: ${futureActive.length}`);

  // 既存 shift を bookingId で索引化
  const shiftsSnap = await db.collection("shifts").get();
  const shiftsByBooking = new Map();
  shiftsSnap.docs.forEach(d => {
    const s = d.data();
    if (!s.bookingId) return;
    if (!shiftsByBooking.has(s.bookingId)) shiftsByBooking.set(s.bookingId, []);
    shiftsByBooking.get(s.bookingId).push({ id: d.id, ...s });
  });

  // 物件データキャッシュ
  const propCache = {};
  const getProperty = async (pid) => {
    if (propCache[pid] !== undefined) return propCache[pid];
    const doc = await db.collection("properties").doc(pid).get();
    propCache[pid] = doc.exists ? { id: doc.id, ...doc.data() } : null;
    return propCache[pid];
  };

  let missingCount = 0;
  let createdCount = 0;
  const now = new Date();

  for (const booking of futureActive) {
    const shifts = shiftsByBooking.get(booking.id) || [];
    const hasCleaningShift = shifts.some(
      s => s.workType === "cleaning_by_count" || s.workType === "cleaning"
    );
    if (hasCleaningShift) continue;

    missingCount++;
    const property = await getProperty(booking.propertyId);
    const propertyName = property?.name || booking.propertyId;

    console.log(`  [欠落] ${booking.checkOut} ${booking.guestName || "不明"} (bookingId=${booking.id})`);

    if (!isDryRun) {
      const checkOutDate = toUtcMidnight(booking.checkOut);
      // 同日同物件に有効シフトが別 bookingId で存在しないか確認
      const sameDaySnap = await db.collection("shifts")
        .where("date", "==", checkOutDate)
        .where("propertyId", "==", booking.propertyId)
        .where("workType", "==", "cleaning_by_count")
        .limit(1).get();
      if (!sameDaySnap.empty) {
        console.log(`    → 同日同物件にシフト既存のためスキップ`);
        continue;
      }
      await db.collection("shifts").add({
        date: checkOutDate,
        propertyId: booking.propertyId,
        propertyName,
        bookingId: booking.id,
        workType: "cleaning_by_count",
        staffId: null,
        staffName: null,
        startTime: property?.cleaningStartTime || "10:30",
        status: "unassigned",
        assignMethod: "auto_backfill",
        createdAt: now,
        updatedAt: now,
      });
      createdCount++;
      console.log(`    → シフト生成完了`);
    }
  }

  console.log(`\n--- 結果 ---`);
  console.log(`欠落: ${missingCount}件`);
  if (!isDryRun) console.log(`生成: ${createdCount}件`);
  else console.log(`(dry-run: 実際の生成は --execute で実行)`);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
