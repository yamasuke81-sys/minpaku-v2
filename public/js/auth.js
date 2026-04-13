/**
 * 認証管理
 * Firebase Authentication + LINEログイン + 招待リンク対応
 */
const Auth = {
  currentUser: null,
  loginModal: null,

  init() {
    this.loginModal = new bootstrap.Modal(document.getElementById("loginModal"));

    document.getElementById("btnLogin").addEventListener("click", () => this.login());
    document.getElementById("loginPassword").addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.login();
    });
    document.getElementById("btnForgotPassword").addEventListener("click", (e) => {
      e.preventDefault();
      this.resetPassword();
    });

    // LINEログインボタン
    const lineBtn = document.getElementById("btnLineLogin");
    if (lineBtn) lineBtn.addEventListener("click", () => this.loginWithLine());

    // ログアウトボタン（存在すれば）
    const logoutBtn = document.getElementById("btnLogout");
    if (logoutBtn) logoutBtn.addEventListener("click", () => this.logout());

    // URLパラメータチェック（LINE OAuthコールバック / 招待受諾後のリダイレクト）
    this.handleAuthCallback();

    firebase.auth().onAuthStateChanged((user) => {
      if (user) {
        this.currentUser = user;
        this.loginModal.hide();
        // ユーザー名表示
        const nameEl = document.getElementById("userName");
        if (nameEl) nameEl.textContent = user.displayName || user.email;
        user.getIdTokenResult().then((result) => {
          this.currentUser.role = result.claims.role || "owner";
          this.currentUser.staffId = result.claims.staffId || null;
          App.onAuthReady();
        });
      } else {
        this.currentUser = null;
        this.loginModal.show();
      }
    });
  },

  /**
   * メール/パスワードログイン（オーナー用）
   */
  async login() {
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    const errorEl = document.getElementById("loginError");
    errorEl.classList.add("d-none");

    if (!email || !password) {
      errorEl.textContent = "メールアドレスとパスワードを入力してください";
      errorEl.classList.remove("d-none");
      return;
    }

    try {
      await firebase.auth().signInWithEmailAndPassword(email, password);
    } catch (e) {
      const messages = {
        "auth/user-not-found": "ユーザーが見つかりません",
        "auth/wrong-password": "パスワードが正しくありません",
        "auth/invalid-email": "メールアドレスの形式が正しくありません",
        "auth/too-many-requests": "ログイン試行回数が多すぎます",
        "auth/invalid-credential": "メールアドレスまたはパスワードが正しくありません",
      };
      errorEl.textContent = messages[e.code] || `ログイン失敗: ${e.message}`;
      errorEl.classList.remove("d-none");
    }
  },

  /**
   * LINEログイン — LINE OAuth2認可画面にリダイレクト
   * LINE Login設定はFirestoreのsettings/lineLoginに保存
   */
  async loginWithLine() {
    const errorEl = document.getElementById("loginError");
    errorEl.classList.add("d-none");

    try {
      // LINE Login チャネルIDを取得（公開情報なのでFirestoreから直接読まない）
      // settings/lineLogin.channelIdはバックエンドのみ。フロントはハードコードまたは別の方法
      // → firebase-config.jsにLINE_LOGIN_CHANNEL_IDを定義する方式
      const channelId = window.LINE_LOGIN_CHANNEL_ID;
      if (!channelId) {
        errorEl.textContent = "LINE Login設定が未完了です。オーナーに確認してください。";
        errorEl.classList.remove("d-none");
        return;
      }

      const redirectUri = `${location.origin}/index.html`;
      const state = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
      sessionStorage.setItem("lineLoginState", state);

      const params = new URLSearchParams({
        response_type: "code",
        client_id: channelId,
        redirect_uri: redirectUri,
        state,
        scope: "profile openid",
      });

      location.href = `https://access.line.me/oauth2/v2.1/authorize?${params}`;
    } catch (e) {
      errorEl.textContent = `LINEログインエラー: ${e.message}`;
      errorEl.classList.remove("d-none");
    }
  },

  /**
   * URLパラメータからOAuthコールバック or カスタムトークンを処理
   */
  async handleAuthCallback() {
    const params = new URLSearchParams(location.search);

    // LINE OAuth2コールバック: ?code=xxx&state=yyy
    if (params.has("code") && params.has("state")) {
      const code = params.get("code");
      const state = params.get("state");
      const savedState = sessionStorage.getItem("lineLoginState");

      // URLからパラメータを削除（ブラウザ履歴をクリーンに）
      history.replaceState(null, "", location.pathname + location.hash);
      sessionStorage.removeItem("lineLoginState");

      if (state !== savedState) {
        console.warn("LINE OAuth state不一致");
        return;
      }

      try {
        const redirectUri = `${location.origin}/index.html`;
        const res = await fetch("/api/auth/line-callback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, redirectUri }),
        });
        const data = await res.json();

        if (data.success && data.customToken) {
          await firebase.auth().signInWithCustomToken(data.customToken);
          // onAuthStateChangedが発火するのでここでは何もしない
        } else {
          const errorEl = document.getElementById("loginError");
          errorEl.textContent = data.error || "LINEログインに失敗しました";
          errorEl.classList.remove("d-none");
        }
      } catch (e) {
        console.error("LINE callback処理エラー:", e);
      }
      return;
    }

    // 招待受諾後のリダイレクト: ?customToken=xxx
    if (params.has("customToken")) {
      const customToken = params.get("customToken");
      history.replaceState(null, "", location.pathname + location.hash);

      try {
        await firebase.auth().signInWithCustomToken(customToken);
      } catch (e) {
        console.error("カスタムトークンログインエラー:", e);
      }
    }
  },

  async resetPassword() {
    const email = document.getElementById("loginEmail").value.trim();
    const errorEl = document.getElementById("loginError");
    const successEl = document.getElementById("loginResetSuccess");
    errorEl.classList.add("d-none");
    successEl.classList.add("d-none");

    if (!email) {
      errorEl.textContent = "メールアドレスを入力してください";
      errorEl.classList.remove("d-none");
      return;
    }

    try {
      await firebase.auth().sendPasswordResetEmail(email);
      successEl.textContent = `${email} にパスワードリセットメールを送信しました`;
      successEl.classList.remove("d-none");
    } catch (e) {
      const messages = {
        "auth/user-not-found": "このメールアドレスは登録されていません",
        "auth/invalid-email": "メールアドレスの形式が正しくありません",
        "auth/too-many-requests": "送信回数が多すぎます。しばらくお待ちください",
      };
      errorEl.textContent = messages[e.code] || `送信失敗: ${e.message}`;
      errorEl.classList.remove("d-none");
    }
  },

  async logout() {
    await firebase.auth().signOut();
  },

  isOwner() {
    return this.currentUser && this.currentUser.role === "owner";
  },

  isStaff() {
    return this.currentUser && this.currentUser.role === "staff";
  },
};
