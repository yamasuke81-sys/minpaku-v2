/**
 * Stripe Webhook 受信ハンドラ (Cloud Run HTTP, asia-northeast1)
 *
 * 署名検証には生 body が必要なので、Express 経由 (JSON parse 済み) の /api とは
 * 別の Cloud Functions エントリポイント (exports.stripeWebhook) として実装する。
 *
 * 受け取るイベント:
 *   - checkout.session.completed        → booking.paymentStatus=paid + paymentEvents 追記
 *   - checkout.session.expired          → booking.paymentStatus=expired + 自動キャンセル + オーナー通知
 *   - checkout.session.async_payment_failed → booking.paymentStatus=payment_failed + オーナー通知
 *   - charge.refunded                   → booking.paymentStatus=refunded (全額) or partially_refunded
 *
 * 冪等性: event.id を bookings/{id}/paymentEvents/{eventId} として set (merge:false)。
 *          既存なら skip (二重処理防止)。
 */
const { onRequest } = require("firebase-functions/v2/https");
const { getStripe, getWebhookSecret, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } = require("./utils/stripe");

// 遅延初期化 (webhook 単独関数のため top-level で admin.initializeApp が呼ばれていない可能性)
let _db = null;
function getDb() {
  if (_db) return _db;
  const admin = require("firebase-admin");
  if (!admin.apps.length) admin.initializeApp();
  _db = admin.firestore();
  return _db;
}

