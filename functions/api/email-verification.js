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

  // ========== 照合結果一覧 (Step 5 UI で利用) ==========
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

  // ========== 手動で予約に紐付け (unmatched → matched) ==========
  //   PUT /:id/link  body: { bookingId }
  router.put("/:id/link", requireOwner_, async (req, res) => {
    try {
      const admin = require("firebase-admin");
      const { id } = req.params;
      const { bookingId } = req.body || {};
      if (!bookingId) return res.status(400).json({ error: "bookingId が必要です" });

      const bookingRef = db.collection("bookings").doc(bookingId);
      const bookingSnap = await bookingRef.get();
      if (!bookingSnap.exists) return res.status(404).json({ error: "指定の予約が見つかりません" });

      const evRef = db.collection("emailVerifications").doc(id);
      const evSnap = await evRef.get();
      if (!evSnap.exists) return res.status(404).json({ error: "メール照合レコードが見つかりません" });
      const ev = evSnap.data();

      await bookingRef.update({
        emailVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        emailMessageId: ev.messageId,
        emailThreadId: ev.threadId || null,
        emailSubject: ev.subject || null,
        emailMatchedBy: "manual",
      });

      await evRef.update({
        matchStatus: ev.extractedInfo && ev.extractedInfo.kind === "cancelled" ? "cancelled" : "matched",
        matchedBookingId: bookingId,
        matchedBy: "manual",
        matchedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({ success: true, bookingId });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========== 無視マーク (迷惑メール等) ==========
  //   PUT /:id/ignore  body: { reason?: string }
  router.put("/:id/ignore", requireOwner_, async (req, res) => {
    try {
      const admin = require("firebase-admin");
      const { id } = req.params;
      const reason = (req.body && req.body.reason) || "";
      const evRef = db.collection("emailVerifications").doc(id);
      const evSnap = await evRef.get();
      if (!evSnap.exists) return res.status(404).json({ error: "メール照合レコードが見つかりません" });

      await evRef.update({
        matchStatus: "ignored",
        ignoredReason: reason,
        ignoredAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========== cancelled-unmatched を手動でキャンセル確定 ==========
  //   PUT /:id/confirm-cancel  body: { bookingId }
  router.put("/:id/confirm-cancel", requireOwner_, async (req, res) => {
    try {
      const admin = require("firebase-admin");
      const { id } = req.params;
      const bookingId = (req.body && req.body.bookingId) || null;
      if (!bookingId) return res.status(400).json({ error: "bookingId が必要です" });

      const evRef = db.collection("emailVerifications").doc(id);
      const evSnap = await evRef.get();
      if (!evSnap.exists) return res.status(404).json({ error: "メール照合レコードが見つかりません" });
      const ev = evSnap.data();

      const bookingRef = db.collection("bookings").doc(bookingId);
      const bookingSnap = await bookingRef.get();
      if (!bookingSnap.exists) return res.status(404).json({ error: "指定の予約が見つかりません" });

      const bd = bookingSnap.data();
      if (bd.manualOverride === true) {
        return res.status(409).json({
          error: "この予約は manualOverride=true で保護されています。手動でステータスを変更してください。",
        });
      }

      await bookingRef.update({
        status: "cancelled",
        cancelSource: "email-manual",
        emailVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        emailMessageId: ev.messageId,
        emailThreadId: ev.threadId || null,
        emailSubject: ev.subject || null,
        emailMatchedBy: "manual",
      });

      await evRef.update({
        matchStatus: "cancelled",
        matchedBookingId: bookingId,
        matchedBy: "manual",
        matchedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.json({ success: true, bookingId });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========== 候補 booking 検索 (手動紐付け UI 用) ==========
  //   GET /candidates?propertyId=&checkIn=&platform=
  router.get("/candidates", requireOwner_, async (req, res) => {
    try {
      const { propertyId, checkIn, platform } = req.query;
      let q = db.collection("bookings");
      if (propertyId) q = q.where("propertyId", "==", propertyId);
      if (platform) q = q.where("source", "==", platform);
      const snap = await q.limit(200).get();
      let items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      if (checkIn) {
        const target = new Date(checkIn + "T00:00:00Z").getTime();
        items = items.filter((b) => {
          const ci = b.checkIn && (b.checkIn.toDate ? b.checkIn.toDate() : new Date(b.checkIn));
          if (!ci || isNaN(ci.getTime())) return false;
          const diffDays = Math.abs(ci.getTime() - target) / (1000 * 60 * 60 * 24);
          return diffDays <= 3;
        });
      }
      res.json({ items });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
