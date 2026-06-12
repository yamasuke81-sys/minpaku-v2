// 直近 1 時間のエラーログを確認
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  const oneHourAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // error_logs (Cloud Functions 側)
  const errSnap = await db.collection("error_logs")
    .where("createdAt", ">=", oneHourAgo)
    .orderBy("createdAt", "desc")
    .limit(20)
    .get();
  console.log(`=== error_logs 直近1時間: ${errSnap.size}件 ===`);
  errSnap.docs.forEach(d => {
    const x = d.data();
    console.log(`[${x.createdAt?.toDate?.()?.toISOString()}] ${x.functionName || "?"}: ${x.error?.slice?.(0, 200)}`);
  });
  // client_errors (フロント側)
  try {
    const clSnap = await db.collection("client_errors")
      .where("at", ">=", oneHourAgo)
      .orderBy("at", "desc")
      .limit(20)
      .get();
    console.log(`\n=== client_errors 直近1時間: ${clSnap.size}件 ===`);
    clSnap.docs.forEach(d => {
      const x = d.data();
      console.log(`[${x.at?.toDate?.()?.toISOString()}] ${x.url || "?"}\n  ${(x.message || "").slice(0, 250)}\n  stack: ${(x.stack || "").slice(0, 200)}`);
    });
  } catch (e) {
    console.log("client_errors 取得エラー:", e.message);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
