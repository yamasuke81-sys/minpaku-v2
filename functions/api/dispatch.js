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
const { notifyByKey } = require("../utils/lineNotify");
const { buildTimeeAutofillUrl_ } = require("../utils/timeeAutofill");

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

      // 並行で LINE/メール通知も発火 (Playwright 失敗時に yamasuke がスマホで Dispatch コピペできるよう、
      // バックアップ経路として timee_posting 通知を送る。channelOverrides.timee_posting で送信先制御済)
      try {
        let pDoc, propertyName = r.propertyName || "";
        if (r.propertyId) {
          pDoc = await db.collection("properties").doc(r.propertyId).get();
          if (pDoc.exists) propertyName = pDoc.data().name || propertyName;
        }
        const tf = pDoc?.data()?.timeeAutofill;
        const urlGroup = buildTimeeAutofillUrl_(tf, r.checkoutDate, "group_limited");
        const urlNewWorker = buildTimeeAutofillUrl_(tf, r.checkoutDate, "new_worker_for_client_limited");

        const lines = [
          `🕐 タイミー募集依頼 (手動発火)`,
          ``,
          `チェックアウト: ${r.checkoutDate}`,
          `物件: ${propertyName}`,
          ``,
          `▼ PC では Playwright が並行で自動投稿を試行中`,
          `▼ スマホで Dispatch 経由でやる場合はコピペ:`,
          `/timee-post ${bookingId} ${visibility}`,
        ];
        if (urlGroup) lines.push(``, `▶ グループ限定で募集を作成 (PC Chrome)`, urlGroup);
        if (urlNewWorker) lines.push(``, `▶ 初回ワーカー限定で募集を作成 (PC Chrome)`, urlNewWorker);

        await notifyByKey(db, "timee_posting", {
          title: `タイミー手動募集発火: ${r.checkoutDate} ${propertyName}`,
          body: lines.join("\n"),
          vars: {
            date: r.checkoutDate,
            property: propertyName,
            url: urlGroup || urlNewWorker || "https://app-new.taimee.co.jp/account",
            urlGroup: urlGroup || "",
            urlNewWorker: urlNewWorker || "",
          },
          propertyId: r.propertyId || null,
          _fromBatchQueue: true, // 即時送信 (バッチ繰延せず)
        });
      } catch (notifyErr) {
        console.error("[dispatch/timee] notifyByKey 失敗 (Playwright 経路は継続):", notifyErr.message);
      }

      res.json({ ok: true, id: ref.id, command });
    } catch (e) {
      console.error("[dispatch/timee] エラー:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // PUT /timee-status — タイミー募集ステータスの手動切替
  // body: { bookingId, status: "posted" | "filled" | "cancelled" | null }
  router.put("/timee-status", requireOwner_, async (req, res) => {
    try {
      const { bookingId, status } = req.body || {};
      if (!bookingId) return res.status(400).json({ error: "bookingId が必要です" });
      const allowed = ["posted", "filled", "cancelled", null, ""];
      if (!allowed.includes(status)) {
        return res.status(400).json({ error: "status の値が不正" });
      }
      const ref = db.collection("bookings").doc(bookingId);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ error: "予約が見つかりません" });

      const patch = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        timeeStatusUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        timeeStatusUpdatedBy: req.user.uid || "unknown",
      };
      if (status === null || status === "" || status === "cancelled") {
        patch.timeeStatus = status === "cancelled" ? "cancelled" : admin.firestore.FieldValue.delete();
        if (status === "" || status === null) {
          patch.timeePostedAt = admin.firestore.FieldValue.delete();
          patch.timeeFilledAt = admin.firestore.FieldValue.delete();
        }
      } else {
        patch.timeeStatus = status;
        if (status === "filled") patch.timeeFilledAt = admin.firestore.FieldValue.serverTimestamp();
        if (status === "posted") patch.timeePostedAt = admin.firestore.FieldValue.serverTimestamp();
      }
      await ref.update(patch);
      res.json({ ok: true, bookingId, status });
    } catch (e) {
      console.error("[dispatch/timee-status] エラー:", e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
