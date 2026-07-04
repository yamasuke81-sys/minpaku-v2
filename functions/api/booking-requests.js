/**
 * 直接予約リクエスト 管理 API (認証必須)
 *
 * 宿公式サイトからの予約リクエスト (bookingRequests) をオーナーが承認/却下する。
 * 承認時のみ bookings を新規作成する (source:"direct" → 既存 iCal フィード配信 /
 * onBookingChange の募集生成・通知フローに自動的に乗る)。
 *
 * bookingRequests は絶対に bookings と混在させない:
 *   - detectDoubleBooking が pending 状態のリクエストまで誤って重複警告を出す
 *   - syncIcal のゴーストガードが OTA 実予約の取込をスキップしてしまう
 */
const { Router } = require("express");
const { FieldValue } = require("firebase-admin/firestore");
const { getAppUrl } = require("../utils/appUrl");
const { periodsOverlap, ymd: normalizeYmd } = require("./booking-request-logic");

module.exports = function bookingRequestsApi(db) {
  const router = Router();
  const collection = db.collection("bookingRequests");

  function requireOwner(req, res) {
    if (req.user.role !== "owner" && req.user.role !== "sub_owner") {
      res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      return false;
    }
    return true;
  }

  // GET /booking-requests?status=pending (既定 pending)
  router.get("/", async (req, res) => {
    try {
      if (!requireOwner(req, res)) return;
      const status = String(req.query.status || "pending");
      // 件数が少ない想定のため全件取得 → JS フィルタ (複合 index 不要)
      const snap = await collection.get();
      let items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (status !== "all") {
        items = items.filter((x) => (x.status || "pending") === status);
      }
      // サブオーナーは所有物件のみ
      if (req.user.role === "sub_owner") {
        const ownedIds = new Set(req.user.ownedPropertyIds || []);
        items = items.filter((x) => ownedIds.has(x.propertyId));
      }
      // 新しい順
      items.sort((a, b) => {
        const at = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
        const bt = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
        return bt - at;
      });
      res.json(items);
    } catch (e) {
      console.error("[booking-requests] 一覧取得エラー:", e);
      res.status(500).json({ error: "一覧の取得に失敗しました" });
    }
  });

  // POST /booking-requests/:id/approve
  // オーナーのみ (サブオーナーは不可: bookings 作成は全体影響があるため)
  router.post("/:id/approve", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const { id } = req.params;
      const docRef = collection.doc(id);
      const doc = await docRef.get();
      if (!doc.exists) return res.status(404).json({ error: "リクエストが見つかりません" });
      const reqData = doc.data();
      if (reqData.status !== "pending") {
        return res.status(409).json({ error: `既に処理済みです (status=${reqData.status})` });
      }

      // 最終重複チェック (リクエスト受付後に別ルートで確定した予約と衝突していないか)
      const bookingsSnap = await db.collection("bookings")
        .where("propertyId", "==", reqData.propertyId)
        .get();
      const overlap = bookingsSnap.docs.some((d) => {
        const b = d.data();
        if (b.status !== "confirmed") return false;
        const bCi = normalizeYmd(b.checkIn);
        const bCo = normalizeYmd(b.checkOut);
        return periodsOverlap(reqData.checkIn, reqData.checkOut, bCi, bCo);
      });
      if (overlap) {
        return res.status(409).json({ error: "selected_dates_unavailable" });
      }

      // bookings 作成 (source:"direct" → icalFeeds の includeSources:["direct"] で自動配信対象)
      // 決定的 docId (direct-<requestId>) + トランザクションで冪等化する。
      // 2端末/2タブで同一リクエストをほぼ同時に承認しても、トランザクション内の
      // status 再確認と booking 存在チェックにより二重作成を防ぐ (add() は非冪等なため使わない)。
      const bookingData = {
        source: "direct",
        syncSource: "direct",
        status: "confirmed",
        guestName: reqData.guestName || "",
        email: reqData.email || "",
        checkIn: reqData.checkIn,
        checkOut: reqData.checkOut,
        guestCount: reqData.guestCount || null,
        cancellationPlan: reqData.plan || "standard",
        propertyId: reqData.propertyId,
        propertyName: reqData.propertyName || "",
        memo: reqData.notes || "",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      const bookingRef = db.collection("bookings").doc(`direct-${id}`);
      await db.runTransaction(async (tx) => {
        const freshReq = await tx.get(docRef);
        if (!freshReq.exists || freshReq.data().status !== "pending") {
          const err = new Error("already_processed");
          err.alreadyProcessed = true;
          throw err;
        }
        const existingBooking = await tx.get(bookingRef);
        if (existingBooking.exists) {
          const err = new Error("already_processed");
          err.alreadyProcessed = true;
          throw err;
        }
        tx.set(bookingRef, bookingData);
        tx.update(docRef, {
          status: "approved",
          approvedAt: FieldValue.serverTimestamp(),
          approvedBy: req.user.uid || "",
          bookingId: bookingRef.id,
        });
      });

      // ゲストへ承認メール (支払案内・キャンセルポリシー・名簿フォームURL)
      try {
        const { sendNotificationEmail_, resolveSenderGmail_ } = require("../utils/lineNotify");
        const senderGmail = await resolveSenderGmail_(db, reqData.propertyId);
        const appUrl = await getAppUrl(db);
        const formUrl = `${appUrl}/form/?propertyId=${encodeURIComponent(reqData.propertyId)}`;
        const planText = reqData.plan === "nonrefundable"
          ? "返金不可プラン（ご予約確定後のキャンセル・返金はできません）"
          : "スタンダードプラン（キャンセルポリシーは物件ページの記載に準じます）";
        const subject = `【${reqData.propertyName || "ご予約"}】ご予約が確定しました`;
        const bodyText = [
          `${reqData.guestName || "ゲスト"} 様`,
          ``,
          `お待たせいたしました。ご予約リクエストを承認し、予約が確定いたしましたのでご連絡いたします。`,
          ``,
          `■ご予約内容`,
          `宿泊施設: ${reqData.propertyName || ""}`,
          `チェックイン: ${reqData.checkIn}`,
          `チェックアウト: ${reqData.checkOut}`,
          `人数: ${reqData.guestCount || "-"}名`,
          `キャンセルポリシー: ${planText}`,
          ``,
          `■お支払いについて`,
          `現地払い、または銀行振込にてお支払いいただけます。詳細は改めてご連絡いたします。`,
          ``,
          `■宿泊者名簿のご提出をお願いします`,
          `チェックインまでに下記フォームよりご記入ください。`,
          `${formUrl}`,
          ``,
          `ご不明な点がございましたらお気軽にお問い合わせください。`,
          `よろしくお願いいたします。`,
        ].join("\n");
        await sendNotificationEmail_(reqData.email, subject, bodyText, senderGmail || null);
      } catch (mailErr) {
        console.warn("[booking-requests/approve] 承認メール送信失敗:", mailErr.message);
      }

      res.json({ ok: true, bookingId: bookingRef.id });
    } catch (e) {
      // 同時承認による競合はエラーではなく「処理済み」として 409 を返す
      if (e && e.alreadyProcessed) {
        return res.status(409).json({ error: "既に処理済みです" });
      }
      console.error("[booking-requests] 承認エラー:", e);
      res.status(500).json({ error: e.message || "承認処理に失敗しました" });
    }
  });

  // POST /booking-requests/:id/reject
  router.post("/:id/reject", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const { id } = req.params;
      const reason = String((req.body && req.body.reason) || "").slice(0, 500);
      const docRef = collection.doc(id);
      const doc = await docRef.get();
      if (!doc.exists) return res.status(404).json({ error: "リクエストが見つかりません" });
      const reqData = doc.data();
      if (reqData.status !== "pending") {
        return res.status(409).json({ error: `既に処理済みです (status=${reqData.status})` });
      }

      await docRef.update({
        status: "rejected",
        rejectedAt: FieldValue.serverTimestamp(),
        rejectedBy: req.user.uid || "",
        rejectReason: reason,
      });

      // ゲストへお断りメール
      try {
        const { sendNotificationEmail_, resolveSenderGmail_ } = require("../utils/lineNotify");
        const senderGmail = await resolveSenderGmail_(db, reqData.propertyId);
        const subject = `【${reqData.propertyName || "ご予約"}】予約リクエストについて`;
        const bodyText = [
          `${reqData.guestName || "ゲスト"} 様`,
          ``,
          `この度は${reqData.propertyName || "当施設"}へのご予約リクエストをいただき、誠にありがとうございました。`,
          ``,
          `大変恐れ入りますが、ご希望の日程（${reqData.checkIn} 〜 ${reqData.checkOut}）は`,
          `満室のためご用意することができませんでした。`,
          reason ? `\n${reason}\n` : "",
          `またの機会がございましたら、ぜひご検討いただけますと幸いです。`,
          `ご期待に沿えず申し訳ございません。`,
        ].join("\n");
        await sendNotificationEmail_(reqData.email, subject, bodyText, senderGmail || null);
      } catch (mailErr) {
        console.warn("[booking-requests/reject] お断りメール送信失敗:", mailErr.message);
      }

      res.json({ ok: true });
    } catch (e) {
      console.error("[booking-requests] 却下エラー:", e);
      res.status(500).json({ error: e.message || "却下処理に失敗しました" });
    }
  });

  return router;
};
