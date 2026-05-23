/**
 * checklistTemplates 移行スクリプト
 *
 * 既存の `checklistTemplates/{propertyId}` を `checklistTemplates/{propertyId}_cleaning` へコピーし、
 * 元ドキュメントを削除する。
 *
 * 冪等性:
 *   - {propertyId}_cleaning が既に存在する物件はスキップ
 *   - ドキュメントIDに既に "_cleaning" または "_pre_inspection" を含むものは対象外
 *
 * 実行方法:
 *   cd C:/Users/yamas/AI_Workspace/minpaku-v2/functions
 *   DRY_RUN=1 node scripts/migrateChecklistTemplatesByWorkType.js   # ドライラン
 *   node scripts/migrateChecklistTemplatesByWorkType.js              # 本番
 */

const admin = require("firebase-admin");

const PROJECT_ID = "minpaku-v2";
const DRY_RUN = process.env.DRY_RUN === "1";

admin.initializeApp({
  projectId: PROJECT_ID,
  credential: admin.credential.applicationDefault()
});
const db = admin.firestore();

async function main() {
  console.log("=== checklistTemplates workType別移行スクリプト ===");
  console.log("プロジェクト:", PROJECT_ID);
  if (DRY_RUN) console.log("※ DRY_RUN モード（書き込みなし）");

  const snapshot = await db.collection("checklistTemplates").get();
  console.log(`取得ドキュメント数: ${snapshot.size}`);

  let skipped = 0;
  let migrated = 0;
  let alreadyDone = 0;

  for (const doc of snapshot.docs) {
    const docId = doc.id;

    // すでに "_cleaning" or "_pre_inspection" サフィックスがあるものは対象外
    if (docId.endsWith("_cleaning") || docId.endsWith("_pre_inspection")) {
      console.log(`[スキップ] 既にサフィックス付き: ${docId}`);
      alreadyDone++;
      continue;
    }

    const data = doc.data();
    const fieldPropertyId = data.propertyId;

    // 安全性: ドキュメントIDと propertyId フィールドが不一致なら孤児データの可能性が高いため移行しない
    if (fieldPropertyId && fieldPropertyId !== docId) {
      console.log(`[スキップ] ドキュメントID(${docId}) と propertyId(${fieldPropertyId}) が不一致のため対象外（孤児データ疑い）`);
      skipped++;
      continue;
    }

    // properties コレクションに対応する物件が存在し active であることを確認
    const propDoc = await db.collection("properties").doc(docId).get();
    if (!propDoc.exists) {
      console.log(`[スキップ] 対応 properties/${docId} が存在しないため対象外`);
      skipped++;
      continue;
    }

    const propertyId = docId;
    const newDocId = `${propertyId}_cleaning`;

    // コピー先が既存の場合はスキップ（冪等）
    const destRef = db.collection("checklistTemplates").doc(newDocId);
    const destDoc = await destRef.get();
    if (destDoc.exists) {
      console.log(`[スキップ] コピー先が既に存在: ${propertyId} → ${newDocId}`);
      skipped++;
      continue;
    }

    console.log(`[移行] ${propertyId} → ${newDocId}  (物件名: ${propDoc.data().name || "(no name)"})`);

    if (!DRY_RUN) {
      // コピー先に書き込み（workType フィールドも追加）
      await destRef.set({
        ...data,
        workType: "cleaning",
        migratedFrom: propertyId,
        migratedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      // 元ドキュメント削除
      await db.collection("checklistTemplates").doc(propertyId).delete();
      console.log(`  ✓ 移行完了・元ドキュメント削除`);
    } else {
      console.log(`  (DRY_RUN) 書き込みスキップ`);
    }
    migrated++;
  }

  console.log("\n=== 完了 ===");
  console.log(`移行: ${migrated}件 / スキップ(既存コピー先): ${skipped}件 / 対象外(サフィックス付き): ${alreadyDone}件`);
  if (DRY_RUN) console.log("※ DRY_RUN のため実際の変更はありません");
}

main().catch(e => {
  console.error("移行スクリプトエラー:", e);
  process.exit(1);
});
