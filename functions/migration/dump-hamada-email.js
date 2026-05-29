const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  const ID = "19e1795a4d9bf977"; // 予約確定 - 濵田 薫平さん
  const snap = await db.collection("emailVerifications").doc(ID).get();
  if (!snap.exists) { console.log("not found"); process.exit(0); }
  const x = snap.data();
  // body は長いので冒頭抜粋
  const out = {
    ...x,
    body: typeof x.body === "string" ? x.body.slice(0, 2000) : x.body,
    bodyHtml: typeof x.bodyHtml === "string" ? x.bodyHtml.slice(0, 500) : x.bodyHtml,
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
