#!/usr/bin/env node
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

(async () => {
  // guestRegistrations で 松本 を含む or 5/16 CI を全部列挙
  const snap = await db.collection("guestRegistrations").get();
  console.log(`guestRegistrations 全件: ${snap.size}`);
  const hits = [];
  snap.forEach((d) => {
    const x = d.data();
    const name = String(x.guestName || "");
    const ci = String(x.checkIn || "");
    if (name.includes("松本") || ci.startsWith("2026-05-16")) {
      hits.push({ id: d.id, ...x });
    }
  });
  console.log(`\nヒット: ${hits.length}件\n`);
  hits.forEach((h) => {
    console.log(`[${h.id}]`);
    console.log(`  guestName=${h.guestName} email=${h.email}`);
    console.log(`  propertyId=${h.propertyId}`);
    console.log(`  status=${h.status} CI=${JSON.stringify(h.checkIn)} CO=${JSON.stringify(h.checkOut)}`);
    console.log(`  keyboxConfirmedAt=${h.keyboxConfirmedAt ? "set" : "未設定"} keyboxSentAt=${h.keyboxSentAt ? "送信済" : "未送信"}`);
    console.log(`  keyboxConfirmToken=${h.keyboxConfirmToken || "(なし)"}`);
    console.log();
  });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
