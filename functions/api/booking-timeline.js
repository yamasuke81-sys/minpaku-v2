/**
 * 予約履歴タイムライン API (オーナー専用)
 *
 * GET /api/booking-timeline/:bookingId
 *
 * 既存の bookings + emailVerifications から組み立てて返す (新規コレクション不要)。
 * イベント種別:
 *   ① iCal で予約検知                  bookings.createdAt (syncSource=ical)
 *   ② iCal で受付停止検知              bookings.cancelledAt (cancelReason に "iCal同期")
 *   ③ 予約確認メール受信               emailVerifications kind=confirmed
 *   ④ キャンセルメール受信             emailVerifications kind=cancelled
 *   ⑤ 予約日変更メール受信             emailVerifications kind=change-approved/change-request/changed
 *   ⑥ 保留中(予約リクエスト)メール受信  emailVerifications kind=request または matchStatus=pending_request
 *   ⑦ 情報補完履歴                    bookings.emailVerifiedAt 反映タイミング (= ③〜⑤で代用可なので別出ししない)
 */
const express = require("express");

module.exports = function (db) {
  const router = express.Router();

  router.get("/:bookingId", async (req, res) => {
    // オーナー権限のみ (role==null は既存アカウント互換でオーナー扱い)
    const role = req.user && req.user.role;
    if (role !== "owner" && role !== null && role !== undefined) {
      return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
    }

    const bookingId = req.params.bookingId;
    if (!bookingId) return res.status(400).json({ error: "bookingId が必要です" });

    try {
      const bDoc = await db.collection("bookings").doc(bookingId).get();
      if (!bDoc.exists) return res.status(404).json({ error: "予約が見つかりません" });
      const b = bDoc.data();

      const events = [];

      // ① iCal 予約検知
      if (b.syncSource === "ical" && b.createdAt) {
        const ts = b.createdAt.toDate ? b.createdAt.toDate().toISOString() : null;
        events.push({
          type: "ical_created",
          label: "iCalで予約検知",
          timestamp: ts,
          source: `${b.source || "iCal"} iCalフィード`,
          linkUrl: b.icalUrl || null,
          linkLabel: b.icalUrl ? "iCalフィードを開く" : null,
          note: b.icalUid ? `UID: ${b.icalUid}` : "",
        });
      }

      // ② iCal で受付停止検知 (cancelReason に "iCal同期" を含む場合のみ)
      // メール由来のキャンセルは下の emailVerifications で扱う
      if (b.status === "cancelled" && b.cancelledAt) {
        const ts = b.cancelledAt.toDate ? b.cancelledAt.toDate().toISOString() : null;
        const isIcalCancel = (b.cancelReason || "").includes("iCal同期");
        const isEmailCancel = b.cancelSource === "email";
        if (isIcalCancel) {
          events.push({
            type: "ical_removed",
            label: "iCalで受付停止検知",
            timestamp: ts,
            source: `${b.source || ""} iCalフィード`,
            linkUrl: b.icalUrl || null,
            linkLabel: b.icalUrl ? "iCalフィードを開く" : null,
            note: b.cancelReason || "",
          });
        } else if (!isEmailCancel) {
          // 手動キャンセル等
          events.push({
            type: "manual_cancelled",
            label: "予約キャンセル (手動/その他)",
            timestamp: ts,
            source: b.cancelSource || "manual",
            note: b.cancelReason || "",
          });
        }
      }

      // ③〜⑥ emailVerifications から
      const KIND_META = {
        confirmed: { type: "email_confirmed", label: "予約確認メール受信" },
        cancelled: { type: "email_cancelled", label: "キャンセルメール受信" },
        "change-approved": { type: "email_changed", label: "予約日変更メール受信 (承認)" },
        "change-request": { type: "email_changed", label: "予約日変更メール受信 (リクエスト)" },
        changed: { type: "email_changed", label: "予約日変更メール受信" },
        request: { type: "email_pending", label: "保留中(予約リクエスト)メール受信" },
      };

      const eSnap = await db.collection("emailVerifications")
        .where("matchedBookingId", "==", bookingId)
        .get();

      eSnap.docs.forEach((d) => {
        const x = d.data();
        const kind = x.extractedInfo && x.extractedInfo.kind;
        let meta = KIND_META[kind];
        // matchStatus=pending_request も保留中メール扱い (kind が unknown でも拾う)
        if (!meta && x.matchStatus === "pending_request") {
          meta = KIND_META["request"];
        }
        if (!meta) return;

        const ts = x.receivedAt && x.receivedAt.toDate
          ? x.receivedAt.toDate().toISOString() : null;

        // Gmail スレッド URL: authuser パラメータでアカウント自動切替
        const gmailAccount = x.gmailAccount;
        const threadId = x.threadId;
        const linkUrl = (gmailAccount && threadId)
          ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(gmailAccount)}#all/${threadId}`
          : null;

        // note 組立 (件名 + 抽出情報)
        const noteParts = [];
        if (x.subject) noteParts.push(`件名: ${String(x.subject).slice(0, 80)}`);
        if (x.extractedInfo) {
          const ei = x.extractedInfo;
          if (ei.reservationCode) noteParts.push(`予約番号: ${ei.reservationCode}`);
          if (ei.guestName) noteParts.push(`氏名: ${ei.guestName}`);
          if (ei.guestCount && ei.guestCount.total) noteParts.push(`人数: ${ei.guestCount.total}名`);
          // 変更メールの場合は新CI/COも表示
          if (kind === "change-approved" || kind === "change-request" || kind === "changed") {
            if (ei.checkIn && ei.checkIn.date) noteParts.push(`新CI: ${ei.checkIn.date}`);
            if (ei.checkOut && ei.checkOut.date) noteParts.push(`新CO: ${ei.checkOut.date}`);
          }
        }

        events.push({
          type: meta.type,
          label: meta.label,
          timestamp: ts,
          source: x.fromHeader || x.platform || "",
          linkUrl,
          linkLabel: linkUrl ? "Gmail で開く" : null,
          note: noteParts.join(" / "),
        });
      });

      // 時系列昇順
      events.sort((a, b) => {
        const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return ta - tb;
      });

      res.json({
        bookingId,
        propertyId: b.propertyId,
        guestName: b.guestName,
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        source: b.source,
        unverified: !!b.unverified,
        events,
      });
    } catch (e) {
      console.error("[booking-timeline] エラー:", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
