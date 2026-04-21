// 共通ユーティリティ (全ページ共通でグローバル露出)

// HTML エスケープ済み文字列内の URL を <a> タグに置換
// 入力は必ず既に escape 済みであること (XSS 対策)
window.linkifyUrls = function(escapedHtml) {
  if (!escapedHtml) return "";
  return String(escapedHtml).replace(
    /(https?:\/\/[^\s<>"'（）【】]+)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>'
  );
};
