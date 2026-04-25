#!/usr/bin/env node
// 梶本さん 2026年4月分シフトの staffId / staffIds 実データ調査
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

(async () => {
  // 1) 梶本さんの staffId を特定
  const staffSnap = await db.collection("staff").get();
  const kajimotos = [];
  staffSnap.forEach(d => {
    const v = d.data();
    if ((v.name || "").includes("梶本") || (v.displayName || "").includes("梶本")) {
      kajimotos.push({ id: d.id, name: v.name || v.displayName, active: v.active });
    }
  });
  console.log("=== 梶本候補 ===");
  console.log(JSON.stringify(kajimotos, null, 2));
  if (kajimotos.length === 0) { process.exit(0); }
  const kajimotoId = kajimotos[0].id;

  // 2) 4月のシフトを date で絞り込み
  const start = new Date("2026-04-01T00:00:00+09:00");
  const end = new Date("2026-04-30T23:59:59+09:00");
  const allShifts = await db.collection("shifts")
    .where("date", ">=", start)
    .where("date", "<=", end)
    .get();
  console.log(`\n=== 2026/4 全shift件数: ${allShifts.size} ===`);

  const hits = [];
  allShifts.forEach(d => {
    const v = d.data();
    const inStaffId = v.staffId === kajimotoId;
    const inStaffIds = Array.isArray(v.staffIds) && v.staffIds.includes(kajimotoId);
    const inSelected = Array.isArray(v.selectedStaffIds) && v.selectedStaffIds.includes(kajimotoId);
    if (inStaffId || inStaffIds || inSelected) {
      hits.push({
        id: d.id,
        date: v.date?.toDate ? v.date.toDate().toISOString() : v.date,
        propertyId: v.propertyId,
        workType: v.workType,
        staffId: v.staffId,
        staffIds: v.staffIds,
        selectedStaffIds: v.selectedStaffIds,
        status: v.status,
        keys: Object.keys(v),
      });
    }
  });
  console.log(`\n=== 梶本ヒット: ${hits.length}件 ===`);
  console.log(JSON.stringify(hits, null, 2));

  // 3) 4/5 と 4/27 のシフトを全件確認 (フィールド構造チェック)
  for (const day of ["2026-04-05", "2026-04-27"]) {
    const s = new Date(`${day}T00:00:00+09:00`);
    const e = new Date(`${day}T23:59:59+09:00`);
    const snap = await db.collection("shifts")
      .where("date", ">=", s).where("date", "<=", e).get();
    console.log(`\n=== ${day} の全shifts (${snap.size}件) ===`);
    snap.forEach(d => {
      const v = d.data();
      console.log(`  ${d.id}: staffId=${JSON.stringify(v.staffId)}, staffName=${JSON.stringify(v.staffName)}, staffIds=${JSON.stringify(v.staffIds)}, selectedStaffIds=${JSON.stringify(v.selectedStaffIds)}, propertyId=${v.propertyId}, workType=${v.workType}, status=${v.status}`);
    });
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
