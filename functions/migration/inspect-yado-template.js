// YADO KOMACHI テンプレート調査
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const PID = "RZV9IwtQgMAsvrdM3j8J";

  console.log("=== YADO KOMACHI の清掃テンプレート ===");
  const tmpl = await db.collection("checklistTemplates").doc(PID).get();
  if (!tmpl.exists) { console.log("テンプレート未設定"); process.exit(0); }
  const t = tmpl.data();
  console.log(`version: ${t.version}`);
  console.log(`areas: ${(t.areas || []).length}個`);
  for (const a of (t.areas || [])) {
    const di = a.directItems || [];
    const it = a.items || [];
    const tt = a.taskTypes || [];
    console.log(`  [${a.id || "?"}] ${a.name || "?"} — directItems=${di.length} items=${it.length} taskTypes=${tt.length}`);
    if (di.length > 0) {
      console.log(`    例: ${di.slice(0, 3).map(x => x.name || "?").join(" / ")}`);
    }
  }

  console.log("\n=== the Terrace 長浜 ===");
  const tmpl2 = await db.collection("checklistTemplates").doc("tsZybhDMcPrxqgcRy7wp").get();
  if (tmpl2.exists) {
    const t2 = tmpl2.data();
    let totalDi = 0, totalTt = 0;
    for (const a of (t2.areas || [])) {
      const di = a.directItems || [];
      const tt = a.taskTypes || [];
      totalDi += di.length;
      totalTt += tt.length;
    }
    console.log(`  version: ${t2.version} / areas: ${(t2.areas || []).length}個`);
    console.log(`  合計 directItems=${totalDi} 合計 taskTypes=${totalTt}`);
  }

  console.log("\n=== YADO のチェックリスト (救済直後のもの) ===");
  const clSnap = await db.collection("checklists").where("propertyId", "==", PID).get();
  for (const d of clSnap.docs) {
    const x = d.data();
    console.log(`  ${d.id}: templateSnapshot areas=${(x.templateSnapshot || []).length}`);
    for (const a of (x.templateSnapshot || [])) {
      console.log(`    [${a.id || "?"}] ${a.name || a.label || "?"} items=${(a.items || []).length}`);
    }
  }

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
