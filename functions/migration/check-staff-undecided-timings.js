#!/usr/bin/env node
// 各物件の channelOverrides.staff_undecided.timings を表示
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  const snap = await db.collection("properties").where("active","==",true).get();
  for (const d of snap.docs) {
    const p = d.data();
    const ov = (p.channelOverrides || {}).staff_undecided || {};
    console.log(`\n--- ${p.name} (${d.id}) ---`);
    console.log("enabled:", ov.enabled, "mode:", ov.timingMode || ov.mode || "(未指定)");
    console.log("timings:", JSON.stringify(ov.timings || [], null, 2));
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
