// 5/17→5/18 に変更したが checkoutDate が更新されなかった YADO の checklist を修正
const a=require("firebase-admin");a.initializeApp({projectId:"minpaku-v2"});const db=a.firestore();
(async()=>{
  // shiftId wYRKXP7TugRSwNN4xbXJ (5/18 に変更済み) に紐付く checklists で
  // checkoutDate が古い (5/17) のものを 5/18 に更新
  const sid = "wYRKXP7TugRSwNN4xbXJ";
  const snap = await db.collection("checklists").where("shiftId","==",sid).get();
  console.log(`shiftId=${sid} に紐付く checklists: ${snap.size}件`);
  for (const d of snap.docs) {
    const x=d.data();
    console.log(`[${d.id}] 現状 checkoutDate=${x.checkoutDate} status=${x.status}`);
    if (x.checkoutDate !== "2026-05-18") {
      await d.ref.update({
        checkoutDate: "2026-05-18",
        updatedAt: a.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`  → 2026-05-18 に更新`);
    }
  }
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
