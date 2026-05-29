// openExternalBrowser=1 付与のテストメール送信 (デプロイ確認用)
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

(async () => {
  const { google } = require("googleapis");
  const oauthDoc = await db.collection("settings").doc("gmailOAuth").get();
  if (!oauthDoc.exists) { console.error("settings/gmailOAuth 未設定"); process.exit(1); }
  const { clientId, clientSecret } = oauthDoc.data();
  if (!clientId || !clientSecret) { console.error("clientId/clientSecret 未設定"); process.exit(1); }
  let tokenSnap = await db.collection("settings").doc("gmailOAuth").collection("tokens")
    .where("email", "==", "81hassac@gmail.com").limit(1).get();
  if (tokenSnap.empty) {
    tokenSnap = await db.collection("settings").doc("gmailOAuthEmailVerification").collection("tokens")
      .where("email", "==", "81hassac@gmail.com").limit(1).get();
  }
  if (tokenSnap.empty) {
    console.error("81hassac@gmail.com の Gmail 連携トークンが見つかりません");
    process.exit(1);
  }
  const tokenData = tokenSnap.docs[0].data();

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: tokenData.refreshToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });

  const body = [
    "v2 アプリ デプロイ完了テストメール (LINE 内蔵ブラウザ回避 + ゴースト予約修正)",
    "",
    "【テスト方法】",
    "下の URL をスマホ LINE トークに転送してタップ。LINE 内蔵ブラウザではなく",
    "OS デフォルトブラウザ (Chrome / Safari) で開けば成功。",
    "",
    "1. ホーム: https://minpaku-v2.web.app/?openExternalBrowser=1",
    "2. 名簿フォーム: https://minpaku-v2.web.app/form/?propertyId=tsZybhDMcPrxqgcRy7wp&openExternalBrowser=1",
    "3. スケジュール: https://minpaku-v2.web.app/?openExternalBrowser=1#/schedule",
    "",
    "【今回の本デプロイで反映】",
    "- syncIcal: Booking.com 匿名 CLOSED が同物件の既存非キャンセル予約と重複",
    "  する場合は取り込まない (the Terrace 5/15-5/17 ゴースト予約再発防止)",
    "- rosterRemind: unverified=true の予約は名簿督促対象外",
    "- lineNotify: LINE / Discord / メール本文の v2 URL に openExternalBrowser=1",
    "  を自動付与",
    "- アプリ内 URL コピー & LINE 共有ボタン (guests / my-checklist / properties /",
    "  staff) で URL に自動付与",
    "",
    "【既に実施済み】",
    "- ゴースト予約 (ical_2e707c2f...@booking.com 5/15-5/17) を本番から削除",
    "- the Terrace 長浜 5/14-5/17 の正規予約 (Lorraine Jordaan) のみが残存",
  ].join("\n");

  const subject = "[v2] LINE 内蔵ブラウザ回避デプロイ完了テスト";
  const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`;
  const messageParts = [
    "From: 81hassac@gmail.com",
    "To: 81hassac@gmail.com",
    `Subject: ${utf8Subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ];
  const raw = Buffer.from(messageParts.join("\n")).toString("base64url");
  const r = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  console.log("送信成功 messageId=", r.data.id);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
