#!/usr/bin/env node
/**
 * 手動予約 (source=manual or manualOverride=true) と対応する recruitments を全洗い出し
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

(async () => {
  // 物件名マップ
  const propSnap = await db.collection("properties").get();
  const propMap = {};
  propSnap.docs.forEach(d => { propMap[d.id] = d.data().name || d.id; });
  console.log("物件一覧:");
  Object.entries(propMap).forEach(([id, name]) => console.log(`  ${id} = ${name}`));

  // 手動予約の抽出
  const bSnap = await db.collection("bookings").get();
  const manualBookings = [];
  bSnap.docs.forEach((d) => {
    const b = d.data();
    const isManual = b.manualOverride === true || (b.source && /manual/i.test(String(b.source)));
    if (isManual) manualBookings.push({ id: d.id, ...b });
  });
  console.log(`\n手動予約 bookings 総数: ${manualBookings.length}`);
  manualBookings.forEach((b) => {
    const ca = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().toISOString() : "-";
    console.log(`  ${b.id} / ${propMap[b.propertyId] || b.propertyId} / CI=${b.checkIn} / CO=${b.checkOut} / guest=${b.guestName || "-"} / status=${b.status} / source=${b.source} / createdAt=${ca}`);
  });

  // 手動募集の抽出
  const rSnap = await db.collection("recruitments").get();
  const manualRecruits = [];
  rSnap.docs.forEach((d) => {
    const r = d.data();
    if (r.manualCreated === true) manualRecruits.push({ id: d.id, ...r });
  });
  console.log(`\n手動作成 recruitments 総数: ${manualRecruits.length}`);
  manualRecruits.forEach((r) => {
    const ca = r.createdAt && r.createdAt.toDate ? r.createdAt.toDate().toISOString() : "-";
    console.log(`  ${r.id} / ${propMap[r.propertyId] || r.propertyId} / CO=${r.checkoutDate} / workType=${r.workType} / status=${r.status} / createdAt=${ca}`);
  });

  // 5/5 近傍の全予約 (物件別)
  console.log(`\n\n===== 2026-05-05 近傍の全予約 (CI が 5/1〜5/10) =====`);
  bSnap.docs.forEach((d) => {
    const b = d.data();
    const ci = b.checkIn;
    if (typeof ci === "string" && ci >= "2026-05-01" && ci <= "2026-05-10") {
      const ca = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().toISOString() : "-";
      console.log(`  ${d.id} / ${propMap[b.propertyId] || b.propertyId} / CI=${b.checkIn} / CO=${b.checkOut} / guest=${b.guestName || "-"} / source=${b.source} / manual=${b.manualOverride === true} / status=${b.status} / createdAt=${ca}`);
    }
  });

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
