#!/usr/bin/env node
/**
 * kind=payout に該当するメール (送金通知等) で上書きされていた
 * bookings.emailSubject / emailMessageId / emailThreadId / emailVerifiedAt を
 * クリアして、次回巡回時に正しい予約メールで再書込できる状態にする
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

(async () => {
  // payout に該当する emailVerifications を特定 (件名 or extractedInfo.kind で判定)
  const allEv = await db.collection("emailVerifications").get();
  const payoutBookingIds = new Set();
  allEv.docs.forEach((d) => {
    const ev = d.data();
    const subject = ev.subject || "";
    const kind = ev.extractedInfo && ev.extractedInfo.kind;
    const isPayout = kind === "payout" || /受取金を送金|送金しました/.test(subject);
    if (isPayout && ev.matchedBookingId) {
      payoutBookingIds.add(ev.matchedBookingId);
    }
  });
  console.log(`payout メールで紐付いている bookings: ${payoutBookingIds.size} 件`);

  let cleared = 0;
  for (const bid of payoutBookingIds) {
    const bref = db.collection("bookings").doc(bid);
    const bsnap = await bref.get();
    if (!bsnap.exists) continue;
    const b = bsnap.data();
    // 他の matched メール (confirmed/cancelled 等) で上書きされていなければクリア
    // 判定: emailMessageId が payout emailVerifications の messageId と一致
    const evSnap = await db.collection("emailVerifications")
      .where("matchedBookingId", "==", bid).get();
    const latestNonPayout = evSnap.docs
      .map((d) => d.data())
      .filter((ev) => {
        const k = ev.extractedInfo && ev.extractedInfo.kind;
        const subj = ev.subject || "";
        return k !== "payout" && !/受取金を送金|送金しました/.test(subj);
      })
      .sort((a, b) => {
        const ams = a.receivedAt && a.receivedAt.toMillis ? a.receivedAt.toMillis() : 0;
        const bms = b.receivedAt && b.receivedAt.toMillis ? b.receivedAt.toMillis() : 0;
        return bms - ams;
      })[0];

    if (latestNonPayout) {
      // 最新の予約関連メールで上書き
      await bref.update({
        emailMessageId: latestNonPayout.messageId,
        emailThreadId: latestNonPayout.threadId || null,
        emailSubject: latestNonPayout.subject || null,
        emailVerifiedAt: latestNonPayout.receivedAt || admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`  ✓ ${bid.slice(0, 30)} → "${(latestNonPayout.subject || "").slice(0, 50)}"`);
      cleared++;
    } else {
      // payout 以外に該当メールが無い → emailSubject などをクリア
      await bref.update({
        emailMessageId: admin.firestore.FieldValue.delete(),
        emailThreadId: admin.firestore.FieldValue.delete(),
        emailSubject: admin.firestore.FieldValue.delete(),
        emailVerifiedAt: admin.firestore.FieldValue.delete(),
      });
      console.log(`  ✓ ${bid.slice(0, 30)} → クリア (代替メールなし)`);
      cleared++;
    }
  }
  console.log(`完了: ${cleared} 件 update`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
