#!/usr/bin/env node
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  const snap = await db.collection("properties").get();
  console.log(`物件 total: ${snap.size}`);
  const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  // propertyNumber 別
  items.sort((a, b) => (a.propertyNumber || 9999) - (b.propertyNumber || 9999));
  console.log("\n=== propertyNumber 順 ===");
  items.forEach(p => {
    console.log(`  #${p.propertyNumber ?? "-"} / ${p.id.slice(0, 12)} / ${p.name || "(名前なし)"} / active=${p.active} / type=${p.type || "-"} / color=${p.color || "-"}`);
  });
  // 使用中の番号マップ
  console.log("\n=== 番号重複チェック ===");
  const byNum = {};
  items.forEach(p => {
    if (p.propertyNumber != null) {
      const n = Number(p.propertyNumber);
      (byNum[n] = byNum[n] || []).push(p);
    }
  });
  Object.entries(byNum).forEach(([n, list]) => {
    if (list.length > 1) {
      console.log(`  🔴 番号 ${n} が ${list.length} 件:`);
      list.forEach(p => console.log(`     - ${p.id.slice(0, 12)} / ${p.name}`));
    }
  });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
