/**
 * Stripe クライアント共通ユーティリティ (2アカウント対応版)
 *
 * ★ 前提: 物件によって受入先の Stripe アカウントが異なる。
 *   - corporate = 合同会社八朔 (法人): the Terrace / 安芸津 / 竹原 / 音戸
 *   - individual = 西山恭介個人事業: 小町 / 若草
 *   - none = 決済無効 (Stripe 未用意): UJINA (宇品)。運営=tomi企画で八朔口座に入れてはいけないが、
 *     tomi企画の Stripe を用意しない方針のため直販 Stripe 決済を一切行わない (当面 OTA のみ)。
 *     isEnabled:false を返し、呼び出し側は決済リンク無し(確定メールのみ)にフォールバックする。
 *   運営者(=売上帰属)の違いに合わせて Stripe アカウントへ振り分ける。
 *
 * ★ Secrets:
 *   - STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET
 *       法人(=corporate) 用。歴史的経緯からデフォルト扱い。
 *   - STRIPE_SECRET_KEY_INDIVIDUAL / STRIPE_WEBHOOK_SECRET_INDIVIDUAL
 *       個人事業(=individual) 用。未設定でも起動は継続 (該当物件だけ決済無しモードにフォールバック)。
 *
 * ★ 段階切替:
 *   - どちらか片方だけの設定でも動く。未設定側の accountKind は isEnabled:false を返し、
 *     呼び出し側で allowTestCheckout ガード同様に決済リンク無しへフォールバックする想定。
 *   - webhook も両シークレットで順に constructEvent を試行するので、片方だけ登録された状態でも
 *     Stripe → Firebase のイベント配信は素通しできる。
 *
 * ★ テストキー/本番キー: 鍵プレフィックス (`sk_test_` / `sk_live_`) で isLive を判定。
 *   本番デプロイでもテストキーが混入していれば isLive:false になる (誤リンク送信の事故防止)。
 *
 * 使い方:
 *   const { getStripeForProperty, getStripeForKind, getStripe } = require("../utils/stripe");
 *   const s = getStripeForProperty(propertyId); // 物件から自動判定
 *   if (!s.isEnabled) { ... 決済リンク無しで確定メール ... }
 *   const session = await s.client.checkout.sessions.create({...});
 */
const { defineSecret } = require("firebase-functions/params");

// 法人(=corporate=八朔)。互換性のため元の名前を維持。
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");
// 個人事業(=individual=恭介個人)。新規。
const STRIPE_SECRET_KEY_INDIVIDUAL = defineSecret("STRIPE_SECRET_KEY_INDIVIDUAL");
const STRIPE_WEBHOOK_SECRET_INDIVIDUAL = defineSecret("STRIPE_WEBHOOK_SECRET_INDIVIDUAL");

// ---------------------------------------------------------------
// 物件 → アカウント振り分けマップ
// ---------------------------------------------------------------
// 将来的に Firestore (`stripeAccounts` コレクション等) へ外出しする余地を残す。
// いまは物件数が少ないためコード内定数で十分。ID は project_minpaku_v2_context に準拠。
const PROPERTY_TO_STRIPE_ACCOUNT = {
  "RZV9IwtQgMAsvrdM3j8J": "individual", // YADO KOMACHI 小町 (西山恭介個人事業)
  "ZXW6wdpnBFk1azQ87KXQ": "individual", // Pocket House WAKA-KUSA (西山恭介個人事業)
  "tsZybhDMcPrxqgcRy7wp": "corporate",  // the Terrace 長浜 (合同会社八朔)
  "ncUKeD4yQo0kfAoznITu": "none",       // UJINA Pocket House (運営=tomi企画。八朔口座に入れない・Stripe未用意=決済無効)
  // 新3宿 (2026-07-09 追記)。運営=合同会社八朔=corporate。
  // 既定も corporate のため実挙動は変わらないが、未マップ時の暗黙フォールバック依存を排し、
  // 将来 DEFAULT が変わっても誤って個人口座へ流れないよう明示登録する。決済open前に必須。
  "nM5JdfecBDdRvTovqVD7": "corporate",  // 安芸津小松原 (合同会社八朔)
  "uzGpqAYqFWZxBygPhllv": "corporate",  // 竹原市下野 (合同会社八朔)
  "OXWgBcBWnmqFZSVpjAcn": "corporate",  // 音戸町鰯浜2-3-6 (合同会社八朔)
};

const DEFAULT_ACCOUNT_KIND = "corporate";
const DISABLED_KIND = "none"; // 決済を行わない物件(Stripe アカウントを持たない)。isEnabled:false を返す。
const VALID_KINDS = new Set(["corporate", "individual"]);

