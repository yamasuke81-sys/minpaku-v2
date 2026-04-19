/**
 * LIFF (LINE Front-end Framework) 初期化モジュール
 * LINE内蔵ブラウザでアプリを開いたとき、自動でLINEログイン → Firebase Auth を行う。
 * 外部ブラウザ（Chrome / Safari等）からのアクセスでは何もしない（従来のLINEログインボタンを使用）。
 */
const LiffClient = {
  initialized: false,
  isInClient: false,

  /**
   * LIFF 初期化 & 自動ログイン
   * Auth.init() より前に呼ぶこと（Firebase Auth ログイン完了後に onAuthStateChanged が発火するため）
   */
  async init() {
    // LIFF_ID が未設定の場合はスキップ（ユーザーが設定するまで無害）
    if (!window.LIFF_ID) {
      console.log("[LIFF] LIFF_ID が未設定のためスキップ");
      return;
    }

    try {
      await liff.init({ liffId: window.LIFF_ID });
      this.initialized = true;
      this.isInClient = liff.isInClient();

      if (!this.isInClient) {
        // 外部ブラウザからのアクセス: 従来フローに任せる
        console.log("[LIFF] 外部ブラウザ検出 — 従来LINEログインフローを使用");
        return;
      }

      console.log("[LIFF] LINE内蔵ブラウザ検出");

      // LINE未ログインなら LINE ログインを促す
      if (!liff.isLoggedIn()) {
        console.log("[LIFF] LINEログインが必要 — loginを実行");
        liff.login({ redirectUri: location.href });
        return;
      }

      // LINE プロフィール取得
      const profile = await liff.getProfile();
      console.log("[LIFF] プロフィール取得:", profile.displayName);

      // Firebase カスタムトークン取得（バックエンドでスタッフ照合）
      const res = await fetch("/api/auth/liff-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: profile.userId,
          displayName: profile.displayName,
        }),
      });

      const data = await res.json();

      if (data.success && data.customToken) {
        console.log("[LIFF] カスタムトークン取得成功 — Firebase Auth ログイン中...");
        await firebase.auth().signInWithCustomToken(data.customToken);
        // onAuthStateChanged が発火して App.onAuthReady() が呼ばれる
      } else {
        // スタッフ未登録 or エラー
        console.warn("[LIFF] ログイン失敗:", data.error);
        // エラーをログインモーダルに表示（loginModal は Auth.init() で作られる前の可能性があるためDOM直接操作）
        const errorEl = document.getElementById("loginError");
        if (errorEl) {
          errorEl.textContent = data.error || "LIFFログインに失敗しました。オーナーに招待を依頼してください。";
          errorEl.classList.remove("d-none");
        }
      }
    } catch (e) {
      console.error("[LIFF] init エラー:", e);
    }
  },
};
