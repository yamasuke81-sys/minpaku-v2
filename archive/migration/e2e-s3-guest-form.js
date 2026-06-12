// E2E Scenario 3: ゲストフォーム送信フロー
//
// 検証:
//   1. guestRegistrations に source=guest_form のドキュメントを投入
//   2. onGuestFormSubmit トリガー発火確認:
//      - editToken / editTokenExpiresAt 付与
//      - status = "submitted"
//   3. GET /api/guest-edit/:token で正常データ取得 (200)
//   4. editTokenExpiresAt を過去日にして再度 GET → 410 Gone
//   5. クリーンアップ

const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

const PID = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜
const TAG = { _e2eTest: true, _createdBy: "e2e-session-20260419-s3" };
const API_BASE = "https://minpaku-v2.web.app/api";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pass = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => { console.log(`  ❌ ${msg}`); hadFail = true; };
let hadFail = false;

(async () => {
  console.log("=== Scenario 3: ゲストフォーム送信フロー ===");

  // Step 1: guestRegistrations に投入
  console.log("\n[Step 1] guestRegistrations に投入");
  const guestRef = db.collection("guestRegistrations").doc();
  await guestRef.set({
    guestName: "E2E-S3テストゲスト",
    nationality: "日本",
    address: "東京都",
    phone: "000-0000-0000",
    email: "e2e-s3@example.invalid",
    checkIn: "2026-09-10",
    checkOut: "2026-09-12",
    guestCount: 2,
    propertyId: PID,
    propertyName: "the Terrace 長浜",
    source: "guest_form",
    status: "pending",
    createdAt: new Date(),
    ...TAG,
  });
  console.log(`  guestId: ${guestRef.id}`);

  // Step 2: トリガー発火待機 (editToken 付与)
  console.log("\n[Step 2] editToken 付与を polling (最大 40秒)...");
  let finalData;
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    finalData = (await guestRef.get()).data();
    if (finalData.editToken && finalData.status === "submitted") {
      console.log(`  ✓ ${(i + 1) * 2}秒で付与`);
      break;
    }
  }
  const token = finalData.editToken;
  if (token && token.length >= 32) pass(`editToken 付与 (${token.length} 文字)`);
  else fail(`editToken 未付与または不正: ${token}`);
  if (finalData.editTokenExpiresAt) pass(`editTokenExpiresAt セット済み`);
  else fail(`editTokenExpiresAt 未セット`);
  if (finalData.status === "submitted") pass(`status = submitted`);
  else fail(`status = ${finalData.status} (期待: submitted)`);

  if (!token) {
    console.log("  トークン未付与のためクリーンアップして終了");
    await guestRef.delete();
    process.exit(1);
  }

  // Step 3: GET /api/guest-edit/:token で正常データ取得
  console.log("\n[Step 3] GET /api/guest-edit/:token (正常系)");
  const res1 = await fetch(`${API_BASE}/guest-edit/${token}`);
  if (res1.status === 200) {
    pass(`GET 200 OK`);
    const body = await res1.json();
    if (body.guestName === "E2E-S3テストゲスト") pass(`  body.guestName 一致`);
    else fail(`  body.guestName=${body.guestName}`);
    if (!body.editToken) pass(`  editToken はレスポンスに含まれない (安全)`);
    else fail(`  editToken がレスポンスに漏洩: ${body.editToken}`);
  } else {
    fail(`GET status=${res1.status} (期待: 200)`);
    const text = await res1.text();
    console.log(`  body: ${text.substring(0, 200)}`);
  }

  // Step 4: editTokenExpiresAt を過去日にして 410 Gone 確認
  console.log("\n[Step 4] editTokenExpiresAt を過去日に → 410 Gone");
  const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await guestRef.update({
    editTokenExpiresAt: admin.firestore.Timestamp.fromDate(pastDate),
  });
  await sleep(1000); // Firestore 一貫性待ち
  const res2 = await fetch(`${API_BASE}/guest-edit/${token}`);
  if (res2.status === 410) pass(`GET 410 Gone`);
  else fail(`GET status=${res2.status} (期待: 410)`);

  // Step 5: クリーンアップ
  console.log("\n[Step 5] クリーンアップ");
  await guestRef.delete();
  // 名簿 trigger で bookings 側の補完が入っていたら復元は困難だが、
  // このテストの checkIn が架空なので該当 booking がないはず
  console.log("  guestRegistration 削除完了");

  console.log(`\n=== 結果: ${hadFail ? "❌ 失敗あり" : "✅ 全 OK"} ===`);
  process.exit(hadFail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
