/**
 * Stripe Webhook 受信ハンドラ (Cloud Run HTTP, asia-northeast1)
 *
 * 署名検証には生 body が必要なので、Express 経由 (JSON parse 済み) の /api とは
 * 別の Cloud Functions エントリポイント (exports.stripeWebhook) として実装する。
 *
 * ★ 2アカウント受信 (2026-07-08〜):
 *   corporate(=八朔) と individual(=恭介個人) の 2 つの Stripe アカウントから
 *   同一エンドポイントに送られてくる。両アカウントは同じ URL を Webhook として登録するが、
 *   それぞれ別の署名シークレット (STRIPE_WEBHOOK_SECRET / STRIPE_WEBHOOK_SECRET_INDIVIDUAL)
 *   で署名されるため、両シークレットで constructEvent を順に試行し、成功した方の
 *   accountKind でイベントを処理する。片方のシークレットが未設定でも動作継続する
 *   (未設定側は verify をスキップ)。
 *
 * 受け取るイベント:
 *   - checkout.session.completed        → booking.paymentStatus=paid + paymentEvents 追記
 *   - checkout.session.async_payment_succeeded → 非同期決済の入金確定
 *   - checkout.session.expired          → booking.paymentStatus=expired + 自動キャンセル + オーナー通知
 *   - checkout.session.async_payment_failed → booking.paymentStatus=payment_failed + オーナー通知
 *   - charge.refunded                   → booking.paymentStatus=refunded (全額) or partially_refunded
 *
 * 冪等性: `${accountKind}_${event.id}` を stripeWebhookEvents/{docId} として set。
 *          異アカウント間で偶然 event.id が衝突するケース(Stripe 内部的にはアカウントごとに独立採番)
 *          を避けるため、accountKind をキー先頭に付与する。既存なら skip (二重処理防止)。
 */
const { onRequest } = require("firebase-functions/v2/https");
const {
  getStripeForKind,
  getStripeForProperty,
  getWebhookSecret,
  allStripeSecrets,
} = require("./utils/stripe");

// 遅延初期化 (webhook 単独関数のため top-level で admin.initializeApp が呼ばれていない可能性)
let _db = null;
function getDb() {
  if (_db) return _db;
  const admin = require("firebase-admin");
  if (!admin.apps.length) admin.initializeApp();
  _db = admin.firestore();
  return _db;
}

/**
 * 両アカウントの webhook シークレットで順に constructEvent を試行する。
 * @returns {{ ok: true, event: object, accountKind: "corporate"|"individual" }
 *          | { ok: false, tried: Array<{kind:string, reason:string}> }}
 */
function verifyEventDualAccount_(rawBody, signature) {
  const tried = [];
  // 両アカウントの client(Stripe SDK) と webhook secret を用意。
  // isEnabled:false (secret 未設定) の分岐はスキップして、設定済みだけで試行する。
  const kinds = ["corporate", "individual"];
  for (const kind of kinds) {
    const stripe = getStripeForKind(kind);
    const webhookSecret = getWebhookSecret(kind);
    if (!stripe.isEnabled) {
      tried.push({ kind, reason: "stripe_secret_not_configured" });
      continue;
    }
    if (!webhookSecret) {
      tried.push({ kind, reason: "webhook_secret_not_configured" });
      continue;
    }
    try {
      const event = stripe.client.webhooks.constructEvent(rawBody, signature, webhookSecret);
      return { ok: true, event, accountKind: kind };
    } catch (err) {
      tried.push({ kind, reason: err.message || "verify_failed" });
    }
  }
  return { ok: false, tried };
}

/**
 * accountKind から Stripe クライアントを取得するショートカット (handler 内で PaymentIntent 等を retrieve するとき用)。
 */
function _stripeFor(accountKind) {
  return getStripeForKind(accountKind);
}

