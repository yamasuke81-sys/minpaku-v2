/**
 * FCM (Firebase Cloud Messaging) 送信ユーティリティ
 * admin.messaging().sendEachForMulticast を使用
 * エミュレータ環境ではコンソール出力にフォールバック（lineNotify.jsパターン踏襲）
 */
const admin = require("firebase-admin");

const IS_EMULATOR = process.env.FUNCTIONS_EMULATOR === "true";

/**
 * 複数FCMトークンに一括プッシュ通知送信
 * @param {string[]} tokens - FCMトークン配列
 * @param {string} title - 通知タイトル
 * @param {string} body - 通知本文
 * @param {object} [data] - 追加データ（url など）
 * @returns {Promise<{success: boolean, successCount: number, failureCount: number, invalidTokens: string[]}>}
 */
async function sendFCM(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) {
    return { success: true, successCount: 0, failureCount: 0, invalidTokens: [] };
  }

  if (IS_EMULATOR) {
    console.log("[EMULATOR] would send FCM:", { tokens: tokens.length, title, body, data });
    return { success: true, successCount: tokens.length, failureCount: 0, invalidTokens: [], stub: true };
  }

  const message = {
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    ),
    tokens,
    webpush: {
      notification: {
        title,
        body,
        icon: "/img/icon-192.png",
        badge: "/img/icon-72.png",
      },
    },
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    const invalidTokens = [];

    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const code = resp.error?.code;
        // 無効・期限切れトークンを収集
        if (
          code === "messaging/invalid-registration-token" ||
          code === "messaging/registration-token-not-registered"
        ) {
          invalidTokens.push(tokens[idx]);
        }
        console.error(`[FCM] トークン送信失敗 [${idx}]:`, code, resp.error?.message);
      }
    });

    return {
      success: response.successCount > 0,
      successCount: response.successCount,
      failureCount: response.failureCount,
      invalidTokens,
    };
  } catch (e) {
    console.error("[FCM] 一括送信エラー:", e);
    return { success: false, successCount: 0, failureCount: tokens.length, invalidTokens: [], error: e.message };
  }
}

/**
 * 無効なFCMトークンをFirestoreから削除
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} staffId - スタッフID（nullの場合はWebアプリ管理者トークンから削除）
 * @param {string[]} invalidTokens
 */
async function cleanupInvalidTokens(db, staffId, invalidTokens) {
  if (!invalidTokens || invalidTokens.length === 0) return;

  try {
    if (staffId) {
      // スタッフドキュメントから無効トークンを削除
      const staffRef = db.collection("staff").doc(staffId);
      await staffRef.update({
        fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens),
        updatedAt: new Date(),
      });
      console.log(`[FCM] スタッフ ${staffId} の無効トークン ${invalidTokens.length}件 削除`);
    } else {
      // Webアプリ管理者設定から削除
      const settingsRef = db.collection("settings").doc("fcmTokens");
      await settingsRef.update({
        ownerTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens),
      });
      console.log(`[FCM] Webアプリ管理者の無効トークン ${invalidTokens.length}件 削除`);
    }
  } catch (e) {
    console.error("[FCM] 無効トークン削除失敗:", e);
  }
}

/**
 * 全スタッフのFCMトークンを収集してFCM送信 + 無効トークンクリーンアップ
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} title
 * @param {string} body
 * @param {object} [data]
 * @returns {Promise<object>}
 */
async function notifyAllStaffFCM(db, title, body, data = {}) {
  // アクティブスタッフのFCMトークン収集
  const staffSnap = await db.collection("staff").where("active", "==", true).get();
  const tokenMap = {}; // token -> staffId

  staffSnap.docs.forEach((doc) => {
    const tokens = doc.data().fcmTokens || [];
    tokens.forEach((t) => { tokenMap[t] = doc.id; });
  });

  const allTokens = Object.keys(tokenMap);
  if (allTokens.length === 0) {
    return { success: true, successCount: 0, note: "スタッフFCMトークンなし" };
  }

  const result = await sendFCM(allTokens, title, body, data);

  // 無効トークンをスタッフ別にまとめてクリーンアップ
  if (result.invalidTokens.length > 0) {
    // staffIdごとにグループ化
    const byStaff = {};
    result.invalidTokens.forEach((t) => {
      const sid = tokenMap[t];
      if (sid) {
        byStaff[sid] = byStaff[sid] || [];
        byStaff[sid].push(t);
      }
    });
    await Promise.all(
      Object.entries(byStaff).map(([sid, tokens]) => cleanupInvalidTokens(db, sid, tokens))
    );
  }

  return result;
}

/**
 * Webアプリ管理者のFCMトークンを取得して送信
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} title
 * @param {string} body
 * @param {object} [data]
 */
async function notifyOwnerFCM(db, title, body, data = {}) {
  const doc = await db.collection("settings").doc("fcmTokens").get();
  if (!doc.exists) return { success: false, note: "Webアプリ管理者FCMトークンなし" };

  const tokens = doc.data().ownerTokens || [];
  if (tokens.length === 0) return { success: false, note: "Webアプリ管理者FCMトークンなし" };

  const result = await sendFCM(tokens, title, body, data);

  // 無効トークンクリーンアップ
  if (result.invalidTokens.length > 0) {
    await cleanupInvalidTokens(db, null, result.invalidTokens);
  }

  return result;
}

module.exports = {
  sendFCM,
  cleanupInvalidTokens,
  notifyAllStaffFCM,
  notifyOwnerFCM,
};
