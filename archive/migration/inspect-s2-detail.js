// S2 欠落詳細: shift 欠落予約と cancelled に残る rec/sh の詳細
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const pid = "tsZybhDMcPrxqgcRy7wp";
  const toDate = (v) => v?.toDate ? v.toDate() : (typeof v === "string" ? new Date(v) : null);

  // bookings: shift 欠落の 2件を特定
  const bkSnap = await db.collection("bookings").where("propertyId", "==", pid).get();
  const bkById = new Map(bkSnap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));

  const shSnap = await db.collection("shifts").where("propertyId", "==", pid).get();
  const recSnap = await db.collection("recruitments").where("propertyId", "==", pid).get();

  // 欠落対象 (confirmed 未来でshift0件)
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const bookingsWithShift = new Set(shSnap.docs.map(d => d.data().bookingId).filter(Boolean));
  const confirmedFutureNoShift = [...bkById.values()].filter(b => {
    const co = toDate(b.checkOut);
    return b.status === "confirmed" && co && co >= today && !bookingsWithShift.has(b.id);
  });

  console.log("=== shift 欠落 confirmed 未来予約 詳細 ===");
  confirmedFutureNoShift.forEach(b => {
    console.log(`\n--- booking ${b.id} ---`);
    console.log(JSON.stringify({
      source: b.source,
      status: b.status,
      checkIn: toDate(b.checkIn)?.toISOString()?.substring(0, 10),
      checkOut: toDate(b.checkOut)?.toISOString()?.substring(0, 10),
      guestName: b.guestName,
      createdAt: toDate(b.createdAt)?.toISOString(),
      updatedAt: toDate(b.updatedAt)?.toISOString(),
      icalUrl: (b.icalUrl||"").substring(0, 40),
    }, null, 2));
    // 同じbooking に紐付く recruitment
    const rec = recSnap.docs.find(d => d.data().bookingId === b.id);
    if (rec) {
      const r = rec.data();
      console.log(`  rec: ${rec.id}  status=${r.status}  checkoutDate=${r.checkoutDate}`);
      console.log(`  selectedStaffIds=${JSON.stringify(r.selectedStaffIds||[])}  confirmedAt=${toDate(r.confirmedAt)?.toISOString()}`);
    }
  });

  // cancelled 残留 rec/sh
  console.log("\n\n=== cancelled 予約に残る recruitments ===");
  recSnap.docs.forEach(d => {
    const x = d.data();
    const b = bkById.get(x.bookingId);
    if (b?.status === "cancelled") {
      console.log(`  rec ${d.id}  bookingId=${x.bookingId}  status=${x.status}  checkoutDate=${x.checkoutDate}  guestName(booking)=${b.guestName}`);
    }
  });
  console.log("\n=== cancelled 予約に残る shifts ===");
  shSnap.docs.forEach(d => {
    const x = d.data();
    const b = bkById.get(x.bookingId);
    if (b?.status === "cancelled") {
      const date = toDate(x.date)?.toISOString()?.substring(0, 10);
      console.log(`  sh ${d.id}  bookingId=${x.bookingId}  date=${date}  status=${x.status}  staffId=${x.staffId}`);
    }
  });

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
