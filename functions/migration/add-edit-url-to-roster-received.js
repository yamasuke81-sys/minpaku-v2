#!/usr/bin/env node
// the Terrace 長浜 / YADO KOMACHI Hiroshima の roster_received 通知本文に
// 名簿修正用URL (ゲスト用) を追加
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const TARGET_PROPERTIES = ["the Terrace 長浜", "YADO KOMACHI Hiroshima"];
const OLD = "宿泊者名簿が届きました\n\n{property}\n\n{checkin} \n\nゲスト: {guest}\n\n詳細\n{url}";
const NEW = "宿泊者名簿が届きました\n\n{property}\n\n{checkin} \n\nゲスト: {guest}\n\n詳細\n{url}\n\n名簿修正用URL（ゲスト用）\n{editUrl}";

const DRY_RUN = process.argv.includes("--dry-run");

(async () => {
  const snap = await db.collection("properties").where("name", "in", TARGET_PROPERTIES).get();
  for (const d of snap.docs) {
    const data = d.data();
    const ov = data.channelOverrides?.roster_received;
    if (!ov) { console.log(`${data.name}: roster_received 未設定 → スキップ`); continue; }
    const cur = ov.customMessage || "";
    if (cur === NEW) { console.log(`${data.name}: 既に新文面 → スキップ`); continue; }
    if (cur !== OLD) {
      console.log(`${data.name}: カスタマイズ済 (旧文面と完全一致せず) → 末尾に追加で更新`);
    }
    const newMessage = cur.includes("{editUrl}") ? cur :
      (cur.endsWith("\n") ? `${cur}\n名簿修正用URL（ゲスト用）\n{editUrl}` : `${cur}\n\n名簿修正用URL（ゲスト用）\n{editUrl}`);
    console.log(`---\n${data.name}: 更新 ${DRY_RUN ? "(DRY_RUN)" : ""}\n旧: ${JSON.stringify(cur)}\n新: ${JSON.stringify(newMessage)}`);
    if (!DRY_RUN) {
      await d.ref.update({
        "channelOverrides.roster_received.customMessage": newMessage,
      });
      console.log("  → 更新完了");
    }
  }
})();
