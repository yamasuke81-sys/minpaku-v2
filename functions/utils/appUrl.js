/**
 * アプリURLの単一情報源 (SSOT)
 *
 * 優先順: Firestore settings/notifications.appUrl → env APP_BASE_URL → DEFAULT_APP_URL
 * カットオーバーは Firestore の appUrl を書き換えるだけで全通知リンクが切り替わる。
 *
 * CUSTOM_DOMAIN は独自ドメイン確定後にここ1箇所だけ設定する
 * （CORS ホワイトリスト・openExternalBrowser 判定が自動追従する）。
 */
const CUSTOM_DOMAIN = ""; // 例: "stay-hiroshima.com"（ドメイン購入後に設定）
const DEFAULT_APP_URL = "https://v2-5-relay.web.app";

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { url: null, at: 0 };

/**
 * 現在のアプリベースURLを返す（末尾スラッシュなし）
 * Firestore 障害時は env → 既定値へフォールバックし、例外は投げない
 */
async function getAppUrl(db) {
  const now = Date.now();
  if (cache.url && now - cache.at < CACHE_TTL_MS) return cache.url;
  let url = null;
  try {
    const doc = await db.collection("settings").doc("notifications").get();
    url = doc.exists ? (doc.data().appUrl || null) : null;
  } catch (e) {
    console.warn("[appUrl] settings/notifications 読取り失敗、フォールバック使用:", e.message);
  }
  url = (url || process.env.APP_BASE_URL || DEFAULT_APP_URL).replace(/\/+$/, "");
  cache = { url, at: now };
  return url;
}

/** テスト用: キャッシュ破棄 */
function _resetAppUrlCache() {
  cache = { url: null, at: 0 };
}

module.exports = { getAppUrl, CUSTOM_DOMAIN, DEFAULT_APP_URL, _resetAppUrlCache };
