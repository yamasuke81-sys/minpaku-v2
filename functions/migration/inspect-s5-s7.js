// S5 (清掃チェックリスト), S6 (ランドリー), S7 (請求書) 検証
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const pid = "tsZybhDMcPrxqgcRy7wp";
  const toDate = (v) => v?.toDate ? v.toDate() : (typeof v === "string" ? new Date(v) : null);

  // ===== S5 =====
  console.log("=== S5: checklists 状況 ===");
  const shSnap = await db.collection("shifts").where("propertyId", "==", pid).get();
  const clSnap = await db.collection("checklists").where("propertyId", "==", pid).get();
  console.log(`  shifts: ${shSnap.size}, checklists: ${clSnap.size}`);
  const clByShift = new Map();
  clSnap.docs.forEach(d => clByShift.set(d.data().shiftId, { id: d.id, ...d.data() }));

  // shift - checklist ペアリング
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const missingCl = [];
  const completed = [];
  const inProgress = [];
  shSnap.docs.forEach(d => {
    const x = d.data();
    const shDate = toDate(x.date);
    if (!shDate) return;
    const cl = clByShift.get(d.id);
    if (shDate >= today) {
      // 未来シフト: checklist あるべき (onShiftCreated で生成)
      if (!cl) missingCl.push({ id: d.id, date: shDate.toISOString().substring(0,10), wt: x.workType, status: x.status });
    }
    if (cl?.status === "completed") completed.push(cl);
    if (cl?.status === "in_progress") inProgress.push(cl);
  });
  console.log(`  未来shiftでchecklist無し: ${missingCl.length}`);
  missingCl.forEach(m => console.log(`    ${m.date} shift=${m.id} wt=${m.wt} status=${m.status}`));
  console.log(`  in_progress: ${inProgress.length}, completed: ${completed.length}`);

  // checklist masterの有無
  const master = await db.collection("checklistMaster").doc("main").get();
  console.log(`  checklistMaster/main: ${master.exists ? "✅" : "❌"}`);
  if (master.exists) {
    const items = master.data().items || [];
    console.log(`    itemCount: ${items.length}`);
  }
  const tmpl = await db.collection("checklistTemplates").doc(pid).get();
  console.log(`  checklistTemplates/${pid}: ${tmpl.exists ? "✅" : "❌"}`);
  if (tmpl.exists) {
    const items = tmpl.data().items || [];
    console.log(`    itemCount (template): ${items.length}`);
  }

  // ===== S6 =====
  console.log("\n=== S6: laundry 状況 ===");
  const lndSnap = await db.collection("laundry").get();
  console.log(`  total: ${lndSnap.size}`);
  const lndPid = lndSnap.docs.filter(d => d.data().propertyId === pid);
  console.log(`  the Terrace 長浜: ${lndPid.length}`);
  const sumAmount = lndPid.reduce((s, d) => s + (d.data().amount || 0), 0);
  const reimbursable = lndPid.filter(d => d.data().isReimbursable === true).length;
  console.log(`  合計金額: ¥${sumAmount.toLocaleString()}, isReimbursable=true: ${reimbursable}`);
  // 直近5件
  lndPid.slice(0, 5).forEach(d => {
    const x = d.data();
    console.log(`    ${toDate(x.date)?.toISOString()?.substring(0,10)} ¥${x.amount} reimb=${x.isReimbursable} staffId=${x.staffId}`);
  });

  // ===== S7 =====
  console.log("\n=== S7: invoices 状況 ===");
  const invSnap = await db.collection("invoices").get();
  console.log(`  total: ${invSnap.size}`);
  const byStatus = {};
  invSnap.docs.forEach(d => {
    const s = d.data().status || "?";
    byStatus[s] = (byStatus[s] || 0) + 1;
  });
  console.log(`  status別:`, byStatus);
  console.log(`  最新10件:`);
  const invs = invSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.toDate?.() || 0) - (a.createdAt?.toDate?.() || 0))
    .slice(0, 10);
  invs.forEach(x => {
    console.log(`    ${x.id.padEnd(25)} ym=${x.yearMonth} staffId=${x.staffId?.substring(0,10)} total=¥${(x.total||0).toLocaleString()} status=${x.status} pdf=${x.pdfUrl ? "✅" : "❌"}`);
  });

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
