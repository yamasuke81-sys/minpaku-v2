/**
 * parse_errors コレクションの expiresAt フィールドに Firestore TTL を有効化する
 *
 * 一回限りの管理スクリプト。デプロイ後に 1 回だけ実行すれば OK。
 *
 * 使い方:
 *   cd functions
 *   node migration/enable-ttl-parse-errors.js
 *
 * 前提:
 *   - Application Default Credentials (gcloud auth application-default login) が通っていること
 *   - 実行ユーザーに roles/datastore.owner または roles/datastore.indexAdmin 等の権限
 *
 * 実装方式:
 *   Firestore Admin REST API を直接叩く
 *     PATCH https://firestore.googleapis.com/v1/projects/{projectId}/databases/(default)/collectionGroups/parse_errors/fields/expiresAt
 *     { ttlConfig: {} }
 *
 * 設定後の TTL 反映には数分〜数時間かかる (Google 側仕様)。
 * 設定状況は Firebase Console > Firestore > "TTL ポリシー" タブで確認可能。
 */
const { google } = require("googleapis");
const GoogleAuth = google.auth.GoogleAuth;

const PROJECT_ID = "minpaku-v2";
const COLLECTION = "parse_errors";
const FIELD = "expiresAt";

async function main() {
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/datastore"],
  });
  const client = await auth.getClient();

  // updateMask を指定しないと既存の indexConfig 等まで巻き込む可能性があるので明示
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}` +
    `/databases/(default)/collectionGroups/${COLLECTION}/fields/${FIELD}` +
    `?updateMask=ttlConfig`;

  const body = { ttlConfig: {} };

  console.log(`[enable-ttl] PATCH ${url}`);
  const res = await client.request({
    url,
    method: "PATCH",
    data: body,
  });

  console.log("[enable-ttl] レスポンス:");
  console.log(JSON.stringify(res.data, null, 2));
  console.log("");
  console.log("✅ TTL 設定リクエスト送信完了。実反映までに数分〜数時間かかる場合があります。");
  console.log("確認: https://console.firebase.google.com/project/" + PROJECT_ID +
    "/firestore/databases/-default-/ttl");
}

main().catch((e) => {
  console.error("[enable-ttl] エラー:", e.message);
  if (e.response && e.response.data) {
    console.error("詳細:", JSON.stringify(e.response.data, null, 2));
  }
  process.exit(1);
});
