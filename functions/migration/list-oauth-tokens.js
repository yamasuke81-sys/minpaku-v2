/**
 * 現状の OAuth トークン一覧を表示 (デバッグ用、書き込みなし)
 */
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const COLS = [
  { docPath: "settings/gmailOAuthEmailVerification", label: "emailVerification + property" },
  { docPath: "settings/gmailOAuth", label: "default (tax-docs)" },
];

async function main() {
  // staff ID → name マップ
  const staffSnap = await db.collection("staff").get();
  const staffName = {};
  for (const s of staffSnap.docs) staffName[s.id] = s.data().name || s.id;

  // properties.senderGmail → {ownerId, name}
  const propsSnap = await db.collection("properties").get();
  const sgmap = new Map();
  for (const p of propsSnap.docs) {
    const d = p.data();
    if (d.senderGmail) {
      sgmap.set(String(d.senderGmail).toLowerCase(), {
        ownerId: d.ownerId || "",
        propertyName: d.name,
      });
    }
  }

  for (const c of COLS) {
    console.log(`\n=== ${c.label} (${c.docPath}/tokens) ===`);
    const snap = await db.doc(c.docPath).collection("tokens").get();
    console.log(`  件数: ${snap.size}`);
    for (const t of snap.docs) {
      const d = t.data();
      const sg = sgmap.get(String(d.email || "").toLowerCase());
      const ownerLabel = d.ownerId
        ? `ownerId=${d.ownerId} (${staffName[d.ownerId] || "?"})`
        : "ownerId=未設定";
      const sgLabel = sg
        ? `senderGmail一致: ${sg.propertyName} → owner=${staffName[sg.ownerId] || sg.ownerId}`
        : "senderGmail一致なし → メインオーナー fallback";
      console.log(`  - ${d.email || t.id}`);
      console.log(`      現状: ${ownerLabel}`);
      console.log(`      推定: ${sgLabel}`);
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
