/**
 * Firebase Cloud Messaging Service Worker
 * バックグラウンド通知を受信して表示する
 * ※ public/ 直下に配置必須 (/firebase-messaging-sw.js でアクセス)
 */

// Firebase compat SDKをインポート
importScripts("https://www.gstatic.com/firebasejs/11.4.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/11.4.0/firebase-messaging-compat.js");

// Firebaseアプリ初期化（firebase-config.jsと同じ値）
firebase.initializeApp({
  apiKey: "AIzaSyDU4ZkCNDzvGpT9BaBlum8bCK5P20Cu-Fs",
  authDomain: "minpaku-v2.firebaseapp.com",
  projectId: "minpaku-v2",
  storageBucket: "minpaku-v2.firebasestorage.app",
  messagingSenderId: "418111574543",
  appId: "1:418111574543:web:6b2f386281e39f4d23c97a",
});

const messaging = firebase.messaging();

/**
 * バックグラウンドメッセージ受信ハンドラ
 * アプリが非表示/閉じているときに呼ばれる
 */
messaging.onBackgroundMessage((payload) => {
  console.log("[SW] バックグラウンドメッセージ受信:", payload);

  const title = payload.notification?.title || payload.data?.title || "民泊管理";
  const body = payload.notification?.body || payload.data?.body || "";
  const icon = "/img/icon-192.png";
  // data.url があればクリック時にそのページを開く
  const clickUrl = payload.data?.url || "/";

  self.registration.showNotification(title, {
    body,
    icon,
    badge: "/img/icon-72.png",
    data: { url: clickUrl },
    // 同じタグの通知は上書き（スタック防止）
    tag: payload.data?.tag || "minpaku-notification",
  });
});

/**
 * 通知クリックで該当画面にフォーカス or 新タブで開く
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      // すでに開いているウィンドウがあればフォーカス
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      // 開いていなければ新タブ
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
