// S1: iCal連携 → bookings 反映 の検証
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const PID = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜

(async () => {
  console.log("=== S1: iCal連携検証 ===\n");

  // 1. syncSettings から the Terrace 長浜 の iCal URL を取得
  console.log("--- syncSettings (iCal URL 登録) ---");
  const ssSnap = await db.collection("syncSettings").get();
  const terraceSettings = ssSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => s.propertyId === PID);
  console.log(`  全 syncSettings: ${ssSnap.size}件 / the Terrace 長浜: ${terraceSettings.length}件`);
  for (const s of terraceSettings) {
    const ls = s.lastSyncedAt?.toDate ? s.lastSyncedAt.toDate().toISOString() : s.lastSyncedAt;
    console.log(`  ${s.id}: active=${s.active} platform=${s.platform || "?"}`);
    console.log(`    icalUrl: ${(s.icalUrl || "").substring(0, 80)}...`);
    console.log(`    lastSyncedAt: ${ls || "(未設定)"}`);
  }

  // 2. 全体 syncConfig
  console.log("\n--- settings/syncConfig ---");
  const sc = await db.collection("settings").doc("syncConfig").get();
  if (sc.exists) {
    const d = sc.data();
    const last = d.lastIcalSync?.toDate ? d.lastIcalSync.toDate().toISOString() : d.lastIcalSync;
    console.log(`  lastIcalSync: ${last || "(未設定)"}`);
    if (d.lastIcalSync) {
      const mins = Math.floor((Date.now() - (d.lastIcalSync.toDate ? d.lastIcalSync.toDate().getTime() : new Date(d.lastIcalSync).getTime())) / 60000);
      console.log(`  → ${mins}分前`);
    }
  }

  // 3. bookings 統計
  console.log("\n--- bookings (the Terrace 長浜) ---");
  const bSnap = await db.collection("bookings").where("propertyId", "==", PID).get();
  const today = new Date().toISOString().slice(0, 10);
  const active = bSnap.docs.filter(d => {
    const x = d.data();
    const s = String(x.status || "").toLowerCase();
    return !s.includes("cancel") && x.status !== "キャンセル" && x.status !== "キャンセル済み";
  });
  const future = active.filter(d => (d.data().checkOut || "") >= today);
  const cancelled = bSnap.docs.length - active.length;
  console.log(`  全件: ${bSnap.size}件 / アクティブ: ${active.length}件 (未来${future.length}) / キャンセル済: ${cancelled}件`);

  // 4. 最新予約
  console.log("\n--- 未来予約 (直近5件) ---");
  const upcoming = future
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.checkIn || "").localeCompare(b.checkIn || ""))
    .slice(0, 5);
  for (const b of upcoming) {
    console.log(`  [${b.checkIn} → ${b.checkOut}] ${b.guestName || "(無記名)"} via ${b.source || "?"}`);
  }

  // 5. 名無し/ブロック予約のアラート
  console.log("\n--- ⚠ 名無し/Not-available 予約 (アクティブ中) ---");
  const blockLike = active.filter(d => {
    const x = d.data();
    const n = String(x.guestName || "");
    return !n || n.includes("Not available") || n === "Reserved" || n === "Blocked" || n === "?";
  });
  console.log(`  ${blockLike.length}件`);
  for (const d of blockLike.slice(0, 5)) {
    const b = d.data();
    console.log(`  ${d.id}: [${b.checkIn}→${b.checkOut}] name="${b.guestName || ""}" status=${b.status}`);
  }

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
