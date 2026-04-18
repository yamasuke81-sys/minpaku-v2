/**
 * 壊れた宿泊者データ削除スクリプト
 *
 * 対象: guestRegistrations コレクションのうち
 *   - source == "gas_form_sync"
 *   - createdAt >= 2026-04-18T00:00:00+09:00
 *
 * 使い方:
 *   node functions/migration/delete-broken-guest-imports.js           # dry-run (デフォルト)
 *   node functions/migration/delete-broken-guest-imports.js --execute # 実際に削除
 *
 * 認証方法 (いずれか):
 *   1. serviceAccountKey.json を functions/migration/ に置く
 *   2. 環境変数 GOOGLE_APPLICATION_CREDENTIALS にパスを設定する
 */

const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");

// 削除実行フラグ: --execute を渡した時のみ true
const EXECUTE = process.argv.includes("--execute");
const BATCH_SIZE = 500;

// プロジェクトID
const PROJECT_ID = "minpaku-v2";

// 対象日時: 2026-04-18 00:00:00 JST (= 2026-04-17 15:00:00 UTC)
const CUTOFF_DATE = new Date("2026-04-17T15:00:00.000Z");

// ===== Firebase Admin 初期化 =====
function initAdmin() {
  const keyPath = path.join(__dirname, "serviceAccountKey.json");
  if (fs.existsSync(keyPath)) {
    const serviceAccount = require(keyPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: PROJECT_ID,
    });
    console.log("認証: serviceAccountKey.json を使用");
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({
      projectId: PROJECT_ID,
    });
    console.log("認証: GOOGLE_APPLICATION_CREDENTIALS 環境変数を使用");
  } else {
    console.error(
      "エラー: 認証情報が見つかりません。\n" +
      "  1. serviceAccountKey.json を functions/migration/ に置く\n" +
      "  2. または GOOGLE_APPLICATION_CREDENTIALS 環境変数を設定する"
    );
    process.exit(1);
  }
}

// ===== メイン処理 =====
async function main() {
  initAdmin();
  const db = admin.firestore();

  console.log("=".repeat(60));
  console.log("壊れた宿泊者データ削除スクリプト");
  console.log("=".repeat(60));
  console.log(`モード: ${EXECUTE ? "【実行】実際に削除します" : "【dry-run】削除はしません"}`);
  console.log(`対象条件:`);
  console.log(`  - source == "gas_form_sync"`);
  console.log(`  - createdAt >= 2026-04-18 00:00:00 JST`);
  console.log("");

  // 対象ドキュメントを検索
  const snap = await db.collection("guestRegistrations")
    .where("source", "==", "gas_form_sync")
    .where("createdAt", ">=", CUTOFF_DATE)
    .get();

  const total = snap.size;
  console.log(`対象ドキュメント数: ${total} 件`);

  if (total === 0) {
    console.log("削除対象なし。終了します。");
    process.exit(0);
  }

  // ドキュメント一覧を表示（最大20件）
  console.log("\n--- 対象ドキュメント一覧 (最大20件表示) ---");
  snap.docs.slice(0, 20).forEach((doc, i) => {
    const d = doc.data();
    const createdAt = d.createdAt instanceof Date
      ? d.createdAt.toISOString()
      : d.createdAt?.toDate?.()?.toISOString?.() || "(不明)";
    console.log(`  ${i + 1}. id=${doc.id} | guestName=${d.guestName || "(空)"} | createdAt=${createdAt}`);
  });
  if (total > 20) {
    console.log(`  ... 他 ${total - 20} 件`);
  }

  if (!EXECUTE) {
    console.log("\n[dry-run] 削除は実行されていません。");
    console.log("実際に削除するには --execute オプションを付けて実行してください:");
    console.log("  node functions/migration/delete-broken-guest-imports.js --execute");
    process.exit(0);
  }

  // 実際に削除
  console.log(`\n削除を開始します (${total} 件, ${Math.ceil(total / BATCH_SIZE)} バッチ)...`);
  let deleted = 0;
  const docs = snap.docs;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = docs.slice(i, i + BATCH_SIZE);
    chunk.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += chunk.length;
    console.log(`  削除済み: ${deleted} / ${total} 件`);
  }

  console.log(`\n完了: ${deleted} 件を削除しました。`);
  process.exit(0);
}

main().catch((e) => {
  console.error("予期しないエラー:", e);
  process.exit(1);
});
