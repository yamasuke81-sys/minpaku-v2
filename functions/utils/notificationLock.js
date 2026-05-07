/**
 * 通知抑制ロック (notification_locks コレクション)
 *
 * 同じ閾値の連続発火を抑制する。
 * トランザクションで取得 + 更新を原子的に行うため、複数 Cloud Function インスタンスから
 * 同時に呼ばれても二重通知にならない。
 *
 * 使い方:
 *   const ok = await tryAcquireNotificationLock(db, "parse_threshold_6h_unmatched", 60*60*1000, "理由");
 *   if (ok) sendNotification(); // ロック取得成功 → 通知送信
 *   else    skipSilently();      // 抑制中
 */

/**
 * 通知抑制ロックの取得を試みる
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} lockKey                  - lockKey (= docId)
 * @param {number} suppressMs               - 抑制期間 (ms)
 * @param {string} [reason]                 - 直近通知のトリガ理由 (記録用)
 * @returns {Promise<boolean>}              - true なら通知してよい / false なら抑制中
 */
async function tryAcquireNotificationLock(db, lockKey, suppressMs, reason) {
  if (!db || !lockKey) return false;
  const admin = require("firebase-admin");
  const lockRef = db.collection("notification_locks").doc(lockKey);
  const now = Date.now();
  const newLockedUntil = admin.firestore.Timestamp.fromMillis(now + suppressMs);

  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(lockRef);
      if (snap.exists) {
        const until = snap.data().lockedUntil;
        const untilMs = until && until.toMillis ? until.toMillis() : 0;
        if (now < untilMs) {
          // 抑制中。lastReason だけ更新しておく (デバッグ用)
          tx.set(lockRef, {
            lastSuppressedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastSuppressedReason: String(reason || "").slice(0, 200),
          }, { merge: true });
          return false;
        }
      }
      tx.set(lockRef, {
        lockKey,
        lockedUntil: newLockedUntil,
        lastFiredAt: admin.firestore.FieldValue.serverTimestamp(),
        lastReason: String(reason || "").slice(0, 200),
      }, { merge: true });
      return true;
    });
  } catch (e) {
    console.error(`[notificationLock] トランザクション失敗 (${lockKey}):`, e.message);
    return false; // 取得失敗時は通知しない (安全側)
  }
}

module.exports = {
  tryAcquireNotificationLock,
};
