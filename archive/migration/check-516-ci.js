const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  // 全プロジェクトで CI=5/16 の bookings (status 問わず)
  const snap = await db.collection("bookings").where("checkIn", "==", "2026-05-16").get();
  console.log(`5/16 CI 予約: ${snap.size}件`);
  snap.docs.forEach(d => {
    const x = d.data();
    console.log(`[${d.id}]\n  propertyId=${x.propertyId} CO=${x.checkOut} status=${x.status} source=${x.source}`);
    console.log(`  guestName=${x.guestName} unverified=${x.unverified} pendingApproval=${x.pendingApproval}`);
    console.log(`  rosterStatus=${x.rosterStatus} rosterRemindSentKeys=${JSON.stringify(x.rosterRemindSentKeys)}`);
  });
  // the Terrace の rosterRemind 設定
  const p = await db.collection("properties").doc("tsZybhDMcPrxqgcRy7wp").get();
  const ov = ((p.data() || {}).channelOverrides || {}).roster_remind || {};
  console.log(`\nthe Terrace roster_remind 設定:`);
  console.log(JSON.stringify(ov, null, 2));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
