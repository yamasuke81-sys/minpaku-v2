#!/usr/bin/env node
/**
 * matched/cancelled な emailVerifications について、対応 booking の
 * emailThreadId / emailMessageId を強制上書きする backfill スクリプト
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

(async () => {
  const snap = await db.collection("emailVerifications")
    .where("matchStatus", "in", ["matched", "cancelled"]).get();
  console.log(`対象 emailVerifications: ${snap.size} 件`);

  let updated = 0;
  for (const d of snap.docs) {
    const ev = d.data();
    if (!ev.matchedBookingId || !ev.threadId) continue;
    try {
      await db.collection("bookings").doc(ev.matchedBookingId).update({
        emailThreadId: ev.threadId,
        emailMessageId: ev.messageId,
      });
      console.log(`  ✓ ${ev.matchedBookingId.slice(0, 30)} ← threadId=${ev.threadId}`);
      updated++;
    } catch (e) {
      console.error(`  ✗ ${ev.matchedBookingId}: ${e.message}`);
    }
  }
  console.log(`完了: ${updated} 件 update`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
