#!/usr/bin/env node
// 既存全 staff に googleCalendarToken を埋め込む (Google カレンダー連携 iCal URL 用)
// 既に token がある staff はスキップ
const admin = require("firebase-admin");
const crypto = require("crypto");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const isExecute = process.argv.includes("--execute");
console.log(`mode: ${isExecute ? "EXECUTE" : "DRY-RUN (実行は --execute)"}`);

function genToken() {
  return crypto.randomBytes(32).toString("hex"); // 64 文字
}

(async () => {
  const snap = await db.collection("staff").get();
  console.log(`staff: ${snap.size} 件`);
  let updated = 0, skipped = 0;
  for (const d of snap.docs) {
    const data = d.data();
    if (data.googleCalendarToken) {
      console.log(`  [skip] ${data.name || d.id}: 既に token あり`);
      skipped++;
      continue;
    }
    const token = genToken();
    console.log(`  [add ] ${data.name || d.id}: token=${token.slice(0, 12)}...`);
    if (isExecute) {
      await d.ref.update({
        googleCalendarToken: token,
        googleCalendarEnabled: false, // 初期は OFF (スタッフ自身が UI から ON にする)
      });
    }
    updated++;
  }
  console.log(`\n=== 更新: ${updated}件 / skip: ${skipped}件 ${isExecute ? "" : "(dry-run)"} ===`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
