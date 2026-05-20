/**
 * バッチ通知キュー処理 (毎時 JST 実行)
 *
 * notify-channel-editor の「朝バッチ(8時)」「夜バッチ(20時)」プリセットで
 * 即時送信を保留してキューイングされた通知を、JST 8時 / 20時 にまとめて配信する。
 *
 * キュー構造: notificationQueue/{id}
 *   notifyKey, options, batchSlot ("08:00"|"20:00"),
 *   scheduledForDate ("YYYY-MM-DD"), status ("pending"|"sent"|"failed"),
 *   createdAt, sentAt
 *
 * 動作:
 *  - JST 8時 / 20時 以外はノーオペ
 *  - 該当スロットの pending を取得し、_fromBatchQueue=true フラグ付きで notifyByKey 再呼び出し
 *  - scheduledForDate <= 今日(JST) のもののみ対象 (未来分は skip)
 */
const admin = require("firebase-admin");
const { notifyByKey } = require("../utils/lineNotify");

function nowJst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

module.exports = async function processBatchNotificationQueue() {
  const db = admin.firestore();
  const { date: todayJst, hour: hourJst } = nowJst();
  const slot = hourJst === 8 ? "08:00" : hourJst === 20 ? "20:00" : null;
  if (!slot) return;
  console.log(`[processBatchNotificationQueue] 起動 JST=${todayJst} ${slot}`);

  let processed = 0, sent = 0, failed = 0;
  try {
    const snap = await db.collection("notificationQueue")
      .where("status", "==", "pending")
      .where("batchSlot", "==", slot)
      .where("scheduledForDate", "<=", todayJst)
      .limit(500)
      .get();

    for (const doc of snap.docs) {
      const data = doc.data();
      processed++;
      try {
        const opts = { ...(data.options || {}), _fromBatchQueue: true };
        const result = await notifyByKey(db, data.notifyKey, opts);
        await doc.ref.update({
          status: "sent",
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          result: {
            sent: result.sent || {},
            errorCount: (result.errors || []).length,
          },
        });
        sent++;
      } catch (e) {
        console.error(`[processBatchNotificationQueue] 送信失敗 id=${doc.id}`, e);
        try {
          await doc.ref.update({
            status: "failed",
            failedAt: admin.firestore.FieldValue.serverTimestamp(),
            error: String(e.message || e).slice(0, 500),
          });
        } catch (_) { /* ignore */ }
        failed++;
      }
    }
    console.log(`[processBatchNotificationQueue] 完了: ${processed}件処理 (送信=${sent}, 失敗=${failed})`);
  } catch (e) {
    console.error("[processBatchNotificationQueue] エラー:", e);
    try {
      await db.collection("error_logs").add({
        functionName: "processBatchNotificationQueue",
        error: e.message,
        stack: (e.stack || "").slice(0, 500),
        severity: "warning",
        createdAt: new Date(),
      });
    } catch (_) { /* ignore */ }
  }
};
