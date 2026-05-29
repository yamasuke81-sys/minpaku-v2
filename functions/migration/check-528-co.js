const a=require("firebase-admin");a.initializeApp({projectId:"minpaku-v2"});const db=a.firestore();
(async()=>{
  const TERRACE = "tsZybhDMcPrxqgcRy7wp";
  // 同物件で CO=5/28 の予約 (あれば pre_inspection skip 条件)
  const coSnap = await db.collection("bookings")
    .where("propertyId","==",TERRACE)
    .where("checkOut","==","2026-05-28")
    .get();
  console.log(`=== the Terrace CO=5/28 bookings: ${coSnap.size}件 ===`);
  coSnap.docs.forEach(d=>{
    const x=d.data();
    console.log(`[${d.id}] CI=${x.checkIn} CO=${x.checkOut} status=${x.status} guest=${x.guestName} unverified=${x.unverified}`);
  });
  // 5/28 CI の予約 (= pre_inspection ターゲット)
  const ciSnap = await db.collection("bookings")
    .where("propertyId","==",TERRACE)
    .where("checkIn","==","2026-05-28")
    .get();
  console.log(`\n=== the Terrace CI=5/28 bookings: ${ciSnap.size}件 ===`);
  ciSnap.docs.forEach(d=>{
    const x=d.data();
    console.log(`[${d.id}] CI=${x.checkIn} CO=${x.checkOut} status=${x.status} guest=${x.guestName} createdAt=${x.createdAt?.toDate?.()?.toISOString()}`);
  });
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
