// YADO KOMACHI の最近の清掃フロー状態を確認
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  // 物件特定
  const propSnap = await db.collection("properties").get();
  const yado = propSnap.docs.find(d => (d.data().name || "").includes("YADO KOMACHI") || (d.data().name || "").includes("Hiroshima"));
  if (!yado) {
    console.log("YADO KOMACHI 物件が見つからない");
    for (const d of propSnap.docs) console.log(`  ${d.id}: ${d.data().name}`);
    process.exit(1);
  }
  const pid = yado.id;
  console.log(`物件: ${yado.data().name} (${pid})`);
  console.log(`  selectionMethod: ${yado.data().selectionMethod || "(未設定=ownerConfirm)"}`);
  console.log(`  active: ${yado.data().active}`);

  // checklistTemplate
  const tmpl = await db.collection("checklistTemplates").doc(pid).get();
  if (tmpl.exists) {
    const t = tmpl.data();
    console.log(`  checklistTemplate: version=${t.version || 1} areas=${(t.areas || []).length}個`);
  } else {
    console.log(`  ❌ checklistTemplate 未設定 → onShiftCreated で skip される`);
  }

  // 直近 recruitments (未来日のみ)
  const today = new Date().toISOString().slice(0, 10);
  const recSnap = await db.collection("recruitments")
    .where("propertyId", "==", pid).get();
  const recs = recSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(r => r.checkoutDate >= today || r.status === "スタッフ確定済み")
    .sort((a, b) => (a.checkoutDate || "").localeCompare(b.checkoutDate || ""));
  console.log(`\n最近の recruitments (${recs.length}件):`);
  for (const r of recs.slice(0, 10)) {
    console.log(`  [${r.checkoutDate}] ${r.status} sids=${JSON.stringify(r.selectedStaffIds||[])} selectedStaff="${r.selectedStaff || ""}" bookingId=${r.bookingId || "(なし)"} workType=${r.workType || "?"}`);
    const resp = r.responses || [];
    console.log(`    responses: ${resp.length}件 / ${resp.map(x => `${x.staffName}(${x.response})`).join(", ") || "なし"}`);
    console.log(`    id=${r.id}`);
    // 対応する shift 探索
    if (r.checkoutDate) {
      const coDate = new Date(r.checkoutDate);
      const shiftSnap = await db.collection("shifts")
        .where("propertyId", "==", pid)
        .where("date", "==", coDate).get();
      if (shiftSnap.empty) {
        console.log(`    shift: ❌ 未生成`);
      } else {
        for (const sd of shiftSnap.docs) {
          const s = sd.data();
          console.log(`    shift ${sd.id}: staffId=${s.staffId || "null"} status=${s.status} workType=${s.workType}`);
          // 対応 checklist
          const clSnap = await db.collection("checklists").where("shiftId", "==", sd.id).limit(1).get();
          if (clSnap.empty) console.log(`    checklist: ❌ 未生成`);
          else console.log(`    checklist ${clSnap.docs[0].id}: status=${clSnap.docs[0].data().status} staffIds=${JSON.stringify(clSnap.docs[0].data().staffIds || [])}`);
        }
      }
    }
  }

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
