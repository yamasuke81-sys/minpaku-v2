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

const GUIDE_BASE_URL = "https://minpaku-v2.web.app/guides";

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

module.exports = { GUIDE_MAP, GUIDE_BASE_URL, getAutoGuideUrl, resolveGuideUrl };
