/**
 * 緊急回避: v2-5-relay.web.app から minpaku-v2 backend の Cloud Run API を直接叩く
 *
 * 通常時 (minpaku-v2.web.app) では Firebase Hosting の rewrite で /api/** → Cloud Run "api"
 * に転送されているが、v2-5-relay からは cross-project rewrite ができないため、
 * fetch を monkey-patch して /api/X を https://api-5qrfx7ujcq-an.a.run.app/X に書き換える。
 *
 * 元プロジェクトのサイト復活後はこのファイルと <script> 参照を削除すれば元に戻る。
 */
(function () {
  // ホスト名が v2-5-relay のときだけ有効化 (本番では何もしない)
  if (!/^v2-5-relay(?:--|\.)/i.test(location.hostname) && location.hostname !== "v2-5-relay.web.app") {
    return;
  }
  var API_BASE = "https://api-5qrfx7ujcq-an.a.run.app";
  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      if (typeof input === "string" && input.indexOf("/api/") === 0) {
        input = API_BASE + input.substring(4); // "/api" を剥がす
      } else if (input && typeof input === "object" && typeof input.url === "string" && input.url.indexOf("/api/") === 0) {
        // Request オブジェクトの場合
        var newUrl = API_BASE + input.url.substring(4);
        input = new Request(newUrl, input);
      }
    } catch (e) {
      console.warn("[api-relay] rewrite skipped:", e);
    }
    return origFetch(input, init);
  };
  console.log("[api-relay] fetch interceptor armed: /api/** -> " + API_BASE);
})();
