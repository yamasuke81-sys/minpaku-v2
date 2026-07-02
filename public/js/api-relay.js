/**
 * /api/** を minpaku-v2 backend の Cloud Run へ直接リレーする fetch パッチ
 *
 * Firebase Hosting の rewrite (/api/** → Cloud Run "api") が機能するのは
 * minpaku-v2 プロジェクト内のホスティングと localhost (emulator) のみ。
 * v2-5-relay や独自ドメインなど他プロジェクトのサイトからは cross-project rewrite が
 * できないため、rewrite が効くホスト以外では常に fetch を monkey-patch して
 * /api/X を https://api-5qrfx7ujcq-an.a.run.app/X に書き換える。
 *
 * 判定を「rewriteが効くホストの除外リスト」にしてあるので、
 * 新しい配信ドメインを足してもこのファイルの変更は不要。
 */
(function () {
  // rewrite が機能するホストでは何もしない (minpaku-v2 プロジェクト内 + ローカル)
  var h = location.hostname;
  if (/^minpaku-v2(?:--[\w-]+)?\.(?:web\.app|firebaseapp\.com)$/i.test(h) ||
      h === "localhost" || h === "127.0.0.1") {
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
