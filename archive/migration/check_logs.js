const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();
db.collection("error_logs").where("type","==","passport_upload_failed").orderBy("createdAt","desc").limit(10).get().then(snap => {
  snap.forEach(d => {
    const x = d.data();
    console.log("---");
    console.log("at:", x.createdAt && x.createdAt.toDate ? x.createdAt.toDate().toISOString() : "?");
    console.log("msg:", x.message);
    console.log("prop:", x.propertyId, x.propertyName || "");
  });
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
