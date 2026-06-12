/**
 * 既存シフトの workType 未設定を補完するマイグレーションスクリプト
 * workType が未設定のシフトを "cleaning_by_count" で batch 更新する
 *
 * 実行方法 (手動):
 *   node functions/migration/fix-shifts-worktype.js
 */
const admin = require("firebase-admin");
const serviceAccount = require("../serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: "minpaku-v2",
});

const db = admin.firestore();

async function main() {
  console.log("workType 未設定シフトの補完を開始します...");

  // workType が存在しないドキュメントを取得
  // Firestore では "フィールドなし" クエリが直接できないため全件取得してフィルタ
  const snap = await db.collection("shifts").get();
  const targets = snap.docs.filter(d => !d.data().workType);

  console.log(`対象シフト数: ${targets.length} 件`);

  if (targets.length === 0) {
    console.log("補完対象なし。終了します。");
    process.exit(0);
  }

  // バッチ書き込み (500件/バッチ制限対応)
  const BATCH_SIZE = 400;
  let processed = 0;

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = targets.slice(i, i + BATCH_SIZE);
    chunk.forEach(d => {
      batch.update(d.ref, {
        workType: "cleaning_by_count",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
    processed += chunk.length;
    console.log(`  ${processed}/${targets.length} 件完了`);
  }

  console.log(`補完完了: ${processed} 件を cleaning_by_count に設定しました`);
  process.exit(0);
}

main().catch(e => {
  console.error("エラー:", e);
  process.exit(1);
});
