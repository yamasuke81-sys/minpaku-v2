// 81hassac@gmail.com の Gmail からタイミーメールをサンプル取得して構造調査
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const { google } = require("googleapis");

(async () => {
  // gmailOAuthEmailVerification/tokens から 81hassac@ を取得
  const t = await db.collection("settings").doc("gmailOAuthEmailVerification").collection("tokens").get();
  let token = null;
  t.forEach((d) => {
    const x = d.data();
    if ((x.email || "").toLowerCase() === "81hassac@gmail.com") token = x;
  });
  if (!token) throw new Error("81hassac@gmail.com のトークン未発見");

  // settings/gmailOAuth に client id/secret あるはず
  const cfg = await db.collection("settings").doc("gmailOAuth").get();
  const cd = cfg.data() || {};
  const clientId = cd.clientId || cd.client_id;
  const clientSecret = cd.clientSecret || cd.client_secret;
  if (!clientId || !clientSecret) {
    // alt 場所も試す
    const cfg2 = await db.collection("settings").doc("gmailOAuthEmailVerification").get();
    const cd2 = cfg2.data() || {};
    if (cd2.clientId && cd2.clientSecret) {
      console.log("(emailVerification 側の clientId/Secret 使用)");
    }
  }
  const oauth = new google.auth.OAuth2(clientId || cd.clientId, clientSecret || cd.clientSecret);
  oauth.setCredentials({ refresh_token: token.refreshToken });
  const gmail = google.gmail({ version: "v1", auth: oauth });

  // タイミーからのメールを検索
  const queries = [
    "from:timee.co.jp newer_than:30d",
    "from:no-reply@timee.co.jp newer_than:30d",
    "from:タイミー newer_than:30d",
    "subject:タイミー newer_than:60d",
  ];
  for (const q of queries) {
    console.log(`\n=== Query: ${q} ===`);
    const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 10 });
    const msgs = list.data.messages || [];
    console.log(`  件数: ${msgs.length}`);
    for (let i = 0; i < Math.min(msgs.length, 5); i++) {
      const m = await gmail.users.messages.get({ userId: "me", id: msgs[i].id, format: "metadata", metadataHeaders: ["Subject", "From", "Date"] });
      const h = m.data.payload.headers;
      const get = (n) => (h.find((x) => x.name.toLowerCase() === n.toLowerCase()) || {}).value;
      console.log(`  [${i + 1}] ${get("Date")}`);
      console.log(`      From: ${get("From")}`);
      console.log(`      Subj: ${get("Subject")}`);
    }
  }

  // 1 件中身を取得 (timee.co.jp から最新)
  console.log("\n=== サンプル本文 (最新1件) ===");
  const list2 = await gmail.users.messages.list({ userId: "me", q: "from:timee.co.jp newer_than:90d", maxResults: 1 });
  if (list2.data.messages?.[0]) {
    const m = await gmail.users.messages.get({ userId: "me", id: list2.data.messages[0].id, format: "full" });
    const h = m.data.payload.headers;
    const get = (n) => (h.find((x) => x.name.toLowerCase() === n.toLowerCase()) || {}).value;
    console.log("From:", get("From"));
    console.log("Subject:", get("Subject"));
    console.log("Date:", get("Date"));
    // 本文抽出
    function extractBody(payload) {
      let found = "";
      function walk(part) {
        if (part.mimeType === "text/plain" && part.body?.data) {
          found = Buffer.from(part.body.data, "base64url").toString("utf-8");
          return;
        }
        if (Array.isArray(part.parts)) part.parts.forEach(walk);
      }
      walk(payload);
      return found;
    }
    const body = extractBody(m.data.payload);
    console.log("\n--- BODY (1500字) ---");
    console.log(body.slice(0, 1500));
  }

  process.exit(0);
})().catch((e) => { console.error("ERR:", e); process.exit(1); });
