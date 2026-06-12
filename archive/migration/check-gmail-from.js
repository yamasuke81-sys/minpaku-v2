#!/usr/bin/env node
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  // sendNotificationEmail_ のフォールバックロジック (fromEmail指定なし時) と同じ順
  let snap = await db.collection("settings").doc("gmailOAuth").collection("tokens").limit(1).get();
  let ctx = "gmailOAuth";
  if (snap.empty) {
    snap = await db.collection("settings").doc("gmailOAuthEmailVerification").collection("tokens").limit(1).get();
    ctx = "gmailOAuthEmailVerification";
  }
  if (snap.empty) { console.log("Gmail 連携なし"); process.exit(0); }
  const d = snap.docs[0];
  console.log(`使用トークン: ctx=${ctx} docId=${d.id}`);
  console.log(`email=${d.data().email}`);

  // settings/gmailOAuth/tokens 全件 (どんなアカウントが連携されているか)
  console.log(`\n--- gmailOAuth/tokens 全件 ---`);
  const all = await db.collection("settings").doc("gmailOAuth").collection("tokens").get();
  all.forEach((x) => console.log(`  [${x.id}] email=${x.data().email}`));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
