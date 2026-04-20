#!/usr/bin/env node
/**
 * メール照合機能 診断スクリプト
 *   - properties.verificationEmails[] の登録状況
 *   - settings/gmailOAuth, settings/gmailOAuthEmailVerification のトークン有無
 *   - emailVerifications コレクションの件数
 * 実行: node functions/migration/diag-email-verification.js
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

async function main() {
  console.log("========== 1. active properties + verificationEmails ==========");
  const pSnap = await db.collection("properties").where("active", "==", true).get();
  console.log(`active properties: ${pSnap.size} 件`);
  let totalVE = 0;
  for (const d of pSnap.docs) {
    const ve = d.data().verificationEmails || [];
    console.log(`- ${d.id} ${d.data().name || ""}: verificationEmails=${ve.length}`);
    for (const e of ve) {
      console.log(`    - ${e.platform || "?"} → ${e.email || "?"}`);
      totalVE++;
    }
  }
  console.log(`→ 合計 verificationEmails: ${totalVE} 件`);

  console.log("\n========== 2. settings/gmailOAuth クライアント ==========");
  const oauthDoc = await db.collection("settings").doc("gmailOAuth").get();
  if (!oauthDoc.exists) {
    console.log("!! settings/gmailOAuth が存在しません");
  } else {
    const d = oauthDoc.data();
    console.log(`clientId: ${d.clientId ? "設定済み" : "未設定"}`);
    console.log(`clientSecret: ${d.clientSecret ? "設定済み" : "未設定"}`);
    console.log(`redirectUri: ${d.redirectUri || "未設定"}`);
  }

  console.log("\n========== 3. settings/gmailOAuth/tokens (税理士資料用) ==========");
  const t1 = await db.collection("settings").doc("gmailOAuth").collection("tokens").get();
  console.log(`tokens: ${t1.size} 件`);
  for (const d of t1.docs) {
    const data = d.data();
    console.log(`- ${d.id}: email=${data.email}, refreshToken=${data.refreshToken ? "あり" : "なし"}, scope=${data.scope}`);
  }

  console.log("\n========== 4. settings/gmailOAuthEmailVerification/tokens (照合用) ==========");
  const t2 = await db.collection("settings").doc("gmailOAuthEmailVerification").collection("tokens").get();
  console.log(`tokens: ${t2.size} 件`);
  for (const d of t2.docs) {
    const data = d.data();
    console.log(`- ${d.id}: email=${data.email}, refreshToken=${data.refreshToken ? "あり" : "なし"}, scope=${data.scope}`);
  }

  console.log("\n========== 5. emailVerifications ==========");
  const ev = await db.collection("emailVerifications").limit(10).get();
  console.log(`総数 (先頭10件取得): ${ev.size} 件`);
  for (const d of ev.docs) {
    const data = d.data();
    console.log(`- ${d.id.substring(0, 20)}... platform=${data.platform} kind=${data.extractedInfo && data.extractedInfo.kind} matchStatus=${data.matchStatus}`);
  }

  console.log("\n========== 6. bookings サンプル (icalUid に HM が入っているか確認用) ==========");
  const b = await db.collection("bookings").orderBy("createdAt", "desc").limit(5).get();
  for (const d of b.docs) {
    const data = d.data();
    console.log(`- ${d.id}: source=${data.source} status=${data.status} icalUid=${(data.icalUid || "").substring(0, 60)}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