// アカウントごとの Stripe クライアントキャッシュ
const _cache = {
  corporate: { client: null, key: null },
  individual: { client: null, key: null },
};

function _secretForKind(kind) {
  return kind === "individual" ? STRIPE_SECRET_KEY_INDIVIDUAL : STRIPE_SECRET_KEY;
}
function _webhookSecretForKind(kind) {
  return kind === "individual" ? STRIPE_WEBHOOK_SECRET_INDIVIDUAL : STRIPE_WEBHOOK_SECRET;
}

/**
 * 指定 accountKind の Stripe クライアントを返す。
 * @param {"corporate"|"individual"} kind
 * @returns {{ isEnabled: boolean, isLive: boolean, client: object|null, secret: object, accountKind: string }}
 */
function getStripeForKind(kind) {
  // 決済無効物件(none): Stripe クライアントを生成せず isEnabled:false を返す。
  // 呼び出し側は !isEnabled で決済リンク無し(確定メールのみ)にフォールバックする。
  if (kind === DISABLED_KIND) {
    return { isEnabled: false, isLive: false, client: null, secret: null, accountKind: DISABLED_KIND };
  }
  const accountKind = VALID_KINDS.has(kind) ? kind : DEFAULT_ACCOUNT_KIND;
  const secret = _secretForKind(accountKind);
  let key = "";
  try {
    key = secret.value();
  } catch (_e) {
    // defineSecret 未バインド時 (エミュレータ等) に例外が飛ぶことがあるため握りつぶす
    key = "";
  }
  if (!key) {
    return { isEnabled: false, isLive: false, client: null, secret, accountKind };
  }
  const cache = _cache[accountKind];
  if (cache.client && cache.key === key) {
    return { isEnabled: true, isLive: key.startsWith("sk_live_"), client: cache.client, secret, accountKind };
  }
  const Stripe = require("stripe");
  cache.client = new Stripe(key, {
    apiVersion: "2025-08-27.basil",
    telemetry: false,
    appInfo: { name: `setouchi-stay/minpaku-v2 (${accountKind})`, version: "0.2.0" },
  });
  cache.key = key;
  return { isEnabled: true, isLive: key.startsWith("sk_live_"), client: cache.client, secret, accountKind };
}

/**
 * 物件 ID から accountKind を解決する (未マップは corporate にフォールバック + warn ログ)。
 */
function resolveAccountKind(propertyId) {
  if (!propertyId) return DEFAULT_ACCOUNT_KIND;
  const kind = PROPERTY_TO_STRIPE_ACCOUNT[propertyId];
  if (!kind) {
    console.warn(`[stripe] propertyId=${propertyId} は PROPERTY_TO_STRIPE_ACCOUNT に未登録。既定(${DEFAULT_ACCOUNT_KIND})へフォールバック。`);
    return DEFAULT_ACCOUNT_KIND;
  }
  return kind;
}

/**
 * 物件から適切な Stripe クライアントを返す。返り値は getStripe と同型 (accountKind 追加)。
 */
function getStripeForProperty(propertyId) {
  const kind = resolveAccountKind(propertyId);
  return getStripeForKind(kind);
}

/**
 * 後方互換 API。propertyId 不明時 (旧コード互換) は corporate を返す。
 * 新規コードは getStripeForProperty を使うこと。
 */
function getStripe() {
  return getStripeForKind(DEFAULT_ACCOUNT_KIND);
}

/**
 * webhook 用シークレット文字列を返す。
 * 引数省略時は corporate (後方互換)。
 */
function getWebhookSecret(kind) {
  const target = VALID_KINDS.has(kind) ? kind : DEFAULT_ACCOUNT_KIND;
  const secret = _webhookSecretForKind(target);
  try {
    return secret.value() || "";
  } catch (_e) {
    return "";
  }
}

/**
 * webhook で使う両アカウントのシークレット定義を返す (Cloud Functions の secrets: に渡す用)。
 * 未設定でも defineSecret ハンドル自体は存在するので配列で常に渡してよい。
 */
function allStripeSecrets() {
  return [
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
    STRIPE_SECRET_KEY_INDIVIDUAL,
    STRIPE_WEBHOOK_SECRET_INDIVIDUAL,
  ];
}

module.exports = {
  // 新 API
  getStripeForProperty,
  getStripeForKind,
  resolveAccountKind,
  allStripeSecrets,
  PROPERTY_TO_STRIPE_ACCOUNT,
  DEFAULT_ACCOUNT_KIND,
  DISABLED_KIND,
  // 後方互換 API
  getStripe,
  getWebhookSecret,
  // Secrets ハンドル (index.js / stripeWebhook.js が secrets: 配列に渡す)
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_SECRET_KEY_INDIVIDUAL,
  STRIPE_WEBHOOK_SECRET_INDIVIDUAL,
};
