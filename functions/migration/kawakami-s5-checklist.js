// S5: 清掃チェックリスト生成・状態確認
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const PID = "tsZybhDMcPrxqgcRy7wp";

(async () => {
  console.log("=== S5: 清掃チェックリスト検証 ===\n");

  const today = new Date().toISOString().slice(0, 10);

  // 1. checklistTemplate の整備確認
  const tmplDoc = await db.collection("checklistTemplates").doc(PID).get();
  if (tmplDoc.exists) {
    const t = tmplDoc.data();
    let totalItems = 0;
    for (const a of (t.areas || [])) {
      totalItems += (a.directItems || []).length;
      totalItems += (a.items || []).length;
      for (const tt of (a.taskTypes || [])) {
        totalItems += (tt.directItems || []).length;
        totalItems += (tt.items || []).length;
      }
    }
    console.log(`テンプレート: v${t.version}, ${(t.areas || []).length}エリア, ${totalItems}項目`);
  } else {
    console.log("❌ テンプレート未設定");
  }

  // 2. 未来 shift に対応する checklist 生成状況
  console.log("\n--- 未来 shift と checklist の紐付き ---");
  const shSnap = await db.collection("shifts").where("propertyId", "==", PID).get();
  const futureShifts = shSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(s => {
      const dstr = s.date?.toDate ? s.date.toDate().toISOString().slice(0, 10) : String(s.date).slice(0, 10);
      return dstr >= today;
    })
    .sort((a, b) => {
      const da = a.date?.toDate ? a.date.toDate() : new Date(a.date);
      const db2 = b.date?.toDate ? b.date.toDate() : new Date(b.date);
      return da - db2;
    });

  console.log(`未来 shifts: ${futureShifts.length}件`);
  let missing = 0;
  for (const s of futureShifts) {
    const dstr = s.date?.toDate ? s.date.toDate().toISOString().slice(0, 10) : s.date;
    const cl = await db.collection("checklists").where("shiftId", "==", s.id).limit(1).get();
    const clInfo = cl.empty ? "cl❌" : `cl✓(${cl.docs[0].data().status})`;
    console.log(`  [${dstr}] shift ${s.id.substring(0, 8)} workType=${s.workType} staff=${s.staffName || "?"} ${clInfo}`);
    if (cl.empty) missing++;
  }
  console.log(`\n  checklist 未生成: ${missing}件`);

  // 3. 最近の完了済 checklist
  console.log("\n--- 最近完了した checklist (過去30日) ---");
  const recentCl = await db.collection("checklists")
    .where("propertyId", "==", PID)
    .where("status", "==", "completed").get();
  const sortByCompleted = recentCl.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(c => c.completedAt)
    .sort((a, b) => {
      const ta = a.completedAt?.toDate ? a.completedAt.toDate().getTime() : 0;
      const tb = b.completedAt?.toDate ? b.completedAt.toDate().getTime() : 0;
      return tb - ta;
    })
    .slice(0, 5);
  for (const c of sortByCompleted) {
    const ca = c.completedAt?.toDate ? c.completedAt.toDate().toISOString() : c.completedAt;
    console.log(`  ${c.id.substring(0, 8)} completed=${ca}`);
  }

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
