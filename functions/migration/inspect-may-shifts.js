#!/usr/bin/env node
// 5/3, 5/5, 5/6 のシフト実態と recruitment の照合
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const PROPERTY_ID = "tsZybhDMcPrxqgcRy7wp";
const dates = ["2026-05-03", "2026-05-05", "2026-05-06"];

(async () => {
  for (const d of dates) {
    console.log(`\n========== ${d} ==========`);
    // shifts: date は Timestamp? 文字列? 両方試す
    const dt = new Date(d + "T00:00:00.000Z");
    let snap = await db.collection("shifts")
      .where("propertyId", "==", PROPERTY_ID)
      .where("date", "==", dt)
      .get();
    console.log(`  shifts (Date型 UTC): ${snap.size}件`);
    for (const doc of snap.docs) {
      const x = doc.data();
      console.log(`    [${doc.id}]`, JSON.stringify({
        staffId: x.staffId,
        staffIds: x.staffIds,
        staffName: x.staffName,
        status: x.status,
        workType: x.workType,
        bookingId: x.bookingId,
        assignMethod: x.assignMethod,
        date: x.date && x.date.toDate ? x.date.toDate().toISOString() : x.date,
      }));
    }

    // 文字列 date の可能性
    const snap2 = await db.collection("shifts")
      .where("propertyId", "==", PROPERTY_ID)
      .where("date", "==", d)
      .get();
    if (snap2.size) {
      console.log(`  shifts (文字列): ${snap2.size}件`);
      for (const doc of snap2.docs) {
        console.log(`    [${doc.id}]`, JSON.stringify(doc.data()));
      }
    }

    // recruitments
    const rs = await db.collection("recruitments")
      .where("propertyId", "==", PROPERTY_ID)
      .where("checkoutDate", "==", d)
      .get();
    console.log(`  recruitments: ${rs.size}件`);
    for (const doc of rs.docs) {
      const x = doc.data();
      console.log(`    [${doc.id}]`, JSON.stringify({
        selectedStaff: x.selectedStaff,
        selectedStaffIds: x.selectedStaffIds,
        status: x.status,
        workType: x.workType,
        bookingId: x.bookingId,
      }));
    }
  }

  // 物件全体での 5月の shift 範囲スキャン (date 型ばらつき検査)
  console.log(`\n========== 5月の全shift走査 ==========`);
  const start = new Date("2026-05-01T00:00:00.000Z");
  const end = new Date("2026-06-01T00:00:00.000Z");
  const allMay = await db.collection("shifts")
    .where("propertyId", "==", PROPERTY_ID)
    .where("date", ">=", start)
    .where("date", "<", end)
    .get();
  console.log(`  5月の shifts: ${allMay.size}件`);
  for (const doc of allMay.docs) {
    const x = doc.data();
    const ds = x.date && x.date.toDate ? x.date.toDate().toISOString().slice(0, 10) : String(x.date);
    console.log(`    ${ds} [${doc.id}] staffId=${x.staffId} staffIds=${JSON.stringify(x.staffIds)} status=${x.status}`);
  }

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