async function handleCheckoutCompleted(db, session, accountKind) {
  const bookingId = (session.metadata && session.metadata.bookingId) || "";
  if (!bookingId) {
    console.warn(`[stripeWebhook/${accountKind}] checkout.session.completed に bookingId metadata なし:`, session.id);
    return;
  }
  // 非同期決済 (コンビニ・銀行振込) では completed が payment_status=unpaid で先に届く。
  // 実際に入金確定 (paid) したときのみ paid 化し、unpaid は async_payment_succeeded を待つ。
  // (これをしないと未入金が paid 表示になり、失敗リトライメールも「既に paid」ガードで死ぬ)
  if (session.payment_status && session.payment_status !== "paid") {
    console.info(`[stripeWebhook/${accountKind}] completed だが payment_status=${session.payment_status} → paid化せず待機: booking=${bookingId}`);
    return;
  }
  const admin = require("firebase-admin");
  const bookingRef = db.collection("bookings").doc(bookingId);
  // paymentSession は「ネストオブジェクト」で set(merge:true) する。
  // set(merge) にドット記法 "paymentSession.paidAt" を渡すと、ドット込みのリテラル名フィールドが
  // 作られてネストされず、返金API/charge.refunded 照合クエリ(where "paymentSession.paymentIntentId")
  // と永遠に不一致になる。ネストオブジェクトなら深いマージで既存の url/expiresAt も保持される。
  await bookingRef.set({
    paymentStatus: "paid",
    paymentPaidAt: admin.firestore.FieldValue.serverTimestamp(),
    paymentSession: {
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      paymentIntentId: session.payment_intent || null,
      amountPaid: Number(session.amount_total) || null,
      accountKind, // 返金 API のフォールバック用
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  console.info(`[stripeWebhook/${accountKind}] paid: booking=${bookingId} session=${session.id} amount=${session.amount_total}`);

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
    console.warn(`[stripeWebhook/${accountKind}] 支払完了通知失敗:`, e.message);
  }
}

async function handleCheckoutExpired(db, session, accountKind) {
  const bookingId = (session.metadata && session.metadata.bookingId) || "";
  const bookingRequestId = (session.metadata && session.metadata.bookingRequestId) || "";
  if (!bookingId) {
    console.warn(`[stripeWebhook/${accountKind}] checkout.session.expired に bookingId metadata なし:`, session.id);
    return;
  }
  const admin = require("firebase-admin");
  const bookingRef = db.collection("bookings").doc(bookingId);
  const snap = await bookingRef.get();
  if (!snap.exists) return;
  const b = snap.data();

  // 既に paid なら expired を無視 (race condition guard)
  if (b.paymentStatus === "paid" || b.paymentStatus === "refunded") {
    console.info(`[stripeWebhook/${accountKind}] expired skip (既に${b.paymentStatus}): booking=${bookingId}`);
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
  console.info(`[stripeWebhook/${accountKind}] expired → cancelled: booking=${bookingId}`);

  const propertyId = b.propertyId || (session.metadata && session.metadata.propertyId) || "";
  const propertyName = b.propertyName || (session.metadata && session.metadata.propertyName) || "";
  const amountRaw = Number((b.paymentSession && b.paymentSession.amount)) || Number(session.amount_total) || 0;
  const amountLabel = amountRaw ? `¥${amountRaw.toLocaleString("ja-JP")}` : "-";

  // (a) ゲストへ日英併記のキャンセル確定メール (handleAsyncPaymentFailed と同型) — 静かに失敗させる
  try {
    const { sendNotificationEmail_, resolveSenderGmail_ } = require("./utils/lineNotify");
    const to = b.email;
    if (to) {
      const guestName = b.guestName || "ゲスト";
      const subject = `【${propertyName || "ご予約"}】ご予約は自動キャンセルされました / Reservation cancelled`;
      const bodyText = [
        `${guestName} 様`,
        ``,
        `お支払い期限を過ぎたため、ご予約は自動的にキャンセルされました。`,
        `恐れ入りますが、改めてご予約いただけますようお願いいたします。`,
        ``,
        `■キャンセルされたご予約`,
        `宿泊施設: ${propertyName}`,
        `チェックイン: ${b.checkIn || ""}`,
        `チェックアウト: ${b.checkOut || ""}`,
        ``,
        `────────────────────`,
        ``,
        `Dear ${guestName},`,
        ``,
        `Your reservation has been cancelled automatically because the payment deadline has passed.`,
        `We apologize for the inconvenience — please feel free to make a new reservation.`,
        ``,
        `- Cancelled reservation`,
        `Property: ${propertyName}`,
        `Check-in: ${b.checkIn || ""}`,
        `Check-out: ${b.checkOut || ""}`,
      ].join("\n");
      const senderGmail = await resolveSenderGmail_(db, propertyId);
      await sendNotificationEmail_(to, subject, bodyText, senderGmail || null);
      console.info(`[stripeWebhook/${accountKind}] expired キャンセル確定メール送信: booking=${bookingId}`);
    } else {
      console.warn(`[stripeWebhook/${accountKind}] expired ${bookingId} メールアドレスなし、キャンセル確定メール送らず`);
    }
  } catch (e) {
    console.warn(`[stripeWebhook/${accountKind}] expired キャンセル確定メール失敗:`, e.message);
  }

  // (b) オーナー通知 (payment_expired) — 支払期限切れが判別できるよう booking_cancel 連鎖とは別に発火。
  //     onBookingChange の booking_cancel も発火するが、そちらは期限切れ起因かどうか本文から判別できないため
  //     「支払期限切れ」を明記した専用通知を追加する。静かに失敗させる (webhook 200 応答を優先)。
  try {
    const { notifyByKey } = require("./utils/lineNotify");
    await notifyByKey(db, "payment_expired", {
      title: "支払期限切れ 自動キャンセル",
      body: `⏰ 支払期限切れ 自動キャンセル\n\n宿: ${propertyName || propertyId || "-"}\n金額: ${amountLabel}\nチェックイン: ${b.checkIn || "-"}\nチェックアウト: ${b.checkOut || "-"}\n予約ID: ${bookingId}\n\n支払期限を過ぎたため予約は自動キャンセルされました。ゲストへ再予約のご案内メールを自動送信済みです。`,
      vars: {
        property: propertyName || "",
        amount: amountLabel,
      },
      propertyId,
      _fromBatchQueue: true,
    });
  } catch (e) {
    console.warn(`[stripeWebhook/${accountKind}] 支払期限切れ通知失敗:`, e.message);
  }
}

async function handleAsyncPaymentFailed(db, session, accountKind) {
  const admin = require("firebase-admin");
  const bookingId = (session.metadata && session.metadata.bookingId) || "";
  if (!bookingId) {
    console.warn(`[stripeWebhook/${accountKind}] async_payment_failed に bookingId metadata なし:`, session.id);
    return;
  }
  const bookingRef = db.collection("bookings").doc(bookingId);
  const snap = await bookingRef.get();
  if (!snap.exists) {
    console.warn(`[stripeWebhook/${accountKind}] async_payment_failed 対象 booking なし:`, bookingId);
    return;
  }
  const b = snap.data();

  // 既に支払い済み → 案内しない (race condition guard)
  if (b.paymentStatus === "paid" || b.paymentStatus === "refunded" || b.paymentStatus === "partially_refunded") {
    console.info(`[stripeWebhook/${accountKind}] async_payment_failed skip (既に${b.paymentStatus}): booking=${bookingId}`);
    return;
  }

  // paymentStatus を payment_failed に記録 (paid にはしない)
  try {
    await bookingRef.update({
      paymentStatus: "payment_failed",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn(`[stripeWebhook/${accountKind}] async_payment_failed ステータス更新失敗:`, e.message);
  }

  // 同一予約への多重送信を防止 (既に案内メール済みなら送らない)
  if (b.paymentFailedMailSentAt) {
    console.info(`[stripeWebhook/${accountKind}] async_payment_failed メール既送信スキップ: booking=${bookingId}`);
    return;
  }

  const paySession = b.paymentSession || {};
  const expiresAt = Number(paySession.expiresAt);
  const payUrl = paySession.url;
  const nowSec = Math.floor(Date.now() / 1000);

  // セッションが既に期限切れなら再試行リンクを案内しても無意味なので送らない
  if (!payUrl || !Number.isFinite(expiresAt) || expiresAt <= nowSec) {
    console.info(`[stripeWebhook/${accountKind}] async_payment_failed リンク期限切れ/未設定のため案内メール送らず: booking=${bookingId}`);
    return;
  }

  // ゲストへ再試行案内メール (日英併記) — 静かに失敗させる (webhook 200 応答を優先)
  try {
    const { sendNotificationEmail_, resolveSenderGmail_ } = require("./utils/lineNotify");
    const to = b.email;
    if (!to) {
      console.warn(`[stripeWebhook/${accountKind}] async_payment_failed ${bookingId} メールアドレスなし、案内送らず`);
      return;
    }
    const propertyId = b.propertyId || "";
    const propertyName = b.propertyName || "";
    const guestName = b.guestName || "ゲスト";
    // JST 表記 (booking-requests.js の確定メールと同じ簡易変換: UTC+9h)
    const jst = new Date(new Date(expiresAt * 1000).getTime() + 9 * 3600 * 1000)
      .toISOString().replace("T", " ").slice(0, 16);

    const subject = `【${propertyName || "ご予約"}】お支払い処理が失敗しました / Payment failed`;
    const bodyText = [
      `${guestName} 様`,
      ``,
      `ご予約のお支払い処理が失敗しました。`,
      `お支払い期限内であれば、同じお支払いページから再度お手続きいただけます。`,
      ``,
      `■ご予約内容`,
      `宿泊施設: ${propertyName}`,
      `チェックイン: ${b.checkIn || ""}`,
      `チェックアウト: ${b.checkOut || ""}`,
      `お支払い期限: ${jst} JST まで`,
      ``,
      `下記のお支払いページより再度お手続きください：`,
      `${payUrl}`,
      ``,
      `※ お支払い期限までにご決済が確認できない場合、ご予約は自動的にキャンセルとなります。`,
      ``,
      `────────────────────`,
      ``,
      `Dear ${guestName},`,
      ``,
      `Your payment could not be processed.`,
      `As long as it is within the payment deadline, you can retry from the same payment page.`,
      ``,
      `- Booking details`,
      `Property: ${propertyName}`,
      `Check-in: ${b.checkIn || ""}`,
      `Check-out: ${b.checkOut || ""}`,
      `Payment deadline: ${jst} (JST)`,
      ``,
      `Please retry your payment from the link below:`,
      `${payUrl}`,
      ``,
      `* If we cannot confirm your payment by the deadline, your reservation will be cancelled automatically.`,
    ].join("\n");

    const senderGmail = await resolveSenderGmail_(db, propertyId);
    await sendNotificationEmail_(to, subject, bodyText, senderGmail || null);
    // 送信成功時のみフラグを立てる (同一予約への多重送信防止)
    await bookingRef.update({
      paymentFailedMailSentAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.info(`[stripeWebhook/${accountKind}] async_payment_failed 案内メール送信: booking=${bookingId}`);
  } catch (e) {
    console.warn(`[stripeWebhook/${accountKind}] async_payment_failed 案内メール失敗:`, e.message);
  }
}

async function handleChargeRefunded(db, charge, accountKind) {
  const admin = require("firebase-admin");
  const paymentIntentId = charge.payment_intent;
  if (!paymentIntentId) return;
  // paymentIntentId で bookings を検索
  const snap = await db.collection("bookings")
    .where("paymentSession.paymentIntentId", "==", paymentIntentId)
    .limit(1)
    .get();
  if (snap.empty) {
    console.warn(`[stripeWebhook/${accountKind}] charge.refunded 対象 booking なし:`, paymentIntentId);
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
  console.info(`[stripeWebhook/${accountKind}] refunded(${fullyRefunded ? "full" : "partial"}): booking=${doc.id} amount=${charge.amount_refunded}`);
}

exports.stripeWebhook = onRequest({
  region: "asia-northeast1",
  invoker: "public",
  memory: "256MiB",
  timeoutSeconds: 30,
  // 4本の secret を宣言。未設定でも起動は継続 (verify 段階で個別にスキップ)。
  secrets: allStripeSecrets(),
}, async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // Cloud Functions Gen2 (Cloud Run) は req.rawBody を用意している (署名検証用)
  const sig = req.headers["stripe-signature"];
  if (!sig) {
    return res.status(400).send("Missing Stripe-Signature header");
  }

  const verified = verifyEventDualAccount_(req.rawBody, sig);
  if (!verified.ok) {
    // 両アカウントとも verify 失敗 → 400 を返し Stripe に再送させる
    // (片方だけ未設定の状態でも「未設定側は skip / 設定側で成功」なら 400 にはならない)
    console.error("[stripeWebhook] 署名検証失敗 (両アカウント):", JSON.stringify(verified.tried));
    return res.status(400).send(`Webhook Error: signature verification failed on all accounts`);
  }
  const { event, accountKind } = verified;
  console.info(`[stripeWebhook/${accountKind}] verified: type=${event.type} id=${event.id}`);

  const db = getDb();

  // 冪等性: `${accountKind}_${event.id}` を記録済みなら 200 だけ返して skip
  // (異アカウント間で event.id が偶然衝突するケースを避けるためキー先頭に accountKind を付与)
  const dedupDocId = `${accountKind}_${event.id}`;
  try {
    const dedupRef = db.collection("stripeWebhookEvents").doc(dedupDocId);
    const dedup = await dedupRef.get();
    if (dedup.exists) {
      console.info(`[stripeWebhook/${accountKind}] duplicate event skip: ${event.id}`);
      return res.status(200).send("duplicate");
    }
    const admin = require("firebase-admin");
    await dedupRef.set({
      type: event.type,
      accountKind,
      eventId: event.id,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      livemode: event.livemode || false,
    });
  } catch (dedupErr) {
    console.warn(`[stripeWebhook/${accountKind}] dedupチェック失敗、処理は継続:`, dedupErr.message);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(db, event.data.object, accountKind);
        break;
      case "checkout.session.async_payment_succeeded":
        // 銀行振込/コンビニ等の非同期決済が後から入金確定したとき。
        // completed(unpaid)では paid 化を保留しているので、ここで確定させる。
        await handleCheckoutCompleted(db, event.data.object, accountKind);
        break;
      case "checkout.session.expired":
        await handleCheckoutExpired(db, event.data.object, accountKind);
        break;
      case "checkout.session.async_payment_failed":
        // 銀行振込/コンビニで失敗した場合。paid にはしない。
        // paymentStatus=payment_failed を記録し、期限内ならゲストへ再試行案内メールを送る。
        await handleAsyncPaymentFailed(db, event.data.object, accountKind);
        break;
      case "charge.refunded":
        await handleChargeRefunded(db, event.data.object, accountKind);
        break;
      default:
        // 未対応イベントは無視 (200 返却)
        break;
    }
    return res.status(200).send("ok");
  } catch (handleErr) {
    console.error(`[stripeWebhook/${accountKind}] ${event.type} 処理失敗:`, handleErr);
    // 500 を返すと Stripe が再送してくれる (指数バックオフ)
    return res.status(500).send("handler error");
  }
});

// テスト用に verify 関数だけエクスポート (Cloud Functions のエントリポイントは exports.stripeWebhook のまま)
exports._internal = {
  verifyEventDualAccount_,
};
