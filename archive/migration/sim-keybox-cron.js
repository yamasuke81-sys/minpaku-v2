// sendKeyboxScheduled のロジックを今 (5/18 朝) で再現
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const { computeScheduledSendAt } = require("../utils/keyboxSender");

(async () => {
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const nowJst = new Date(now.getTime() + jstOffset);
  const todayStr = nowJst.toISOString().slice(0, 10);
  const futureLimit = new Date(nowJst.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  console.log("now UTC:", now.toISOString());
  console.log("now JST:", nowJst.toISOString());
  console.log("todayStr:", todayStr, "futureLimit:", futureLimit);

  const snap = await db.collection("guestRegistrations")
    .where("checkIn", ">=", todayStr)
    .where("checkIn", "<=", futureLimit)
    .where("status", "in", ["submitted", "confirmed"])
    .get();
  console.log("snap size:", snap.size);

  for (const doc of snap.docs) {
    const data = doc.data();
    console.log("\n---", doc.id, data.guestName, "CI=" + data.checkIn, "status=" + data.status);
    console.log("  keyboxSentAt:", data.keyboxSentAt ? "SET" : "未送信");
    console.log("  keyboxConfirmedAt:", data.keyboxConfirmedAt ? "SET" : "未確認");
    if (data.keyboxSentAt) { console.log("  → 既送信スキップ"); continue; }
    const prop = data.propertyId ? (await db.collection("properties").doc(data.propertyId).get()).data() : null;
    if (!prop) { console.log("  → property無しスキップ"); continue; }
    const ks = prop.keyboxSend || {};
    console.log("  prop.name:", prop.name, "enabled:", ks.enabled, "mode:", ks.mode);
    if (!ks.enabled) { console.log("  → enabled=falseスキップ"); continue; }
    const scheduledAt = computeScheduledSendAt(data.checkIn, ks);
    if (!scheduledAt) { console.log("  → scheduledAt null"); continue; }
    const diffMin = (scheduledAt.getTime() - now.getTime()) / 60000;
    console.log("  scheduledAt UTC:", scheduledAt.toISOString(), "diffMin:", diffMin.toFixed(1));
    const inSendWindow = diffMin >= -30 && diffMin <= 30;
    const inRemindWindow = diffMin >= -60 && diffMin <= 60;
    console.log("  inSendWindow:", inSendWindow, "inRemindWindow:", inRemindWindow);
    if (ks.mode === "after_ok_click" && inRemindWindow && !data.keyboxConfirmedAt) {
      console.log("  → keybox_remind対象");
      continue;
    }
    if (!inSendWindow) { console.log("  → 送信ウィンドウ外スキップ"); continue; }
    if (ks.mode === "after_ok_click" && !data.keyboxConfirmedAt) { console.log("  → OK未押下スキップ"); continue; }
    if (!data.email) { console.log("  → メール無しスキップ"); continue; }
    console.log("  ★ 送信されるべき!");
  }
  process.exit(0);
})();