async function handleCheckoutCompleted(db, session) {
  const bookingId = (session.metadata && session.metadata.bookingId) || "";
  if (!bookingId) {
    console.warn("[stripeWebhook] checkout.session.completed に bookingId metadata なし:", session.id);
    return;
  }
  const admin = require("firebase-admin");
  const bookingRef = db.collection("bookings").doc(bookingId);
  await bookingRef.set({
    paymentStatus: "paid",
    paymentPaidAt: admin.firestore.FieldValue.serverTimestamp(),
    "paymentSession.paidAt": admin.firestore.FieldValue.serverTimestamp(),
    "paymentSession.paymentIntentId": session.payment_intent || null,
    "paymentSession.amountPaid": Number(session.amount_total) || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  console.info(`[stripeWebhook] paid: booking=${bookingId} session=${session.id} amount=${session.amount_total}`);

  // オーナー通知 (LINE/メール) — 静かに失敗させる (webhook 200 応答を優先)
  try {
    const { notifyByKey } = require("./utils/lineNotify");
    const propertyId = (session.metadata && session.metadata.propertyId) || null;
    const propertyName = (session.metadata && session.metadata.propertyName) || "";
    await notifyByKey(db, "payment_received", {
      title: "宿泊料お支払い完了",
      body: `💳 宿泊料のお支払いが完了しました\n\n宿: ${propertyName || propertyId || "-"}\n金額: ¥${Number(session.amount_total).toLocaleString("ja-JP")}\n予約ID: ${bookingId}`,
      vars: {
        property: propertyName || "",
        amount: `¥${Number(session.amount_total).toLocaleString("ja-JP")}`,
      },
      propertyId,
      _fromBatchQueue: true,
    });
  } catch (e) {
    console.warn("[stripeWebhook] 支払完了通知失敗:", e.message);
  }
}

async function handleCheckoutExpired(db, session) {
  const bookingId = (session.metadata && session.metadata.bookingId) || "";
  const bookingRequestId = (session.metadata && session.metadata.bookingRequestId) || "";
  if (!bookingId) {
    console.warn("[stripeWebhook] checkout.session.expired に bookingId metadata なし:", session.id);
    return;
  }
  const admin = require("firebase-admin");
  const bookingRef = db.collection("bookings").doc(bookingId);
  const snap = await bookingRef.get();
  if (!snap.exists) return;
  const b = snap.data();

  // 既に paid なら expired を無視 (race condition guard)
  if (b.paymentStatus === "paid" || b.paymentStatus === "refunded") {
    console.info(`[stripeWebhook] expired skip (既に${b.paymentStatus}): booking=${bookingId}`);
    return;
  }

  // 予約を自動キャンセル
  //   syncSource:direct なので syncIcal の自動キャンセルとは干渉しない。
  //   status:"cancelled" にすると availability から外れ、iCal フィードから消え、
  //   onBookingChange で cancel 通知が発火する (連鎖処理はそちらに任せる)。
  await bookingRef.update({
    paymentStatus: "expired",
    status: "cancelled",
    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
    cancelReason: "payment_expired",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // bookingRequest も expired に (再申請可能にはしない — オーナー判断で対応)
  if (bookingRequestId) {
    try {
      await db.collection("bookingRequests").doc(bookingRequestId).update({
        paymentStatus: "expired",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) { /* not critical */ }
  }
  console.info(`[stripeWebhook] expired → cancelled: booking=${bookingId}`);
}

async function handleChargeRefunded(db, charge) {
  const admin = require("firebase-admin");
  const paymentIntentId = charge.payment_intent;
  if (!paymentIntentId) return;
  // paymentIntentId で bookings を検索
  const snap = await db.collection("bookings")
    .where("paymentSession.paymentIntentId", "==", paymentIntentId)
    .limit(1)
    .get();
  if (snap.empty) {
    console.warn("[stripeWebhook] charge.refunded 対象 booking なし:", paymentIntentId);
    return;
  }
  const doc = snap.docs[0];
  const fullyRefunded = charge.amount_refunded >= charge.amount;
  await doc.ref.update({
    paymentStatus: fullyRefunded ? "refunded" : "partially_refunded",
    "paymentSession.amountRefunded": charge.amount_refunded,
    "paymentSession.refundedAt": admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.info(`[stripeWebhook] refunded(${fullyRefunded ? "full" : "partial"}): booking=${doc.id} amount=${charge.amount_refunded}`);
}

exports.stripeWebhook = onRequest({
  region: "asia-northeast1",
  invoker: "public",
  memory: "256MiB",
  timeoutSeconds: 30,
  secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET],
}, async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }
  const stripe = getStripe();
  if (!stripe.isEnabled) {
    return res.status(503).send("Stripe not configured");
  }
  const webhookSecret = getWebhookSecret();
  if (!webhookSecret) {
    return res.status(503).send("Webhook secret not configured");
  }

  // Cloud Functions Gen2 (Cloud Run) は req.rawBody を用意している (署名検証用)
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.client.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("[stripeWebhook] 署名検証失敗:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const db = getDb();

  // 冪等性: event.id を記録済みなら 200 だけ返して skip
  try {
    const dedupRef = db.collection("stripeWebhookEvents").doc(event.id);
    const dedup = await dedupRef.get();
    if (dedup.exists) {
      console.info(`[stripeWebhook] duplicate event skip: ${event.id}`);
      return res.status(200).send("duplicate");
    }
    const admin = require("firebase-admin");
    await dedupRef.set({
      type: event.type,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      livemode: event.livemode || false,
    });
  } catch (dedupErr) {
    console.warn("[stripeWebhook] dedupチェック失敗、処理は継続:", dedupErr.message);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(db, event.data.object);
        break;
      case "checkout.session.expired":
        await handleCheckoutExpired(db, event.data.object);
        break;
      case "checkout.session.async_payment_failed":
        // 銀行振込/コンビニで失敗した場合。paid にはしない。
        console.warn("[stripeWebhook] async_payment_failed:", event.data.object.id);
        break;
      case "charge.refunded":
        await handleChargeRefunded(db, event.data.object);
        break;
      default:
        // 未対応イベントは無視 (200 返却)
        break;
    }
    return res.status(200).send("ok");
  } catch (handleErr) {
    console.error(`[stripeWebhook] ${event.type} 処理失敗:`, handleErr);
    // 500 を返すと Stripe が再送してくれる (指数バックオフ)
    return res.status(500).send("handler error");
  }
});
