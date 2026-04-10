/**
 * 認証管理
 * Firebase Authenticationでログイン
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

    // ログアウトボタン（存在すれば）
    const logoutBtn = document.getElementById("btnLogout");
    if (logoutBtn) logoutBtn.addEventListener("click", () => this.logout());

    firebase.auth().onAuthStateChanged((user) => {
      if (user) {
        this.currentUser = user;
        this.loginModal.hide();
        // ユーザー名表示
        const nameEl = document.getElementById("userName");
        if (nameEl) nameEl.textContent = user.displayName || user.email;
        user.getIdTokenResult().then((result) => {
          this.currentUser.role = result.claims.role || "owner";
          App.onAuthReady();
        });
      } else {
        this.currentUser = null;
        this.loginModal.show();
      }
    });
  },

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
};
