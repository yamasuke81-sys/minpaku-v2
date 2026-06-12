#!/usr/bin/env node
// settings/notifications.timee_posting のテンプレを Dispatch 対応版に更新
//
// 使い方:
//   node functions/migration/update-timee-notification-template.js          # dry-run (現状確認)
//   node functions/migration/update-timee-notification-template.js --execute
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const isExecute = process.argv.includes("--execute");
console.log(`mode: ${isExecute ? "EXECUTE" : "DRY-RUN"}`);

// 新テンプレ (onBookingChange.js の本文と同期。{var} は notifyByKey の vars から置換)
const NEW_TEMPLATE = {
  title: "タイミー募集依頼: {date} {property}",
  body: [
    "🕐 タイミー募集依頼",
    "",
    "チェックアウト: {date}",
    "物件: {property}",
    "ゲスト: {guest}（{site}）",
    "",
    "▼ PC Chrome でタップ → 自動入力 → 「求人を作成」",
    "",
    "▶ グループ限定で募集を作成",
    "{urlGroup}",
    "",
    "▶ 初回ワーカー限定で募集を作成",
    "{urlNewWorker}",
    "",
    "▼ スマホ完結 (Dispatch コピペ用)",
    "/timee-post {bookingId} group_limited",
    "/timee-post {bookingId} new_worker_for_client_limited",
  ].join("\n"),
};

(async () => {
  const ref = db.collection("settings").doc("notifications");
  const snap = await ref.get();
  const data = snap.exists ? snap.data() || {} : {};
  const cur = data.timee_posting || {};
  console.log("\n--- 現状の timee_posting テンプレ ---");
  console.log(JSON.stringify(cur, null, 2));
  console.log("--- ここまで ---\n");

  console.log("\n--- 新テンプレ ---");
  console.log(JSON.stringify(NEW_TEMPLATE, null, 2));
  console.log("--- ここまで ---\n");

  if (!isExecute) {
    console.log("dry-run のためここで終了。--execute で反映。");
    process.exit(0);
  }

  await ref.set({
    timee_posting: {
      ...cur,
      title: NEW_TEMPLATE.title,
      body: NEW_TEMPLATE.body,
      customMessage: NEW_TEMPLATE.body, // customMessage キーで保存されるパターンも考慮
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  }, { merge: true });
  console.log("✅ 更新完了");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
