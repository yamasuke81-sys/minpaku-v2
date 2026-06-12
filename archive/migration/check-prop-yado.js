#!/usr/bin/env node
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

(async () => {
  const id = "RZV9IwtQgMAsvrdM3j8J";
  const p = await db.collection("properties").doc(id).get();
  const x = p.data() || {};
  console.log(`[${id}] name=${x.name} number=${x.propertyNumber}`);
  console.log(`keyboxSend:`, JSON.stringify(x.keyboxSend, null, 2));
  console.log(`ownerStaffId=${x.ownerStaffId}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
