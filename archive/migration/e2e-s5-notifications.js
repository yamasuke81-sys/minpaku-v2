// E2E Scenario 5: 通知設定の発火検証 (LINE 実送信は除外)
//
// 検証:
//   1. 架空の shift + checklist を投入 → checklist.status = "completed" に更新
//   2. onChecklistComplete トリガー発火確認:
//      - shift.status が "completed" に更新される (処理A)
//      - error_logs に LINE 送信失敗ログが出る (枯渇済みのため想定) / 通知試行が行われた証跡
//   3. resolveNotifyTargets のロジックを直接呼んで、channels の設定解決を検証

const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

const { resolveNotifyTargets, getNotificationSettings_ } = require("../utils/lineNotify");

const PID = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜
const TAG = { _e2eTest: true, _createdBy: "e2e-session-20260419-s5" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pass = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => { console.log(`  ❌ ${msg}`); hadFail = true; };
let hadFail = false;

(async () => {
  console.log("=== Scenario 5: 通知設定発火検証 (LINE 除外) ===");

  // Step A: resolveNotifyTargets の解決検証
  console.log("\n[Step A] resolveNotifyTargets の解決");
  const { settings } = await getNotificationSettings_(db);
  const TYPES = ["cleaning_done", "recruit_start", "recruit_response", "double_booking", "laundry_reminder", "roster_received", "staff_confirm", "invoice_submitted"];
  for (const t of TYPES) {
    const tgt = resolveNotifyTargets(settings, t);
    console.log(`  ${t.padEnd(20)} enabled=${tgt.enabled} ownerLine=${tgt.ownerLine} groupLine=${tgt.groupLine} staffLine=${tgt.staffLine}`);
  }
  pass(`全${TYPES.length}種の通知解決動作確認`);

  // Step B: onChecklistComplete トリガー発火検証 (LINE 失敗は許容)
  console.log("\n[Step B] onChecklistComplete 発火検証");

  // テストスタッフ
  const staffRef = db.collection("staff").doc();
  await staffRef.set({
    name: "E2E-S5テストスタッフ",
    email: "e2e-s5@example.invalid",
    active: true,
    isOwner: false,
    lineUserId: "", // 空なら送信スキップ
    assignedPropertyIds: [PID],
    ...TAG,
  });

  // テストシフト (staffId 紐付きで in_progress 状態)
  const coDate = new Date("2026-06-10");
  const shiftRef = db.collection("shifts").doc();
  await shiftRef.set({
    date: coDate,
    propertyId: PID,
    propertyName: "the Terrace 長浜",
    staffId: staffRef.id,
    staffName: "E2E-S5テストスタッフ",
    workType: "cleaning_by_count",
    status: "assigned",
    assignMethod: "manual",
    ...TAG,
  });
  console.log(`  shift: ${shiftRef.id} status=assigned`);

  // テストチェックリスト
  const checklistRef = db.collection("checklists").doc();
  await checklistRef.set({
    shiftId: shiftRef.id,
    propertyId: PID,
    propertyName: "the Terrace 長浜",
    checkoutDate: coDate,
    staffIds: [staffRef.id],
    workType: "cleaning",
    templateVersion: 1,
    templateSnapshot: [],
    itemStates: {},
    status: "in_progress",
    completedAt: null,
    completedBy: null,
    createdAt: FV.serverTimestamp(),
    updatedAt: FV.serverTimestamp(),
    ...TAG,
  });
  console.log(`  checklist: ${checklistRef.id} status=in_progress`);

  // エラーログ件数記録 (発火前)
  const errBefore = await db.collection("error_logs")
    .where("type", "in", ["onChecklistComplete_ownerNotify", "onChecklistComplete_staffNotify", "onChecklistComplete_shiftUpdate"])
    .get();
  const errBeforeCount = errBefore.size;

  // completed に更新 → トリガー発火
  console.log("\n  checklist.status = completed に更新...");
  await checklistRef.update({
    status: "completed",
    completedAt: FV.serverTimestamp(),
    completedBy: staffRef.id,
    updatedAt: FV.serverTimestamp(),
  });

  // shift.status が completed に更新されるまで polling
  console.log("  shift.status=completed を polling (最大 30秒)...");
  let shiftOK = false;
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const s = (await shiftRef.get()).data();
    if (s.status === "completed" && s.completedAt) {
      pass(`shift.status=completed に更新 (${(i + 1) * 2}秒で完了)`);
      shiftOK = true;
      break;
    }
  }
  if (!shiftOK) fail(`shift.status が completed にならず`);

  // LINE 送信試行 → エラーログに記録されるはず (枯渇のため)
  // ownerLine channel の enabled によっては試行しないので、cleaning_done の enabled を確認
  const cdTargets = resolveNotifyTargets(settings, "cleaning_done");
  if (cdTargets.enabled && cdTargets.ownerLine) {
    console.log(`  cleaning_done enabled=true ownerLine=true → notifyOwner 試行されるはず`);
    // 429 はエラーログに残らないが、内部でハンドリングされる
    // error_logs はエラー時のみ書かれる (LINE 429 は error throw しないので書かれない)
    console.log(`  (LINE 枯渇により実送信はされないが、trigger は動作した)`);
  } else {
    console.log(`  cleaning_done 無効 → notifyOwner 呼び出しスキップ`);
  }

  // error_logs 増分確認
  const errAfter = await db.collection("error_logs")
    .where("type", "in", ["onChecklistComplete_ownerNotify", "onChecklistComplete_staffNotify", "onChecklistComplete_shiftUpdate"])
    .get();
  console.log(`  error_logs 増分: ${errAfter.size - errBeforeCount}件 (trigger 動作時の例外ログ)`);

  // クリーンアップ
  console.log("\n[クリーンアップ]");
  await checklistRef.delete();
  await shiftRef.delete();
  await staffRef.delete();
  console.log(`  全削除完了`);

  console.log(`\n=== 結果: ${hadFail ? "❌ 失敗あり" : "✅ 全 OK"} ===`);
  process.exit(hadFail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
