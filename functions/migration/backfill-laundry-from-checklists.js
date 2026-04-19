/**
 * 既存チェックリストから laundry コレクションへバックフィル
 *
 * checklists.laundry.putOut がセット済みで、laundry コレクションに
 * sourceChecklistId 一致するドキュメントが存在しないものを同期する。
 *
 * 使用方法:
 *   DRY-RUN (デフォルト):
 *     node functions/migration/backfill-laundry-from-checklists.js
 *
 *   実行:
 *     node functions/migration/backfill-laundry-from-checklists.js --execute
 */

const admin = require("firebase-admin");
const path = require("path");

// サービスアカウントキーのパス (環境変数 GOOGLE_APPLICATION_CREDENTIALS 推奨)
if (!admin.apps.length) {
  const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    || path.join(__dirname, "../../serviceAccountKey.json");
  try {
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } catch (_) {
    // Application Default Credentials を使用 (既存 inspect スクリプトと同パターン)
    admin.initializeApp({
      projectId: "minpaku-v2",
      credential: admin.credential.applicationDefault(),
    });
  }
}

const db = admin.firestore();
const isDryRun = !process.argv.includes("--execute");

function isLaundrySet(v) {
  if (v == null) return false;
  if (typeof v === "object") {
    if (v.at) return true;
    if (typeof v.toDate === "function") return true;
    if (v.seconds != null) return true;
  }
  return !!v;
}

async function run() {
  console.log(`[backfill-laundry] モード: ${isDryRun ? "DRY-RUN (--execute で実行)" : "EXECUTE"}`);

  // laundry コレクションの既存 sourceChecklistId をインデックス化
  console.log("[backfill-laundry] laundry コレクションを読み込み中...");
  const existingSnap = await db.collection("laundry")
    .where("sourceField", "==", "putOut")
    .get();
  const existingIds = new Set(existingSnap.docs.map(d => d.data().sourceChecklistId).filter(Boolean));
  console.log(`[backfill-laundry] 既存 laundry ドキュメント (sourceField=putOut): ${existingSnap.docs.length} 件`);

  // checklists を全件スキャン
  console.log("[backfill-laundry] checklists を全件スキャン中...");
  const checklistsSnap = await db.collection("checklists").get();
  console.log(`[backfill-laundry] checklists 総数: ${checklistsSnap.docs.length} 件`);

  let targetCount = 0;
  let skippedCount = 0;
  let createdCount = 0;
  let errorCount = 0;

  for (const doc of checklistsSnap.docs) {
    const data = doc.data();
    const laundry = data.laundry || {};
    const putOut = laundry.putOut;

    if (!isLaundrySet(putOut) || putOut == null || typeof putOut !== "object") {
      // putOut が未設定 → スキップ
      continue;
    }

    targetCount++;
    const checklistId = doc.id;

    if (existingIds.has(checklistId)) {
      // 既に laundry コレクションに存在 → スキップ
      skippedCount++;
      console.log(`  [SKIP] checklistId=${checklistId} (既存あり)`);
      continue;
    }

    const paymentMethod = putOut.paymentMethod || "";
    const isReimbursable = ["cash", "credit"].includes(paymentMethod);

    const laundryData = {
      date: data.checkoutDate || data.date || null,
      propertyId: data.propertyId || "",
      staffId: putOut.by?.id || putOut.by || "",
      depot: putOut.depot || "",
      depotOther: putOut.depotOther || "",
      depotKind: putOut.depotKind || "",
      paymentMethod,
      sheets: 0,
      amount: Number(putOut.amount) || 0,
      memo: putOut.note || "",
      isReimbursable,
      sourceChecklistId: checklistId,
      sourceField: "putOut",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    console.log(`  [${isDryRun ? "DRY" : "CREATE"}] checklistId=${checklistId} propertyId=${laundryData.propertyId} amount=${laundryData.amount} paymentMethod=${laundryData.paymentMethod} isReimbursable=${laundryData.isReimbursable}`);

    if (!isDryRun) {
      try {
        await db.collection("laundry").add(laundryData);
        createdCount++;
      } catch (e) {
        errorCount++;
        console.error(`  [ERROR] checklistId=${checklistId}:`, e.message);
      }
    } else {
      createdCount++; // DRY-RUN では件数だけカウント
    }
  }

  console.log("\n=== 結果 ===");
  console.log(`  putOut セット済み: ${targetCount} 件`);
  console.log(`  既存あり (スキップ): ${skippedCount} 件`);
  console.log(`  ${isDryRun ? "作成予定" : "作成済み"}: ${createdCount} 件`);
  if (!isDryRun) console.log(`  エラー: ${errorCount} 件`);
  if (isDryRun) console.log("\n  → 実際に反映する場合は --execute フラグを付けて再実行してください。");
}

run().then(() => {
  console.log("[backfill-laundry] 完了");
  process.exit(0);
}).catch(e => {
  console.error("[backfill-laundry] 致命エラー:", e);
  process.exit(1);
});
