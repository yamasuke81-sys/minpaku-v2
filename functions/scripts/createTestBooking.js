// the Terrace 長浜 にテスト予約を作成し onBookingChange を発火 → recruitments / shifts 自動生成
// → 清掃募集通知 (recruit_start) の LINE 通知をテストする
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const PROPERTY_ID = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜
  // テスト用: 1週間後のチェックイン → 翌日チェックアウト
  const today = new Date();
  const checkIn = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  const checkOut = new Date(checkIn.getTime() + 1 * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10); // YYYY-MM-DD

  const bookingData = {
    propertyId: PROPERTY_ID,
    guestName: "テスト予約 (LINE 通知確認)",
    guestCount: 2,
    checkIn: fmt(checkIn),
    checkOut: fmt(checkOut),
    source: "manual-test",
    status: "confirmed",
    bbq: false,
    parking: true,
    notes: "createTestBooking.js による LINE 通知動作確認用テスト予約。削除推奨。",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    syncedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  console.log("=== テスト予約作成 ===");
  console.log(`propertyId: ${PROPERTY_ID}`);
  console.log(`checkIn → checkOut: ${bookingData.checkIn} → ${bookingData.checkOut}`);
  console.log(`guestName: ${bookingData.guestName}`);
  console.log("");

  const ref = await db.collection("bookings").add(bookingData);
  console.log(`✓ booking 作成: ${ref.id}`);
  console.log("");
  console.log("→ onBookingChange トリガーが起動して shifts/recruitments を自動生成します");
  console.log("→ recruit_start 通知 (LINE) が channelOverrides 設定に従って発火するはず");
  console.log("");
  console.log("確認:");
  console.log(`  1. Firebase Console → bookings → ${ref.id}`);
  console.log(`  2. recruitments で checkoutDate=${bookingData.checkOut} のドキュメント生成確認`);
  console.log(`  3. shifts で checkoutDate のドキュメント生成確認`);
  console.log(`  4. LINE 通知が「長浜清掃G通知」「グループ」へ届くか確認`);
  console.log("");
  console.log("⚠ テスト後の削除コマンド:");
  console.log(`  node functions/scripts/deleteTestBooking.js ${ref.id}`);
})().catch(e => { console.error(e); process.exit(1); });
