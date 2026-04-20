const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();
(async () => {
  const ls = await db.collection("laundry")
    .where("staffId", "==", "ziTig6tefnj5NvkgN4fG")
    .where("date", ">=", new Date(2026, 3, 1))
    .where("date", "<=", new Date(2026, 3, 30, 23, 59, 59))
    .get();
  console.log(`4月 owner laundry: ${ls.size}件`);
  ls.forEach(d => {
    const l = d.data();
    console.log(`  [${d.id}] date=${l.date?.toDate?.().toISOString?.().slice(0,10) || l.date} amount=${l.amount} paymentMethod=${l.paymentMethod} isReimbursable=${l.isReimbursable} sourceShiftId=${l.sourceShiftId || "none"} depotId=${l.depotId} propertyId=${l.propertyId} memo="${l.memo || ""}"`);
  });
  console.log("");
  // shifts
  const ss = await db.collection("shifts")
    .where("staffId", "==", "ziTig6tefnj5NvkgN4fG")
    .where("date", ">=", new Date(2026, 3, 20))
    .where("date", "<=", new Date(2026, 3, 20, 23, 59, 59))
    .get();
  ss.forEach(d => {
    const s = d.data();
    console.log(`  shift [${d.id}] workType=${s.workType} amount=${s.amount || "none"} sourceChecklistId=${s.sourceChecklistId || "none"}`);
  });
  process.exit(0);
})();
