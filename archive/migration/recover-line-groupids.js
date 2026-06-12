#!/usr/bin/env node
// line_webhook_logs から groupId 一覧を復元する
const a = require("firebase-admin");
a.initializeApp({ projectId: "minpaku-v2" });
const db = a.firestore();
(async () => {
  const since = 0; // 全期間
  const snap = await db.collection("line_webhook_logs").get();
  console.log(`line_webhook_logs 総件数: ${snap.size}`);
  const groups = {}; // groupId -> { count, lastMsg, sample, channelId, dest, hostBotUserId }
  for (const d of snap.docs) {
    const x = d.data();
    const gid = x.groupId;
    if (!gid) continue;
    const at = x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : 0;
    if (!groups[gid]) groups[gid] = { count: 0, last: 0, msg: "", dest: new Set(), hosts: new Set() };
    groups[gid].count++;
    if (at > groups[gid].last) {
      groups[gid].last = at;
      groups[gid].msg = (x.message || x.text || "").toString().slice(0, 50);
    }
    if (x.destination) groups[gid].dest.add(x.destination);
    if (x.hostBotUserId) groups[gid].hosts.add(x.hostBotUserId);
  }
  console.log(`\n=== ユニーク groupId: ${Object.keys(groups).length}件 (60日以内) ===`);
  for (const [gid, info] of Object.entries(groups)) {
    const lastDate = info.last ? new Date(info.last).toISOString().slice(0, 16).replace("T", " ") : "(不明)";
    console.log(`\n  groupId: ${gid}`);
    console.log(`    最終受信: ${lastDate} (${info.count}件)`);
    console.log(`    最後のメッセージ: ${info.msg || "(本文なし)"}`);
    if (info.dest && info.dest.size) console.log(`    destination (Bot userId): ${[...info.dest].join(", ")}`);
    if (info.hosts && info.hosts.size) console.log(`    hostBotUserId: ${[...info.hosts].join(", ")}`);
  }
  // 物件別 lineChannelToken (旧) の値も参考表示
  console.log(`\n=== 各物件の lineChannelToken (旧, 単独フィールド) ===`);
  const props = await db.collection("properties").where("active", "==", true).get();
  for (const p of props.docs) {
    const d = p.data();
    if (d.lineChannelToken) {
      console.log(`  ${d.name}: token len=${d.lineChannelToken.length} head=${d.lineChannelToken.slice(0, 12)}...`);
      console.log(`    lineGroupId (旧): ${d.lineGroupId || "(なし)"}`);
    }
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
