// E2E Scenario 4: ダブルブッキング検知 (D-1/D-2)
//
// 手順:
//   1. テスト booking A/B を同期間で作成 (propertyId=the Terrace 長浜, _e2eTest=true)
//   2. 8秒待機して onBookingChange トリガー発火を待つ
//   3. conflictWithIds / bookingConflicts の付与を確認
//   4. A を cancelled に変更 → resolved:true + 相手の conflictWithIds 除去を確認
//   5. A/B + bookingConflicts を削除
//
// 使い方: node migration/e2e-s4-double-booking.js

const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const PID = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜
const TAG = { _e2eTest: true, _createdBy: "e2e-session-20260419-s4" };
const CI = "2026-07-01";
const CO = "2026-07-03";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pass = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => { console.log(`  ❌ ${msg}`); hadFail = true; };
let hadFail = false;

(async () => {
  console.log("=== Scenario 4: ダブルブッキング検知 ===");

  // 準備: 既存の残留 e2e データを掃除
  const preA = await db.collection("bookings").where("_e2eTest", "==", true).get();
  for (const d of preA.docs) await d.ref.delete();
  const preC = await db.collection("bookingConflicts").where("_e2eTest", "==", true).get();
  for (const d of preC.docs) await d.ref.delete();

  // Step 1: booking A 作成
  console.log("\n[Step 1] booking A 作成");
  const refA = await db.collection("bookings").add({
    propertyId: PID,
    propertyName: "the Terrace 長浜",
    checkIn: CI,
    checkOut: CO,
    guestName: "E2E-S4-A",
    source: "manual",
    status: "confirmed",
    createdAt: new Date(),
    ...TAG,
  });
  console.log(`  bookingA id=${refA.id}`);
  await sleep(3000); // A 側トリガーは衝突なしなので早く終わる

  // Step 2: booking B 作成 (同期間)
  console.log("\n[Step 2] booking B 作成 (同期間)");
  const refB = await db.collection("bookings").add({
    propertyId: PID,
    propertyName: "the Terrace 長浜",
    checkIn: CI,
    checkOut: CO,
    guestName: "E2E-S4-B",
    source: "manual",
    status: "confirmed",
    createdAt: new Date(),
    ...TAG,
  });
  console.log(`  bookingB id=${refB.id}`);
  console.log("  トリガー発火を polling (最大 60秒)...");
  let dataA, dataB, idsA = [], idsB = [];
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const [docA, docB] = await Promise.all([refA.get(), refB.get()]);
    dataA = docA.data();
    dataB = docB.data();
    idsA = dataA.conflictWithIds || [];
    idsB = dataB.conflictWithIds || [];
    if (idsA.includes(refB.id) && idsB.includes(refA.id)) {
      console.log(`  ✓ ${(i + 1) * 2}秒で検出`);
      break;
    }
  }

  // Step 3: conflict 付与確認
  console.log("\n[Step 3] conflict 付与確認");
  if (idsA.includes(refB.id)) pass(`booking A.conflictWithIds に B を含む`);
  else fail(`booking A.conflictWithIds=${JSON.stringify(idsA)} (B=${refB.id} 未含有)`);
  if (idsB.includes(refA.id)) pass(`booking B.conflictWithIds に A を含む`);
  else fail(`booking B.conflictWithIds=${JSON.stringify(idsB)} (A=${refA.id} 未含有)`);

  const confId = [refA.id, refB.id].sort().join("__");
  const confDoc = await db.collection("bookingConflicts").doc(confId).get();
  if (confDoc.exists) {
    pass(`bookingConflicts/${confId} 生成済み`);
    const c = confDoc.data();
    if (c.resolved === false) pass(`  resolved: false`);
    else fail(`  resolved=${c.resolved} (期待: false)`);
    if (Array.isArray(c.bookingIds) && c.bookingIds.length === 2) pass(`  bookingIds: ${JSON.stringify(c.bookingIds)}`);
    else fail(`  bookingIds=${JSON.stringify(c.bookingIds)}`);
  } else {
    fail(`bookingConflicts/${confId} 未生成`);
  }

  // Step 4: A を cancelled に
  console.log("\n[Step 4] booking A を cancelled に変更");
  await refA.update({ status: "cancelled", updatedAt: new Date() });
  console.log("  D-2 発火を polling (最大 60秒)...");
  let confAfter;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    confAfter = await db.collection("bookingConflicts").doc(confId).get();
    if (confAfter.exists && confAfter.data().resolved === true) {
      console.log(`  ✓ ${(i + 1) * 2}秒で resolved`);
      break;
    }
  }
  if (confAfter.exists) {
    const c = confAfter.data();
    if (c.resolved === true) pass(`bookingConflicts/${confId}.resolved: true`);
    else fail(`  resolved=${c.resolved} (期待: true)`);
    if (c.resolvedAt) pass(`  resolvedAt セット済み`);
    else fail(`  resolvedAt 未セット`);
  } else {
    fail(`bookingConflicts/${confId} 消失`);
  }

  const docB2 = await refB.get();
  const idsB2 = docB2.data().conflictWithIds || [];
  if (!idsB2.includes(refA.id)) pass(`booking B.conflictWithIds から A が除去された (現在: ${JSON.stringify(idsB2)})`);
  else fail(`booking B.conflictWithIds に A がまだ残存 (現在: ${JSON.stringify(idsB2)})`);

  // Step 5: クリーンアップ
  console.log("\n[Step 5] クリーンアップ");
  await refA.delete();
  await refB.delete();
  console.log(`  bookings A/B 削除完了`);
  // キャンセル化で生成された shift/recruitment はもう存在しないはずだが念のため
  if (confAfter.exists) {
    await confAfter.ref.delete();
    console.log(`  bookingConflicts/${confId} 削除完了`);
  }

  console.log(`\n=== 結果: ${hadFail ? "❌ 失敗あり" : "✅ 全 OK"} ===`);
  process.exit(hadFail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
