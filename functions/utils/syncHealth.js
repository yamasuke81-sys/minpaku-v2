/**
 * syncHealth コレクション更新ヘルパ
 *
 * 各定期ジョブの最後で updateSyncHealth(db, jobName, { ok, error }) を呼ぶ。
 * P1 では書き込みのみ。アラート連携は P2 で別途。
 *
 * ドキュメント構造:
 *   syncHealth/{jobName}
 *     jobName               : "syncIcal" | "emailVerification" | "reconciliation"
 *     lastSuccessAt         : Timestamp | null
 *     lastErrorAt           : Timestamp | null
 *     lastError             : string | null  (200文字で切る)
 *     consecutiveErrorCount : number          (成功で 0 リセット)
 *     updatedAt             : Timestamp
 */

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {"syncIcal"|"emailVerification"|"reconciliation"} jobName
 * @param {{ ok: boolean, error?: string }} status
 */
async function updateSyncHealth(db, jobName, status) {
  if (!db || !jobName || !status) return;
  try {
    const admin = require("firebase-admin");
    const ref = db.collection("syncHealth").doc(jobName);
    const now = admin.firestore.FieldValue.serverTimestamp();

    if (status.ok) {
      await ref.set({
        jobName,
        lastSuccessAt: now,
        consecutiveErrorCount: 0,
        updatedAt: now,
      }, { merge: true });
    } else {
      // 連続エラー回数はトランザクションでインクリメント
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const prev = snap.exists ? (snap.data().consecutiveErrorCount || 0) : 0;
        tx.set(ref, {
          jobName,
          lastErrorAt: now,
          lastError: String(status.error || "unknown").slice(0, 200),
          consecutiveErrorCount: prev + 1,
          updatedAt: now,
        }, { merge: true });
      });
    }
  } catch (e) {
    // 健康記録の失敗で本処理を止めない
    console.error(`[syncHealth] 更新失敗 (${jobName}, 握り潰し):`, e.message);
  }
}

module.exports = {
  updateSyncHealth,
};
