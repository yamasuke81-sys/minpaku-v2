/**
 * オーナーをスタッフの1人として登録
 * settings/notifications.ownerEmail と Auth の表示名を参考にして
 * staff/{owner-uid} ドキュメントを作成/更新する。既に同一 authUid のスタッフがあれば更新だけ。
 *
 * 実行:
 *   node migration/seed-owner-staff.js <ownerUid> [--name="やますけ"] [--email=xx@xx]
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const args = process.argv.slice(2);
const ownerUid = args.find(a => !a.startsWith("--"));
const nameArg = args.find(a => a.startsWith("--name="));
const emailArg = args.find(a => a.startsWith("--email="));

if (!ownerUid) {
  console.error("Usage: node seed-owner-staff.js <ownerUid> [--name=xx] [--email=xx]");
  process.exit(1);
}

(async () => {
  // 設定からメールを補完
  let email = emailArg ? emailArg.split("=")[1] : "";
  let name = nameArg ? nameArg.split("=")[1] : "";
  if (!email) {
    const s = await db.collection("settings").doc("notifications").get();
    if (s.exists) email = s.data().ownerEmail || "";
  }
  if (!name) name = email ? email.split("@")[0] : "オーナー";

  // 既存 staff で authUid が一致するものを検索
  const existingSnap = await db.collection("staff").where("authUid", "==", ownerUid).limit(1).get();
  const baseData = {
    name,
    email,
    authUid: ownerUid,
    role: "owner",
    isOwner: true,                  // UI識別用フラグ
    active: true,
    assignedPropertyIds: [],         // オーナーも担当物件を選ぶ
    skills: [],
    displayOrder: 0,                 // オーナーを最上段に表示
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (!existingSnap.empty) {
    const doc = existingSnap.docs[0];
    await doc.ref.set(baseData, { merge: true });
    console.log(`既存staff更新: id=${doc.id} (${name})`);
  } else {
    baseData.createdAt = admin.firestore.FieldValue.serverTimestamp();
    const ref = await db.collection("staff").add(baseData);
    console.log(`新規staff作成: id=${ref.id} (${name})`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
