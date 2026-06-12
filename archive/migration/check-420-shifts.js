#!/usr/bin/env node
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  const ids = ["LqUWnqX1N3OQNdh4d9DT", "tf2EtT02hj5Nf9Qm0ygs", "yKLUGeKImtd5aKTWJAW9", "XtDQPWbGUuKHcB3VpyEh"];
  for (const id of ids) {
    const s = await db.collection("shifts").doc(id).get();
    if (!s.exists) { console.log(`${id}: 存在しません`); continue; }
    const d = s.data();
    console.log(`${id}`);
    console.log(`  propertyId: ${d.propertyId}`);
    console.log(`  date: ${JSON.stringify(d.date)} (type=${typeof d.date}${d.date?.toDate ? "=Timestamp" : ""})`);
    console.log(`  workType: ${JSON.stringify(d.workType)}`);
    console.log(`  staffId: ${JSON.stringify(d.staffId)}`);
    console.log(`  bookingId: ${JSON.stringify(d.bookingId)}`);
    console.log(`  status: ${JSON.stringify(d.status)}`);
    console.log(`  createdAt: ${d.createdAt?.toDate ? d.createdAt.toDate().toISOString() : "-"}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
