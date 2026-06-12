const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();
(async () => {
  const doc = await db.collection("settings").doc("prepaidCards").get();
  const items = (doc.exists && doc.data().items) || [];
  console.log(`プリカ件数: ${items.length}`);
  items.forEach((c, i) => {
    const paStr = c.purchasedAt?.toDate?.().toISOString?.() || c.purchasedAt?._seconds ? new Date(c.purchasedAt._seconds * 1000).toISOString() : String(c.purchasedAt || "(none)");
    console.log(`  [${i}] ${c.cardNumber} depotId=${c.depotId} balance=${c.balance} chargeAmount=${c.chargeAmount || "(none)"} purchasedAt=${paStr} purchasedBy=${JSON.stringify(c.purchasedBy || null)} propertyIds=${JSON.stringify(c.propertyIds || [])}`);
  });
  process.exit(0);
})();
