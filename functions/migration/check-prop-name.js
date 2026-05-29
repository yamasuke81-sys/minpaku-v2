const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  for (const id of ["GK31ElxSjhRdxSMWc4AZ", "RDH4s0nThw04xJb8JQnp", "tsZybhDMcPrxqgcRy7wp"]) {
    const p = await db.collection("properties").doc(id).get();
    const d = p.data() || {};
    console.log(`${id}: name="${d.name}" number=${d.propertyNumber} active=${d.active}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
