/**
 * 全請求書再集計スクリプト
 * status=draft または submitted の全 invoice を対象に computeInvoiceDetails を呼び直す
 *
 * 使い方:
 *   node kawakami-recalc-all-invoices.js --dry-run    # 変更前後の total を確認のみ
 *   node kawakami-recalc-all-invoices.js --execute    # 実際に再集計して書き込み
 */
const admin = require("firebase-admin");

admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const args = process.argv.slice(2);
const isDryRun = !args.includes("--execute");

// invoices.js の computeInvoiceDetails を直接 require
const { computeInvoiceDetails } = require("../api/invoices");

async function main() {
  console.log(`[mode] ${isDryRun ? "DRY-RUN (変更なし)" : "EXECUTE (実際に再集計)"}`);

  const snap = await db.collection("invoices")
    .where("status", "in", ["draft", "submitted"])
    .get();

  console.log(`対象 invoice 数: ${snap.size}`);

  let updated = 0;
  let errors = 0;

  for (const doc of snap.docs) {
    const inv = doc.data();
    const { staffId, yearMonth } = inv;

    if (!staffId || !yearMonth) {
      console.warn(`  [skip] ${doc.id}: staffId or yearMonth なし`);
      continue;
    }

    let computed;
    try {
      const existingManual = inv.details?.manualItems || [];
      computed = await computeInvoiceDetails(db, staffId, yearMonth, existingManual);
    } catch (e) {
      console.error(`  [error] ${doc.id}: ${e.message}`);
      errors++;
      continue;
    }

    const before = inv.total || 0;
    const after = computed.total;
    const diff = after - before;
    const mark = diff > 0 ? `↑+${diff}` : diff < 0 ? `↓${diff}` : "変化なし";
    console.log(`  [${isDryRun ? "preview" : "update"}] ${doc.id} (${inv.staffName || staffId} ${yearMonth}): ¥${before} → ¥${after} ${mark}`);
    console.log(`    shiftCount=${computed.shiftCount} shiftAmount=${computed.shiftAmount} laundryAmount=${computed.laundryAmount}`);

    if (!isDryRun) {
      await doc.ref.update({
        basePayment: computed.shiftAmount,
        laundryFee: computed.laundryAmount,
        transportationFee: computed.transportationFee,
        specialAllowance: computed.specialAmount,
        total: computed.total,
        byProperty: computed.byProperty || {},
        details: {
          shifts: computed.shifts,
          laundry: computed.laundry,
          special: computed.special,
          manualItems: computed.manual,
        },
        recalculatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    updated++;
  }

  console.log(`\n===== 結果 =====`);
  console.log(`再集計: ${updated} 件`);
  console.log(`エラー: ${errors} 件`);
  if (isDryRun) {
    console.log(`\n--execute オプションを付けて実行すると実際に更新します`);
  } else {
    console.log(`\n全請求書再集計完了`);
  }

  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
