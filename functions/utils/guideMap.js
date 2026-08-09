/**
 * ゲスト案内ページの propertyId → slug マッピング（サーバー共通）
 * クライアント側は public/js/guide-map.js を同期更新。
 */

const GUIDE_MAP = {
  // the Terrace 長浜
  "tsZybhDMcPrxqgcRy7wp": { slug: "the-terrace-nagahama" },
  // YADO KOMACHI Hiroshima
  "RZV9IwtQgMAsvrdM3j8J": { slug: "yado-komachi-hiroshima" },
  // UJINA Pocket House
  "ncUKeD4yQo0kfAoznITu": { slug: "ujina-pocket-house" },
  // Pocket House WAKA-KUSA
  "ZXW6wdpnBFk1azQ87KXQ": { slug: "pocket-house-waka-kusa" },
};

// 独自ドメイン設定後は app.<domain> 配下、未設定時は relay 配下のガイドを指す
const { CUSTOM_DOMAIN, DEFAULT_APP_URL } = require("./appUrl");
const GUIDE_BASE_URL = `${CUSTOM_DOMAIN ? `https://app.${CUSTOM_DOMAIN}` : DEFAULT_APP_URL}/guides`;

function getAutoGuideUrl(propertyId) {
  const m = GUIDE_MAP[propertyId];
  if (!m || !m.slug) return "";
  return `${GUIDE_BASE_URL}/${m.slug}.html`;
}

/**
 * 物件設定からゲストガイドURLを解決する
 * @param {Object} prop  Firestore properties/{id} のデータ + id
 * @returns {string}
 */
function resolveGuideUrl(prop) {
  if (!prop) return "";
  const mode = prop.guideUrlMode || "auto";
  if (mode === "manual") return prop.guideUrl || "";
  return getAutoGuideUrl(prop.id);
}

/**
 * ゲスト案内ページURLのテキストブロックを返す。
 * かつては旧本番(minpaku-v2)が凍結していたため、リレー(v2-5-relay)版URLを
 * 「開けない場合はこちら」として併記していたが、独自ドメイン app.setouchi-stay.com が
 * 信頼できる単一URLになり、かつリレー自体も危険サイト判定を受けたため、
 * フォールバック併記は廃止する(ゲスト向け本文にリレーURLを出さない)。
 * @param {string} guideUrl ゲスト案内ページURL(独自ドメイン)
 * @param {string} [lang]   互換のため引数は残す(未使用)
 * @returns {string}
 */
function buildGuideUrlBlock(guideUrl, lang) {
  return guideUrl || "";
}

module.exports = { GUIDE_MAP, GUIDE_BASE_URL, getAutoGuideUrl, resolveGuideUrl, buildGuideUrlBlock };
