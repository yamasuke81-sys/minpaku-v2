const a=require("firebase-admin");a.initializeApp({projectId:"minpaku-v2"});const db=a.firestore();
(async()=>{
  const ref = db.collection("checklists").doc("1zRaUVjXUuMNQFntK0fZ");
  await ref.update({
    checkoutDate: a.firestore.Timestamp.fromDate(new Date("2026-05-18T00:00:00")),
    updatedAt: a.firestore.FieldValue.serverTimestamp(),
  });
  const x=(await ref.get()).data();
  console.log("修正後 checkoutDate:", x.checkoutDate?.toDate?.()?.toISOString());
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
