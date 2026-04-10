/**
 * Gmail OAuth2 認証フロー
 * 個人Gmail（@gmail.com）用のOAuth2リフレッシュトークン取得
 *
 * フロー:
 *   1. ユーザーが /gmail-auth/start?email=xxx@gmail.com にアクセス
 *   2. Googleの同意画面にリダイレクト
 *   3. ユーザーが承認 → /gmail-auth/callback にリダイレクト
 *   4. 認可コードをリフレッシュトークンに交換
 *   5. Firestoreに保存 → 完了画面表示
 */
const { Router } = require("express");
const { google } = require("googleapis");

module.exports = function gmailAuthApi(db) {
  const router = Router();

  // OAuth2クライアント生成
  function getOAuth2Client_() {
    const settingsCache = gmailAuthApi._settingsCache;
    if (settingsCache) return settingsCache;
    // Cloud Functions の環境変数 or Firestore から取得
    // デフォルト: minpaku-v2 プロジェクトの OAuth クライアント
    return null; // initで上書き
  }

  // ========================================
  // OAuth2設定取得（Firestoreから）
  // ========================================
  async function getOrCreateOAuthClient_() {
    const doc = await db.collection("settings").doc("gmailOAuth").get();
    if (!doc.exists || !doc.data().clientId || !doc.data().clientSecret) {
      return null;
    }
    const { clientId, clientSecret, redirectUri } = doc.data();
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  // ========================================
  // Step 1: 認証開始（Googleの同意画面にリダイレクト）
  // ========================================
  router.get("/start", async (req, res) => {
    try {
      const email = req.query.email || "";
      const oauth2Client = await getOrCreateOAuthClient_();
      if (!oauth2Client) {
        return res.status(400).send(`
          <html><body style="font-family:sans-serif;padding:20px;">
            <h2>OAuth2クライアント未設定</h2>
            <p>Firestoreの <code>settings/gmailOAuth</code> に以下を設定してください:</p>
            <ul>
              <li><b>clientId</b>: Google Cloud Console → 認証情報 → OAuthクライアントID</li>
              <li><b>clientSecret</b>: 同上のクライアントシークレット</li>
              <li><b>redirectUri</b>: <code>https://api-5qrfx7ujcq-an.a.run.app/gmail-auth/callback</code></li>
            </ul>
            <p><a href="https://console.cloud.google.com/apis/credentials?project=minpaku-v2" target="_blank">→ Google Cloud Console 認証情報</a></p>
          </body></html>
        `);
      }

      const scopes = [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
      ];

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",  // リフレッシュトークン取得に必須
        prompt: "consent",       // 毎回同意画面を表示（リフレッシュトークン確実に取得）
        scope: scopes,
        login_hint: email,
        state: email,            // コールバックでメールアドレスを受け取る
      });

      res.redirect(authUrl);
    } catch (e) {
      console.error("OAuth2開始エラー:", e);
      res.status(500).send(`エラー: ${e.message}`);
    }
  });

  // ========================================
  // Step 2: コールバック（認可コード→トークン交換）
  // ========================================
  router.get("/callback", async (req, res) => {
    try {
      const { code, state: email, error } = req.query;
      if (error) {
        return res.send(`<html><body style="font-family:sans-serif;padding:20px;">
          <h2>認証がキャンセルされました</h2>
          <p>${error}</p>
          <a href="https://minpaku-v2.web.app/#/tax-docs">← 税理士資料に戻る</a>
        </body></html>`);
      }
      if (!code) {
        return res.status(400).send("認可コードがありません");
      }

      const oauth2Client = await getOrCreateOAuthClient_();
      if (!oauth2Client) {
        return res.status(500).send("OAuth2クライアント未設定");
      }

      // 認可コードをトークンに交換
      const { tokens } = await oauth2Client.getToken(code);

      if (!tokens.refresh_token) {
        return res.send(`<html><body style="font-family:sans-serif;padding:20px;">
          <h2>リフレッシュトークンが取得できませんでした</h2>
          <p>Googleアカウントの設定で以前の承認を取り消してから再度お試しください。</p>
          <a href="https://myaccount.google.com/permissions" target="_blank">→ Googleアカウント アクセス権</a>
          <br><br>
          <a href="https://minpaku-v2.web.app/#/tax-docs">← 税理士資料に戻る</a>
        </body></html>`);
      }

      // Firestoreに保存
      const tokenData = {
        email: email || "",
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiryDate: tokens.expiry_date,
        scope: tokens.scope,
        savedAt: new Date(),
      };

      // メールアドレスごとに保存（複数アカウント対応）
      const docId = email ? email.replace(/[@.]/g, "_") : "default";
      await db.collection("settings").doc("gmailOAuth").collection("tokens").doc(docId).set(tokenData);

      // settings/gmail にも反映
      const gmailDoc = await db.collection("settings").doc("gmail").get();
      const gmailData = gmailDoc.exists ? gmailDoc.data() : {};
      const existingEmails = (gmailData.userEmails || gmailData.userEmail || "").split(",").map(e => e.trim()).filter(Boolean);
      if (email && !existingEmails.includes(email)) {
        existingEmails.push(email);
      }
      await db.collection("settings").doc("gmail").set({
        enabled: true,
        userEmail: existingEmails[0] || email,
        userEmails: existingEmails.join(", "),
        authMethod: "oauth2",
      }, { merge: true });

      res.send(`<html><body style="font-family:sans-serif;padding:20px;">
        <h2 style="color:green;">✅ Gmail認証完了</h2>
        <p><b>${email || "アカウント"}</b> のGmail読み取り・送信権限を取得しました。</p>
        <p>リフレッシュトークンが保存され、以降は自動でメール収集が行われます。</p>
        <br>
        <a href="https://minpaku-v2.web.app/#/tax-docs" style="padding:10px 20px;background:#198754;color:white;text-decoration:none;border-radius:5px;">
          税理士資料に戻る
        </a>
      </body></html>`);
    } catch (e) {
      console.error("OAuth2コールバックエラー:", e);
      res.status(500).send(`エラー: ${e.message}`);
    }
  });

  // ========================================
  // 認証済みアカウント一覧
  // ========================================
  router.get("/accounts", async (req, res) => {
    try {
      const snap = await db.collection("settings").doc("gmailOAuth").collection("tokens").get();
      const accounts = snap.docs.map(d => ({
        email: d.data().email,
        savedAt: d.data().savedAt,
        hasRefreshToken: !!d.data().refreshToken,
      }));
      res.json({ accounts });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ========================================
  // アカウント削除
  // ========================================
  router.delete("/accounts/:email", async (req, res) => {
    try {
      const docId = req.params.email.replace(/[@.]/g, "_");
      await db.collection("settings").doc("gmailOAuth").collection("tokens").doc(docId).delete();
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
