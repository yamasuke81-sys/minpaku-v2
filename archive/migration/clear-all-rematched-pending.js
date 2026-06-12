// auto-rematch でマッチした booking で pendingApproval/unverified が
// 残っているものを一括降下
const a=require("firebase-admin");a.initializeApp({projectId:"minpaku-v2"});const db=a.firestore();
(async()=>{
  // emailMatchedBy が auto-rematch* のもの
  const snap = await db.collection("bookings").where("emailMatchedBy","in",["auto-rematch","auto-rematch-global","reevaluate"]).get();
  console.log(`auto-rematch booking: ${snap.size}件`);
  let cleared=0;
  for(const d of snap.docs){
    const x=d.data();
    if(x.pendingApproval===true || x.unverified===true){
      const patch={};
      if(x.pendingApproval===true){patch.pendingApproval=false;patch.pendingApprovalResolvedAt=a.firestore.FieldValue.serverTimestamp();}
      if(x.unverified===true){patch.unverified=false;patch.unverifiedResolvedAt=a.firestore.FieldValue.serverTimestamp();}
      await d.ref.update(patch);
      console.log(`[clear] ${d.id} CI=${x.checkIn} guest=${x.guestName} (cleared keys=${Object.keys(patch).join(",")})`);
      cleared++;
    }
  }
  console.log(`\n=== cleared: ${cleared}件 ===`);
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
