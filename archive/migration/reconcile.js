/**
 * 最終整合性確保:
 *  - 各 shift に対して checklist 1件(重複/孤児は削除、欠け補充)
 *  - 同じ booking+日付 の recruitment 重複削除、欠け補充
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const [shifts, checklists, recruitments, templates] = await Promise.all([
    db.collection("shifts").get(),
    db.collection("checklists").get(),
    db.collection("recruitments").get(),
    db.collection("checklistTemplates").get(),
  ]);

  const shiftIds = new Set(shifts.docs.map(d => d.id));

  // checklists 整合性
  const clByShift = {};
  const orphans = [];
  for (const d of checklists.docs) {
    const x = d.data();
    if (!x.shiftId || !shiftIds.has(x.shiftId)) { orphans.push(d); continue; }
    (clByShift[x.shiftId] = clByShift[x.shiftId] || []).push(d);
  }

  // 孤児削除
  console.log(`孤児 checklist 削除: ${orphans.length}件`);
  for (const d of orphans) await d.ref.delete();

  // 重複削除(同一shiftに複数)
  let clDupDel = 0;
  for (const [sid, arr] of Object.entries(clByShift)) {
    if (arr.length <= 1) continue;
    arr.sort((a,b) => (a.data().createdAt?.toMillis?.()||0) - (b.data().createdAt?.toMillis?.()||0));
    for (let i = 1; i < arr.length; i++) { await arr[i].ref.delete(); clDupDel++; }
  }
  console.log(`重複 checklist 削除: ${clDupDel}件`);

  // 欠け checklist 補充
  const tmplMap = {};
  templates.docs.forEach(d => { tmplMap[d.id] = d.data(); });
  let clAdd = 0;
  for (const s of shifts.docs) {
    const arr = clByShift[s.id] || [];
    if (arr.length >= 1) continue;
    const x = s.data();
    const tmpl = tmplMap[x.propertyId];
    if (!tmpl) continue;
    await db.collection("checklists").add({
      shiftId: s.id,
      propertyId: x.propertyId,
      propertyName: x.propertyName || "",
      checkoutDate: x.date,
      staffIds: x.staffIds || (x.staffId ? [x.staffId] : []),
      templateVersion: tmpl.version || 1,
      templateSnapshot: tmpl.areas || [],
      itemStates: {},
      beforePhotos: [], afterPhotos: [],
      laundry: { putOut: null, collected: null, stored: null },
      status: "in_progress", completedAt: null, completedBy: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    clAdd++;
  }
  console.log(`欠け checklist 補充: ${clAdd}件`);

  // recruitments 重複削除
  const recByKey = {};
  recruitments.docs.forEach(d => {
    const x = d.data();
    const k = `${x.checkoutDate}__${x.propertyId}__${x.bookingId}`;
    (recByKey[k] = recByKey[k] || []).push(d);
  });
  let recDupDel = 0;
  for (const arr of Object.values(recByKey)) {
    if (arr.length <= 1) continue;
    arr.sort((a,b) => (a.data().createdAt?.toMillis?.()||0) - (b.data().createdAt?.toMillis?.()||0));
    for (let i = 1; i < arr.length; i++) { await arr[i].ref.delete(); recDupDel++; }
  }
  console.log(`重複 recruitment 削除: ${recDupDel}件`);

  // 最終状態
  const [ns, nc, nr] = await Promise.all([
    db.collection("shifts").get(),
    db.collection("checklists").get(),
    db.collection("recruitments").get(),
  ]);
  console.log("\n=== 最終状態 ===");
  console.log(`shifts: ${ns.size} / checklists: ${nc.size} / recruitments: ${nr.size}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
