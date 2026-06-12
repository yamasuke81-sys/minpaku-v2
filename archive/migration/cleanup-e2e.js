// E2Eテストデータ一括削除スクリプト
// 使い方:
//   node migration/cleanup-e2e.js --dry-run
//   node migration/cleanup-e2e.js --execute
//
// 対象コレクション: _e2eTest=true フラグを持つ全ドキュメント
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const COLLECTIONS = [
  "staff",
  "recruitments",
  "shifts",
  "bookings",
  "guestRegistrations",
  "laundry",
  "invoices",
  "checklists",
  "bookingConflicts",
  "properties", // テスト物件作成する場合あり
];

const DRY = !process.argv.includes("--execute");

(async () => {
  console.log(`[cleanup-e2e] mode=${DRY ? "DRY-RUN" : "EXECUTE"}`);
  let total = 0;
  for (const col of COLLECTIONS) {
    const snap = await db.collection(col).where("_e2eTest", "==", true).get();
    if (snap.empty) {
      console.log(`  ${col}: 0件`);
      continue;
    }
    console.log(`  ${col}: ${snap.size}件`);
    total += snap.size;
    for (const d of snap.docs) {
      const label = d.data()._createdBy || "(no-createdBy)";
      console.log(`    - ${d.id} [${label}]`);
      if (!DRY) await d.ref.delete();
    }
  }
  console.log(`[cleanup-e2e] 合計 ${total}件 ${DRY ? "(dry-run: 削除未実行)" : "削除完了"}`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
