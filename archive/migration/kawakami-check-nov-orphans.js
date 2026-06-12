/**
 * 2026-11 月に表示されている "謎の清掃" 2件の調査 (readonly)
 *
 * スクショで the Terrace 長浜 の 11/22, 11/25 に "清" マークだけ表示されている。
 * 対応する bookings / shifts / checklists / recruitments を突き合わせて原因特定。
 */
const admin = require("firebase-admin");

admin.initializeApp({
  projectId: "minpaku-v2",
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();

const BOOKING_IDS = ["WytvWTWgB0VoZExdjTrw", "Bq85bwCjLaKnwDQIAe1f"];
const RECRUIT_IDS = ["oi5i2LcNlikfvKTHBMwb", "URNa2lai0YFminMEWu5L"];

function section(t) { console.log(`\n==== ${t} ====`); }
function dump(obj) { console.log(JSON.stringify(obj, null, 2)); }

(async () => {
  section("1. bookings 存在確認");
  for (const id of BOOKING_IDS) {
    const snap = await db.collection("bookings").doc(id).get();
    if (!snap.exists) {
      console.log(`[${id}] MISSING ← bookings に存在しない (孤児)`);
    } else {
      const d = snap.data();
      console.log(`[${id}] exists`);
      dump({
        checkIn: d.checkIn, checkOut: d.checkOut, status: d.status,
        source: d.source, syncSource: d.syncSource, guestName: d.guestName,
        propertyId: d.propertyId, icalUid: d.icalUid, manualOverride: d.manualOverride,
      });
    }
  }

  section("2. recruitments 確認");
  for (const id of RECRUIT_IDS) {
    const snap = await db.collection("recruitments").doc(id).get();
    if (!snap.exists) {
      console.log(`[${id}] MISSING`);
    } else {
      const d = snap.data();
      console.log(`[${id}]`);
      dump({
        checkoutDate: d.checkoutDate, propertyId: d.propertyId, status: d.status,
        bookingId: d.bookingId, selectedStaff: d.selectedStaff,
        createdAt: d.createdAt?.toDate?.().toISOString?.(),
      });
    }
  }

  section("3. recruitmentId に紐づく shifts 確認");
  for (const rid of RECRUIT_IDS) {
    const shiftSnap = await db.collection("shifts").where("recruitmentId", "==", rid).get();
    console.log(`[${rid}] shifts: ${shiftSnap.size}件`);
    shiftSnap.forEach(d => console.log(`  - ${d.id}: status=${d.data().status}`));
  }

  section("4. bookingId に紐づく shifts 確認");
  for (const bid of BOOKING_IDS) {
    const shiftSnap = await db.collection("shifts").where("bookingId", "==", bid).get();
    console.log(`[${bid}] shifts: ${shiftSnap.size}件`);
    shiftSnap.forEach(d => {
      const data = d.data();
      console.log(`  - ${d.id}: date=${data.date?.toDate?.().toISOString?.().slice(0,10)}, status=${data.status}`);
    });
  }

  section("5. 日付 (11/22, 11/25) で shifts 全件確認");
  const dates = ["2026-11-22", "2026-11-25"];
  for (const ds of dates) {
    const ts = admin.firestore.Timestamp.fromDate(new Date(ds + "T00:00:00+09:00"));
    const tsNext = admin.firestore.Timestamp.fromDate(new Date(ds + "T23:59:59+09:00"));
    const s = await db.collection("shifts")
      .where("date", ">=", ts).where("date", "<=", tsNext)
      .where("propertyId", "==", "tsZybhDMcPrxqgcRy7wp")
      .get();
    console.log(`[${ds}] the Terrace shifts: ${s.size}件`);
    s.forEach(d => {
      const data = d.data();
      console.log(`  - ${d.id}: status=${data.status}, bookingId=${data.bookingId}, recruitmentId=${data.recruitmentId || "-"}`);
    });
  }

  console.log("\n==== 完了 ====");
  process.exit(0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
