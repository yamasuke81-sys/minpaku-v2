/**
 * 通知テスト API
 * POST /notifications/test — 指定送信先にテスト通知を送信
 *
 * 実装方針:
 *   resolveMessage_ を経由すると customMessage でフロントの「【テスト】」プレフィックスが
 *   上書きされてしまうため、pushMessages_ / sendNotificationEmail_ を直接呼び出し、
 *   フロントから届いた message をそのまま送信する。
 *   送信件数は results.sentCount として明示的に返す。
 */
const { Router } = require("express");
const {
  pushMessages_,
  getNotificationSettings_,
  sendNotificationEmail_,
  sendDiscord_,
} = require("../utils/lineNotify");
const { notifyAllStaffFCM, notifyOwnerFCM } = require("../utils/fcmSender");

module.exports = function notificationsApi(db) {
  const router = Router();

  function requireOwner(req, res, next) {
    const role = req.user && req.user.role;
    if (role !== undefined && role !== "owner") {
      return res.status(403).json({ error: "オーナー権限が必要です" });
    }
    next();
  }

  router.post("/test", requireOwner, async (req, res) => {
    const { type, message, targets } = req.body;

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
    const results = [];
    let sentCount = 0;
    let failCount = 0;

    // LINE / Discord / メール設定をまとめて取得
    let channelToken = null, ownerUserId = null, groupId = null, ownerEmail = null;
    let discordOwnerUrl = null, discordSubOwnerUrl = null;
    try {
      const s = await getNotificationSettings_(db);
      channelToken = s.channelToken;
      ownerUserId = s.ownerUserId;
      groupId = s.groupId;
      ownerEmail = s.settings && s.settings.ownerEmail;
      discordOwnerUrl = s.settings && s.settings.discordOwnerWebhookUrl;
      discordSubOwnerUrl = s.settings && s.settings.discordSubOwnerWebhookUrl;
    } catch (e) {
      return res.status(500).json({
        error: "通知設定の取得に失敗しました: " + e.message,
        results: [],
        sentCount: 0,
      });
    }

    // オーナーLINE
    if (targets.ownerLine) {
      if (!channelToken) {
        results.push({ target: "ownerLine", success: false, error: "LINEチャネルトークン未設定" });
        failCount++;
      } else if (!ownerUserId) {
        results.push({ target: "ownerLine", success: false, error: "オーナーLINE User ID 未設定" });
        failCount++;
      } else {
        const r = await pushMessages_(channelToken, ownerUserId, [{ type: "text", text: body.slice(0, 5000) }]);
        if (r.success) sentCount++; else failCount++;
        results.push({ target: "ownerLine", ...r });
      }
    }

    // グループLINE
    if (targets.groupLine) {
      if (!channelToken) {
        results.push({ target: "groupLine", success: false, error: "LINEチャネルトークン未設定" });
        failCount++;
      } else if (!groupId) {
        results.push({ target: "groupLine", success: false, error: "LINEグループID 未設定" });
        failCount++;
      } else {
        const r = await pushMessages_(channelToken, groupId, [{ type: "text", text: body.slice(0, 5000) }]);
        if (r.success) sentCount++; else failCount++;
        results.push({ target: "groupLine", ...r });
      }
    }

    // スタッフ個別LINE（LINE連携済みのアクティブスタッフ全員）
    if (targets.staffLine) {
      if (!channelToken) {
        results.push({ target: "staffLine", success: false, error: "LINEチャネルトークン未設定" });
        failCount++;
      } else {
        try {
          const staffSnap = await db.collection("staff").where("active", "==", true).get();
          const staffResults = [];
          let staffSent = 0;
          for (const doc of staffSnap.docs) {
            const sd = doc.data();
            if (!sd.lineUserId) continue;
            const r = await pushMessages_(channelToken, sd.lineUserId, [{ type: "text", text: body.slice(0, 5000) }]);
            if (r.success) { sentCount++; staffSent++; } else { failCount++; }
            staffResults.push({ staffId: doc.id, staffName: sd.name, ...r });
          }
          results.push({ target: "staffLine", success: staffSent > 0, staffResults, count: staffSent });
        } catch (e) {
          console.error("スタッフLINE一括送信エラー:", e);
          results.push({ target: "staffLine", success: false, error: e.message });
          failCount++;
        }
      }
    }

    // Discord (オーナー)
    if (targets.discordOwner) {
      if (!discordOwnerUrl) {
        results.push({ target: "discordOwner", success: false, error: "Discord(オーナー)Webhook URL 未設定" });
        failCount++;
      } else {
        const r = await sendDiscord_(discordOwnerUrl, body);
        if (r.success) sentCount++; else failCount++;
        results.push({ target: "discordOwner", ...r });
      }
    }

    // Discord (サブオーナー)
    if (targets.discordSubOwner) {
      if (!discordSubOwnerUrl) {
        results.push({ target: "discordSubOwner", success: false, error: "Discord(サブオーナー)Webhook URL 未設定" });
        failCount++;
      } else {
        const r = await sendDiscord_(discordSubOwnerUrl, body);
        if (r.success) sentCount++; else failCount++;
        results.push({ target: "discordSubOwner", ...r });
      }
    }

    // オーナーメール
    if (targets.ownerEmail) {
      if (!ownerEmail) {
        results.push({ target: "ownerEmail", success: false, error: "オーナーメールアドレス未設定" });
        failCount++;
      } else {
        try {
          await sendNotificationEmail_(ownerEmail, title, body);
          sentCount++;
          results.push({ target: "ownerEmail", success: true, to: ownerEmail });
        } catch (e) {
          console.error("オーナーメール送信エラー:", e);
          results.push({ target: "ownerEmail", success: false, error: e.message });
          failCount++;
        }
      }
    }

    // FCM Web Push (スタッフ)
    if (targets.fcmStaff) {
      try {
        const r = await notifyAllStaffFCM(db, title, body, { url: "/index.html#/my-dashboard" });
        if (r.success) sentCount++; else failCount++;
        results.push({ target: "fcmStaff", ...r });
      } catch (e) {
        console.error("FCMスタッフ送信エラー:", e);
        results.push({ target: "fcmStaff", success: false, error: e.message });
        failCount++;
      }
    }

    // FCM Web Push (オーナー)
    if (targets.fcmOwner) {
      try {
        const r = await notifyOwnerFCM(db, title, body, { url: "/index.html" });
        if (r.success) sentCount++; else failCount++;
        results.push({ target: "fcmOwner", ...r });
      } catch (e) {
        console.error("FCMオーナー送信エラー:", e);
        results.push({ target: "fcmOwner", success: false, error: e.message });
        failCount++;
      }
    }

    res.json({ success: sentCount > 0, sentCount, failCount, results });
  });

  return router;
};
