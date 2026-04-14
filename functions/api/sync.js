/**
 * 手動同期 API
 * POST /sync/ical — iCal手動同期
 */
const express = require("express");
const admin = require("firebase-admin");
const syncIcal = require("../scheduled/syncIcal");

module.exports = function (db) {
  const router = express.Router();

  // オーナー権限チェック
  function requireOwner(req, res, next) {
    // role が未定義またはowner の場合に許可
    if (req.user.role !== undefined && req.user.role !== "owner") {
      return res.status(403).json({ error: "オーナー権限が必要です" });
    }
    next();
  }

  // POST /sync/ical — iCal手動同期
  router.post("/ical", requireOwner, async (req, res) => {
    try {
      console.log(`[sync/ical] 手動同期開始: ${req.user.email}`);

      // iCal同期実行（頻度チェックをスキップするため、settings/syncConfig の lastIcalSync を一時的にクリア）
      // 手動実行なので interval チェックなしで即実行したい場合は syncIcal 側が対応済みでないため、
      // lastIcalSync を過去日時にリセットしてから実行する
      const syncConfigRef = db.collection("settings").doc("syncConfig");
      const syncConfigSnap = await syncConfigRef.get();
      const prevLastSync = syncConfigSnap.exists
        ? syncConfigSnap.data().lastIcalSync
        : null;

      // 強制実行のため lastIcalSync を一時クリア
      await syncConfigRef.set(
        { lastIcalSync: null },
        { merge: true }
      );

      // iCal同期を実行
      await syncIcal();

      // lastIcalSync は syncIcal() 内で更新済み（現在時刻に更新されている）
      const afterSnap = await syncConfigRef.get();
      const lastIcalSync = afterSnap.exists
        ? afterSnap.data().lastIcalSync
        : null;

      console.log(`[sync/ical] 手動同期完了: ${req.user.email}`);
      res.json({
        ok: true,
        message: "iCal同期が完了しました",
        lastIcalSync,
      });
    } catch (e) {
      console.error("[sync/ical] エラー:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
