/**
 * 物件 10日市ムラタク の ownerStaffId / ownerBillingProfileId
 * + 対応スタッフの billingProfiles[] 確認 (readonly)
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();
(async () => {
  // 物件一覧から 十日市ムラタク を探す
  const propsSnap = await db.collection("properties").get();
  const target = propsSnap.docs.find(d => (d.data().name || "").includes("十日市ムラタク"));
  if (!target) { console.log("物件 十日市ムラタク が見つかりません"); process.exit(0); }
  const prop = target.data();
  console.log(`=== 物件 ${prop.name} (${target.id}) ===`);
  console.log(`  ownerStaffId: ${prop.ownerStaffId || "(未設定)"}`);
  console.log(`  ownerBillingProfileId: ${prop.ownerBillingProfileId || "(未設定)"}`);

  if (!prop.ownerStaffId) { process.exit(0); }
  const sDoc = await db.collection("staff").doc(prop.ownerStaffId).get();
  if (!sDoc.exists) { console.log("ownerStaff が見つかりません"); process.exit(0); }
  const s = sDoc.data();
  console.log(`\n=== ownerStaff ${s.name} (${sDoc.id}) ===`);
  console.log(`  旧 companyName: "${s.companyName || ""}"`);
  console.log(`  旧 zipCode: "${s.zipCode || ""}"`);
  console.log(`  旧 address: "${s.address || ""}"`);
  console.log(`  billingProfiles:`);
  const profiles = Array.isArray(s.billingProfiles) ? s.billingProfiles : [];
  if (!profiles.length) {
    console.log("    (無し)");
  } else {
    profiles.forEach((p, i) => {
      console.log(`    [${i}] id="${p.id}" label="${p.label}" companyName="${p.companyName}" zip="${p.zipCode}" address="${p.address}"`);
    });
  }
  process.exit(0);
})();
