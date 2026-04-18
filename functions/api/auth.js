/**
 * 認証API — スタッフ招待・LINEログイン・ロール管理
 * authenticateミドルウェアの前に登録（一部エンドポイントは認証不要）
 */
const express = require("express");
const https = require("https");
const crypto = require("crypto");
const admin = require("firebase-admin");

module.exports = function authApi(db) {
  const router = express.Router();

  // ========== 認証不要エンドポイント ==========

  /**
   * POST /auth/line-callback
   * LINE OAuth2コールバック → Firebase Authカスタムトークン発行
   * リクエスト: { code: string, redirectUri: string }
   */
  router.post("/line-callback", async (req, res) => {
    try {
      const { code, redirectUri } = req.body;
      if (!code) {
        return res.status(400).json({ error: "認可コードが必要です" });
      }

      // LINE Login設定取得
      const settingsDoc = await db.collection("settings").doc("lineLogin").get();
      if (!settingsDoc.exists) {
        return res.status(500).json({ error: "LINE Login設定が未登録です" });
      }
      const { channelId, channelSecret } = settingsDoc.data();
      if (!channelId || !channelSecret) {
        return res.status(500).json({ error: "LINE Login設定が不完全です" });
      }

      // LINE トークンエンドポイントで認可コード→アクセストークン取得
      const tokenResult = await lineTokenExchange_(channelId, channelSecret, code, redirectUri);
      if (!tokenResult.success) {
        return res.status(401).json({ error: `LINEトークン取得失敗: ${tokenResult.error}` });
      }

      // LINE プロフィール取得
      const profile = await lineGetProfile_(tokenResult.accessToken);
      if (!profile.success) {
        return res.status(401).json({ error: `LINEプロフィール取得失敗: ${profile.error}` });
      }

      const lineUserId = profile.userId;
      const displayName = profile.displayName;

      // staffコレクションでlineUserId照合
      const staffSnap = await db.collection("staff")
        .where("lineUserId", "==", lineUserId)
        .where("active", "==", true)
        .limit(1)
        .get();

      if (staffSnap.empty) {
        return res.status(403).json({
          error: "このLINEアカウントに紐付くスタッフが見つかりません。オーナーに招待を依頼してください。",
          lineUserId,
          displayName,
        });
      }

      const staffDoc = staffSnap.docs[0];
      const staffId = staffDoc.id;
      const staffData = staffDoc.data();

      // Firebase Authユーザー取得 or 作成
      let uid;
      if (staffData.authUid) {
        uid = staffData.authUid;
      } else {
        // 新規Firebase Authユーザー作成
        const email = `staff_${staffId}@minpaku-v2.internal`;
        try {
          const userRecord = await admin.auth().createUser({
            email,
            displayName: staffData.name || displayName,
            disabled: false,
          });
          uid = userRecord.uid;
        } catch (e) {
          if (e.code === "auth/email-already-exists") {
            const existingUser = await admin.auth().getUserByEmail(email);
            uid = existingUser.uid;
          } else {
            throw e;
          }
        }
        // authUidを記録
        await staffDoc.ref.update({ authUid: uid, updatedAt: new Date() });
      }

      // カスタムクレーム設定
      await admin.auth().setCustomUserClaims(uid, { role: "staff", staffId });

      // カスタムトークン発行
      const customToken = await admin.auth().createCustomToken(uid);

      res.json({ success: true, customToken, staffName: staffData.name });
    } catch (e) {
      console.error("LINE callback エラー:", e);
      res.status(500).json({ error: `サーバーエラー: ${e.message}` });
    }
  });

  /**
   * POST /auth/accept-invite-line
   * 招待トークン + LINE OAuthコード → lineUserId を staff に保存 → カスタムトークン発行
   * リクエスト: { code: string, redirectUri: string, inviteToken: string }
   */
  router.post("/accept-invite-line", async (req, res) => {
    try {
      const { code, redirectUri, inviteToken } = req.body;
      if (!code || !inviteToken) {
        return res.status(400).json({ error: "code と inviteToken が必要です" });
      }

      // 招待トークン検証
      const inviteDoc = await db.collection("staffInvites").doc(inviteToken).get();
      if (!inviteDoc.exists) {
        return res.status(404).json({ error: "無効な招待リンクです" });
      }
      const invite = inviteDoc.data();
      if (invite.used) {
        return res.status(400).json({ error: "この招待リンクは使用済みです" });
      }
      if (invite.expiresAt && invite.expiresAt.toDate() < new Date()) {
        return res.status(400).json({ error: "招待リンクの有効期限が切れています" });
      }

      // スタッフドキュメント取得
      const staffDoc = await db.collection("staff").doc(invite.staffId).get();
      if (!staffDoc.exists || !staffDoc.data().active) {
        return res.status(404).json({ error: "対象スタッフが見つかりません" });
      }

      // LINE Login設定取得
      const settingsDoc = await db.collection("settings").doc("lineLogin").get();
      if (!settingsDoc.exists) {
        return res.status(500).json({ error: "LINE Login設定が未登録です" });
      }
      const { channelId, channelSecret } = settingsDoc.data();
      if (!channelId || !channelSecret) {
        return res.status(500).json({ error: "LINE Login設定が不完全です" });
      }

      // 認可コード → アクセストークン取得
      const tokenResult = await lineTokenExchange_(channelId, channelSecret, code, redirectUri);
      if (!tokenResult.success) {
        return res.status(401).json({ error: `LINEトークン取得失敗: ${tokenResult.error}` });
      }

      // LINE プロフィール取得
      const profile = await lineGetProfile_(tokenResult.accessToken);
      if (!profile.success) {
        return res.status(401).json({ error: `LINEプロフィール取得失敗: ${profile.error}` });
      }

      const lineUserId = profile.userId;
      const staffData = staffDoc.data();
      const staffId = invite.staffId;

      // Firebase Authユーザー作成 or 取得
      let uid;
      if (staffData.authUid) {
        uid = staffData.authUid;
      } else {
        const email = `staff_${staffId}@minpaku-v2.internal`;
        try {
          const userRecord = await admin.auth().createUser({
            email,
            displayName: staffData.name || profile.displayName,
            disabled: false,
          });
          uid = userRecord.uid;
        } catch (e) {
          if (e.code === "auth/email-already-exists") {
            const existingUser = await admin.auth().getUserByEmail(email);
            uid = existingUser.uid;
          } else {
            throw e;
          }
        }
      }

      // staff doc に lineUserId と authUid を保存（旧フローでは lineUserId が未保存だった問題を解消）
      await staffDoc.ref.update({
        lineUserId,
        authUid: uid,
        updatedAt: new Date(),
      });

      // カスタムクレーム設定
      await admin.auth().setCustomUserClaims(uid, { role: "staff", staffId });

      // 招待トークンを使用済みに
      await inviteDoc.ref.update({
        used: true,
        usedAt: new Date(),
        usedByUid: uid,
        authMethod: "line_oauth",
        lineUserId,
      });

      // カスタムトークン発行
      const customToken = await admin.auth().createCustomToken(uid);

      res.json({ success: true, customToken, staffName: staffData.name });
    } catch (e) {
      console.error("招待LINE OAuth受諾エラー:", e);
      res.status(500).json({ error: `サーバーエラー: ${e.message}` });
    }
  });

  /**
   * POST /auth/accept-invite
   * 招待トークン検証 → Firebase Authユーザー作成 → カスタムトークン発行
   * リクエスト: { token: string }
   * @deprecated LINE OAuth経由の /auth/accept-invite-line を推奨。lineUserId が保存されない問題あり
   */
  router.post("/accept-invite", async (req, res) => {
    try {
      const { token } = req.body;
      if (!token) {
        return res.status(400).json({ error: "招待トークンが必要です" });
      }

      // 招待トークン検証
      const inviteDoc = await db.collection("staffInvites").doc(token).get();
      if (!inviteDoc.exists) {
        return res.status(404).json({ error: "無効な招待リンクです" });
      }

      const invite = inviteDoc.data();
      if (invite.used) {
        return res.status(400).json({ error: "この招待リンクは使用済みです" });
      }
      if (invite.expiresAt && invite.expiresAt.toDate() < new Date()) {
        return res.status(400).json({ error: "招待リンクの有効期限が切れています" });
      }

      // スタッフドキュメント取得
      const staffDoc = await db.collection("staff").doc(invite.staffId).get();
      if (!staffDoc.exists || !staffDoc.data().active) {
        return res.status(404).json({ error: "対象スタッフが見つかりません" });
      }

      const staffData = staffDoc.data();
      const staffId = invite.staffId;

      // Firebase Authユーザー作成
      let uid;
      if (staffData.authUid) {
        uid = staffData.authUid;
      } else {
        const email = `staff_${staffId}@minpaku-v2.internal`;
        try {
          const userRecord = await admin.auth().createUser({
            email,
            displayName: staffData.name,
            disabled: false,
          });
          uid = userRecord.uid;
        } catch (e) {
          if (e.code === "auth/email-already-exists") {
            const existingUser = await admin.auth().getUserByEmail(email);
            uid = existingUser.uid;
          } else {
            throw e;
          }
        }
        await staffDoc.ref.update({ authUid: uid, updatedAt: new Date() });
      }

      // カスタムクレーム設定
      await admin.auth().setCustomUserClaims(uid, { role: "staff", staffId });

      // 招待トークンを使用済みに
      await inviteDoc.ref.update({ used: true, usedAt: new Date(), usedByUid: uid });

      // カスタムトークン発行
      const customToken = await admin.auth().createCustomToken(uid);

      res.json({ success: true, customToken, staffName: staffData.name });
    } catch (e) {
      console.error("招待受諾エラー:", e);
      res.status(500).json({ error: `サーバーエラー: ${e.message}` });
    }
  });

  /**
   * POST /auth/accept-invite-email
   * メールリンク認証後の招待受諾 — Firebase Authユーザーにrole:staff + staffIdクレームを付与
   * リクエスト: { token: string, email: string }
   * ※ 呼び出し時点でFirebase Auth済み（email-signin.htmlからIDトークン付きで呼ばれる）
   */
  router.post("/accept-invite-email", async (req, res) => {
    try {
      // 認証済みユーザーのIDトークン検証
      const user = await authenticateRequest_(req);
      if (!user) {
        return res.status(401).json({ error: "認証が必要です" });
      }

      const { token, email } = req.body;
      if (!token) {
        return res.status(400).json({ error: "招待トークンが必要です" });
      }

      // 招待トークン検証
      const inviteDoc = await db.collection("staffInvites").doc(token).get();
      if (!inviteDoc.exists) {
        return res.status(404).json({ error: "無効な招待リンクです" });
      }

      const invite = inviteDoc.data();
      if (invite.used) {
        return res.status(400).json({ error: "この招待リンクは使用済みです" });
      }
      if (invite.expiresAt && invite.expiresAt.toDate() < new Date()) {
        return res.status(400).json({ error: "招待リンクの有効期限が切れています" });
      }

      // スタッフドキュメント取得
      const staffDoc = await db.collection("staff").doc(invite.staffId).get();
      if (!staffDoc.exists || !staffDoc.data().active) {
        return res.status(404).json({ error: "対象スタッフが見つかりません" });
      }

      const staffId = invite.staffId;
      const uid = user.uid;

      // カスタムクレーム設定（role: staff + staffId）
      await admin.auth().setCustomUserClaims(uid, { role: "staff", staffId });

      // スタッフドキュメントに authUid と email を記録
      const updateData = {
        authUid: uid,
        updatedAt: new Date(),
      };
      if (email) updateData.email = email;
      await staffDoc.ref.update(updateData);

      // 招待トークンを使用済みに
      await inviteDoc.ref.update({
        used: true,
        usedAt: new Date(),
        usedByUid: uid,
        usedByEmail: email || null,
        authMethod: "email_link",
      });

      res.json({ success: true, staffName: staffDoc.data().name });
    } catch (e) {
      console.error("メールリンク招待受諾エラー:", e);
      res.status(500).json({ error: `サーバーエラー: ${e.message}` });
    }
  });

  /**
   * GET /auth/invite-info
   * 招待トークンの情報を取得（認証不要、スタッフ名表示用）
   * クエリ: ?token=xxx
   */
  router.get("/invite-info", async (req, res) => {
    try {
      const { token } = req.query;
      if (!token) {
        return res.status(400).json({ error: "トークンが必要です" });
      }

      const inviteDoc = await db.collection("staffInvites").doc(token).get();
      if (!inviteDoc.exists) {
        return res.status(404).json({ error: "無効な招待リンクです" });
      }

      const invite = inviteDoc.data();
      if (invite.used) {
        return res.json({ valid: false, reason: "使用済み" });
      }
      if (invite.expiresAt && invite.expiresAt.toDate() < new Date()) {
        return res.json({ valid: false, reason: "有効期限切れ" });
      }

      const staffDoc = await db.collection("staff").doc(invite.staffId).get();
      const staffName = staffDoc.exists ? staffDoc.data().name : "不明";

      res.json({ valid: true, staffName });
    } catch (e) {
      console.error("招待情報取得エラー:", e);
      res.status(500).json({ error: `サーバーエラー: ${e.message}` });
    }
  });

  // ========== 認証必要エンドポイント（内部で認証チェック） ==========

  /**
   * POST /auth/invite
   * スタッフ招待リンク発行（オーナー限定）
   * リクエスト: { staffId: string }
   */
  router.post("/invite", async (req, res) => {
    try {
      // 認証チェック
      const user = await authenticateRequest_(req);
      if (!user) {
        return res.status(401).json({ error: "認証が必要です" });
      }
      // オーナー権限チェック: role=="owner" OR roleが未設定（既存オーナー互換）
      if (user.role && user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }

      const { staffId } = req.body;
      if (!staffId) {
        return res.status(400).json({ error: "staffIdが必要です" });
      }

      // スタッフ存在確認
      const staffDoc = await db.collection("staff").doc(staffId).get();
      if (!staffDoc.exists) {
        return res.status(404).json({ error: "スタッフが見つかりません" });
      }

      // トークン生成
      const token = crypto.randomUUID();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7); // 7日間有効

      await db.collection("staffInvites").doc(token).set({
        staffId,
        createdAt: new Date(),
        expiresAt,
        used: false,
        createdBy: user.uid,
      });

      // ホスト名を環境変数またはデフォルトから取得
      const baseUrl = process.env.APP_BASE_URL || "https://minpaku-v2.web.app";
      const inviteUrl = `${baseUrl}/invite.html?token=${token}`;

      res.json({ success: true, inviteUrl, token, expiresAt: expiresAt.toISOString() });
    } catch (e) {
      console.error("招待リンク発行エラー:", e.stack || e);
      return res.status(500).json({ error: `招待リンク発行失敗: ${e.message || "不明"}` });
    }
  });

  /**
   * POST /auth/set-role
   * カスタムクレーム手動設定（オーナー限定、管理用）
   * リクエスト: { uid: string, role: "owner"|"staff", staffId?: string }
   */
  router.post("/set-role", async (req, res) => {
    try {
      const user = await authenticateRequest_(req);
      if (!user) {
        return res.status(401).json({ error: "認証が必要です" });
      }
      // オーナー権限チェック: role=="owner" OR roleが未設定（既存オーナー互換）
      if (user.role && user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }

      const { uid, role, staffId } = req.body;
      if (!uid || !role) {
        return res.status(400).json({ error: "uid と role が必要です" });
      }
      if (!["owner", "staff"].includes(role)) {
        return res.status(400).json({ error: "role は 'owner' または 'staff' のみ" });
      }

      const claims = { role };
      if (role === "staff" && staffId) {
        claims.staffId = staffId;
      }

      await admin.auth().setCustomUserClaims(uid, claims);

      res.json({ success: true, uid, claims });
    } catch (e) {
      console.error("ロール設定エラー:", e);
      res.status(500).json({ error: `サーバーエラー: ${e.message}` });
    }
  });

  /**
   * POST /auth/link-line
   * スタッフにLINE User IDを紐付ける（オーナー限定）
   * リクエスト: { staffId: string, lineUserId: string }
   */
  router.post("/link-line", async (req, res) => {
    try {
      const user = await authenticateRequest_(req);
      if (!user) {
        return res.status(401).json({ error: "認証が必要です" });
      }
      if (user.role && user.role !== "owner") {
        return res.status(403).json({ error: "オーナー権限が必要です" });
      }

      const { staffId, lineUserId } = req.body;
      if (!staffId || !lineUserId) {
        return res.status(400).json({ error: "staffId と lineUserId が必要です" });
      }

      await db.collection("staff").doc(staffId).update({
        lineUserId,
        updatedAt: new Date(),
      });

      res.json({ success: true });
    } catch (e) {
      console.error("LINE紐付けエラー:", e);
      res.status(500).json({ error: `サーバーエラー: ${e.message}` });
    }
  });

  return router;
};

