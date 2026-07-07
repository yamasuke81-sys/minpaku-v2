/**
 * サーバー内部から見積を再計算するヘルパー
 *
 * public.js の GET /public/quote と同じロジックを、Firestore admin SDK で再利用可能にする。
 * 承認 API や Stripe Webhook から呼び出して、決済金額をサーバー側で決定的に確定させる用途。
 * (フロントから金額を渡させると改ざんリスク → サーバー側で毎回再計算する)
 */
const { computeQuote } = require("../api/pricing-logic");

async function computeQuoteFromDb(db, propertyId, { checkIn, checkOut, guests, plan }) {
  const admin = require("firebase-admin");
  const ratesDoc = await db.collection("propertyRates").doc(propertyId).get();
  if (!ratesDoc.exists) {
    return { ok: false, error: "propertyRates_not_configured", hasRates: false };
  }
  const rates = ratesDoc.data();

  const overrides = {};
  try {
    const ovSnap = await db.collection("propertyRates").doc(propertyId).collection("overrides")
      .where(admin.firestore.FieldPath.documentId(), ">=", checkIn)
      .where(admin.firestore.FieldPath.documentId(), "<", checkOut)
      .get();
    ovSnap.forEach((d) => { overrides[d.id] = d.data(); });
  } catch (ovErr) {
    // overrides 取得失敗は fatal ではない
    console.warn("[pricing/computeQuoteFromDb] overrides 取得失敗:", ovErr.message);
  }

  const result = computeQuote({ rates, checkIn, checkOut, guests, plan, overrides });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, quote: result.quote, hasRates: true };
}

module.exports = { computeQuoteFromDb };
