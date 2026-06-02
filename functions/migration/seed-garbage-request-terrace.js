#!/usr/bin/env node
// the Terrace 長浜 の channelOverrides.garbage_request を既定ON にする
// (ゴミ回収依頼: 清掃完了画面の確認表示 + 通知を Terrace のみ有効化)
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const TERRACE_PID = "tsZybhDMcPrxqgcRy7wp";

(async () => {
  const ref = db.collection("properties").doc(TERRACE_PID);
  const snap = await ref.get();
  if (!snap.exists) { console.error("物件が見つかりません:", TERRACE_PID); process.exit(1); }

  const existing = snap.data().channelOverrides?.garbage_request;
  if (existing && existing.enabled === true) {
    console.log("既に garbage_request は有効です。スキップ。");
    return;
  }

  await ref.update({
    "channelOverrides.garbage_request": {
      enabled: true,
      ownerLine: true,
      groupLine: false,
      staffLine: false,
      ownerEmail: false,
    },
  });
  console.log("✅ the Terrace 長浜 の garbage_request を有効化しました。");
})().catch((e) => { console.error(e); process.exit(1); });
