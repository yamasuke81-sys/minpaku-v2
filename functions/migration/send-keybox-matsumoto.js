#!/usr/bin/env node
// 松本和樹さん (5/16 CI YADO KOMACHI Hiroshima) にキーボックスメールを送信
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const { sendKeyboxEmail } = require("../utils/keyboxSender");

const GUEST_ID = "H7M13bpDYLzDjilHp0fb";

(async () => {
  const gDoc = await db.collection("guestRegistrations").doc(GUEST_ID).get();
  if (!gDoc.exists) throw new Error("guest not found");
  const g = gDoc.data();
  console.log(`送信対象: ${g.guestName} (${g.email}) CI=${g.checkIn}`);
  if (g.keyboxSentAt) {
    console.log("既に送信済み。中止");
    process.exit(1);
  }
  const pDoc = await db.collection("properties").doc(g.propertyId).get();
  const p = pDoc.data();
  console.log(`物件: ${p.name}`);

  console.log("送信中...");
  await sendKeyboxEmail(g, p);
  await gDoc.ref.update({
    keyboxSentAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log("✅ 送信完了");
  process.exit(0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
