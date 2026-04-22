#!/usr/bin/env node
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  const snap = await db.collection("guestRegistrations")
    .orderBy("createdAt", "desc").limit(15).get();
  console.log(`直近 ${snap.size} 件の guestRegistrations:`);
  snap.docs.forEach(d => {
    const g = d.data();
    const ca = g.createdAt && g.createdAt.toDate ? g.createdAt.toDate().toISOString() : "-";
    const ua = g.updatedAt && g.updatedAt.toDate ? g.updatedAt.toDate().toISOString() : "-";
    console.log(`  ${d.id} / createdAt=${ca} / source=${g.source || "-"} / formResponseRow=${g.formResponseRow || "-"} / guestName=${g.guestName || "-"} / CI=${g.checkIn || "-"} / propertyId=${g.propertyId || "-"} / 列数=${Object.keys(g).length}`);
  });
  // source 別件数
  const all = await db.collection("guestRegistrations").get();
  const bySource = {};
  all.docs.forEach(d => {
    const s = d.data().source || "(none)";
    bySource[s] = (bySource[s] || 0) + 1;
  });
  console.log(`\nsource 別件数 (全 ${all.size} 件):`);
  Object.entries(bySource).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
