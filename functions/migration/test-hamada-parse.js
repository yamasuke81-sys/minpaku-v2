const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const { parseEmail } = require("../utils/emailParser");
(async () => {
  const ID = "19e1795a4d9bf977";
  const snap = await db.collection("emailVerifications").doc(ID).get();
  const x = snap.data();
  console.log("==== STORED parsed ====");
  console.log(JSON.stringify(x.parsed || x.extractedInfo || null, null, 2));
  console.log("==== STORED matchedBookingId ====");
  console.log(x.matchedBookingId);
  console.log("==== Re-run parser ====");
  const parsed = parseEmail({
    subject: x.subject,
    body: x.rawBodyText || x.body || "",
    fromHeader: x.fromHeader || "",
    platform: "Airbnb",
    receivedAt: x.receivedAt?.toDate?.() || new Date(),
  });
  console.log(JSON.stringify(parsed, null, 2));
  console.log("==== HM regex test ====");
  const m = /HM[A-Z0-9]{8}/.exec(x.rawBodyText || "");
  console.log("match:", m ? m[0] : "NONE");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
