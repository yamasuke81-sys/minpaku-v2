// 予約フロー各ステップの「他タブ同期元」候補を一覧
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  console.log("=== settings/notifications.channels の全キー ===");
  const notif = await db.collection("settings").doc("notifications").get();
  const s = notif.data() || {};
  const chs = s.channels || {};
  Object.keys(chs).sort().forEach(k => {
    const c = chs[k] || {};
    console.log(`  ${k}: enabled=${c.enabled} ownerLine=${c.ownerLine} groupLine=${c.groupLine}`);
  });

  console.log("\n=== properties[0] の iCal 関連フィールド ===");
  const pSnap = await db.collection("properties").limit(1).get();
  if (!pSnap.empty) {
    const p = pSnap.docs[0].data();
    const icalKeys = Object.keys(p).filter(k => k.toLowerCase().includes("ical") || k.toLowerCase().includes("sync") || k.toLowerCase().includes("beds24"));
    console.log(`  該当キー: ${icalKeys.join(", ") || "なし"}`);
    for (const k of icalKeys) {
      const v = p[k];
      console.log(`  ${k}: ${typeof v === "object" ? JSON.stringify(v).slice(0, 120) : v}`);
    }
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
