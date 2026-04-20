/**
 * D: 確定済み請求書 PDF バックフィル
 *
 * status が "submitted" または "paid" で、pdfUrl が null/未設定の請求書に対し
 * PDF を生成して pdfUrl を更新する。
 *
 * 注意: Cloud Storage 署名付きURL生成にはサービスアカウントキーが必要。
 * ローカルからは GOOGLE_APPLICATION_CREDENTIALS にキーファイルを指定して実行するか、
 * Firebase Functions のデプロイ後に管理画面から各請求書の PDF 生成ボタンを押してください。
 *
 * 使い方:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json
 *   node backfill-invoice-pdfs.js --dry-run   # 確認のみ
 *   node backfill-invoice-pdfs.js --execute   # 実際に生成
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const isDryRun = !process.argv.includes("--execute");

// generateInvoicePdf_ を functions/api/invoices.js から直接 require はできないため、
// 同等の PDF 生成ロジックを直接呼び出す
// → invoices.js の generateInvoicePdf_ を admin SDK 環境で呼ぶために
//    module として import できるよう invoices.js の export を確認してから判断

// invoices.js は Router を export しているため generateInvoicePdf_ は外部から
// 直接呼べない。代わりに、functions/api/invoices.js の generateInvoicePdf_ を
// 内部で再実装せず、Functions の HTTP エンドポイント /:id/pdf を管理者として叩く方法を採用。
// ただし Cloud Functions のベース URL が必要なため、ここでは直接 require して
// generateInvoicePdf_ を共有するリファクタリングが必要かを確認する。

// シンプルな実装: pdfkit と同じロジックを使う generateInvoicePdf_ を
// invoices.js からエクスポートして呼ぶか、もしくは invoices.js 自体を修正する。
// 現状は generateInvoicePdf_ が module.exports に含まれていないため、
// ここでは Functions デプロイ後に HTTP 経由で呼び出す方針にする。

// しかし、このスクリプトを migration として直接実行するには
// Firebase Admin SDK 経由で Firestore 操作のみ可能。
// PDF 生成には Cloud Storage + PDFKit が必要であり、
// functions/api/invoices.js の generateInvoicePdf_ を require できるよう
// 関数を export する修正が必要。

// 方針: invoices.js に generateInvoicePdf_ をエクスポートする修正を行い、
// このスクリプトから直接呼び出す。

// まず invoices.js が generateInvoicePdf_ を export していれば以下が機能する:
let generateInvoicePdf_;
try {
  const invoicesModule = require("../api/invoices");
  generateInvoicePdf_ = invoicesModule.generateInvoicePdf_;
} catch (e) {
  console.warn("invoices.js から generateInvoicePdf_ を import できませんでした:", e.message);
  console.warn("HTTP 経由で呼び出す代替モードを使用します");
}

(async () => {
  console.log(`=== 請求書 PDF バックフィル (${isDryRun ? "DRY RUN" : "EXECUTE"}) ===\n`);

  // pdfUrl が未設定の確定済み/支払済み請求書を取得
  const snap = await db.collection("invoices").get();
  const targets = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(inv => {
      const s = inv.status || "";
      const needsPdf = s === "submitted" || s === "paid";
      const hasPdf = inv.pdfUrl && typeof inv.pdfUrl === "string" && inv.pdfUrl.length > 0;
      return needsPdf && !hasPdf;
    });

  console.log(`PDF 未生成の確定/支払済み請求書: ${targets.length}件`);
  for (const inv of targets) {
    console.log(`  - ${inv.id} (status=${inv.status}, yearMonth=${inv.yearMonth}, staffId=${inv.staffId})`);
  }

  if (targets.length === 0) {
    console.log("対象なし。終了。");
    process.exit(0);
  }

  if (isDryRun) {
    console.log("\n(dry-run: 実際の PDF 生成は --execute で実行)");
    process.exit(0);
  }

  if (!generateInvoicePdf_) {
    console.error("generateInvoicePdf_ が利用できません。invoices.js に export を追加してから再実行してください。");
    console.error("代替: firebase deploy 後に管理画面から各請求書の PDF 生成ボタンを押してください。");
    process.exit(1);
  }

  let successCount = 0;
  let failCount = 0;

  for (const inv of targets) {
    console.log(`\n処理中: ${inv.id}`);
    try {
      const pdfUrl = await generateInvoicePdf_(db, inv.id);
      await db.collection("invoices").doc(inv.id).update({
        pdfUrl,
        pdfGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`  → PDF 生成成功: ${pdfUrl.substring(0, 60)}...`);
      successCount++;
    } catch (e) {
      console.error(`  → PDF 生成失敗: ${e.message}`);
      failCount++;
    }
  }

  console.log(`\n--- 結果 ---`);
  console.log(`成功: ${successCount}件 / 失敗: ${failCount}件`);

  process.exit(failCount > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
