// S5-S7 追加調査: checklistMaster 中身、invoices PDF状況、checklist 中身サンプル
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const pid = "tsZybhDMcPrxqgcRy7wp";
  const toDate = (v) => v?.toDate ? v.toDate() : (typeof v === "string" ? new Date(v) : null);

  // checklistMaster/main 全フィールド
  console.log("=== checklistMaster/main 全フィールド ===");
  const m = await db.collection("checklistMaster").doc("main").get();
  if (m.exists) {
    const d = m.data();
    console.log("  keys:", Object.keys(d));
    Object.keys(d).forEach(k => {
      const v = d[k];
      if (Array.isArray(v)) console.log(`  ${k}: array length=${v.length}`);
      else if (typeof v === "object" && v !== null) console.log(`  ${k}: object keys=${Object.keys(v).slice(0,5)}`);
      else console.log(`  ${k}: ${v}`);
    });
    // categories / tree / サブコレ構造の可能性
    const subs = ["items", "categories", "areas", "tree", "levels"];
    for (const s of subs) {
      const sub = await m.ref.collection(s).get();
      if (sub.size > 0) console.log(`  sub.${s}: ${sub.size}件`);
    }
  }

  // checklistTemplates/{pid}
  console.log("\n=== checklistTemplates/" + pid + " ===");
  const t = await db.collection("checklistTemplates").doc(pid).get();
  if (t.exists) {
    const d = t.data();
    console.log("  keys:", Object.keys(d));
    Object.keys(d).forEach(k => {
      const v = d[k];
      if (Array.isArray(v)) console.log(`  ${k}: array length=${v.length}`);
      else if (typeof v === "object" && v !== null) console.log(`  ${k}: object keys=${Object.keys(v).slice(0,10)}`);
      else console.log(`  ${k}: ${v}`);
    });
  }

  // サブコレ (古い仕様の可能性)
  const tmplSub = await db.collection("checklistTemplates").doc(pid).collection("items").get();
  console.log(`  sub.items: ${tmplSub.size}`);

  // checklists 1件詳細 (items 有無)
  console.log("\n=== checklists サンプル (1件 items 構造) ===");
  const cl = await db.collection("checklists").where("propertyId", "==", pid).limit(1).get();
  if (!cl.empty) {
    const d = cl.docs[0].data();
    console.log("  keys:", Object.keys(d));
    console.log("  items length:", (d.items || []).length);
    if ((d.items || []).length > 0) {
      console.log("  items[0]:", JSON.stringify(d.items[0]).substring(0, 300));
    }
    // サブコレクション版
    const subItems = await cl.docs[0].ref.collection("items").get();
    console.log("  sub.items:", subItems.size);
    if (subItems.size > 0) {
      console.log("  sub.items[0]:", JSON.stringify(subItems.docs[0].data()).substring(0, 300));
    }
  }

  // invoices 詳細
  console.log("\n=== invoices 詳細 ===");
  const invSnap = await db.collection("invoices").get();
  invSnap.docs.forEach(d => {
    const x = d.data();
    console.log(`\n  [${d.id}]`);
    console.log(`    yearMonth: ${x.yearMonth}`);
    console.log(`    staffId: ${x.staffId}`);
    console.log(`    total: ¥${(x.total||0).toLocaleString()}`);
    console.log(`    status: ${x.status}`);
    console.log(`    pdfUrl: ${x.pdfUrl || "(なし)"}`);
    console.log(`    submittedAt: ${toDate(x.submittedAt)?.toISOString() || "(なし)"}`);
    console.log(`    confirmedAt: ${toDate(x.confirmedAt)?.toISOString() || "(なし)"}`);
    console.log(`    shifts: ${(x.details?.shifts || []).length}件, laundry: ${(x.details?.laundry || []).length}件, manualItems: ${(x.manualItems || []).length}件`);
  });

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
