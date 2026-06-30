/**
 * 宿泊税CSV (やどぜい) 自動化 API
 *
 * Firestore コレクション: yadozeiQueue/{auto-id}
 *   kind: "airbnb_csv_fetch" | "booking_csv_fetch" | "yadozei_csv_upload" | "yadozei_pdf_fetch"
 *   propertyId, propertyName, yearMonth, params{}, status, result, createdBy, createdAt ...
 *
 * PC 常駐 scripts/yadozei-listener.mjs が onSnapshot で監視し、検知 → Playwright 実行 → status 更新する。
 *
 * エンドポイント:
 *   POST /api/yadozei/run-now            手動キュー投入
 *   GET  /api/yadozei/history/:pid       実行履歴
 *   GET  /api/yadozei/state              listener heartbeat 確認
 */
const { Router } = require("express");
const admin = require("firebase-admin");

module.exports = function yadozeiApi(db) {
  const router = Router();

  // オーナー or サブオーナー権限チェック
  function requireOwnerOrSubOwner_(req, res, next) {
    if (!req.user) return res.status(401).json({ error: "認証が必要です" });
    if (req.user.role !== "owner" && req.user.role !== "sub_owner") {
      return res.status(403).json({ error: "オーナー権限が必要です" });
    }
    next();
  }

  // サブオーナーが所有物件のみ操作できるよう確認
  function _isPropertyAccessible(req, propertyId) {
    if (req.user.role === "owner") return true;
    if (req.user.role === "sub_owner") {
      const owned = req.user.ownedPropertyIds || [];
      return owned.includes(propertyId);
    }
    return false;
  }

  // JST で前月の "YYYY-MM" を返す
  function _prevMonthJst() {
    const now = new Date();
    // JST = UTC + 9h
    const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const y = jstNow.getUTCFullYear();
    const m = jstNow.getUTCMonth(); // 0-11
    // 前月
    const prev = new Date(Date.UTC(y, m - 1, 1));
    const py = prev.getUTCFullYear();
    const pm = String(prev.getUTCMonth() + 1).padStart(2, "0");
    return `${py}-${pm}`;
  }

  // yearMonth の妥当性 ("YYYY-MM")
  function _isValidYearMonth(ym) {
    return typeof ym === "string" && /^\d{4}-\d{2}$/.test(ym);
  }

  // ============================================================
  // POST /run-now — 手動でキュー投入
  // body: { propertyId, ota: "airbnb"|"booking"|"both", yearMonth?: "YYYY-MM" }
  // query: ?force=true で 24h 以内の done でも強制再投入
  // ============================================================
  router.post("/run-now", requireOwnerOrSubOwner_, async (req, res) => {
    try {
      const { propertyId, ota, yearMonth } = req.body || {};
      if (!propertyId) return res.status(400).json({ error: "propertyId が必要です" });
      if (!["airbnb", "booking", "both"].includes(ota)) {
        return res.status(400).json({ error: "ota は airbnb / booking / both のいずれかです" });
      }
      if (yearMonth !== undefined && !_isValidYearMonth(yearMonth)) {
        return res.status(400).json({ error: "yearMonth は YYYY-MM 形式で指定してください" });
      }
      const force = String(req.query.force || "") === "true";

      // 物件アクセス権チェック
      if (!_isPropertyAccessible(req, propertyId)) {
        return res.status(403).json({ error: "この物件のアクセス権がありません" });
      }

      // 物件情報取得
      const propDoc = await db.collection("properties").doc(propertyId).get();
      if (!propDoc.exists) return res.status(404).json({ error: "物件が見つかりません" });
      const prop = propDoc.data();
      const propertyName = prop.name || propertyId;
      const yadozei = prop.yadozei || {};

      // 対象月決定 (省略時=前月JST)
      const targetYm = yearMonth || _prevMonthJst();

      // 対象 OTA を展開
      const targetOtas = ota === "both" ? ["airbnb", "booking"] : [ota];

      // 各 OTA で設定/重複チェック → enqueue
      const jobIds = [];
      const skipped = [];

      for (const o of targetOtas) {
        const cfg = yadozei[o];
        if (!cfg || cfg.enabled !== true) {
          skipped.push({ ota: o, reason: `この物件で ${o} の自動取得が無効です` });
          continue;
        }

        let kind = null;
        let listingId = "";
        let bookingPropertyId = "";
        if (o === "airbnb") {
          listingId = (cfg.listingId || "").trim();
          if (!listingId) {
            skipped.push({ ota: o, reason: "Airbnb リスティングIDが未設定です" });
            continue;
          }
          kind = "airbnb_csv_fetch";
        } else {
          bookingPropertyId = (cfg.propertyId || "").trim();
          if (!bookingPropertyId) {
            skipped.push({ ota: o, reason: "Booking.com 物件IDが未設定です" });
            continue;
          }
          kind = "booking_csv_fetch";
        }

        // 直近24h以内に done のジョブがあるか確認 (force=true で無視)
        if (!force) {
          const since = admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
          const dupSnap = await db.collection("yadozeiQueue")
            .where("propertyId", "==", propertyId)
            .where("kind", "==", kind)
            .where("yearMonth", "==", targetYm)
            .where("status", "==", "done")
            .where("completedAt", ">", since)
            .limit(1)
            .get();
          if (!dupSnap.empty) {
            return res.status(409).json({
              error: `${o === "airbnb" ? "Airbnb" : "Booking.com"} の ${targetYm} 分は直近24時間以内に取得済みです (force=true で強制再投入可)`,
              jobId: dupSnap.docs[0].id,
            });
          }
        }

        const jobData = {
          kind,
          propertyId,
          propertyName,
          yearMonth: targetYm,
          params: kind === "airbnb_csv_fetch"
            ? { listingId }
            : { bookingPropertyId },
          status: "pending",
          result: null,
          createdBy: `manual:${req.user.uid || "unknown"}`,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          startedAt: null,
          completedAt: null,
          error: null,
          retries: 0,
        };

        const ref = await db.collection("yadozeiQueue").add(jobData);
        jobIds.push(ref.id);
        console.log(`[yadozei] queued: kind=${kind} property=${propertyName} ym=${targetYm} (id=${ref.id})`);
      }

      if (jobIds.length === 0) {
        return res.status(400).json({
          error: "投入可能なジョブがありませんでした",
          skipped,
        });
      }

      res.json({ ok: true, jobIds, yearMonth: targetYm, skipped });
    } catch (e) {
      console.error("[yadozei/run-now] エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ============================================================
  // GET /history/:propertyId?limit=20
  // 物件単位の yadozeiQueue 履歴 (createdAt desc)
  // ============================================================
  router.get("/history/:propertyId", requireOwnerOrSubOwner_, async (req, res) => {
    try {
      const propertyId = req.params.propertyId;
      if (!_isPropertyAccessible(req, propertyId)) {
        return res.status(403).json({ error: "この物件のアクセス権がありません" });
      }
      const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || "20", 10)));

      const snap = await db.collection("yadozeiQueue")
        .where("propertyId", "==", propertyId)
        .orderBy("createdAt", "desc")
        .limit(limit)
        .get();

      const jobs = snap.docs.map((d) => {
        const x = d.data();
        return {
          id: d.id,
          kind: x.kind,
          propertyId: x.propertyId,
          propertyName: x.propertyName,
          yearMonth: x.yearMonth,
          status: x.status,
          result: x.result || null,
          error: x.error || null,
          retries: x.retries || 0,
          createdBy: x.createdBy,
          createdAt: x.createdAt?.toMillis ? x.createdAt.toMillis() : null,
          startedAt: x.startedAt?.toMillis ? x.startedAt.toMillis() : null,
          completedAt: x.completedAt?.toMillis ? x.completedAt.toMillis() : null,
        };
      });

      res.json({ jobs });
    } catch (e) {
      console.error("[yadozei/history] エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ============================================================
  // GET /state
  // listener heartbeat の状態を返す
  // settings/yadozeiListener.lastSeenAt から alive 判定
  // ============================================================
  router.get("/state", requireOwnerOrSubOwner_, async (req, res) => {
    try {
      const doc = await db.collection("settings").doc("yadozeiListener").get();
      if (!doc.exists) {
        return res.json({
          listener: {
            lastSeenAt: null,
            hostName: null,
            version: null,
            alive: false,
          },
        });
      }
      const data = doc.data() || {};
      const lastSeenMs = data.lastSeenAt?.toMillis ? data.lastSeenAt.toMillis() : 0;
      const alive = lastSeenMs > 0 && (Date.now() - lastSeenMs) < 5 * 60 * 1000;

      res.json({
        listener: {
          lastSeenAt: lastSeenMs || null,
          hostName: data.hostName || null,
          version: data.version || null,
          alive,
        },
      });
    } catch (e) {
      console.error("[yadozei/state] エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
