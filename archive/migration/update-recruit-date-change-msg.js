#!/usr/bin/env node
// settings/notifications/channels/recruit_date_change.message を新文面に更新
// 旧文面と完全一致する場合のみ更新 (ユーザーがカスタマイズ済みなら触らない)
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const OLD = "{property}\n清掃日変更\n\n旧: {oldDate}\n新: {date}\n\n回答内容は新しい日付の募集に引き継がれます。\n\nWebアプリ\n{url}";
const NEW = "{property}\n清掃日変更\n\n旧: {oldDate}\n新: {date}\n\n以前の回答はクリアされました。新しい日付で改めて回答をお願いします。\n\nWebアプリ\n{url}";

const DRY_RUN = process.argv.includes("--dry-run");

(async () => {
  const ref = db.doc("settings/notifications");
  const snap = await ref.get();
  if (!snap.exists) { console.log("settings/notifications 未作成"); return; }
  const data = snap.data();
  const ch = data.channels?.recruit_date_change;
  if (!ch) { console.log("recruit_date_change チャンネル未作成"); return; }
  console.log("現在の message:", JSON.stringify(ch.message));
  if (ch.message === OLD) {
    console.log("旧文面と一致 → 新文面に更新", DRY_RUN ? "(DRY_RUN)" : "");
    if (!DRY_RUN) {
      await ref.update({ "channels.recruit_date_change.message": NEW });
      console.log("更新完了");
    }
  } else {
    console.log("カスタマイズ済みのためスキップ");
  }
})().catch(e => { console.error(e); process.exit(1); });
