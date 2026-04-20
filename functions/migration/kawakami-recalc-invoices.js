// 川上オーナー分 請求書 再計算スクリプト
//
// 対象: status が "draft" または "submitted" の invoice
//       (paid は確定済みのため変更しない)
//
// 実行方法:
//   --dry-run  : 変更内容を表示するだけ (デフォルト)
//   --execute  : 実際に Firestore を更新する
//
// 使用例:
//   node functions/migration/kawakami-recalc-invoices.js --dry-run
//   node functions/migration/kawakami-recalc-invoices.js --execute

const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const { computeInvoiceDetails } = require("../api/invoices");

const isDryRun = !process.argv.includes("--execute");

(async () => {
  console.log(`=== kawakami-recalc-invoices [${ isDryRun ? "DRY RUN" : "EXECUTE" }] ===`);

  // draft / submitted の invoice を全件取得 (paid は除外)
  const snap = await db.collection("invoices")
    .where("status", "in", ["draft", "submitted"])
    .get();

  if (snap.empty) {
    console.log("対象 invoice なし");
    return;
  }

  console.log(`対象 invoice: ${snap.size}件`);

  let updatedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const doc of snap.docs) {
    const inv = { id: doc.id, ...doc.data() };
    const { staffId, yearMonth, manualItems, status } = inv;

    if (!staffId || !yearMonth) {
      console.warn(`  [SKIP] ${doc.id}: staffId or yearMonth 欠損`);
      skippedCount++;
      continue;
    }

    let computed;
    try {
      computed = await computeInvoiceDetails(db, staffId, yearMonth, manualItems || []);
    } catch (e) {
      console.error(`  [ERROR] ${doc.id}: computeInvoiceDetails 失敗 — ${e.message}`);
      errorCount++;
      continue;
    }

    const before = {
      shiftCount: inv.shiftCount ?? "未設定",
      shiftAmount: inv.shiftAmount ?? "未設定",
      laundryAmount: inv.laundryAmount ?? "未設定",
      specialAmount: inv.specialAmount ?? "未設定",
      transportationFee: inv.transportationFee ?? "未設定",
      total: inv.total ?? "未設定",
    };

    const after = {
      shiftCount: computed.shiftCount,
      shiftAmount: computed.shiftAmount,
      laundryAmount: computed.laundryAmount,
      specialAmount: computed.specialAmount,
      transportationFee: computed.transportationFee,
      total: computed.total,
    };

    console.log(`\n  [${doc.id}] staffId=${staffId} yearMonth=${yearMonth} status=${status}`);
    console.log(`    BEFORE: shiftCount=${before.shiftCount} shiftAmount=¥${before.shiftAmount} laundry=¥${before.laundryAmount} special=¥${before.specialAmount} transport=¥${before.transportationFee} total=¥${before.total}`);
    console.log(`    AFTER : shiftCount=${after.shiftCount} shiftAmount=¥${after.shiftAmount} laundry=¥${after.laundryAmount} special=¥${after.specialAmount} transport=¥${after.transportationFee} total=¥${after.total}`);

    if (!isDryRun) {
      await doc.ref.update({
        shiftCount: computed.shiftCount,
        shiftAmount: computed.shiftAmount,
        laundryAmount: computed.laundryAmount,
        specialAmount: computed.specialAmount,
        transportationFee: computed.transportationFee,
        total: computed.total,
        shifts: computed.shifts,
        laundry: computed.laundry,
        special: computed.special,
        manualAmount: computed.manualAmount,
        pdfUrl: null, // PDF は再生成が必要
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`    → 更新完了`);
    }
    updatedCount++;
  }

  console.log(`\n=== 完了 ===`);
  console.log(`対象: ${snap.size}件 / 更新${isDryRun ? "(予定)" : "済み"}: ${updatedCount}件 / スキップ: ${skippedCount}件 / エラー: ${errorCount}件`);
  if (isDryRun) {
    console.log(`\n実際に更新するには --execute を付けて再実行してください`);
  }

  process.exit(errorCount > 0 ? 1 : 0);
})();
