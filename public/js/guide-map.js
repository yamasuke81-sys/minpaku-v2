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

  // 独自ドメイン (window.V2_CUSTOM_DOMAIN、firebase-config.js で定義) 設定後は
  // app.<domain> 配下、未設定時は relay 配下のガイドを指す。
  // スクリプト読込順に依存しないよう呼び出し時に評価する
  function guideBaseUrl() {
    const d = global.V2_CUSTOM_DOMAIN;
    return `${d ? `https://app.${d}` : "https://v2-5-relay.web.app"}/guides`;
  }
  const GUIDE_BASE_URL = guideBaseUrl(); // 後方互換 (既存参照向け・relay 既定)

  function getAutoGuideUrl(propertyId) {
    const m = GUIDE_MAP[propertyId];
    if (!m || !m.slug) return "";
    return `${guideBaseUrl()}/${m.slug}.html`;
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
