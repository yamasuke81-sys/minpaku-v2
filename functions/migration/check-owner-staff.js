const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const ownerDoc = await db.collection("staff").doc("ziTig6tefnj5NvkgN4fG").get();
  console.log("オーナースタッフドキュメント:");
  if (ownerDoc.exists) {
    const d = ownerDoc.data();
    console.log(JSON.stringify({
      id: ownerDoc.id,
      name: d.name,
      displayName: d.displayName,
      isOwner: d.isOwner,
      active: d.active,
      authUid: d.authUid,
      assignedPropertyIds: d.assignedPropertyIds,
    }, null, 2));
  } else {
    console.log("NOT FOUND");
  }

  // 4/20 の shift を全件 (staffId filter なし)
  console.log("\n4/20 shifts (全件):");
  const snap = await db.collection("shifts")
    .where("date", ">=", new Date(2026, 3, 20))
    .where("date", "<=", new Date(2026, 3, 20, 23, 59, 59))
    .get();
  snap.forEach(d => {
    const data = d.data();
    console.log(`  [${d.id}] staffId=${data.staffId || "null"} staffName="${data.staffName || ""}" propertyId=${data.propertyId} workType=${data.workType}`);
  });

  console.log("\n4/26 shifts (全件):");
  const snap2 = await db.collection("shifts")
    .where("date", ">=", new Date(2026, 3, 26))
    .where("date", "<=", new Date(2026, 3, 26, 23, 59, 59))
    .get();
  snap2.forEach(d => {
    const data = d.data();
    console.log(`  [${d.id}] staffId=${data.staffId || "null"} staffName="${data.staffName || ""}" propertyId=${data.propertyId} workType=${data.workType}`);
  });

  process.exit(0);
})();
