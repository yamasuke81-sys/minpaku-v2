#!/usr/bin/env node
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  const snap = await db.collection("emailVerifications").where("matchStatus", "in", ["matched", "cancelled"]).get();
  console.log(`matched/cancelled emailVerifications: ${snap.size} 件`);
  snap.docs.forEach((d) => {
    const ev = d.data();
    console.log(JSON.stringify({
      id: d.id.slice(0, 15),
      messageId: (ev.messageId || "").slice(0, 20),
      threadId: (ev.threadId || "").slice(0, 20),
      matchStatus: ev.matchStatus,
      matchedBookingId: (ev.matchedBookingId || "").slice(0, 30),
    }));
  });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
