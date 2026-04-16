/**
 * Firebase Auth から owner role のユーザー一覧を表示
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });

(async () => {
  const list = await admin.auth().listUsers(1000);
  console.log(`全ユーザー: ${list.users.length}件`);
  list.users.forEach(u => {
    const role = (u.customClaims && u.customClaims.role) || "";
    const star = role === "owner" ? "★" : "  ";
    console.log(`${star} uid=${u.uid.padEnd(30)} email=${(u.email||"(none)").padEnd(30)} name=${u.displayName||""} role=${role}`);
  });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
