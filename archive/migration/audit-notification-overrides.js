#!/usr/bin/env node
// 全物件の channelOverrides を一覧表示し、グローバル settings との差異を精査
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

(async () => {
  const settingsSnap = await db.doc("settings/notifications").get();
  const globalCh = settingsSnap.data()?.channels || {};
  const globalKeys = Object.keys(globalCh).sort();

  console.log("=== グローバル settings/notifications.channels ===");
  for (const k of globalKeys) {
    const c = globalCh[k];
    console.log(`  ${k}: enabled=${c.enabled} ownerLine=${c.ownerLine} timing=${c.timing}`);
  }

  console.log("\n=== 全物件の channelOverrides ===");
  const props = await db.collection("properties").where("active", "==", true).get();
  for (const p of props.docs) {
    const pd = p.data();
    const ov = pd.channelOverrides || {};
    const ovKeys = Object.keys(ov).sort();
    console.log(`\n--- ${pd.name} (${p.id}) ---`);
    if (!ovKeys.length) { console.log("  (channelOverrides 未設定)"); continue; }
    for (const k of ovKeys) {
      const o = ov[k];
      const g = globalCh[k] || {};
      const diff = (o.enabled !== g.enabled) ? "⚠️ 差異" : "";
      console.log(`  ${k}: 物件別 enabled=${o.enabled} ownerLine=${o.ownerLine} | グローバル enabled=${g.enabled} ${diff}`);
    }
  }

  // YADO の booking_cancel を詳細
  const yado = props.docs.find(p => p.data().name === "YADO KOMACHI Hiroshima");
  if (yado) {
    console.log(`\n=== YADO booking_cancel 詳細 ===`);
    console.log(JSON.stringify(yado.data().channelOverrides?.booking_cancel, null, 2));
  }
})().catch(e => { console.error(e); process.exit(1); });
