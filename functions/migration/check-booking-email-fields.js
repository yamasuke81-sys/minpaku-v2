#!/usr/bin/env node
/**
 * bookings 側にメール照合フィールドがどれだけ書き込まれているか確認する診断スクリプト
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

(async () => {
  const snap = await db.collection("bookings").get();
  let total = 0;
  let hasEmailMessageId = 0;
  let hasEmailVerifiedAt = 0;
  const rows = [];
  snap.docs.forEach((d) => {
    const b = d.data();
    total++;
    if (b.emailMessageId) hasEmailMessageId++;
    if (b.emailVerifiedAt) hasEmailVerifiedAt++;
    if (b.emailMessageId || b.emailVerifiedAt) {
      const ci = b.checkIn && b.checkIn.toDate ? b.checkIn.toDate().toISOString().slice(0, 10) : b.checkIn;
      rows.push({
        id: d.id.slice(0, 30),
        ci: ci || "-",
        guest: (b.guestName || "").slice(0, 20),
        emailMessageId: (b.emailMessageId || "").slice(0, 20),
        emailVerifiedAt: b.emailVerifiedAt ? (b.emailVerifiedAt.toDate ? b.emailVerifiedAt.toDate().toISOString() : String(b.emailVerifiedAt)) : "-",
        emailMatchedBy: b.emailMatchedBy || "-",
      });
    }
  });
  console.log(`bookings total: ${total}`);
  console.log(`  emailMessageId あり: ${hasEmailMessageId}`);
  console.log(`  emailVerifiedAt あり: ${hasEmailVerifiedAt}`);
  console.log("--- 書込み済み一覧 ---");
  rows.forEach((r) => console.log(JSON.stringify(r)));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
