#!/usr/bin/env node
// oauthReminder のロジックをローカルで一度走らせて、各 token の疎通結果を確認する
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const { oauthReminderCore } = require("../scheduled/oauthReminder");

(async () => {
  // 通知が飛ばないように notifyEmails を空に上書きするモックは使わず、本番設定で動作確認
  const result = await oauthReminderCore(db);
  console.log("結果:", JSON.stringify(result, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
