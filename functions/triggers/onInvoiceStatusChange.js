const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

/**
 * 請求書ステータス変更トリガー
 * - draft → submitted: pdfUrl 未生成なら PDF を自動生成
 */
module.exports = async (event) => {
  const before = event.data?.before?.data();
  const after = event.data?.after?.data();
  if (!before || !after) return;

  const invoiceId = event.params.invoiceId;
  const db = admin.firestore();

  // status が submitted に遷移 + pdfUrl 未生成
  if (before.status !== "submitted" && after.status === "submitted" && !after.pdfUrl) {
    console.log(`[onInvoiceStatusChange] submitted 遷移を検知 invoiceId=${invoiceId} → PDF 自動生成開始`);
    try {
      const { generateInvoicePdf_ } = require("../api/invoices");
      const pdfUrl = await generateInvoicePdf_(db, invoiceId);
      await db.collection("invoices").doc(invoiceId).update({
        pdfUrl,
        pdfGeneratedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.log(`[onInvoiceStatusChange] PDF 自動生成完了: ${invoiceId} url=${pdfUrl}`);
    } catch (e) {
      console.error(`[onInvoiceStatusChange] PDF 生成失敗 ${invoiceId}:`, e);
      try {
        await db.collection("error_logs").add({
          type: "onInvoiceStatusChange_pdfGen",
          message: e.message,
          invoiceId,
          createdAt: new Date(),
        });
      } catch (_) { /* ignore */ }
    }
  }
};
