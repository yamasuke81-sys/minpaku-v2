#!/usr/bin/env node
// 緊急: notificationQueue の pending を今すぐ全部 drain して送信する
// インデックス未作成で processBatchNotificationQueue が動いていなかった分を救済
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const { notifyByKey } = require("../utils/lineNotify");

const isExecute = process.argv.includes("--execute");
console.log(`mode: ${isExecute ? "EXECUTE" : "DRY-RUN"}`);

(async () => {
  // インデックス不要のクエリ (status のみ)
  const snap = await db.collection("notificationQueue").where("status", "==", "pending").get();
  console.log(`pending 件数: ${snap.size}`);
  let sent = 0, failed = 0;
  for (const d of snap.docs) {
    const x = d.data();
    const at = x.createdAt?.toDate?.()?.toISOString() || "";
    console.log(`\n--- ${d.id} key=${x.notifyKey} slot=${x.batchSlot} schedDate=${x.scheduledForDate} created=${at} ---`);
    if (!isExecute) {
      console.log("  (dry-run)");
      continue;
    }
    try {
      const opts = { ...(x.options || {}), _fromBatchQueue: true };
      const result = await notifyByKey(db, x.notifyKey, opts);
      await d.ref.update({
        status: "sent",
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        result: {
          sent: result.sent || {},
          errorCount: (result.errors || []).length,
        },
      });
      console.log(`  ✅ sent: ${JSON.stringify(result.sent || {})}`);
      sent++;
    } catch (e) {
      console.error(`  ❌ ${e.message}`);
      try {
        await d.ref.update({
          status: "failed",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          error: String(e.message || e).slice(0, 500),
        });
      } catch (_) {}
      failed++;
    }
  }
  console.log(`\n=== 完了: sent=${sent} failed=${failed} ${isExecute ? "" : "(dry-run)"} ===`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
