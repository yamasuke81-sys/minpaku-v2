const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const [tmpl, shifts] = await Promise.all([
    db.collection("checklistTemplates").doc("tsZybhDMcPrxqgcRy7wp").get(),
    db.collection("shifts").get(),
  ]);
  console.log("checklistTemplates/tsZybhDMcPrxqgcRy7wp exists?", tmpl.exists, "areas:", (tmpl.data()?.areas||[]).length);

  // 同日同物件の重複チェック
  const byKey = {};
  shifts.docs.forEach(d => {
    const x = d.data();
    const dt = x.date?.toDate ? x.date.toDate().toISOString().slice(0,10) : String(x.date);
    const k = `${dt}_${x.propertyId}`;
    byKey[k] = (byKey[k]||[]).concat([{ id: d.id, bookingId: x.bookingId, createdAt: x.createdAt }]);
  });
  console.log("shifts 日×物件キー別:", Object.keys(byKey).length, "key");
  const dups = Object.entries(byKey).filter(([k,v]) => v.length > 1);
  console.log("重複キー:", dups.length);
  dups.forEach(([k,v]) => console.log(`  ${k}: ${v.length}件 (ids: ${v.map(x=>x.id).join(", ")})`));

  // 全shift一覧
  console.log("\n全shifts:");
  shifts.docs.forEach(d => {
    const x = d.data();
    const dt = x.date?.toDate ? x.date.toDate().toISOString().slice(0,10) : String(x.date);
    console.log(`  ${d.id} date=${dt} booking=${x.bookingId} status=${x.status}`);
  });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
