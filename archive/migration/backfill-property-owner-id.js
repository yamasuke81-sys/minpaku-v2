/**
 * properties.ownerId 既存データ補完スクリプト
 * 実行: cd functions && node migration/backfill-property-owner-id.js
 *
 * 処理:
 *   1. staff 全件取得 → メインオーナー (isOwner=true) と サブオーナー (isSubOwner=true) を抽出
 *   2. properties 全件をループ
 *   3. ownerId 未設定の物件のみ対象:
 *      - isSubOwner かつ ownedPropertyIds に当物件 ID が含まれる staff があれば、その staffId を ownerId に設定
 *      - なければメインオーナーの staffId を設定
 *   4. 既に ownerId が設定済みの物件はスキップ
 *
 * サブオーナー対応の前提:
 *   - メール照合・送信元 Gmail 等のスコープ限定で「物件 → オーナー」の逆引きに使用
 *   - staff.ownedPropertyIds[] とは独立した正規化フィールド (双方向で持つ)
 */
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

async function main() {
  console.log("[backfill-property-owner-id] staff 全件取得中...");
  const staffSnap = await db.collection("staff").get();
  const allStaff = staffSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const mainOwner = allStaff.find((s) => s.isOwner === true);
  if (!mainOwner) {
    console.error("[ERROR] isOwner=true のメインオーナーが見つかりません。中断。");
    process.exit(1);
  }
  console.log(`[backfill] メインオーナー: ${mainOwner.name} (${mainOwner.id})`);

  const subOwners = allStaff.filter((s) => s.isSubOwner === true);
  console.log(`[backfill] サブオーナー: ${subOwners.length} 件`);
  for (const so of subOwners) {
    const owned = Array.isArray(so.ownedPropertyIds) ? so.ownedPropertyIds : [];
    console.log(`  - ${so.name} (${so.id}): ${owned.length} 物件`);
  }

  console.log("[backfill] properties 全件取得中...");
  const propsSnap = await db.collection("properties").get();
  const props = propsSnap.docs;
  console.log(`[backfill] 総数: ${props.length}`);

  let assignedToSub = 0;
  let assignedToMain = 0;
  let skipped = 0;

  for (const pDoc of props) {
    const p = pDoc.data();
    if (p.ownerId) {
      skipped++;
      continue;
    }

    const subOwner = subOwners.find((so) =>
      Array.isArray(so.ownedPropertyIds) && so.ownedPropertyIds.includes(pDoc.id)
    );

    let ownerId;
    if (subOwner) {
      ownerId = subOwner.id;
      assignedToSub++;
      console.log(`  [sub] ${p.name} (${pDoc.id}) → ${subOwner.name}`);
    } else {
      ownerId = mainOwner.id;
      assignedToMain++;
      console.log(`  [main] ${p.name} (${pDoc.id}) → ${mainOwner.name}`);
    }

    await pDoc.ref.update({
      ownerId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  console.log("\n=== 結果 ===");
  console.log(`総数:          ${props.length}`);
  console.log(`スキップ (既設): ${skipped}`);
  console.log(`サブオーナー割当: ${assignedToSub}`);
  console.log(`メインオーナー割当: ${assignedToMain}`);
  console.log("[backfill-property-owner-id] 完了");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[ERROR]", e);
    process.exit(1);
  });
