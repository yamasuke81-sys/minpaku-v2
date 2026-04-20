// Pocket House WAKA-KUSA と UJINA Pocket House に the Terrace 長浜のフォームをコピー
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const SRC = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜
const DRY = !process.argv.includes("--execute");

(async () => {
  console.log(`モード: ${DRY ? "確認のみ" : "実行"}\n`);

  const src = (await db.collection("properties").doc(SRC).get()).data();
  console.log(`ソース: ${src.name} (fields=${(src.customFormFields || []).length}, sections=${(src.customFormSections || []).length})\n`);

  // fields が 0 の民泊物件を対象
  const pSnap = await db.collection("properties").where("active", "==", true).get();
  const targets = pSnap.docs.filter(d => {
    const p = d.data();
    if ((p.type || "minpaku") !== "minpaku") return false;
    if (d.id === SRC) return false;
    return (p.customFormFields || []).length === 0;
  });
  console.log(`コピー対象: ${targets.length}件\n`);

  for (const d of targets) {
    const p = d.data();
    console.log(`  → ${p.name} (${d.id})`);
    const update = {
      customFormFields: src.customFormFields || [],
      customFormSections: src.customFormSections || [],
      customFormEnabled: true,
      // showNoiseAgreement / miniGameEnabled はそのまま (各物件の運用に任せる)
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (!DRY) {
      await d.ref.update(update);
      console.log(`    ✓ fields=${update.customFormFields.length} sections=${update.customFormSections.length} をコピー`);
    }
  }

  console.log(`\n${DRY ? "→ --execute で実行" : "完了"}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
