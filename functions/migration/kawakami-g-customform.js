// customFormFields が空の物件を確認 + the Terrace 長浜のテンプレートを比較
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const props = await db.collection("properties").where("active", "==", true).get();
  const minpaku = props.docs.filter(d => (d.data().type || "minpaku") === "minpaku");

  console.log("物件 | customFormEnabled | fields | sections");
  for (const d of minpaku) {
    const p = d.data();
    const fields = (p.customFormFields || []).length;
    const sections = (p.customFormSections || []).length;
    console.log(`  ${p.name.padEnd(32)} | ${String(p.customFormEnabled !== false).padEnd(5)} | ${fields} | ${sections}`);
  }

  // the Terrace と WAKA-KUSA の比較
  const terrace = (await db.collection("properties").doc("tsZybhDMcPrxqgcRy7wp").get()).data();
  console.log(`\nthe Terrace 長浜 customFormFields サンプル (3件):`);
  for (const f of (terrace.customFormFields || []).slice(0, 3)) {
    console.log(`  ${f.id}: ${f.label} (${f.type}, required=${f.required})`);
  }

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
