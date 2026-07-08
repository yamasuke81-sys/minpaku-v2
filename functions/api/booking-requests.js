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
const { getStripe, getStripeForProperty } = require("../utils/stripe");
const { computeQuoteFromDb } = require("../utils/pricing");

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

      // 決済状態の付与: paymentStatus / paymentSession は booking ドキュメント (direct-<id>) が SSOT。
      // approve 済みリクエストのみ bookingId を持つので、その booking を読んで決済フィールドを合流させる。
      // (webhook で更新される paid/refunded 等は bookingRequest 側には書かれないため、ここで join する)
      const withBooking = items.filter((x) => x.bookingId);
      if (withBooking.length > 0) {
        const bookingRefs = withBooking.map((x) => db.collection("bookings").doc(x.bookingId));
        const bookingSnaps = await db.getAll(...bookingRefs);
        const bookingById = new Map();
        bookingSnaps.forEach((s) => { if (s.exists) bookingById.set(s.id, s.data()); });
        items = items.map((x) => {
          const bk = x.bookingId ? bookingById.get(x.bookingId) : null;
          if (!bk) return x;
          return {
            ...x,
            paymentStatus: bk.paymentStatus || x.paymentStatus || "unconfigured",
            paymentSession: bk.paymentSession || x.paymentSession || null,
            paymentPaidAt: bk.paymentPaidAt || null,
          };
        });
      }

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
        // 決済ステータス初期値。Checkout Session 生成成功時に paymentSession 情報を追記する。
        paymentStatus: "unconfigured", // unconfigured | pending | paid | expired | refunded
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

      // ===== Stripe Checkout Session 生成 =====
      // 承認成立後 (booking 確定後) にサーバー側で見積再計算 → Checkout Session を作成し、
      // 決済 URL を確定メールに差し込む。Stripe 未設定 or 料金未設定なら決済無しモードで続行。
      let payment = { status: "unconfigured", url: null, amount: null, expiresAt: null, sessionId: null };
      try {
        // 物件ごとに個人事業(=individual) / 法人(=corporate) の Stripe アカウントを切替。
        // (未マップの物件は corporate へフォールバックし、utils/stripe.js が warn を出す)
        const stripe = getStripeForProperty(reqData.propertyId);
        // テストモードキー(sk_test_)混入の事故防止ガード:
        // 本番運用中に誤ってテストキーが設定されていた場合、そのままだとオーナー承認の瞬間に
        // 実ゲストの確定メールへテストモードの決済リンクが載ってしまう(決済してもらっても実売上にならない事故)。
        // → 本番鍵(isLive)のときのみ通常どおり生成。テスト鍵のときは settings/directBooking.allowTestCheckout
        //   が明示的に true (E2E検証用フラグ) の場合のみ許可し、それ以外は決済リンク無しにフォールバックする。
        // ★ ガードは accountKind ごとに独立に評価される(個人=test/法人=live が混在してもガードは片方だけ作用)。
        let allowTestCheckout = false;
        if (stripe.isEnabled && !stripe.isLive) {
          try {
            const directCfgSnap = await db.collection("settings").doc("directBooking").get();
            allowTestCheckout = directCfgSnap.exists && directCfgSnap.data().allowTestCheckout === true;
          } catch (_e) { /* 読めなければ従来どおり無効扱い */ }
        }
        const stripeUsable = stripe.isEnabled && (stripe.isLive || allowTestCheckout);
        if (!stripeUsable) {
          if (stripe.isEnabled && !stripe.isLive) {
            console.warn(`[booking-requests/approve] Stripe(${stripe.accountKind})がテストモードキーのため決済リンク無しで承認完了 (settings/directBooking.allowTestCheckoutで明示許可されていません)`);
          } else {
            console.info(`[booking-requests/approve] Stripe(${stripe.accountKind})未設定のため決済リンク無しで承認完了`);
          }
        } else {
          const quoteResult = await computeQuoteFromDb(db, reqData.propertyId, {
            checkIn: reqData.checkIn,
            checkOut: reqData.checkOut,
            guests: Number(reqData.guestCount) || 1,
            plan: reqData.plan || "standard",
          });
          if (!quoteResult.ok || !quoteResult.hasRates) {
            console.warn(`[booking-requests/approve] 見積算出不可のため決済リンク無しで承認完了 (${quoteResult.error || "no_rates"})`);
          } else {
            const total = Number(quoteResult.quote.total);
            if (!Number.isFinite(total) || total <= 0) {
              console.warn("[booking-requests/approve] 見積合計が不正のため決済リンク無しで承認完了");
            } else {
              // Stripe Checkout Session の expires_at は最大24時間 (Stripe仕様上限)。
              // 24時間を過ぎたら自動キャンセルされ、その時点で checkout.session.expired が飛ぶ。
              // (24時間で払われなかった場合の運用: オーナーが手動で新しいリクエストを促す)
              const expiresAtSec = Math.floor(Date.now() / 1000) + 24 * 3600 - 60; // 24時間 - 1分の余裕
              const appUrl = await getAppUrl(db);
              const nights = Number(quoteResult.quote.nights) || 1;
              const description = `${reqData.propertyName || "宿泊予約"} ${reqData.checkIn}〜${reqData.checkOut} (${nights}泊・${reqData.guestCount || 1}名)`;
              // 戻り先は宿公式サイト側の静的ページ (setouchi-stay-sites の top サイト)。
              // settings/directBooking.paymentReturnBase で上書き可 (テスト/本番切替用)。
              let returnBase = "https://www.setouchi-stay.com";
              try {
                const directCfgSnap = await db.collection("settings").doc("directBooking").get();
                const rb = directCfgSnap.exists ? directCfgSnap.data().paymentReturnBase : null;
                if (rb) returnBase = String(rb).replace(/\/+$/, "");
              } catch (_e) { /* fallback */ }
              const successUrl = `${returnBase}/payment-success.html?bookingId=${encodeURIComponent(bookingRef.id)}&sid={CHECKOUT_SESSION_ID}`;
              const cancelUrl = `${returnBase}/payment-cancel.html?bookingId=${encodeURIComponent(bookingRef.id)}`;
              const session = await stripe.client.checkout.sessions.create({
                mode: "payment",
                currency: "jpy",
                expires_at: expiresAtSec,
                customer_email: reqData.email || undefined,
                line_items: [{
                  quantity: 1,
                  price_data: {
                    currency: "jpy",
                    unit_amount: total,
                    product_data: {
                      name: `【${reqData.propertyName || "宿泊予約"}】宿泊料金`,
                      description: description.slice(0, 200),
                    },
                  },
                }],
                metadata: {
                  bookingId: bookingRef.id,
                  bookingRequestId: id,
                  propertyId: reqData.propertyId,
                  propertyName: (reqData.propertyName || "").slice(0, 80),
                  plan: reqData.plan || "standard",
                  checkIn: reqData.checkIn,
                  checkOut: reqData.checkOut,
                  guests: String(reqData.guestCount || 1),
                  quoteTotal: String(total),
                  // どちらの Stripe アカウントで作られたセッションかを webhook 側で照合するため付与
                  accountKind: stripe.accountKind,
                },
                payment_intent_data: {
                  metadata: {
                    bookingId: bookingRef.id,
                    propertyId: reqData.propertyId,
                    accountKind: stripe.accountKind,
                  },
                  description: description.slice(0, 200),
                },
                success_url: successUrl,
                cancel_url: cancelUrl,
              });
              payment = {
                status: "pending",
                url: session.url,
                amount: total,
                expiresAt: expiresAtSec,
                sessionId: session.id,
              };
              await bookingRef.update({
                paymentStatus: "pending",
                paymentSession: {
                  provider: "stripe",
                  sessionId: session.id,
                  url: session.url,
                  amount: total,
                  currency: "jpy",
                  expiresAt: expiresAtSec,
                  createdAt: FieldValue.serverTimestamp(),
                  // 返金 API / charge.refunded webhook が正しいアカウントの Stripe client を選ぶために保存
                  accountKind: stripe.accountKind,
                },
                priceBreakdown: quoteResult.quote,
              });
            }
          }
        }
      } catch (payErr) {
        console.error("[booking-requests/approve] Checkout Session 生成失敗:", payErr.message);
        // 決済生成失敗でも承認は成立させる (メール本文は決済無しモードにフォールバック)
      }

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

        const bodyLines = [
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
        ];

        if (payment.status === "pending" && payment.url) {
          const expDate = new Date(payment.expiresAt * 1000);
          // JST表記 (Asia/Tokyo 固定): UTC からのオフセットで簡易に変換 (Node の toLocaleString でもよいが依存を減らす)
          const jst = new Date(expDate.getTime() + 9 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16);
          bodyLines.push(
            `■お支払いのご案内`,
            `合計金額: ¥${Number(payment.amount).toLocaleString("ja-JP")}（税込・宿泊料金）`,
            `お支払い方法: クレジットカード（Visa / Mastercard / JCB / American Express 等）`,
            `お支払い期限: ${jst} JST まで（承認から約24時間）`,
            ``,
            `下記のお支払いページよりお手続きください：`,
            `${payment.url}`,
            ``,
            `※ お支払い期限までにご決済が確認できない場合、ご予約は自動的にキャンセルとなります。`,
            `※ お支払い後、Stripe より領収書が自動送信されます。`,
            ``,
          );
        } else {
          bodyLines.push(
            `■お支払いについて`,
            `お支払い方法およびお支払い時期については、追ってご案内いたします。`,
            ``,
          );
        }

        bodyLines.push(
          `■宿泊者名簿のご提出をお願いします`,
          `チェックインまでに下記フォームよりご記入ください。`,
          `${formUrl}`,
          ``,
          `ご不明な点がございましたらお気軽にお問い合わせください。`,
          `よろしくお願いいたします。`,
        );

        const bodyText = bodyLines.join("\n");
        await sendNotificationEmail_(reqData.email, subject, bodyText, senderGmail || null);
      } catch (mailErr) {
        console.warn("[booking-requests/approve] 承認メール送信失敗:", mailErr.message);
      }

      res.json({ ok: true, bookingId: bookingRef.id, payment });
    } catch (e) {
      // 同時承認による競合はエラーではなく「処理済み」として 409 を返す
      if (e && e.alreadyProcessed) {
        return res.status(409).json({ error: "既に処理済みです" });
      }
      console.error("[booking-requests] 承認エラー:", e);
      res.status(500).json({ error: e.message || "承認処理に失敗しました" });
    }
  });

  // POST /booking-requests/:id/refund
  // オーナーが決済済みの予約に対して返金を実行する。
  // body: { amount?: number, reason?: string }
  //   amount 未指定 → 全額返金 (Stripe が支払金額を自動判定)
  //   amount 指定 → 部分返金 (キャンセル料相殺後の返金額を渡す)
  // 実データ更新は Stripe Webhook (charge.refunded) が担う (SSOT を分けない)。
  router.post("/:id/refund", async (req, res) => {
    try {
      if (req.user.role !== "owner") {
        return res.status(403).json({ error: "Webアプリ管理者権限が必要です" });
      }
      const { id } = req.params;
      const body = req.body || {};
      const amountRaw = body.amount;
      const reason = String(body.reason || "").slice(0, 500);

      const bookingRef = db.collection("bookings").doc(`direct-${id}`);
      const bookingSnap = await bookingRef.get();
      if (!bookingSnap.exists) {
        return res.status(404).json({ error: "予約が見つかりません" });
      }
      const b = bookingSnap.data();
      const session = b.paymentSession;
      const paymentIntentId = session && session.paymentIntentId;
      if (!paymentIntentId) {
        return res.status(400).json({ error: "決済情報が見つかりません（未払い or Stripe未使用）" });
      }
      if (b.paymentStatus !== "paid" && b.paymentStatus !== "partially_refunded") {
        return res.status(409).json({ error: `返金できない状態です (paymentStatus=${b.paymentStatus})` });
      }

      // 決済に使ったアカウントで返金する必要があるため、booking から accountKind を復元する。
      // 優先順: paymentSession.accountKind (承認時に保存済み) > propertyId から再解決。
      // 旧予約 (paymentSession.accountKind 未保存) は propertyId 経由でも同じ結果になる。
      const stripe = session.accountKind
        ? require("../utils/stripe").getStripeForKind(session.accountKind)
        : getStripeForProperty(b.propertyId || "");
      if (!stripe.isEnabled) return res.status(503).json({ error: `Stripe(${stripe.accountKind})未設定です` });

      // Stripe 実額をサーバー側でも検証する (フロントの上限検証・Stripe の過大返金拒否に加えた三重防御)。
      // PaymentIntent から実支払額と既返金額を取得し、返金可能残額を超える指定を 400 で弾く。
      let refundableAmount = null; // 取得できたときのみ検証 (取得失敗時は Stripe 側の拒否に委ねる)
      try {
        const pi = await stripe.client.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
        const charged = Number(pi && pi.amount_received) || Number(pi && pi.amount) || 0;
        const charge = pi && pi.latest_charge;
        const alreadyRefunded = (charge && Number(charge.amount_refunded)) || 0;
        if (charged > 0) refundableAmount = Math.max(0, charged - alreadyRefunded);
      } catch (piErr) {
        console.warn("[booking-requests/refund] PaymentIntent 取得失敗、上限検証はStripeに委ねる:", piErr.message);
      }
      if (refundableAmount != null && refundableAmount <= 0) {
        return res.status(400).json({ error: "返金可能な残額がありません（既に全額返金済みの可能性）" });
      }

      const refundParams = { payment_intent: paymentIntentId };
      if (amountRaw != null) {
        const amount = Number(amountRaw);
        if (!Number.isFinite(amount) || amount <= 0) {
          return res.status(400).json({ error: "amount が不正です" });
        }
        // 実支払額(残額)を超える部分返金はサーバー側で拒否 (フォールバック表示の誤り等で過大指定されても防ぐ)
        if (refundableAmount != null && Math.floor(amount) > refundableAmount) {
          return res.status(400).json({ error: `返金額が返金可能残額(¥${refundableAmount.toLocaleString("ja-JP")})を超えています` });
        }
        refundParams.amount = Math.floor(amount);
      }
      if (reason) refundParams.metadata = { reason };

      const refund = await stripe.client.refunds.create(refundParams);
      // paymentStatus 反映は charge.refunded webhook 側で確定 (SSOT)
      res.json({ ok: true, refundId: refund.id, status: refund.status, amount: refund.amount });
    } catch (e) {
      console.error("[booking-requests] 返金エラー:", e);
      res.status(500).json({ error: e.message || "返金処理に失敗しました" });
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
