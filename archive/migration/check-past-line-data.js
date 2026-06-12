#!/usr/bin/env node
const a = require("firebase-admin");
a.initializeApp({ projectId: "minpaku-v2" });
const db = a.firestore();
(async () => {
  // 過去 notifications コレクションから物件別 LINE 送信履歴を探し groupId/channelName を復元
  const snap = await db.collection("notifications").orderBy("createdAt", "desc").limit(200).get();
  const byProp = {};
  for (const d of snap.docs) {
    const x = d.data();
    if (!x.propertyId) continue;
    if (!byProp[x.propertyId]) byProp[x.propertyId] = { name: x.propertyName, channels: new Set(), groups: new Set() };
    // result.sent や result の中に usedChannel/channelName/groupId があるか
    const r = x.result || x.sent || {};
    const s = JSON.stringify(r);
    const cm = s.match(/channelName"?\s*:\s*"([^"]+)"/g);
    if (cm) cm.forEach(m => byProp[x.propertyId].channels.add(m));
    const gm = s.match(/(?:groupId|to)"?\s*:\s*"(C[0-9a-f]{32}|U[0-9a-f]{32})"/g);
    if (gm) gm.forEach(m => byProp[x.propertyId].groups.add(m));
  }
  for (const [pid, info] of Object.entries(byProp)) {
    console.log(`--- ${info.name} (${pid}) ---`);
    console.log(`  channels: ${[...info.channels].join(", ") || "(なし)"}`);
    console.log(`  groups/users: ${[...info.groups].join(", ") || "(なし)"}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
