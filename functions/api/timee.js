/**
 * Timee メール照合 API
 *
 * GET  /api/timee/by-recruitment/:recruitmentId    指定募集に紐付くタイミーメール一覧
 * POST /api/timee/run                              手動で巡回を実行 (オーナー専用)
 */
const { Router } = require("express");
const syncTimeeEmailsCore = require("../scheduled/syncTimeeEmails");

module.exports = function timeeApi(db) {
  const router = Router();

  // 募集に紐付くタイミーメール一覧
  router.get("/by-recruitment/:recruitmentId", async (req, res) => {
    try {
      const { recruitmentId } = req.params;
      if (!recruitmentId) return res.status(400).json({ error: "recruitmentId が必要" });

      // recruitment 自体の読込権限チェックは Firestore rules に委ね、ここでは bookId と
      // propertyId を取得して timeeMatches を検索 (propertyId + workDate 一致もカバー)
      const rDoc = await db.collection("recruitments").doc(recruitmentId).get();
      if (!rDoc.exists) return res.status(404).json({ error: "募集が見つかりません" });
      const r = rDoc.data();

      // 1) linkedRecruitmentId 一致
      const direct = await db.collection("timeeMatches")
        .where("linkedRecruitmentId", "==", recruitmentId)
        .get();
      const items = direct.docs.map((d) => ({ id: d.id, ...d.data() }));

      // 2) 未リンクの可能性 (propertyId + workDate 一致)
      if (r.propertyId && r.checkoutDate) {
        const indirect = await db.collection("timeeMatches")
          .where("propertyId", "==", r.propertyId)
          .where("workDate", "==", r.checkoutDate)
          .get();
        for (const d of indirect.docs) {
          if (items.find((x) => x.id === d.id)) continue;
          items.push({ id: d.id, ...d.data() });
        }
      }

      // 受信日時降順
      items.sort((a, b) => {
        const aMs = a.receivedAt?._seconds ? a.receivedAt._seconds : (a.receivedAt?.seconds || 0);
        const bMs = b.receivedAt?._seconds ? b.receivedAt._seconds : (b.receivedAt?.seconds || 0);
        return bMs - aMs;
      });

      res.json({ items, count: items.length });
    } catch (e) {
      console.error("[timee/by-recruitment] エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // 手動巡回 (オーナーのみ)
  router.post("/run", async (req, res) => {
    if (!req.user || req.user.role !== "owner") {
      return res.status(403).json({ error: "オーナー権限が必要です" });
    }
    try {
      const result = await syncTimeeEmailsCore(db, { log: console });
      res.json({ success: true, ...result });
    } catch (e) {
      console.error("[timee/run] エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
