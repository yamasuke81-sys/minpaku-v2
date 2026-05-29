/**
 * メール照合機能の修復: properties.ownerId をメインオーナー (ziTig6tefnj5NvkgN4fG) に統一する。
 *
 * 背景:
 *   gmailOAuthEmailVerification/tokens の ownerId は ziTig6tefnj5NvkgN4fG だが、
 *   properties.ownerId はサブオーナー (JJTNFEJtPq0iAnyErlzv 等) になっており、
 *   emailVerificationCore 内の `t.ownerId === tokenOwnerId` フィルタで一致せず巡回0件で終わっていた。
 *
 * 修正方針 (やますけ確認済 / 親エージェント指示):
 *   現状単一オーナー前提のため、active=true の物件すべての ownerId を
 *   メインオーナー (ziTig6tefnj5NvkgN4fG) に上書きする。
 *
 * 実行: cd functions && node migration/fix-property-owner-for-email-verification.js
 */
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const MAIN_OWNER_ID = "ziTig6tefnj5NvkgN4fG";

async function main() {
  const snap = await db.collection("properties").where("active", "==", true).get();
  console.log(`active=true 物件: ${snap.size}`);
  let updated = 0, skipped = 0;
  for (const d of snap.docs) {
    const p = d.data();
    if (p.ownerId === MAIN_OWNER_ID) {
      console.log(`  [skip] ${p.name} (${d.id}) 既に正しい ownerId`);
      skipped++;
      continue;
    }
    console.log(`  [update] ${p.name} (${d.id}) ownerId: ${p.ownerId || "(none)"} → ${MAIN_OWNER_ID}`);
    await d.ref.update({
      ownerId: MAIN_OWNER_ID,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    updated++;
  }
  console.log(`\n=== 結果 ===`);
  console.log(`更新: ${updated} / スキップ: ${skipped} / 合計: ${snap.size}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
