const a=require("firebase-admin");a.initializeApp({projectId:"minpaku-v2"});const db=a.firestore();
(async()=>{
  // 5/28 周辺の予約 (the Terrace 長浜)
  const TERRACE = "tsZybhDMcPrxqgcRy7wp";
  const snap = await db.collection("bookings")
    .where("propertyId","==",TERRACE)
    .where("checkIn",">=","2026-05-25")
    .where("checkIn","<=","2026-06-02")
    .get();
  console.log(`=== the Terrace bookings 5/25-6/2 CI: ${snap.size}件 ===`);
  snap.docs.forEach(d=>{
    const x=d.data();
    console.log(`[${d.id}] CI=${x.checkIn} CO=${x.checkOut} src=${x.source} status=${x.status} guest=${x.guestName} pendingApproval=${x.pendingApproval} unverified=${x.unverified}`);
  });
  // 物件の inspection 設定確認
  const p = await db.collection("properties").doc(TERRACE).get();
  const pd=p.data();
  console.log(`\n=== the Terrace inspection 設定 ===`);
  console.log(JSON.stringify(pd.inspection || {}, null, 2));
  // 5/28 CI または直前 CI の shifts/recruitments
  const sh = await db.collection("shifts")
    .where("propertyId","==",TERRACE)
    .where("date",">=",new Date("2026-05-25"))
    .where("date","<=",new Date("2026-06-02"))
    .get();
  console.log(`\n=== the Terrace shifts 5/25-6/2: ${sh.size}件 ===`);
  sh.docs.forEach(d=>{
    const x=d.data();
    console.log(`[${d.id}] date=${x.date?.toDate?.()?.toISOString().slice(0,10)} workType=${x.workType} status=${x.status} bookingId=${x.bookingId}`);
  });
  const rec = await db.collection("recruitments")
    .where("propertyId","==",TERRACE)
    .where("checkoutDate","in",["2026-05-25","2026-05-26","2026-05-27","2026-05-28","2026-05-29","2026-05-30","2026-05-31","2026-06-01","2026-06-02"])
    .get();
  console.log(`\n=== the Terrace recruitments 5/25-6/2 coDate: ${rec.size}件 ===`);
  rec.docs.forEach(d=>{
    const x=d.data();
    console.log(`[${d.id}] coDate=${x.checkoutDate} workType=${x.workType||'-'} status=${x.status} bookingId=${x.bookingId}`);
  });
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
