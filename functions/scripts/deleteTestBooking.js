// テスト予約を削除 (関連 shift/recruitment/checklist も onBookingChange トリガーで連動削除される)
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const bookingId = process.argv[2];
  if (!bookingId) {
    console.log("使い方: node functions/scripts/deleteTestBooking.js <bookingId>");
    return;
  }
  const ref = db.collection("bookings").doc(bookingId);
  const doc = await ref.get();
  if (!doc.exists) {
    console.log(`予約が見つかりません: ${bookingId}`);
    return;
  }
  const d = doc.data();
  console.log(`削除対象: ${bookingId} / ${d.guestName} / ${d.checkIn} → ${d.checkOut}`);
  // status を cancelled に → onBookingChange で連動削除
  await ref.update({
    status: "cancelled",
    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`✓ status=cancelled に更新。連動削除がトリガーされます`);
  // 念のため 5秒後にドキュメント自体も削除
  await new Promise(r => setTimeout(r, 5000));
  await ref.delete();
  console.log(`✓ booking ドキュメント削除完了`);
})().catch(e => { console.error(e); process.exit(1); });
