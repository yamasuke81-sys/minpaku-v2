/**
 * PWA インストールバナー
 * iOS Safari でホーム画面に追加されていない場合、案内バナーを表示する。
 * 「閉じる」を押したら localStorage に記録し、以後は非表示。
 */
(function () {
  const STORAGE_KEY = "pwa_banner_dismissed";

  // すでに閉じた場合はスキップ
  if (localStorage.getItem(STORAGE_KEY)) return;

  // iOS Safari 判定
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  // スタンドアロン（PWA）起動済み判定
  const isStandalone =
    window.navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;

  if (!isIOS || isStandalone) return;

  // バナー要素生成
  const banner = document.createElement("div");
  banner.id = "pwa-install-banner";
  banner.style.cssText = [
    "position:fixed",
    "bottom:16px",
    "left:50%",
    "transform:translateX(-50%)",
    "z-index:9999",
    "background:#0d6efd",
    "color:#fff",
    "border-radius:12px",
    "padding:10px 16px",
    "display:flex",
    "align-items:center",
    "gap:10px",
    "box-shadow:0 4px 16px rgba(0,0,0,0.25)",
    "max-width:calc(100vw - 32px)",
    "font-size:13px",
    "line-height:1.4",
  ].join(";");

  banner.innerHTML = `
    <span style="flex:1">
      <b>📲 通知を受け取るには</b><br>
      「共有」→「ホーム画面に追加」でインストールしてください
    </span>
    <button id="pwa-banner-close"
      style="background:transparent;border:none;color:#fff;font-size:20px;line-height:1;cursor:pointer;padding:0 4px;"
      aria-label="閉じる">&times;</button>
  `;

  // DOMContentLoaded 後に追加
  function mountBanner() {
    document.body.appendChild(banner);
    document.getElementById("pwa-banner-close").addEventListener("click", function () {
      banner.remove();
      localStorage.setItem(STORAGE_KEY, "1");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountBanner);
  } else {
    mountBanner();
  }
})();
