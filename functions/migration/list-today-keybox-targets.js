#!/usr/bin/env node
// 本日 CI のキーボックス送信対象ゲスト一覧 (YADO KOMACHI Hiroshima)
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const YADO_ID = "ncUKeD4yQo0kfAoznITu";

(async () => {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const today = now.toISOString().slice(0, 10);
  console.log(`本日 (JST): ${today}`);

  const snap = await db.collection("guestRegistrations")
    .where("checkIn", "==", today)
    .where("propertyId", "==", YADO_ID)
    .get();

  console.log(`本日 CI ゲスト (YADO KOMACHI): ${snap.size}件\n`);
  snap.forEach((d) => {
    const x = d.data();
    console.log(`[${d.id}]`);
    console.log(`  guestName=${x.guestName} email=${x.email}`);
    console.log(`  status=${x.status} CI=${x.checkIn} CO=${x.checkOut}`);
    console.log(`  keyboxConfirmedAt=${x.keyboxConfirmedAt ? "set" : "未設定"}`);
    console.log(`  keyboxSentAt=${x.keyboxSentAt ? "送信済" : "未送信"}`);
    console.log();
  });

  // 物件の keyboxSend 設定確認
  const p = await db.collection("properties").doc(YADO_ID).get();
  const ks = (p.data() || {}).keyboxSend || {};
  console.log(`YADO KOMACHI keyboxSend 設定:`);
  console.log(`  enabled=${ks.enabled} mode=${ks.mode}`);
  console.log(`  scheduleType=${ks.scheduleType} daysBeforeCheckin=${ks.daysBeforeCheckin} sendTime=${ks.sendTime}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
