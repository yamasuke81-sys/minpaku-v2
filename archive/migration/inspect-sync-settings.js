const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const snap = await db.collection("syncSettings").get();
  console.log(`syncSettings: ${snap.size}件`);
  snap.docs.forEach(d => {
    const x = d.data();
    console.log(`${d.id}`);
    console.log(`  propertyId: ${x.propertyId || "(空)"}`);
    console.log(`  propertyName: ${x.propertyName || "(空)"}`);
    console.log(`  platform: ${x.platform || "(空)"}`);
    console.log(`  active: ${x.active}`);
    console.log(`  icalUrl: ${(x.icalUrl||"").substring(0,80)}`);
  });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
