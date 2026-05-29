const a=require("firebase-admin");a.initializeApp({projectId:"minpaku-v2"});const db=a.firestore();
(async()=>{
  // YADO KOMACHI Hiroshima propertyId: ncUKeD4yQo0kfAoznITu  ※注意 — 別IDかも要確認
  // 5/17 or 5/18 の recruitment + shift + checklist
  const recSnap = await db.collection("recruitments")
    .where("checkoutDate","in",["2026-05-17","2026-05-18"]).get();
  console.log("=== recruitments 5/17 or 5/18 ===");
  recSnap.docs.forEach(d=>{const x=d.data();console.log(`[${d.id}] coDate=${x.checkoutDate} prop=${x.propertyId} status=${x.status}`);});
  const sSnap = await db.collection("shifts").where("date","in",[new Date("2026-05-17"), new Date("2026-05-18")]).limit(20).get();
  console.log("\n=== shifts 5/17 or 5/18 ===");
  sSnap.docs.forEach(d=>{const x=d.data();console.log(`[${d.id}] date=${x.date?.toDate?.()?.toISOString().slice(0,10)} prop=${x.propertyId} status=${x.status} workType=${x.workType}`);});
  // checklist 全フィールド構造調査 (1件)
  const clSnap = await db.collection("checklists").limit(1).get();
  if (!clSnap.empty) {
    console.log("\n=== checklist sample fields ===");
    console.log(Object.keys(clSnap.docs[0].data()));
  }
  // YADO KOMACHI 物件名で確認
  const props = await db.collection("properties").get();
  const yado = props.docs.find(d=>/YADO KOMACHI/.test(d.data().name||""));
  console.log("\nYADO KOMACHI propertyId:", yado?.id);
  // YADO KOMACHI の 5/17 と 5/18 の checklist
  if(yado){
    const cl = await db.collection("checklists").where("propertyId","==",yado.id).get();
    console.log(`YADO KOMACHI checklists: ${cl.size}件`);
    cl.docs.slice(0,30).forEach(d=>{
      const x=d.data();
      const dt = x.date?.toDate?.()?.toISOString().slice(0,10) || x.date;
      const codt = x.checkoutDate?.toDate?.()?.toISOString().slice(0,10) || x.checkoutDate;
      const m517 = (typeof dt==="string"&&dt.includes("2026-05-17"))||(typeof codt==="string"&&codt.includes("2026-05-17"));
      const m518 = (typeof dt==="string"&&dt.includes("2026-05-18"))||(typeof codt==="string"&&codt.includes("2026-05-18"));
      if(m517||m518) console.log(`[${d.id}] date=${dt} checkoutDate=${codt} status=${x.status} shiftId=${x.shiftId}`);
    });
  }
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
