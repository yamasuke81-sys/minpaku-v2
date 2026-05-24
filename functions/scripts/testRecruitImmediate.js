// 一時的に recruit_start を immediate モードに変更 → テスト予約作成 → 通知発火 → 削除 → モード復元
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const PROPERTY_ID = "tsZybhDMcPrxqgcRy7wp";
  const propRef = db.collection("properties").doc(PROPERTY_ID);
  const propDoc = await propRef.get();
  const originalOv = propDoc.data()?.channelOverrides?.recruit_start;
  if (!originalOv) {
    console.log("channelOverrides.recruit_start が見つからない");
    return;
  }

  console.log("=== 元の recruit_start 設定をバックアップ ===");
  console.log("mode:", originalOv.mode);
  console.log("timings:", JSON.stringify(originalOv.timings));

  // 一時的に immediate モードに変更
  const tempOv = {
    ...originalOv,
    mode: "immediate",
    timing: "immediate",
    timings: [{ mode: "immediate", timing: "immediate" }],
  };
  await propRef.update({
    "channelOverrides.recruit_start": tempOv,
  });
  console.log("\n✓ recruit_start を一時的に immediate モードに変更");

  // テスト予約作成
  const fmt = (d) => d.toISOString().slice(0, 10);
  const snap = await db.collection("bookings")
    .where("propertyId", "==", PROPERTY_ID)
    .get();
  const usedCheckOuts = new Set();
  const usedCheckIns = new Set();
  for (const d of snap.docs) {
    const x = d.data();
    if (x.status === "cancelled") continue;
    if (x.checkOut) usedCheckOuts.add(x.checkOut);
    if (x.checkIn) usedCheckIns.add(x.checkIn);
  }
  const start = new Date(Date.now() + 14 * 86400000);
  let testCI = null;
  for (let i = 0; i < 180; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const ci = fmt(d);
    const co = fmt(new Date(d.getTime() + 86400000));
    if (!usedCheckOuts.has(co) && !usedCheckOuts.has(ci) && !usedCheckIns.has(ci) && !usedCheckIns.has(co)) {
      testCI = ci;
      break;
    }
  }
  const ci = testCI;
  const co = fmt(new Date(new Date(testCI).getTime() + 86400000));
  console.log(`\n空き日決定: CI=${ci} CO=${co}`);

  const bookingData = {
    propertyId: PROPERTY_ID,
    guestName: "AUTO-TEST 即時通知確認 (削除予定)",
    guestCount: 2,
    checkIn: ci, checkOut: co,
    source: "manual-test-immediate",
    status: "confirmed",
    bbq: false, parking: false,
    notes: "testRecruitImmediate.js による即時通知テスト",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    syncedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  const ref = await db.collection("bookings").add(bookingData);
  console.log(`✓ booking 作成: ${ref.id}`);

  console.log("\n通知発火待機 30秒...");
  await new Promise(r => setTimeout(r, 30000));

  // 削除
  console.log("\n削除開始");
  await ref.update({ status: "cancelled", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  await new Promise(r => setTimeout(r, 5000));
  await ref.delete();
  console.log(`✓ booking 削除完了 (id=${ref.id})`);

  // 設定復元
  console.log("\n=== recruit_start 設定を元に戻します ===");
  await propRef.update({
    "channelOverrides.recruit_start": originalOv,
  });
  console.log("✓ mode/timings 復元完了");
  console.log("\n→ 即時 LINE 通知が届いたか確認してください");
})().catch(e => { console.error(e); process.exit(1); });
