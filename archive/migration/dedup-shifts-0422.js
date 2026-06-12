#!/usr/bin/env node
/**
 * 2026-04-22 重複 shifts + checklists を整理
 *
 * groupBy: propertyId | checkoutDate(YYYY-MM-DD) | workType(未設定は "cleaning")
 * 残す 1 件の優先順:
 *   1. status === "completed"
 *   2. staffId が設定されている (確定済)
 *   3. createdAt が最古
 *
 * 削除対象の shift に紐づく checklists (shiftId 一致) も同時に削除。
 * bookings / recruitments / staff / properties は一切触らない。
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

function toDateStr(co) {
  if (!co) return "";
  if (typeof co === "string") return co.slice(0, 10);
  if (co.toDate) return co.toDate().toLocaleDateString("sv-SE");
  if (co instanceof Date) return co.toLocaleDateString("sv-SE");
  return String(co).slice(0, 10);
}

function createdAtMs(x) {
  return x.createdAt?.toMillis?.() || (x.createdAt instanceof Date ? x.createdAt.getTime() : 0);
}

function pickKeeper(arr) {
  // 優先順で 1 件選ぶ
  const completed = arr.filter(x => x.data.status === "completed");
  if (completed.length) {
    completed.sort((a, b) => createdAtMs(a.data) - createdAtMs(b.data));
    return completed[0];
  }
  const withStaff = arr.filter(x => !!x.data.staffId);
  if (withStaff.length) {
    withStaff.sort((a, b) => createdAtMs(a.data) - createdAtMs(b.data));
    return withStaff[0];
  }
  const sorted = [...arr].sort((a, b) => createdAtMs(a.data) - createdAtMs(b.data));
  return sorted[0];
}

(async () => {
  const shiftSnap = await db.collection("shifts").get();
  const groups = {};
  shiftSnap.docs.forEach(d => {
    const x = d.data();
    const pid = x.propertyId || "-";
    const co = toDateStr(x.checkoutDate);
    const wt = x.workType || "cleaning";
    const key = `${pid}|${co}|${wt}`;
    (groups[key] = groups[key] || []).push({ ref: d.ref, id: d.id, data: x });
  });

  const dupGroups = Object.entries(groups).filter(([, arr]) => arr.length > 1);
  console.log(`全 shifts: ${shiftSnap.size}`);
  console.log(`グループ総数: ${Object.keys(groups).length}`);
  console.log(`重複グループ数: ${dupGroups.length}`);

  const shiftIdsToDelete = [];
  const summary = [];
  for (const [key, arr] of dupGroups) {
    const keeper = pickKeeper(arr);
    const drops = arr.filter(x => x.id !== keeper.id);
    summary.push({ key, total: arr.length, keep: keeper.id, keepStatus: keeper.data.status || "-", drops: drops.length });
    drops.forEach(x => shiftIdsToDelete.push(x));
  }

  // dry-run サマリ (上位 20 件)
  console.log("\n=== dry-run サマリ (上位 20 グループ) ===");
  summary.slice(0, 20).forEach(s => {
    console.log(`  ${s.key} / total=${s.total} / keep=${s.keep}(status=${s.keepStatus}) / drop=${s.drops}`);
  });
  console.log(`\n削除予定 shifts: ${shiftIdsToDelete.length} 件`);

  // 対応 checklists 収集
  const clSnap = await db.collection("checklists").get();
  const dropIdSet = new Set(shiftIdsToDelete.map(x => x.id));
  const clDelTargets = clSnap.docs.filter(d => dropIdSet.has(d.data().shiftId));
  console.log(`削除予定 checklists: ${clDelTargets.length} 件 (全 checklists=${clSnap.size})`);

  // 本削除実行
  console.log("\n=== 削除実行 ===");
  let shiftDel = 0;
  for (const x of shiftIdsToDelete) {
    await x.ref.delete();
    shiftDel++;
  }
  let clDel = 0;
  for (const d of clDelTargets) {
    await d.ref.delete();
    clDel++;
  }

  console.log(`\n結果: shifts 削除 ${shiftDel} 件 / checklists 削除 ${clDel} 件`);

  // === 追加ステップ: 現存 shifts に紐づかない孤児 checklists + checklist 自体の重複を整理 ===
  console.log("\n=== checklist 側 dedup ===");
  const afterShiftSnap = await db.collection("shifts").get();
  const aliveShiftIds = new Set(afterShiftSnap.docs.map(d => d.id));
  const afterClSnap = await db.collection("checklists").get();

  // 1) 孤児 checklist (shiftId が現存しない) を削除
  let orphanDel = 0;
  for (const d of afterClSnap.docs) {
    const sid = d.data().shiftId;
    if (sid && !aliveShiftIds.has(sid)) {
      await d.ref.delete();
      orphanDel++;
    }
  }
  console.log(`孤児 checklist 削除: ${orphanDel} 件`);

  // 2) propertyId+checkoutDate+workType で checklist を dedup (shift 側と同じ優先順)
  //    残すキー: 対応 shift が生存 & shift.workType を採用
  const after2 = await db.collection("checklists").get();
  const clGroups = {};
  after2.docs.forEach(d => {
    const x = d.data();
    const pid = x.propertyId || "-";
    const co = toDateStr(x.checkoutDate);
    const wt = x.workType || "cleaning";
    const key = `${pid}|${co}|${wt}`;
    (clGroups[key] = clGroups[key] || []).push({ ref: d.ref, id: d.id, data: x });
  });
  const clDupGroups = Object.entries(clGroups).filter(([, arr]) => arr.length > 1);
  console.log(`checklist 重複グループ: ${clDupGroups.length}`);
  let clGroupDel = 0;
  for (const [key, arr] of clDupGroups) {
    const keeper = pickKeeper(arr);
    for (const x of arr) {
      if (x.id !== keeper.id) { await x.ref.delete(); clGroupDel++; }
    }
    console.log(`  ${key} / ${arr.length}件 → keep=${keeper.id}(status=${keeper.data.status || "-"})`);
  }
  console.log(`checklist 重複削除: ${clGroupDel} 件`);

  // 再確認
  const finalShift = await db.collection("shifts").get();
  const finalCl = await db.collection("checklists").get();
  console.log(`\n最終: shifts=${finalShift.size} / checklists=${finalCl.size}`);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
