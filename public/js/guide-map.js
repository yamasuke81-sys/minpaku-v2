/**
 * ゲスト案内ページの propertyId → slug マッピング（クライアント共通）
 * 新規ガイド作成時はここに追記する。サーバー側は functions/utils/guideMap.js を同期更新。
 */
(function (global) {
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
   * @param {Object} prop  { id, guideUrl, guideUrlMode }
   * @returns {string} URL（解決不可なら空文字）
   */
  function resolveGuideUrl(prop) {
    if (!prop) return "";
    const mode = prop.guideUrlMode || "auto";
    if (mode === "manual") return prop.guideUrl || "";
    return getAutoGuideUrl(prop.id);
  }

  global.GuideMap = { GUIDE_MAP, GUIDE_BASE_URL, getAutoGuideUrl, resolveGuideUrl };
})(window);
