// Timee メール巡回を 1 回手動実行 (バックフィル用)
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const syncCore = require("../scheduled/syncTimeeEmails");

(async () => {
  const result = await syncCore(db, { log: console });
  console.log("結果:", JSON.stringify(result, null, 2));
  process.exit(0);
})().catch((e) => { console.error("ERR:", e); process.exit(1); });
