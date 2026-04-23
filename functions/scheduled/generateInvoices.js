const admin = require("firebase-admin");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { FieldValue } = require("firebase-admin/firestore");
const { computeInvoiceDetails } = require("../api/invoices");
const { notifyOwner } = require("../utils/lineNotify");

/**
 * 月次請求書自動生成
 * 毎月1日 2:00 JST に前月分を全 active スタッフ(isTimee 以外)に対して生成
 */
exports.generateInvoices = onSchedule({
  schedule: "0 2 1 * *",
  timeZone: "Asia/Tokyo",
  region: "asia-northeast1",
  timeoutSeconds: 540,
}, async (event) => {
  const db = admin.firestore();

  // 前月の yearMonth を算出
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const yearMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;

  console.log(`[generateInvoices] 開始: yearMonth=${yearMonth}`);

  const staffSnap = await db.collection("staff").where("active", "==", true).get();
  const generated = [];
  const skipped = [];

  for (const staffDoc of staffSnap.docs) {
    const staff = staffDoc.data();
    if (staff.isTimee) continue; // タイミーは別途対応

    const invoiceId = `INV-${yearMonth.replace("-", "")}-${staffDoc.id.substring(0, 6)}`;

    // 重複防止: 既存ドキュメントがあればスキップ
    const existing = await db.collection("invoices").doc(invoiceId).get();
    if (existing.exists) {
      skipped.push({ staffId: staffDoc.id, reason: "既存" });
      continue;
    }

    let computed;
    try {
      computed = await computeInvoiceDetails(db, staffDoc.id, yearMonth, []);
    } catch (e) {
      console.error(`[generateInvoices] computeInvoiceDetails エラー staff=${staffDoc.id}:`, e.message);
      skipped.push({ staffId: staffDoc.id, reason: e.message });
      continue;
    }

    // シフト0件ならスキップ
    if (!computed.shiftCount || computed.shiftCount === 0) {
      skipped.push({ staffId: staffDoc.id, reason: "shift 0件" });
      continue;
    }

    await db.collection("invoices").doc(invoiceId).set({
      yearMonth,
      staffId: staffDoc.id,
      staffName: staff.name,
      basePayment: computed.shiftAmount || 0,
      laundryFee: computed.laundryAmount || 0,
      transportationFee: computed.transportationFee || 0,
      specialAllowance: computed.specialAmount || 0,
      manualAmount: 0,
      total: computed.total || 0,
      status: "draft",
      byProperty: computed.byProperty || {},
      details: {
        shifts: computed.shifts || [],
        laundry: computed.laundry || [],
        special: computed.special || [],
        manualItems: computed.manual || [],
      },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      generatedBy: "scheduled_monthly",
    });

    generated.push({ invoiceId, staff: staff.name, total: computed.total || 0 });
  }

  console.log(`[generateInvoices] ${yearMonth}: generated=${generated.length} skipped=${skipped.length}`);
  for (const g of generated) console.log(`  ✓ ${g.invoiceId} ${g.staff} ¥${g.total}`);
  for (const s of skipped) console.log(`  - skip staff=${s.staffId} reason=${s.reason}`);

  // Webアプリ管理者サマリ通知
  if (generated.length > 0) {
    try {
      const totalAmount = generated.reduce((s, g) => s + g.total, 0);
      const title = `${yearMonth} 請求書 ${generated.length}件 自動生成`;
      const body = `月次集計が完了しました。\n\n件数: ${generated.length}件\n合計: ¥${totalAmount.toLocaleString()}\n\n確認: https://minpaku-v2.web.app/#/invoices`;
      await notifyOwner(db, "invoice_request", title, body, { month: yearMonth, count: generated.length });
    } catch (e) {
      console.error("[generateInvoices] 通知エラー:", e);
    }
  }

  console.log("[generateInvoices] 完了");
});
