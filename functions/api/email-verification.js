/**
 * メール照合機能 API
 *
 * POST /api/email-verification/run    オーナー手動で巡回を実行
 * GET  /api/email-verification/list   照合結果一覧 (Step 5 UI 用)
 *
 * index.js で authenticate ミドルウェアが適用された後にマウントされる想定。
 * ここではオーナー権限チェックのみ追加で行う。
 */
const { Router } = require("express");
const { emailVerificationCore } = require("../scheduled/emailVerification");

module.exports = function emailVerificationApi(db) {
  const router = Router();

  function requireOwner_(req, res, next) {
    if (!req.user || req.user.role !== "owner") {
      return res.status(403).json({ error: "オーナー権限が必要です" });
    }
    next();
  }

  // ========== 手動巡回 ==========
  router.post("/run", requireOwner_, async (req, res) => {
    try {
      const result = await emailVerificationCore(db, { log: console });
      res.json({ success: true, ...result });
    } catch (e) {
      console.error("[email-verification/run] エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ========== 照合結果一覧 (Step 5 UI で利用予定) ==========
  router.get("/list", requireOwner_, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const matchStatus = req.query.status; // optional フィルタ
      let q = db.collection("emailVerifications").orderBy("createdAt", "desc");
      if (matchStatus) q = q.where("matchStatus", "==", matchStatus);
      const snap = await q.limit(limit).get();
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      res.json({ items, count: items.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
