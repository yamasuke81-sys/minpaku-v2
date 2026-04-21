// resolveInvoiceRecipient_ を直接呼んで結果確認 (readonly)
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

async function resolveInvoiceRecipient_(db, propertyId, client) {
  const fallback = {
    companyName: client?.companyName || "合同会社八朔",
    address: client?.address || "広島県安芸郡海田町上市4-23-12",
    zipCode: client?.zipCode || "736-0061",
    name: client?.name || "",
    source: "settings",
  };
  if (!propertyId) return fallback;
  const pDoc = await db.collection("properties").doc(propertyId).get();
  if (!pDoc.exists) return fallback;
  const pData = pDoc.data();
  const ownerStaffId = pData.ownerStaffId;
  const ownerBillingProfileId = pData.ownerBillingProfileId || null;
  if (!ownerStaffId) return fallback;
  const sDoc = await db.collection("staff").doc(ownerStaffId).get();
  if (!sDoc.exists) return fallback;
  const s = sDoc.data();
  const profiles = Array.isArray(s.billingProfiles) ? s.billingProfiles : [];
  let picked = null;
  if (ownerBillingProfileId) {
    picked = profiles.find(p => p && p.id === ownerBillingProfileId) || null;
  }
  if (!picked && profiles.length === 1) picked = profiles[0];
  console.log(`propertyId=${propertyId}`);
  console.log(`ownerBillingProfileId=${ownerBillingProfileId}`);
  console.log(`profiles.length=${profiles.length}`);
  profiles.forEach((p, i) => {
    console.log(`  profiles[${i}].id="${p.id}" match=${p.id === ownerBillingProfileId}`);
  });
  console.log(`picked=${picked ? JSON.stringify(picked) : "null"}`);
  if (picked) {
    return { companyName: picked.companyName || s.name || "", address: picked.address || "", zipCode: picked.zipCode || "", name: s.name || "", source: "ownerStaffBillingProfile" };
  }
  if (s.companyName || s.address || s.zipCode) {
    return { companyName: s.companyName || s.name || "", address: s.address || "", zipCode: s.zipCode || "", name: s.name || "", source: "ownerStaffLegacy" };
  }
  return fallback;
}

(async () => {
  const result = await resolveInvoiceRecipient_(db, "mrFcQpAHGBxvHKO2fJbj", {});
  console.log(`\n=== 最終結果 ===`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
})();
