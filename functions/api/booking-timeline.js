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
        // kind=unknown でも紐付け済 (matchedBookingId あり) なら「関連メール」として表示
        // (RE: のご予約 / お問い合わせ 等、件名で予約に紐付くが kind 抽出できないメール)
        if (!meta && x.matchedBookingId) {
          meta = { type: "email_related", label: "関連メール受信" };
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

      // ⑧ 直販予約 (source="direct") の履歴
      // iCal でもメール照合でも拾えないため、bookingRequests / paymentSession / 名簿依頼メールの
      // タイムスタンプから組み立てる。加えて物件 Gmail からゲストとの実際のメール往復を拾う。
      if (b.source === "direct" || b.syncSource === "direct") {
        const tsIso = (t) => (t && t.toDate ? t.toDate().toISOString() : (t || null));

        // 関連する予約リクエスト = この予約の元になったもの + 同じゲスト(メール)の他のリクエスト。
        // 人数間違いで却下→再送信のような経緯も履歴に出す。
        // where は propertyId 1本にして残りは JS で絞る (複合 index を増やさない既存方針)
        const reqSnap = await db.collection("bookingRequests")
          .where("propertyId", "==", b.propertyId || "")
          .get();
        const relatedReqs = reqSnap.docs.filter((d) => {
          const r = d.data() || {};
          if (`direct-${d.id}` === bookingId) return true;
          return !!(r.email && b.email && r.email === b.email);
        });

        relatedReqs.forEach((d) => {
          const r = d.data() || {};
          const isThis = `direct-${d.id}` === bookingId;
          const suffix = isThis ? "" : " (別リクエスト)";

          const parts = [];
          if (r.guestCount) parts.push(`人数: ${r.guestCount}名`);
          if (r.checkIn && r.checkOut) parts.push(`日程: ${r.checkIn} 〜 ${r.checkOut}`);
          if (r.plan) parts.push(`プラン: ${r.plan === "nonrefundable" ? "返金不可割引" : r.plan}`);
          if (r.nationality) parts.push(`国籍: ${r.nationality}`);
          if (r.memberComposition) parts.push(`構成: ${r.memberComposition}`);
          if (r.carCount != null) parts.push(`お車: ${Number(r.carCount) === 0 ? "なし" : `${r.carCount}台`}`);
          if (r.notes) parts.push(`備考: ${String(r.notes).slice(0, 60)}`);

          events.push({
            type: "direct_request",
            label: `直販サイトから予約リクエスト受信${suffix}`,
            timestamp: tsIso(r.createdAt),
            source: "setouchi-stay.com",
            linkUrl: "#/booking-requests",
            linkLabel: "予約リクエスト画面へ",
            _isFocusLink: true,
            note: parts.join(" / "),
          });

          if (r.status === "approved" && r.approvedAt) {
            events.push({
              type: "direct_approved",
              label: `リクエストを承認・予約確定${suffix}`,
              timestamp: tsIso(r.approvedAt),
              source: "オーナー操作",
              note: "ゲストへ確定メール(決済リンク・名簿フォーム)を送信",
            });
          }
          if (r.status === "rejected" && r.rejectedAt) {
            events.push({
              type: "direct_rejected",
              label: `リクエストを却下${suffix}`,
              timestamp: tsIso(r.rejectedAt),
              source: "オーナー操作",
              note: r.rejectReason ? `理由: ${r.rejectReason}` : "",
            });
          }
        });

        // 決済 (Stripe Checkout)
        const ps = b.paymentSession || {};
        const yen = (n) => `¥${Number(n || 0).toLocaleString("ja-JP")}`;
        if (ps.createdAt) {
          // 期限は JST 表記 (他のイベント時刻はクライアントがローカル時刻へ直すので揃える)
          const expIso = ps.expiresAt
            ? new Date(Number(ps.expiresAt) * 1000 + 9 * 3600 * 1000).toISOString()
            : null;
          events.push({
            type: "payment_link",
            label: "決済リンクを発行",
            timestamp: tsIso(ps.createdAt),
            source: "Stripe Checkout",
            linkUrl: ps.url || null,
            linkLabel: ps.url ? "決済ページを開く" : null,
            note: [ps.amount ? `金額: ${yen(ps.amount)}` : "", expIso ? `支払期限: ${expIso.slice(0, 16).replace("T", " ")} JST` : ""].filter(Boolean).join(" / "),
          });
        }
        if (b.paymentReminderSentAt) {
          events.push({
            type: "payment_reminder",
            label: "支払い期限リマインドメール送信",
            timestamp: tsIso(b.paymentReminderSentAt),
            source: "自動送信 (期限6時間前)",
            note: "",
          });
        }
        if (b.paymentStatus === "paid" || b.paymentStatus === "partially_refunded") {
          const paidIso = tsIso(b.paymentPaidAt) || tsIso(ps.paidAt);
          if (paidIso) {
            events.push({
              type: "payment_paid",
              label: "お支払い完了",
              timestamp: paidIso,
              source: "Stripe",
              note: ps.amountPaid ? `入金額: ${yen(ps.amountPaid)}` : "",
            });
          }
        }
        if (b.paymentStatus === "expired") {
          events.push({
            type: "payment_expired",
            label: "支払期限切れ・自動キャンセル",
            timestamp: tsIso(b.cancelledAt) || null,
            source: "Stripe webhook",
            note: "",
          });
        }

        // 名簿の記入依頼メール (支払完了時 / 定期リマインド / 手動送信)
        const rosterMailMap = b.rosterGuestMailSentAt || {};
        const KEY_LABEL = { payment_paid: "支払完了時", d6: "6日前", d4: "4日前", d2: "2日前", d1: "前日" };
        Object.keys(rosterMailMap).forEach((k) => {
          events.push({
            type: "roster_request_mail",
            label: "名簿の記入依頼メール送信",
            timestamp: tsIso(rosterMailMap[k]),
            source: k.startsWith("manual_") ? "手動送信" : (KEY_LABEL[k] ? `自動送信 (${KEY_LABEL[k]})` : "自動送信"),
            note: "",
          });
        });

        // ゲストとの実際のメール往復 (物件 Gmail から metadata のみ読む)
        if (b.email) {
          try {
            const { resolveSenderGmail_ } = require("../utils/lineNotify");
            const { searchMailWithGuest_ } = require("../utils/gmailSearch");
            const mailbox = await resolveSenderGmail_(db, b.propertyId);
            const mails = await searchMailWithGuest_(db, mailbox, b.email, 15);
            mails.forEach((m) => {
              events.push({
                type: m.outgoing ? "direct_mail_sent" : "direct_mail_received",
                label: m.outgoing ? "ゲストへメール送信" : "ゲストからメール受信",
                timestamp: m.date,
                source: m.outgoing ? `→ ${b.email}` : `← ${b.email}`,
                linkUrl: `https://mail.google.com/mail/?authuser=${encodeURIComponent(m.account)}#all/${m.threadId}`,
                linkLabel: "Gmail で開く",
                note: [m.subject ? `件名: ${String(m.subject).slice(0, 80)}` : "", m.snippet ? String(m.snippet).slice(0, 90) : ""].filter(Boolean).join(" / "),
              });
            });
          } catch (mailErr) {
            console.warn("[booking-timeline] Gmail 履歴の取得失敗:", mailErr.message);
          }
        }
      }

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