// ========== 内部ヘルパー関数 ==========

/**
 * リクエストからBearer Tokenを取得してFirebase Auth検証
 * index.jsのauthenticateと同じロジック（auth APIは独立して認証チェック）
 */
async function authenticateRequest_(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.split("Bearer ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded;
  } catch (e) {
    return null;
  }
}

/**
 * LINE トークンエンドポイントで認可コード→アクセストークン交換
 */
function lineTokenExchange_(channelId, channelSecret, code, redirectUri) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: channelId,
      client_secret: channelSecret,
    });
    const body = params.toString();

    const options = {
      hostname: "api.line.me",
      path: "/oauth2/v2.1/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode === 200 && json.access_token) {
            resolve({ success: true, accessToken: json.access_token });
          } else {
            resolve({ success: false, error: json.error_description || `HTTP ${res.statusCode}` });
          }
        } catch (e) {
          resolve({ success: false, error: `レスポンス解析失敗: ${data}` });
        }
      });
    });
    req.on("error", (e) => resolve({ success: false, error: e.message }));
    req.write(body);
    req.end();
  });
}

/**
 * LINE Profile API でユーザー情報取得
 */
function lineGetProfile_(accessToken) {
  return new Promise((resolve) => {
    const options = {
      hostname: "api.line.me",
      path: "/v2/profile",
      method: "GET",
      headers: { "Authorization": `Bearer ${accessToken}` },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode === 200 && json.userId) {
            resolve({ success: true, userId: json.userId, displayName: json.displayName });
          } else {
            resolve({ success: false, error: `HTTP ${res.statusCode}: ${data}` });
          }
        } catch (e) {
          resolve({ success: false, error: `レスポンス解析失敗: ${data}` });
        }
      });
    });
    req.on("error", (e) => resolve({ success: false, error: e.message }));
    req.end();
  });
}
