/**
 * Gmail OAuth トークン.ownerId 既存データ補完スクリプト
 * 実行: cd functions && node migration/backfill-oauth-token-owner-id.js
 *
 * 処理:
 *   1. メインオーナー (staff.isOwner=true) を取得
 *   2. 以下の3つのトークン格納先をループ:
 *      - settings/gmailOAuthEmailVerification/tokens/* (受信用 + 送信用 共有)
 *      - settings/gmailOAuth/tokens/* (税理士資料用)
 *   3. ownerId 未設定のトークンに対して:
 *      - email から properties.senderGmail 一致を検索 → その物件の ownerId を採用
 *      - 一致なし → メインオーナーの staffId を採用
 *
 * 前提: backfill-property-owner-id.js を先に実行して properties.ownerId が埋まっていること
 */
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

const TOKEN_COLLECTIONS = [
  { docPath: "settings/gmailOAuthEmailVerification", label: "emailVerification + property" },
  { docPath: "settings/gmailOAuth", label: "default (tax-docs)" },
];

async function main() {
  // メインオーナー取得
  const ownerSnap = await db.collection("staff").where("isOwner", "==", true).limit(1).get();
  if (ownerSnap.empty) {
    console.error("[ERROR] isOwner=true のメインオーナーが見つかりません。中断。");
    process.exit(1);
  }
  const mainOwnerId = ownerSnap.docs[0].id;
  const mainOwnerName = ownerSnap.docs[0].data().name || "";
  console.log(`[backfill] メインオーナー: ${mainOwnerName} (${mainOwnerId})`);

  // 全物件の senderGmail → ownerId マップ
  const propsSnap = await db.collection("properties").get();
  const senderGmailToOwner = new Map();
  for (const p of propsSnap.docs) {
    const d = p.data();
    if (d.senderGmail && d.ownerId) {
      senderGmailToOwner.set(String(d.senderGmail).toLowerCase(), {
        ownerId: d.ownerId,
        propertyName: d.name,
      });
    }
  }
  console.log(`[backfill] senderGmail マップ: ${senderGmailToOwner.size} 件`);

  let totalScanned = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const tc of TOKEN_COLLECTIONS) {
    console.log(`\n--- ${tc.label} (${tc.docPath}/tokens) ---`);
    const tokensSnap = await db.doc(tc.docPath).collection("tokens").get();
    console.log(`  トークン総数: ${tokensSnap.size}`);

    for (const tDoc of tokensSnap.docs) {
      totalScanned++;
      const t = tDoc.data();
      if (t.ownerId) {
        totalSkipped++;
        continue;
      }
      const emailLower = String(t.email || "").toLowerCase();
      const matched = senderGmailToOwner.get(emailLower);
      let ownerId, reason;
      if (matched) {
        ownerId = matched.ownerId;
        reason = `senderGmail一致 (${matched.propertyName})`;
      } else {
        ownerId = mainOwnerId;
        reason = `メインオーナー fallback`;
      }
      await tDoc.ref.update({ ownerId });
      totalUpdated++;
      console.log(`  [updated] ${t.email} → ${ownerId} (${reason})`);
    }
  }

  console.log("\n=== 結果 ===");
  console.log(`総スキャン: ${totalScanned}`);
  console.log(`スキップ (既設): ${totalSkipped}`);
  console.log(`更新: ${totalUpdated}`);
  console.log("[backfill-oauth-token-owner-id] 完了");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[ERROR]", e);
    process.exit(1);
  });
