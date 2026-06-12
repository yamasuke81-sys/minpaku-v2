#!/usr/bin/env node
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  const s = await db.collection("shifts").doc("HzKaxxqdoJ257b8GSfZ1").get();
  const v = s.data();
  console.log("date raw:", v.date);
  console.log("date.toDate ISO:", v.date.toDate().toISOString());
  console.log("date.toMillis:", v.date.toMillis());
  // recruitment.js と同じ方法で生成される日付
  const cmp = new Date("2026-04-27");
  console.log("new Date('2026-04-27') ISO:", cmp.toISOString(), "ms:", cmp.getTime());
  console.log("一致?", v.date.toMillis() === cmp.getTime());
  // 4/5 については同様にシフトが無いか
  const start = new Date("2026-04-05T00:00:00.000Z");
  const end = new Date("2026-04-05T23:59:59.999Z");
  const snap = await db.collection("shifts").where("date", ">=", start).where("date", "<=", end).get();
  console.log("4/5 UTC範囲:", snap.size);
  // JST 4/5
  const jstS = new Date("2026-04-04T15:00:00.000Z");
  const jstE = new Date("2026-04-05T15:00:00.000Z");
  const snap2 = await db.collection("shifts").where("date", ">=", jstS).where("date", "<=", jstE).get();
  console.log("4/5 JST範囲:", snap2.size);
  snap2.forEach(d => console.log("  ", d.id, d.data().date.toDate().toISOString(), "staffId=", d.data().staffId, "staffIds=", d.data().staffIds, "propertyId=", d.data().propertyId));

  // 4/27 関連の recruitment 全シフトと、4/5 全shift表示
  console.log("\n=== 全 4/5 関連 ===");
  const ws = new Date("2026-04-04T00:00:00Z");
  const we = new Date("2026-04-06T23:59:59Z");
  const w = await db.collection("shifts").where("date", ">=", ws).where("date", "<=", we).get();
  w.forEach(d => console.log("  ", d.id, d.data().date.toDate().toISOString(), "propertyId=", d.data().propertyId, "staffIds=", d.data().staffIds));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
