#!/usr/bin/env node
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  const id = "RZV9IwtQgMAsvrdM3j8J";
  const p = (await db.collection("properties").doc(id).get()).data() || {};
  console.log(`name=${p.name}`);
  console.log(`senderGmail=${p.senderGmail}`);
  console.log(`notificationEmail=${p.notificationEmail}`);
  console.log(`ownerStaffId=${p.ownerStaffId} ownerId=${p.ownerId}`);

  console.log("\n--- gmailOAuth tokens ---");
  const tk = await db.collection("settings").doc("gmailOAuth").collection("tokens").get();
  tk.forEach((d) => console.log(`  [${d.id}] email=${d.data().email} ownerId=${d.data().ownerId}`));
  console.log("\n--- gmailOAuthEmailVerification tokens ---");
  const tk2 = await db.collection("settings").doc("gmailOAuthEmailVerification").collection("tokens").get();
  tk2.forEach((d) => console.log(`  [${d.id}] email=${d.data().email} ownerId=${d.data().ownerId}`));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
