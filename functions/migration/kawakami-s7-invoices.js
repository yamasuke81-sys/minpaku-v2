// S7: 請求書の状態検証
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const PID = "tsZybhDMcPrxqgcRy7wp";

(async () => {
  console.log("=== S7: 請求書検証 ===\n");

  const invSnap = await db.collection("invoices").get();
  console.log(`全請求書件数: ${invSnap.size}`);

  // status 別
  const byStatus = {};
  for (const d of invSnap.docs) {
    const s = d.data().status || "(未定)";
    byStatus[s] = (byStatus[s] || 0) + 1;
  }
  console.log(`\n--- status 別 ---`);
  for (const [s, n] of Object.entries(byStatus)) {
    console.log(`  ${s}: ${n}件`);
  }

  // 最近 10 件
  console.log(`\n--- 最近 10 件 ---`);
  const recent = invSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.yearMonth || "").localeCompare(a.yearMonth || ""))
    .slice(0, 10);
  for (const i of recent) {
    const hasPdf = i.pdfUrl ? "PDF✓" : "PDF❌";
    console.log(`  [${i.yearMonth}] ${i.status.padEnd(12)} staff=${i.staffName || "?"} total=¥${i.total || 0} ${hasPdf}`);
  }

  // PDF URL 有無
  const withPdf = invSnap.docs.filter(d => d.data().pdfUrl).length;
  const withoutPdf = invSnap.size - withPdf;
  console.log(`\n--- PDF URL ---`);
  console.log(`  生成済: ${withPdf}件 / 未生成: ${withoutPdf}件`);

  // shift集計ベースの今月分テスト計算 (オーナー)
  console.log(`\n--- 計算可能性検査 (オーナー 2026-04) ---`);
  const { computeInvoiceDetails } = require("../api/invoices");
  const OWNER_STAFF_ID = "ziTig6tefnj5NvkgN4fG";
  const result = await computeInvoiceDetails(db, OWNER_STAFF_ID, "2026-04", []);
  console.log(`  shiftCount: ${result.shiftCount}`);
  console.log(`  shiftAmount: ¥${result.shiftAmount}`);
  console.log(`  laundryAmount: ¥${result.laundryAmount}`);
  console.log(`  total: ¥${result.total}`);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
