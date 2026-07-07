/**
 * Stripe クライアント共通ユーティリティ
 *
 * - 秘密鍵は Firebase Functions Secrets (defineSecret) で管理する
 *   (Firestore 平文保存や Secret Manager 直接管理より安全 + 監査ログが残る)
 * - テストキー/本番キーの区別は鍵プレフィックス (`sk_test_` / `sk_live_`) で自動判定
 *   → 本番デプロイでもテストキーが混入していれば isLive:false になる
 * - キー未設定なら isEnabled:false を返す。呼び出し側は決済無効モードで動作を継続する
 *   (承認自体は成立させる。決済案内だけ従来の暫定文面に戻す)
 *
 * 呼び出し側:
 *   const { getStripe } = require("../utils/stripe");
 *   const s = getStripe();
 *   if (!s.isEnabled) { ... 決済リンク無しで確定メール ... }
 *   const session = await s.client.checkout.sessions.create({...});
 */
const { defineSecret } = require("firebase-functions/params");

const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

let cachedClient = null;
let cachedKey = null;

function getStripe() {
  const key = STRIPE_SECRET_KEY.value();
  if (!key) {
    return { isEnabled: false, isLive: false, client: null, secret: STRIPE_SECRET_KEY };
  }
  if (cachedClient && cachedKey === key) {
    return { isEnabled: true, isLive: key.startsWith("sk_live_"), client: cachedClient, secret: STRIPE_SECRET_KEY };
  }
  const Stripe = require("stripe");
  cachedClient = new Stripe(key, {
    apiVersion: "2025-08-27.basil",
    telemetry: false,
    appInfo: { name: "setouchi-stay/minpaku-v2", version: "0.1.0" },
  });
  cachedKey = key;
  return { isEnabled: true, isLive: key.startsWith("sk_live_"), client: cachedClient, secret: STRIPE_SECRET_KEY };
}

function getWebhookSecret() {
  return STRIPE_WEBHOOK_SECRET.value() || "";
}

module.exports = {
  getStripe,
  getWebhookSecret,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
};
