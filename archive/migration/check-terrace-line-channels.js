#!/usr/bin/env node
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  for (const pid of ["tsZybhDMcPrxqgcRy7wp", "RZV9IwtQgMAsvrdM3j8J"]) {
    const d = await db.doc(`properties/${pid}`).get();
    const data = d.data() || {};
    console.log(`\n=== ${data.name} (${pid}) ===`);
    console.log(`lineChannels type: ${Array.isArray(data.lineChannels) ? "array" : typeof data.lineChannels}`);
    console.log(`lineChannels raw:`, JSON.stringify(data.lineChannels, (k, v) => {
      if (k === "token" && typeof v === "string") return `${v.slice(0, 12)}...${v.slice(-8)} (len=${v.length})`;
      return v;
    }, 2));
  }
  // settings/notifications
  const s = await db.doc("settings/notifications").get();
  const sd = s.data() || {};
  console.log(`\n=== settings/notifications ===`);
  console.log(`ownerLineChannels type: ${Array.isArray(sd.ownerLineChannels) ? "array" : typeof sd.ownerLineChannels}`);
  console.log(`ownerLineChannels:`, JSON.stringify(sd.ownerLineChannels, null, 2));
  console.log(`lineBotInfo:`, JSON.stringify(sd.lineBotInfo, null, 2));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
