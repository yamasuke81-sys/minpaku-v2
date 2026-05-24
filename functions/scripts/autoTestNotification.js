// the Terrace 長浜 の空いている日にテスト予約を作成 → 通知発火を Cloud Functions ログで確認 → 削除
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const PROPERTY_ID = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜
  const fmt = (d) => d.toISOString().slice(0, 10);

  // 既存予約の checkOut 日を集合化 (キャンセル除く)
  const snap = await db.collection("bookings")
    .where("propertyId", "==", PROPERTY_ID)
    .get();
  const usedCheckOuts = new Set();
  for (const d of snap.docs) {
    const x = d.data();
    if (x.status === "cancelled") continue;
    if (x.checkOut) usedCheckOuts.add(x.checkOut);
  }
  console.log(`既存有効予約の checkOut 数: ${usedCheckOuts.size}`);

  // 2週間後〜6ヶ月後で空いている日を探す
  const start = new Date(Date.now() + 14 * 86400000);
  const end = new Date(Date.now() + 180 * 86400000);
  let testCheckIn = null;
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400000)) {
    const ci = fmt(d);
    const coDate = new Date(d.getTime() + 86400000);
    const co = fmt(coDate);
    // CI 日に CO がある = 別予約あり (CI=同物件 CO 日と被るとスキップ)
    if (usedCheckOuts.has(co)) continue;
    // CO 日に CI=他予約 CO がある = 連泊扱いになりうる
    if (usedCheckOuts.has(ci)) continue;
    testCheckIn = ci;
    break;
  }
  if (!testCheckIn) {
    console.log("空き日が見つからず");
    return;
  }

  const ci = testCheckIn;
  const co = fmt(new Date(new Date(testCheckIn).getTime() + 86400000));
  console.log(`空き日決定: CI=${ci} CO=${co}`);

  // テスト予約作成
  const bookingData = {
    propertyId: PROPERTY_ID,
    guestName: "AUTO-TEST 通知確認 (削除予定)",
    guestCount: 2,
    checkIn: ci,
    checkOut: co,
    source: "manual-test-auto",
    status: "confirmed",
    bbq: false,
    parking: false,
    notes: "autoTestNotification.js による自動テスト。即座に削除されます。",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    syncedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  const ref = await db.collection("bookings").add(bookingData);
  console.log(`✓ booking 作成: ${ref.id}`);
  console.log(`  → onBookingChange トリガー発火、notifyByKey("recruit_start") 実行されるはず`);

  // 30秒待機 (Functions 実行 + 通知送信完了を待つ)
  console.log("\n30秒待機 (通知発火完了待ち)...");
  await new Promise(r => setTimeout(r, 30000));

  // 即削除
  console.log("\n削除開始");
  await ref.update({
    status: "cancelled",
    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await new Promise(r => setTimeout(r, 5000));
  await ref.delete();
  console.log(`✓ booking 削除完了 (id=${ref.id})`);
  console.log("\n→ Cloud Functions ログ確認:");
  console.log(`  gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="onbookingchange" AND timestamp>="${new Date(Date.now() - 5 * 60 * 1000).toISOString()}"' --project=minpaku-v2 --limit=20`);
})().catch(e => { console.error(e); process.exit(1); });
