/**
 * propertyId が空の recruitment にデフォルト物件を付与
 * デフォルト: the Terrace長浜 (tsZybhDMcPrxqgcRy7wp)
 *
 * 実行方法:
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json node functions/migration/fix-orphan-recruitment-propertyid.js
 * または firebase CLI 認証済みなら:
 *   node functions/migration/fix-orphan-recruitment-propertyid.js
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

// CLAUDE.md 記載のデフォルト物件
const DEFAULT_PROPERTY_ID = "tsZybhDMcPrxqgcRy7wp";
const DEFAULT_PROPERTY_NAME = "the Terrace長浜";

(async () => {
  const snap = await db.collection("recruitments").get();
  let fixed = 0;
  let skipped = 0;

  const batch = db.batch();

  for (const doc of snap.docs) {
    const d = doc.data();
    // propertyId が空・未設定のドキュメントだけ対象
    if (d.propertyId && String(d.propertyId).trim() !== "") {
      skipped++;
      continue;
    }

    console.log(`[fix] ${doc.id} checkoutDate=${d.checkoutDate} status=${d.status}`);
    batch.update(doc.ref, {
      propertyId: DEFAULT_PROPERTY_ID,
      propertyName: DEFAULT_PROPERTY_NAME,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    fixed++;

    // バッチ上限 (500件) に達したらコミット
    if (fixed % 400 === 0) {
      await batch.commit();
      console.log(`[info] ${fixed}件コミット済み`);
    }
  }

  if (fixed % 400 !== 0) {
    await batch.commit();
  }

  console.log(`\n完了: ${fixed}件を修正, ${skipped}件をスキップ（propertyId 設定済み）`);
  process.exit(0);
})().catch(e => {
  console.error("エラー:", e);
  process.exit(1);
});
