#!/usr/bin/env node
// properties/{id}.channelOverrides.timee_posting.customMessage を Dispatch 対応版に更新
//
// 使い方:
//   node functions/migration/update-property-timee-template.js          # dry-run
//   node functions/migration/update-property-timee-template.js --execute
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const isExecute = process.argv.includes("--execute");
console.log(`mode: ${isExecute ? "EXECUTE" : "DRY-RUN"}`);

// 新テンプレ (notifyByKey 内で {var} → vars[var] に置換される)
// 利用可能変数: date / property / guest / site / url / urlGroup / urlNewWorker / bookingId
const NEW_CUSTOM_MESSAGE = [
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
].join("\n");

(async () => {
  const snap = await db.collection("properties").where("active", "==", true).get();
  let touched = 0;
  for (const doc of snap.docs) {
    const p = doc.data() || {};
    const ov = p.channelOverrides || {};
    const cur = ov.timee_posting || {};
    console.log(`\n→ ${doc.id} : ${p.name || ""}`);
    console.log(`  current customMessage: ${cur.customMessage ? cur.customMessage.slice(0, 80) + "..." : "(なし)"}`);
    console.log(`  enabled: ${cur.enabled}`);
    if (!isExecute) continue;
    await doc.ref.update({
      [`channelOverrides.timee_posting.customMessage`]: NEW_CUSTOM_MESSAGE,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    touched++;
  }
  console.log(`\n結果: ${isExecute ? `更新 ${touched} 件` : "dry-run のみ"}`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
