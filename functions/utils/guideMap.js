/**
 * ゲスト案内ページの propertyId → slug マッピング（サーバー共通）
 * クライアント側は public/js/guide-map.js を同期更新。
 */

const GUIDE_MAP = {
  // the Terrace 長浜
  "tsZybhDMcPrxqgcRy7wp": { slug: "the-terrace-nagahama" },
  // YADO KOMACHI Hiroshima
  "RZV9IwtQgMAsvrdM3j8J": { slug: "yado-komachi-hiroshima" },
};

const GUIDE_BASE_URL = "https://v2-5-relay.web.app/guides";

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

const RELAY_HOST = "v2-5-relay.web.app";

/**
 * guideUrl に退避用(リレーアプリ)URLのフォールバックを併記したテキストブロックを返す。
 * 現行URLはそのまま残し、その下に案内文 + リレー版URLを追記する。
 * 既にリレーURLの場合は重複を避けてそのまま返す。
 * @param {string} guideUrl ゲスト案内ページURL
 * @returns {string}
 */
function buildGuideUrlBlock(guideUrl) {
  if (!guideUrl) return "";
  let relayUrl = guideUrl;
  try {
    const u = new URL(guideUrl);
    if (u.hostname === RELAY_HOST) return guideUrl; // 既にリレー → フォールバック不要
    u.hostname = RELAY_HOST;
    relayUrl = u.toString();
  } catch (_) {
    return guideUrl; // URL として解釈できなければそのまま
  }
  return `${guideUrl}\n開けない場合はこちらを開いてください:\n${relayUrl}`;
}

module.exports = { GUIDE_MAP, GUIDE_BASE_URL, getAutoGuideUrl, resolveGuideUrl, buildGuideUrlBlock };
