/**
 * Dispatch API — Web ボタンから PC リスナースクリプト経由で
 * Claude Code / 任意の自動化処理を起動する。
 *
 * Firestore コレクション: dispatchQueue/{auto-id}
 *   command: string  (例: "/timee-post {bookingId} group_limited")
 *   kind: string     (例: "timee_post")
 *   recruitmentId, bookingId, propertyId, params
 *   status: "pending" | "processing" | "done" | "failed"
 *   createdBy, createdAt, startedAt, completedAt, error
 *
 * PC 側の dispatch-listener.js が onSnapshot で監視し、検知 → 実行 → status 更新する想定。
 *
 * エンドポイント:
 *   POST /api/dispatch/timee   { recruitmentId, visibility }
 */
const { Router } = require("express");
const admin = require("firebase-admin");

module.exports = function dispatchApi(db) {
  const router = Router();

  function requireOwner_(req, res, next) {
    if (!req.user || req.user.role !== "owner") {
      return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
    }
    next();
  }

  // POST /timee — タイミー求人作成を PC リスナーに依頼
  router.post("/timee", requireOwner_, async (req, res) => {
    try {
      const { recruitmentId, visibility } = req.body || {};
      if (!recruitmentId) return res.status(400).json({ error: "recruitmentId が必要です" });
      if (!["group_limited", "new_worker_for_client_limited"].includes(visibility)) {
        return res.status(400).json({ error: "visibility の値が不正" });
      }

      const rDoc = await db.collection("recruitments").doc(recruitmentId).get();
      if (!rDoc.exists) return res.status(404).json({ error: "募集が見つかりません" });
      const r = rDoc.data();
      const bookingId = r.bookingId || "";
      if (!bookingId) {
        return res.status(400).json({ error: "この募集には予約が紐付いていません (bookingId 空)" });
      }

      // PC リスナーが解釈するスラッシュコマンド
      const command = `/timee-post ${bookingId} ${visibility}`;

      const ref = await db.collection("dispatchQueue").add({
        kind: "timee_post",
        command,
        recruitmentId,
        bookingId,
        propertyId: r.propertyId || null,
        params: {
          visibility,
          checkoutDate: r.checkoutDate || null,
          propertyName: r.propertyName || null,
        },
        status: "pending",
        createdBy: req.user.uid || "unknown",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(`[dispatch] queued: ${command} (id=${ref.id})`);
      res.json({ ok: true, id: ref.id, command });
    } catch (e) {
      console.error("[dispatch/timee] エラー:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
