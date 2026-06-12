// 異なるタイトルパターンの Timee メール本文を確認
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const { google } = require("googleapis");

(async () => {
  const t = await db.collection("settings").doc("gmailOAuthEmailVerification").collection("tokens").get();
  let token = null;
  t.forEach((d) => { const x = d.data(); if ((x.email || "").toLowerCase() === "81hassac@gmail.com") token = x; });

  const cfg = await db.collection("settings").doc("gmailOAuth").get();
  const cd = cfg.data() || {};
  const oauth = new google.auth.OAuth2(cd.clientId, cd.clientSecret);
  oauth.setCredentials({ refresh_token: token.refreshToken });
  const gmail = google.gmail({ version: "v1", auth: oauth });

  function extractBody(payload) {
    let found = "";
    function walk(part) {
      if (part.mimeType === "text/plain" && part.body?.data) { found = Buffer.from(part.body.data, "base64url").toString("utf-8"); return; }
      if (Array.isArray(part.parts)) part.parts.forEach(walk);
    }
    walk(payload);
    return found;
  }

  // 異なる Subject パターンごとに 1 件ずつ取って本文表示
  const queries = [
    'subject:"マッチング状況のお知らせ" from:timee.co.jp newer_than:60d',
    'subject:"がマッチングしました" from:timee.co.jp newer_than:60d',
    'subject:"キャンセル" from:timee.co.jp newer_than:60d',
    'subject:"応募" from:timee.co.jp newer_than:60d',
    'subject:"投稿" from:timee.co.jp newer_than:60d',
  ];
  for (const q of queries) {
    console.log(`\n========== ${q} ==========`);
    const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 1 });
    if (!list.data.messages?.[0]) { console.log("  (該当なし)"); continue; }
    const m = await gmail.users.messages.get({ userId: "me", id: list.data.messages[0].id, format: "full" });
    const h = m.data.payload.headers;
    const get = (n) => (h.find((x) => x.name.toLowerCase() === n.toLowerCase()) || {}).value;
    console.log("Subject:", get("Subject"));
    console.log("Date:", get("Date"));
    const body = extractBody(m.data.payload);
    console.log("---");
    console.log(body.slice(0, 1200));
  }
  process.exit(0);
})().catch((e) => { console.error("ERR:", e); process.exit(1); });
