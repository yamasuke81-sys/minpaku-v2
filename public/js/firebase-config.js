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

// エミュレータ使用時の設定
const USE_EMULATOR = location.hostname === "localhost" || location.hostname === "127.0.0.1";

firebase.initializeApp(firebaseConfig);

if (USE_EMULATOR) {
  firebase.auth().useEmulator("http://localhost:9099");
  firebase.firestore().useEmulator("localhost", 8080);
  console.log("🔧 Firebase Emulator に接続中");
}
