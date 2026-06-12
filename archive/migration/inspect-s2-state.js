// S2 (予約→スタッフ募集自動生成) 検証: confirmed 未来予約に対応する recruitments/shifts を確認
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const pid = "tsZybhDMcPrxqgcRy7wp";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const toDate = (v) => v?.toDate ? v.toDate() : (typeof v === "string" ? new Date(v) : null);
  const ymd = (d) => d ? d.toISOString().substring(0, 10) : "?";

  // confirmed 未来予約
  const bkSnap = await db.collection("bookings").where("propertyId", "==", pid).get();
  const confirmedFuture = bkSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(x => x.status === "confirmed" && toDate(x.checkOut) && toDate(x.checkOut) >= today)
    .sort((a, b) => toDate(a.checkOut) - toDate(b.checkOut));

  console.log(`=== confirmed 未来予約 (checkOut >= 今日): ${confirmedFuture.length}件 ===\n`);

  // recruitments / shifts を一括取得
  const recSnap = await db.collection("recruitments").where("propertyId", "==", pid).get();
  const shSnap = await db.collection("shifts").where("propertyId", "==", pid).get();

  const recByBooking = {};
  recSnap.docs.forEach(d => {
    const x = d.data();
    const bid = x.bookingId || "(no-booking)";
    (recByBooking[bid] ||= []).push({ id: d.id, ...x });
  });
  const shByBooking = {};
  shSnap.docs.forEach(d => {
    const x = d.data();
    const bid = x.bookingId || "(no-booking)";
    (shByBooking[bid] ||= []).push({ id: d.id, ...x });
  });

  console.log(`recruitments total (pid): ${recSnap.size}`);
  console.log(`shifts total (pid): ${shSnap.size}\n`);

  let missingRec = 0, missingShift = 0;
  confirmedFuture.forEach(b => {
    const co = ymd(toDate(b.checkOut));
    const recs = recByBooking[b.id] || [];
    const shs = shByBooking[b.id] || [];
    const recMark = recs.length ? `✅ ${recs.length}件 status=${recs.map(r => r.status).join(",")}` : "❌ なし";
    const shMark = shs.length ? `✅ ${shs.length}件 status=${shs.map(s => s.status).join(",")} wt=${shs.map(s => s.workType||"?").join(",")}` : "❌ なし";
    if (!recs.length) missingRec++;
    if (!shs.length) missingShift++;
    console.log(`[${co}] ${(b.source||"").padEnd(12)} ${(b.guestName||"").padEnd(24)} ${b.id.substring(0, 10)}`);
    console.log(`  rec: ${recMark}`);
    console.log(`  sh : ${shMark}`);
  });

  console.log(`\n=== 集計 ===`);
  console.log(`  recruitments 欠落: ${missingRec} / ${confirmedFuture.length}`);
  console.log(`  shifts 欠落: ${missingShift} / ${confirmedFuture.length}`);

  // 孤児検出 (bookingId が確認済み予約と紐付かない recruitment / shift)
  const validBookingIds = new Set(bkSnap.docs.map(d => d.id));
  const orphanRecs = recSnap.docs.filter(d => d.data().bookingId && !validBookingIds.has(d.data().bookingId));
  const orphanShs = shSnap.docs.filter(d => d.data().bookingId && !validBookingIds.has(d.data().bookingId));
  console.log(`  孤児 recruitments (bookingId が全bookings中に無い): ${orphanRecs.length}`);
  console.log(`  孤児 shifts: ${orphanShs.length}`);

  // cancelled 予約に残ってる rec/sh
  const cancelledBookingIds = new Set(bkSnap.docs.filter(d => d.data().status === "cancelled").map(d => d.id));
  const onCancelledRec = recSnap.docs.filter(d => cancelledBookingIds.has(d.data().bookingId));
  const onCancelledSh = shSnap.docs.filter(d => cancelledBookingIds.has(d.data().bookingId));
  console.log(`  cancelled 予約に残る recruitments: ${onCancelledRec.length}`);
  console.log(`  cancelled 予約に残る shifts: ${onCancelledSh.length}`);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
