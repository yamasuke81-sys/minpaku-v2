/**
 * Firebase 初期化設定
 * Firebase Console → プロジェクト設定 → マイアプリ から値を取得して設定
 */
const firebaseConfig = {
  apiKey: "AIzaSyDU4ZkCNDzvGpT9BaBlum8bCK5P20Cu-Fs",
  authDomain: "minpaku-v2.firebaseapp.com",
  projectId: "minpaku-v2",
  storageBucket: "minpaku-v2.firebasestorage.app",
  messagingSenderId: "418111574543",
  appId: "1:418111574543:web:6b2f386281e39f4d23c97a",
  measurementId: "G-B1NWL65MDX",
};

// エミュレータ使用時の設定（localhost / 127.0.0.1 どちらでも動作）
const USE_EMULATOR = location.hostname === "localhost" || location.hostname === "127.0.0.1";

firebase.initializeApp(firebaseConfig);

if (USE_EMULATOR) {
  firebase.auth().useEmulator("http://127.0.0.1:9099");
  firebase.firestore().useEmulator("127.0.0.1", 8080);
  console.log("[Emulator] Firebase Emulator に接続中 (auth:9099, firestore:8080)");
}

// LINE Login チャネルID（LINE Developers Console → LINE Login → Channel ID）
// スタッフのLINEログインに使用。未設定の場合はLINEログインボタンが無効になる
window.LINE_LOGIN_CHANNEL_ID = "2009790221";

// FCM VAPID 公開キー (Firebase Console → プロジェクト設定 → Cloud Messaging → ウェブプッシュ証明書)
// Web Push 通知のトークン取得に使用
window.FCM_VAPID_KEY = "BNQ2p2-IZDYu4Ru5PvMzKtZWbuZ5pq07ln8SJL-gat-Ky85EjIYNVuDYHZWbhPo9NJ-X8rzVpaRiTgW5Cp0Evu8";
