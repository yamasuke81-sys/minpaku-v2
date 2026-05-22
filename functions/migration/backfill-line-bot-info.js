#!/usr/bin/env node
// 全 active 物件 + settings/notifications の LINE Channel Access Token から
// Bot Info (displayName/basicId/userId) を取得して Firestore にキャッシュ書き戻す
//
// 使い方:
//   node functions/migration/backfill-line-bot-info.js            # dry-run
//   node functions/migration/backfill-line-bot-info.js --execute  # 本番反映
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const { fetchLineBotInfo } = require("../utils/lineBotInfo");

const isExecute = process.argv.includes("--execute");
console.log(`mode: ${isExecute ? "EXECUTE" : "DRY-RUN (実行は --execute)"}`);

async function refreshDoc(ref, data, label) {
  const update = {};
  let count = 0;
  // 配列フィールドへの dot 記法書き込みは配列をマップ化して破壊する。
  // 配列全体を読んで botInfo を埋めた新配列で update する。
  const lineChannels = Array.isArray(data.lineChannels) ? data.lineChannels.map(c => ({ ...c })) : null;
  if (lineChannels) {
    for (let i = 0; i < lineChannels.length; i++) {
      const c = lineChannels[i];
      if (!c || !c.token) continue;
      const info = await fetchLineBotInfo(c.token);
      if (!info) { console.log(`  [skip] ${label}.lineChannels[${i}]: 取得失敗`); continue; }
      lineChannels[i].botInfo = info;
      console.log(`  [add ] ${label}.lineChannels[${i}]: ${info.displayName} (${info.basicId})`);
      count++;
    }
    if (count > 0) update.lineChannels = lineChannels;
  }
  if (data.lineChannelToken) {
    const info = await fetchLineBotInfo(data.lineChannelToken);
    if (info) {
      update["lineBotInfo"] = info;
      console.log(`  [add ] ${label}.lineChannelToken: ${info.displayName} (${info.basicId})`);
      count++;
    }
  }
  const ownerLineChannels = Array.isArray(data.ownerLineChannels) ? data.ownerLineChannels.map(c => ({ ...c })) : null;
  if (ownerLineChannels) {
    let ownerDirty = false;
    for (let i = 0; i < ownerLineChannels.length; i++) {
      const c = ownerLineChannels[i];
      if (!c || !c.token) continue;
      const info = await fetchLineBotInfo(c.token);
      if (!info) continue;
      ownerLineChannels[i].botInfo = info;
      console.log(`  [add ] ${label}.ownerLineChannels[${i}]: ${info.displayName} (${info.basicId})`);
      count++;
      ownerDirty = true;
    }
    if (ownerDirty) update.ownerLineChannels = ownerLineChannels;
  }
  if (count === 0) {
    console.log(`  [skip] ${label}: token なし`);
    return 0;
  }
  if (isExecute) await ref.update(update);
  return count;
}

(async () => {
  let total = 0;

  // settings/notifications
  console.log(`\n--- settings/notifications ---`);
  const sDoc = await db.doc("settings/notifications").get();
  if (sDoc.exists) {
    total += await refreshDoc(sDoc.ref, sDoc.data(), "settings/notifications");
  } else {
    console.log("  (なし)");
  }

  // properties (active=true)
  const props = await db.collection("properties").where("active", "==", true).get();
  for (const pd of props.docs) {
    const name = pd.data().name || pd.id;
    console.log(`\n--- ${name} (${pd.id}) ---`);
    total += await refreshDoc(pd.ref, pd.data(), name);
  }

  console.log(`\n=== 更新: ${total}件 ${isExecute ? "" : "(dry-run)"} ===`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
