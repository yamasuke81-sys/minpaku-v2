// 孤児データの現状確認スクリプト（読み取りのみ、削除なし）
// 使い方: node verify-orphan-health.js
const admin = require("firebase-admin");
const serviceAccount = require("../../serviceAccountKey.json");

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function main() {
  console.log("=== 孤児データ現状確認 ===\n");

  const shSnap = await db.collection("shifts").get();
  const shIds = new Set(shSnap.docs.map(d => d.id));
  const bSnap = await db.collection("bookings").get();
  const bMap = new Map(bSnap.docs.map(d => [d.id, d.data()]));
  const recSnap = await db.collection("recruitments").get();
  const realRecIds = new Set(recSnap.docs.map(d => d.id));
  const clSnap = await db.collection("checklists").get();

  const isCancelled = (s) => String(s || "").toLowerCase().includes("cancel");

  // 1. 孤児 checklist
  const orphanCl = clSnap.docs.filter(d => {
    const shId = d.data().shiftId;
    return !shId || !shIds.has(shId);
  });
  console.log(`孤児 checklists: ${orphanCl.length} 件`);
  orphanCl.slice(0, 5).forEach(d => console.log(`  - ${d.id} shiftId=${d.data().shiftId}`));

  // 2. ghost shift
  const ghostShifts = shSnap.docs.filter(d => {
    const s = d.data();
    if (!s.bookingId) return false;
    const b = bMap.get(s.bookingId);
    return !b || isCancelled(b.status);
  });
  console.log(`\nghost shifts: ${ghostShifts.length} 件`);
  ghostShifts.slice(0, 5).forEach(d => {
    const s = d.data();
    const b = bMap.get(s.bookingId);
    console.log(`  - ${d.id} bookingId=${s.bookingId} booking=${b ? b.status : "不在"}`);
  });

  // 3. ghost recruitment
  const ghostRecs = recSnap.docs.filter(d => {
    const r = d.data();
    if (!r.bookingId) return false;
    const b = bMap.get(r.bookingId);
    return !b || isCancelled(b.status);
  });
  console.log(`\nghost recruitments: ${ghostRecs.length} 件`);
  ghostRecs.slice(0, 5).forEach(d => {
    const r = d.data();
    const b = bMap.get(r.bookingId);
    console.log(`  - ${d.id} bookingId=${r.bookingId} booking=${b ? b.status : "不在"}`);
  });

  // 4. 孤児 pendingRecruitmentIds
  const staffSnap = await db.collection("staff").get();
  let pendingIssues = 0;
  let inactiveFromPending = 0;
  for (const d of staffSnap.docs) {
    const s = d.data();
    const pending = Array.isArray(s.pendingRecruitmentIds) ? s.pendingRecruitmentIds : [];
    const valid = pending.filter(id => realRecIds.has(id));
    if (valid.length < pending.length) {
      pendingIssues++;
      console.log(`\n孤児 pending スタッフ: ${s.name} (${d.id})`);
      console.log(`  pending=${pending.length} → valid=${valid.length}`);
      if (s.active === false) inactiveFromPending++;
    }
  }
  if (pendingIssues === 0) console.log("\n孤児 pendingRecruitmentIds: なし");

  // 5. Reserved ブロック予約
  const reservedSnap = await db.collection("bookings")
    .where("syncSource", "==", "ical")
    .where("status", "==", "confirmed")
    .where("guestName", "==", "Reserved")
    .get();
  console.log(`\nReservedブロック予約(confirmed): ${reservedSnap.size} 件`);
  reservedSnap.docs.forEach(d => {
    const data = d.data();
    console.log(`  - ${d.id} ${data.checkIn}〜${data.checkOut}`);
  });

  console.log("\n=== 確認完了 ===");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
