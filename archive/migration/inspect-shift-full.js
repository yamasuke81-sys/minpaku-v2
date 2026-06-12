#!/usr/bin/env node
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  const s = await db.collection("shifts").doc("HzKaxxqdoJ257b8GSfZ1").get();
  console.log(JSON.stringify(s.data(), (k,v) => v && v._seconds !== undefined ? new Date(v._seconds*1000).toISOString() : v, 2));
  // 4/27 propertyId tsZybhDMcPrxqgcRy7wp の全シフト (重複確認)
  const all = await db.collection("shifts")
    .where("propertyId", "==", "tsZybhDMcPrxqgcRy7wp")
    .where("date", "==", new Date("2026-04-27"))
    .get();
  console.log("\n=== 4/27 the Terrace shifts:", all.size);
  all.forEach(d => console.log("  ", d.id, "staffIds=", d.data().staffIds, "createdAt=", d.data().createdAt?.toDate?.().toISOString(), "updatedAt=", d.data().updatedAt?.toDate?.().toISOString()));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
