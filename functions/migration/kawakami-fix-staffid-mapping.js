/**
 * staffId バックフィル: auth uid → staff doc ID に書き換え
 *
 * shifts / laundry / invoices コレクションで staffId が auth uid になっている
 * ドキュメントを staff doc ID に修正する。
 *
 * 使い方:
 *   node kawakami-fix-staffid-mapping.js --dry-run   # 変更対象を確認のみ
 *   node kawakami-fix-staffid-mapping.js --execute   # 実際に書き換え
 */
const admin = require("firebase-admin");

admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const args = process.argv.slice(2);
const isDryRun = !args.includes("--execute");

async function main() {
  console.log(`[mode] ${isDryRun ? "DRY-RUN (変更なし)" : "EXECUTE (実際に書き換え)"}`);

  // --- step1: staff コレクションから authUid → docId マップ構築 ---
  const staffSnap = await db.collection("staff").get();
  const uidToDocId = {}; // authUid → staff doc ID
  const docIdSet = new Set(); // 正規 staff doc ID の集合

  staffSnap.forEach(doc => {
    const data = doc.data();
    docIdSet.add(doc.id);
    if (data.authUid) {
      uidToDocId[data.authUid] = doc.id;
    }
  });

  console.log(`staff ドキュメント数: ${staffSnap.size}, authUid マップ: ${Object.keys(uidToDocId).length} 件`);

  // --- step2: 各コレクションをスキャン ---
  const collections = ["shifts", "laundry", "invoices"];
  let totalFixed = 0;
  let totalSkipped = 0;

  for (const colName of collections) {
    const snap = await db.collection(colName).get();
    console.log(`\n[${colName}] ドキュメント数: ${snap.size}`);

    let fixed = 0;
    let skipped = 0;

    for (const doc of snap.docs) {
      const data = doc.data();
      const currentStaffId = data.staffId;

      if (!currentStaffId) {
        skipped++;
        continue;
      }

      // すでに正規 doc ID なら skip
      if (docIdSet.has(currentStaffId)) {
        skipped++;
        continue;
      }

      // auth uid → doc ID に変換できるか確認
      const correctDocId = uidToDocId[currentStaffId];
      if (!correctDocId) {
        console.warn(`  [skip] ${colName}/${doc.id}: staffId="${currentStaffId}" は staff コレクションに存在しない`);
        skipped++;
        continue;
      }

      console.log(`  [fix] ${colName}/${doc.id}: staffId "${currentStaffId}" → "${correctDocId}"`);
      fixed++;

      if (!isDryRun) {
        await doc.ref.update({
          staffId: correctDocId,
          _staffIdFixed: true,
          _staffIdFixedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    console.log(`  → 修正: ${fixed} 件 / スキップ: ${skipped} 件`);
    totalFixed += fixed;
    totalSkipped += skipped;
  }

  console.log(`\n===== 結果 =====`);
  console.log(`修正対象: ${totalFixed} 件`);
  console.log(`スキップ: ${totalSkipped} 件`);
  if (isDryRun) {
    console.log(`\n--execute オプションを付けて実行すると実際に書き換えます`);
  } else {
    console.log(`\nバックフィル完了`);
  }

  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
