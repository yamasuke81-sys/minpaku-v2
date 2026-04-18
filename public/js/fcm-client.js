/**
 * FCM (Firebase Cloud Messaging) クライアント
 * Service Worker登録、トークン取得、フォアグラウンド通知表示
 *
 * 使い方:
 *   await FCMClient.init();            // ページロード時
 *   await FCMClient.requestAndSave();  // 「通知をオンにする」ボタン押下時
 */
const FCMClient = {
  // VAPID公開キー（Firebase Console → プロジェクト設定 → Cloud Messaging → Web プッシュ証明書で生成）
  // ※ 生成後にここを更新してデプロイしてください
  VAPID_KEY: window.FCM_VAPID_KEY || "",

  messaging: null,
  _initialized: false,

  /**
   * FCM初期化
   * - Service Worker登録
   * - firebase.messaging()インスタンス作成
   * - フォアグラウンド通知ハンドラ登録
   */
  async init() {
    if (this._initialized) return;
    if (!("serviceWorker" in navigator) || !("Notification" in window)) {
      console.warn("[FCM] このブラウザはPush通知に対応していません");
      return;
    }

    try {
      // Service Worker 登録 (scope明示 + 登録オブジェクトを保持)
      this.swRegistration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");

      this.messaging = firebase.messaging();

      // フォアグラウンド通知（アプリ表示中）はBootstrap Toastで表示
      this.messaging.onMessage((payload) => {
        console.log("[FCM] フォアグラウンドメッセージ:", payload);
        const title = payload.notification?.title || payload.data?.title || "民泊管理";
        const body = payload.notification?.body || payload.data?.body || "";
        this._showToast(title, body, payload.data?.url);
      });

      this._initialized = true;
      console.log("[FCM] 初期化完了");
    } catch (e) {
      console.error("[FCM] 初期化失敗:", e);
    }
  },

  /**
   * 通知許可リクエスト + トークン取得 + サーバー保存
   * @returns {Promise<{success: boolean, token?: string, error?: string}>}
   */
  async requestAndSave() {
    if (!this._initialized) await this.init();
    if (!this.messaging) {
      return { success: false, error: "FCM未初期化" };
    }
    if (!this.VAPID_KEY) {
      console.warn("[FCM] VAPID_KEY未設定。Firebase ConsoleでVAPIDキーを生成してfcm-client.jsに設定してください");
      return { success: false, error: "VAPIDキー未設定" };
    }

    try {
      // 通知許可リクエスト
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        return { success: false, error: `通知が拒否されました (${permission})` };
      }

      // FCMトークン取得 (SW登録を明示的に渡して scope 不一致を回避)
      const getTokenOpts = { vapidKey: this.VAPID_KEY };
      if (this.swRegistration) getTokenOpts.serviceWorkerRegistration = this.swRegistration;
      const token = await this.messaging.getToken(getTokenOpts);
      if (!token) {
        return { success: false, error: "トークン取得失敗" };
      }

      // サーバーに保存
      await this._saveToken(token);
      return { success: true, token };
    } catch (e) {
      console.error("[FCM] トークン取得失敗:", e);
      return { success: false, error: e.message };
    }
  },

  /**
   * 現在の通知許可状態を返す
   * @returns {"granted"|"denied"|"default"|"unsupported"}
   */
  getPermissionStatus() {
    if (!("Notification" in window)) return "unsupported";
    return Notification.permission;
  },

  /**
   * トークンをサーバー(staffドキュメント or settings/fcmTokens)に保存
   * @param {string} token
   */
  async _saveToken(token) {
    const user = Auth?.currentUser;
    if (!user) {
      console.warn("[FCM] 未ログイン状態でのトークン保存は不可");
      return;
    }

    const idToken = await user.getIdToken();
    const staffId = user.staffId || null;

    const role = user.role || null;
    const isOwner = role === "owner" || role === null; // null=既存オーナー互換

    if (staffId) {
      // スタッフ: /staff/:id/fcm-token エンドポイントに保存
      const res = await fetch(`/api/staff/${staffId}/fcm-token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${idToken}`,
        },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error("[FCM] スタッフトークン保存失敗:", err);
      }
    } else if (isOwner) {
      // オーナーのみ: settings/fcmTokensドキュメントに直接書き込み (Rulesで許可)
      try {
        await firebase.firestore().collection("settings").doc("fcmTokens").set(
          { ownerTokens: firebase.firestore.FieldValue.arrayUnion(token) },
          { merge: true }
        );
      } catch (e) {
        console.error("[FCM] オーナートークン保存失敗:", e);
      }
    } else {
      // スタッフロールだが staffId 未解決 → 権限エラー回避のためスキップ
      console.warn("[FCM] staffId 未解決のためトークン保存をスキップ");
      return;
    }
    console.log("[FCM] トークン保存完了:", token.slice(0, 20) + "...");
  },

  /**
   * フォアグラウンド通知をBootstrap Toastで表示
   * @param {string} title
   * @param {string} body
   * @param {string|undefined} url クリック時遷移先
   */
  _showToast(title, body, url) {
    // Toast コンテナがなければ作成
    let container = document.getElementById("fcmToastContainer");
    if (!container) {
      container = document.createElement("div");
      container.id = "fcmToastContainer";
      container.className = "toast-container position-fixed top-0 end-0 p-3";
      container.style.zIndex = "9999";
      document.body.appendChild(container);
    }

    const toastId = `fcmToast_${Date.now()}`;
    const clickHandler = url ? `onclick="location.href='${url}';return false;"` : "";
    const toastHtml = `
      <div id="${toastId}" class="toast align-items-center border-0 bg-primary text-white" role="alert" aria-live="assertive">
        <div class="d-flex">
          <div class="toast-body" ${clickHandler} style="${url ? "cursor:pointer;" : ""}">
            <strong><i class="bi bi-bell-fill me-1"></i>${title}</strong><br>
            <small>${body}</small>
          </div>
          <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
        </div>
      </div>
    `;
    container.insertAdjacentHTML("beforeend", toastHtml);

    const el = document.getElementById(toastId);
    const toast = new bootstrap.Toast(el, { delay: 6000 });
    toast.show();

    // 表示後にDOMを削除
    el.addEventListener("hidden.bs.toast", () => el.remove());
  },
};
