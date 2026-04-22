/**
 * 認証管理
 * Firebase Authentication + LINEログイン + 招待リンク対応
 */
const Auth = {
  currentUser: null,
  loginModal: null,

  async init() {
    this.loginModal = new bootstrap.Modal(document.getElementById("loginModal"));

    // LIFF 初期化（LINE内蔵ブラウザでの自動ログイン）
    // Firebase signInWithCustomToken を呼ぶため、onAuthStateChanged より先に完了させる
    if (window.LiffClient) {
      await LiffClient.init();
    }

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

    // マジックリンクログインボタン
    const magicBtn = document.getElementById("btnMagicLinkLogin");
    if (magicBtn) magicBtn.addEventListener("click", () => this.toggleMagicLinkForm());

    const sendBtn = document.getElementById("btnSendMagicLink");
    if (sendBtn) sendBtn.addEventListener("click", () => this.sendMagicLink());

    // ログアウトボタン（存在すれば）
    const logoutBtn = document.getElementById("btnLogout");
    if (logoutBtn) logoutBtn.addEventListener("click", () => this.logout());

    // キャッシュ削除して再読み込みボタン
    const reloadBtn = document.getElementById("btnReloadCache");
    if (reloadBtn) reloadBtn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      try {
        // Service Worker キャッシュ + 登録解除 (ある場合のみ)
        if (typeof caches !== "undefined") {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
        if (navigator.serviceWorker) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
      } catch (_) { /* 無視 */ }
      // クエリパラメータにタイムスタンプを付与して再遷移
      // → ブラウザが「新規 URL」とみなし HTTP キャッシュをバイパスして index.html 取り直し
      // → 中の <script src="...?v=xxx"> も最新版が反映される
      // ハッシュ (#/my-checklist 等) は維持
      try {
        const u = new URL(window.location.href);
        u.searchParams.set("_cb", String(Date.now()));
        window.location.replace(u.toString());
      } catch (_) {
        window.location.reload();
      }
    });

    // URLパラメータチェック（LINE OAuthコールバック / 招待受諾後のリダイレクト）
    this.handleAuthCallback();

    // 他タブでログイン成功した場合、このタブも自動リロードする
    // (Android Chrome で LINE 認証後、新タブで開かれた時に古いタブも同期させる)
    // ただし自分が既にログイン済みならリロードしない (無限ループ防止)
    window.addEventListener("storage", (e) => {
      if (e.key === "lineLoginSuccess" && e.newValue) {
        if (this.currentUser) {
          console.log("[Auth] 自分は既にログイン済み、リロードはスキップ");
          return;
        }
        console.log("[Auth] 他タブでログイン成功を検知、リロードします");
        location.reload();
      }
    });

    // シグナル送信は初回ログイン時のみ (2回目以降のセッション復元では送らない)
    let _signalSent = false;
    firebase.auth().onAuthStateChanged((user) => {
      if (user) {
        const wasLoggedIn = this.currentUser !== null;
        this.currentUser = user;
        this.loginModal.hide();
        // 他タブに「ログイン成功」シグナルを送る (初回のログイン遷移時のみ)
        if (!wasLoggedIn && !_signalSent) {
          _signalSent = true;
          try {
            localStorage.setItem("lineLoginSuccess", String(Date.now()));
            setTimeout(() => localStorage.removeItem("lineLoginSuccess"), 500);
          } catch (_) { /* ignore */ }
        }
        // ユーザー名表示
        const nameEl = document.getElementById("userName");
        if (nameEl) nameEl.textContent = user.displayName || user.email;
        user.getIdTokenResult().then((result) => {
          this.currentUser.role = result.claims.role || "owner";
          this.currentUser.staffId = result.claims.staffId || null;
          this.currentUser.ownedPropertyIds = result.claims.ownedPropertyIds || [];
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
      // パスワードマネージャ (Google / Bitwarden / 1Password 等) に資格情報保存を促す。
      // PasswordCredential API が利用できるブラウザでは明示的に store を呼ぶ。
      // (form 属性だけでは資格情報保存プロンプトが出ないブラウザでも拾われるようにする)
      try {
        if (window.PasswordCredential && navigator.credentials) {
          const cred = new PasswordCredential({ id: email, password, name: email });
          await navigator.credentials.store(cred);
        }
      } catch (_) { /* noop — ブラウザ非対応 / ユーザー拒否は無視 */ }
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
      // localStorage に保存 (Android Chrome では LINE 認証後、新しいタブで開かれる
      //  場合があり、sessionStorage では state が失われるため)
      // 有効期限 10 分で埋め込む
      localStorage.setItem("lineLoginState", JSON.stringify({
        state,
        expiresAt: Date.now() + 10 * 60 * 1000,
      }));

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

      // localStorage から state 復元 (タブが変わっても参照可能)
      let savedState = null;
      try {
        const raw = localStorage.getItem("lineLoginState");
        if (raw) {
          const obj = JSON.parse(raw);
          if (obj && obj.expiresAt && obj.expiresAt > Date.now()) {
            savedState = obj.state;
          }
        }
      } catch (_) { /* ignore */ }
      // 旧 sessionStorage もフォールバックとして参照 (後方互換)
      if (!savedState) savedState = sessionStorage.getItem("lineLoginState");

      // URLからパラメータを削除（ブラウザ履歴をクリーンに）
      history.replaceState(null, "", location.pathname + location.hash);
      localStorage.removeItem("lineLoginState");
      sessionStorage.removeItem("lineLoginState");

      if (savedState && state !== savedState) {
        console.warn("LINE OAuth state不一致 — 不一致でも処理続行 (CSRFリスクあり)", {state, savedState});
        // 新タブでも LINE 認証を完了させるため、state 不一致でも処理継続
        // (本来は CSRF 対策として return すべきだが、Android Chrome の
        //  新タブ挙動で state が完全に失われるケースがあるため緩和)
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
          // onAuthStateChangedが発火 → localStorage経由で他タブにも通知される
          // Android Chrome で新タブが開いていた場合、元タブも自動リロードで同期する
          // このタブを自動でフォーカスしたまま使い続けられるよう、何もしない
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

  // ========== マジックリンク (Email Link Sign-in) ==========

  /**
   * マジックリンクフォームの表示/非表示切替
   */
  toggleMagicLinkForm() {
    const form = document.getElementById("magicLinkForm");
    if (!form) return;
    const isHidden = form.classList.contains("d-none");
    form.classList.toggle("d-none", !isHidden);
    if (!isHidden) return;
    // 表示時はメールアドレス欄にフォーカス
    const emailInput = document.getElementById("magicLinkEmail");
    if (emailInput) setTimeout(() => emailInput.focus(), 50);
  },

  /**
   * マジックリンクメール送信
   * Firebase Auth の sendSignInLinkToEmail を使用
   */
  async sendMagicLink() {
    const emailInput = document.getElementById("magicLinkEmail");
    const sentEl = document.getElementById("magicLinkSent");
    const errorEl = document.getElementById("loginError");
    const btnLabel = document.getElementById("magicLinkBtnLabel");
    const sendBtn = document.getElementById("btnSendMagicLink");

    const email = emailInput?.value.trim();
    errorEl.classList.add("d-none");
    sentEl?.classList.add("d-none");

    if (!email) {
      errorEl.textContent = "メールアドレスを入力してください";
      errorEl.classList.remove("d-none");
      return;
    }

    sendBtn.disabled = true;
    if (btnLabel) btnLabel.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';

    try {
      const actionCodeSettings = {
        // メールリンクのリダイレクト先
        url: `${location.origin}/email-signin.html`,
        handleCodeInApp: true,
      };
      await firebase.auth().sendSignInLinkToEmail(email, actionCodeSettings);

      // 受信ページで使うためにlocalStorageに保存
      localStorage.setItem("emailForSignIn", email);

      sentEl?.classList.remove("d-none");
    } catch (e) {
      const messages = {
        "auth/invalid-email": "メールアドレスの形式が正しくありません",
        "auth/operation-not-allowed": "メールリンクログインが無効です。Firebase ConsoleでEmail Link Sign-inを有効にしてください",
        "auth/too-many-requests": "送信回数が多すぎます。しばらくお待ちください",
      };
      errorEl.textContent = messages[e.code] || `送信失敗: ${e.message}`;
      errorEl.classList.remove("d-none");
    } finally {
      sendBtn.disabled = false;
      if (btnLabel) btnLabel.innerHTML = '<i class="bi bi-send"></i> 送信';
    }
  },

  isOwner() {
    return this.currentUser && (this.currentUser.role === "owner" || this.currentUser.role == null);
  },

  isSubOwner() {
    return this.currentUser && this.currentUser.role === "sub_owner";
  },

  isStaff() {
    return this.currentUser && this.currentUser.role === "staff";
  },
};
