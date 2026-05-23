// the Terrace 長浜の inspection 設定を確認
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const doc = await db.collection("properties").doc("tsZybhDMcPrxqgcRy7wp").get();
  if (!doc.exists) { console.log("not found"); return; }
  const d = doc.data();
  console.log("name:", d.name);
  console.log("inspection:", JSON.stringify(d.inspection, null, 2));
  console.log("active:", d.active);
  console.log("channelOverrides keys:", d.channelOverrides ? Object.keys(d.channelOverrides) : "なし");
  if (d.channelOverrides && d.channelOverrides.pre_inspection_done) {
    console.log("pre_inspection_done overrides:", JSON.stringify(d.channelOverrides.pre_inspection_done, null, 2));
  }
})().catch(e => { console.error(e); process.exit(1); });
