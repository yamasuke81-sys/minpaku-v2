const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  const docId = "ical_1418fb94e984-9ace522714195c3b7bb1b642b639831a@airbnb.com";
  const snap = await db.collection("bookings").doc(docId).get();
  const b = snap.data();
  console.log(JSON.stringify(b, (key, value) => {
    if (value && typeof value.toDate === "function") return value.toDate().toISOString();
    return value;
  }, 2));

  // 同じ propertyId + 期間重複の active 予約を確認 (suppressCancelNotify 判定の再現)
  console.log("\n=== 期間重複の active 予約チェック ===");
  const dupSnap = await db.collection("bookings")
    .where("propertyId", "==", b.propertyId)
    .where("status", "==", "confirmed")
    .get();
  let dupFound = false;
  for (const d of dupSnap.docs) {
    if (d.id === docId) continue;
    const dd = d.data();
    if (dd.pendingApproval === true) continue;
    if (!dd.checkIn || !dd.checkOut) continue;
    if (b.checkIn <= dd.checkOut && b.checkOut >= dd.checkIn) {
      dupFound = true;
      console.log(`重複あり: ${d.id} CI=${dd.checkIn} CO=${dd.checkOut} guest=${dd.guestName}`);
    }
  }
  if (!dupFound) console.log("重複なし → 本来 booking_cancel 通知が飛ぶはず");

  // 関連 emailVerifications ドキュメント
  console.log("\n=== 関連 emailVerifications ===");
  if (b.emailMessageId) {
    const ev = await db.collection("emailVerifications").doc(b.emailMessageId).get();
    if (ev.exists) {
      const e = ev.data();
      console.log(`messageId=${b.emailMessageId}`);
      console.log(`  kind=${e.parsedInfo?.kind} subject=${e.subject}`);
      console.log(`  receivedAt=${e.receivedAt?.toDate?.()}`);
      console.log(`  matchStatus=${e.matchStatus}`);
    } else {
      console.log("emailVerifications doc 未検出");
    }
  }

  // 関連 emailVerifications を threadId で探す
  if (b.emailThreadId) {
    const evSnap = await db.collection("emailVerifications")
      .where("threadId", "==", b.emailThreadId)
      .get();
    console.log(`threadId=${b.emailThreadId} のメール件数: ${evSnap.size}`);
    evSnap.docs.forEach(d => {
      const e = d.data();
      console.log(`  ${d.id}: kind=${e.parsedInfo?.kind} subject=${(e.subject || "").slice(0, 50)} matchStatus=${e.matchStatus}`);
    });
  }
})();
