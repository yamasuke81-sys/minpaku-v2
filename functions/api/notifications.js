/**
 * 通知テスト API
 * POST /notifications/test — 指定送信先にテスト通知を送信
 */
const { Router } = require("express");
const {
  notifyOwner,
  notifyGroup,
  notifyStaff,
  getNotificationSettings_,
  sendNotificationEmail_,
} = require("../utils/lineNotify");

module.exports = function notificationsApi(db) {
  const router = Router();

  // オーナー権限チェック（未設定の場合はオーナー扱い）
  function requireOwner(req, res, next) {
    const role = req.user && req.user.role;
    if (role !== undefined && role !== "owner") {
      return res.status(403).json({ error: "オーナー権限が必要です" });
    }
    next();
  }

  /**
   * POST /notifications/test
   * リクエストボディ:
   *   type: string       — 通知種別キー（例: "recruit_start"）
   *   message: string    — カスタムメッセージ
   *   targets: {
   *     ownerLine: bool,
   *     groupLine: bool,
   *     staffLine: bool,
   *     ownerEmail: bool
   *   }
   */
  router.post("/test", requireOwner, async (req, res) => {
    const { type, message, targets, vars } = req.body;

    // バリデーション
    if (!type || typeof type !== "string") {
      return res.status(400).json({ error: "type は必須です" });
    }
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message は必須です" });
    }
    if (!targets || typeof targets !== "object") {
      return res.status(400).json({ error: "targets は必須です" });
    }

    const title = `【テスト送信】${type}`;
    const body = message;
    // vars を受け取って customMessage 内 {変数} の置換に使う (フロントが systemVariables のサンプル値を渡す想定)
    const testVars = (vars && typeof vars === "object") ? vars : {};
    const results = [];

    // オーナーLINE送信
    if (targets.ownerLine) {
      try {
        const r = await notifyOwner(db, type, title, body, testVars);
        results.push({ target: "ownerLine", ...r });
      } catch (e) {
        console.error("オーナーLINE送信エラー:", e);
        results.push({ target: "ownerLine", success: false, error: e.message });
      }
    }

    // グループLINE送信
    if (targets.groupLine) {
      try {
        const r = await notifyGroup(db, type, title, body, testVars);
        results.push({ target: "groupLine", ...r });
      } catch (e) {
        console.error("グループLINE送信エラー:", e);
        results.push({ target: "groupLine", success: false, error: e.message });
      }
    }

    // スタッフ個別LINE送信（lineUserId設定済みのアクティブスタッフ全員）
    if (targets.staffLine) {
      try {
        const staffSnap = await db.collection("staff")
          .where("active", "==", true)
          .get();

        const staffResults = [];
        for (const doc of staffSnap.docs) {
          const staffData = doc.data();
          if (!staffData.lineUserId) continue;

          try {
            const r = await notifyStaff(db, doc.id, type, title, body, testVars);
            staffResults.push({ staffId: doc.id, staffName: staffData.name, ...r });
          } catch (e) {
            console.error(`スタッフ${doc.id} LINE送信エラー:`, e);
            staffResults.push({
              staffId: doc.id,
              staffName: staffData.name,
              success: false,
              error: e.message,
            });
          }
        }

        results.push({ target: "staffLine", staffResults });
      } catch (e) {
        console.error("スタッフLINE一括送信エラー:", e);
        results.push({ target: "staffLine", success: false, error: e.message });
      }
    }

    // オーナーメール送信
    if (targets.ownerEmail) {
      try {
        const { settings } = await getNotificationSettings_(db);
        const ownerEmail = settings && settings.ownerEmail;
        if (!ownerEmail) {
          results.push({ target: "ownerEmail", success: false, error: "ownerEmail 未設定" });
        } else {
          await sendNotificationEmail_(ownerEmail, title, body);
          results.push({ target: "ownerEmail", success: true, to: ownerEmail });
        }
      } catch (e) {
        console.error("オーナーメール送信エラー:", e);
        results.push({ target: "ownerEmail", success: false, error: e.message });
      }
    }

    const anySuccess = results.some((r) => r.success !== false);
    res.json({ success: anySuccess, results });
  });

  return router;
};
