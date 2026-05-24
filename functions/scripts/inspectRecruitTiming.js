// recruit_start の通知タイミング設定を確認
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const PROPERTY_ID = "tsZybhDMcPrxqgcRy7wp";
  const propDoc = await db.collection("properties").doc(PROPERTY_ID).get();
  const ov = propDoc.data()?.channelOverrides?.recruit_start;
  console.log("=== the Terrace 長浜 - channelOverrides.recruit_start ===");
  console.log(JSON.stringify(ov, null, 2));
  console.log("");
  // バッチキューの中身も
  const queueSnap = await db.collection("batchNotificationQueue")
    .where("propertyId", "==", PROPERTY_ID)
    .where("notifyKey", "==", "recruit_start")
    .get();
  console.log(`=== batchNotificationQueue (recruit_start): ${queueSnap.size}件 ===`);
  for (const d of queueSnap.docs) {
    const x = d.data();
    console.log(`  id=${d.id} slot=${x.slot} date=${x.date} createdAt=${x.createdAt?.toDate?.()?.toISOString()} status=${x.status || "pending"}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
