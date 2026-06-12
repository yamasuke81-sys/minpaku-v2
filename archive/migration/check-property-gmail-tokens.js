#!/usr/bin/env node
// 物件別 Gmail OAuth トークンの実態確認
// - settings/gmailOAuthEmailVerification/tokens/{email} に refresh_token があるか
// - その refresh_token で実際にアクセストークン取得 → API 叩けるか試す
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const { google } = require("googleapis");

(async () => {
  // OAuth クライアント設定
  const cfg = await db.doc("settings/gmailOAuth").get();
  if (!cfg.exists) { console.error("settings/gmailOAuth 未設定"); process.exit(1); }
  const { clientId, clientSecret, redirectUri } = cfg.data();
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  // 物件別トークンサブコレクション
  const tokensSnap = await db.collection("settings").doc("gmailOAuthEmailVerification").collection("tokens").get();
  console.log(`tokens 件数: ${tokensSnap.size}\n`);

  for (const t of tokensSnap.docs) {
    const data = t.data();
    console.log(`=== ${t.id} ===`);
    console.log(`  保存時刻: ${data.savedAt?.toDate?.() || data.savedAt}`);
    console.log(`  scope: ${data.scope || "(none)"}`);
    console.log(`  ownerId: ${data.ownerId || "(none)"}`);
    console.log(`  propertyId: ${data.propertyId || "(none)"}`);
    console.log(`  refresh_token (snake): ${!!data.refresh_token} | refreshToken (camel): ${!!data.refreshToken}`);
    console.log(`  全フィールド: ${Object.keys(data).join(", ")}`);
    const rt = data.refresh_token || data.refreshToken;
    if (!rt) {
      console.log(`  ⚠️ refresh_token なし → 連携切れ`);
      continue;
    }
    // アクセストークン取得試行
    try {
      oauth2.setCredentials({ refresh_token: rt });
      const { credentials } = await oauth2.refreshAccessToken();
      console.log(`  ✓ アクセストークン取得成功 (有効期限: ${new Date(credentials.expiry_date).toLocaleString("ja-JP")})`);
      // 簡単な API 確認 (プロファイル取得)
      const gmail = google.gmail({ version: "v1", auth: oauth2 });
      const profile = await gmail.users.getProfile({ userId: "me" });
      console.log(`  ✓ Gmail API 疎通 OK (emailAddress=${profile.data.emailAddress}, messagesTotal=${profile.data.messagesTotal})`);
    } catch (e) {
      console.log(`  ✗ トークンリフレッシュ失敗: ${e.message}`);
      if (e.message.includes("invalid_grant")) {
        console.log(`     → ユーザーが連携を取消した、もしくはトークンが期限切れ`);
      }
    }
    console.log();
  }
})().catch(e => { console.error(e); process.exit(1); });
