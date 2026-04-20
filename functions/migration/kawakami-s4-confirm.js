// S4: スタッフ確定状態の検証
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const PID = "tsZybhDMcPrxqgcRy7wp";

(async () => {
  console.log("=== S4: スタッフ確定状態の検証 ===\n");

  const pd = (await db.collection("properties").doc(PID).get()).data();
  console.log(`物件: ${pd.name}`);
  console.log(`  selectionMethod: ${pd.selectionMethod || "(未設定=ownerConfirm)"}\n`);

  const recSnap = await db.collection("recruitments").where("propertyId", "==", PID).get();
  const today = new Date().toISOString().slice(0, 10);
  const recs = recSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(r => (r.checkoutDate || "") >= today)
    .sort((a, b) => (a.checkoutDate || "").localeCompare(b.checkoutDate || ""));

  // 確定済み rec を掘り下げる
  const confirmed = recs.filter(r => r.status === "スタッフ確定済み");
  console.log(`確定済み: ${confirmed.length}件`);
  for (const r of confirmed) {
    const sids = r.selectedStaffIds || [];
    const sname = r.selectedStaff || "";
    // 対応 shift
    const shSnap = await db.collection("shifts")
      .where("bookingId", "==", r.bookingId).get();
    const shifts = shSnap.docs.filter(d => {
      const sd = d.data();
      const dstr = sd.date?.toDate ? sd.date.toDate().toISOString().slice(0, 10) : String(sd.date).slice(0, 10);
      return dstr === r.checkoutDate;
    });
    console.log(`\n  [${r.checkoutDate}] rec ${r.id}`);
    console.log(`    selectedStaff="${sname}" selectedStaffIds=${JSON.stringify(sids)}`);
    console.log(`    shifts: ${shifts.length}件`);
    for (const s of shifts) {
      const sd = s.data();
      console.log(`      shift ${s.id}: staffId=${sd.staffId || "null"} staffName="${sd.staffName || ""}" status=${sd.status} assignMethod=${sd.assignMethod || "?"}`);
    }
    // 整合性チェック
    const sh = shifts[0];
    if (!sh) {
      console.log(`    ❌ shift 未生成`);
    } else if (!sh.data().staffId && sids.length > 0) {
      console.log(`    ❌ shift.staffId が null なのに selectedStaffIds あり → 確定 API の shift upsert が未動作`);
    } else if (sh.data().staffId && sids.length > 0 && sh.data().staffId === sids[0]) {
      console.log(`    ✅ 整合`);
    } else {
      console.log(`    ⚠ 状態不明`);
    }
  }

  // 募集中だが回答ある rec
  const withResp = recs.filter(r => r.status === "募集中" && (r.responses || []).length > 0);
  console.log(`\n\n募集中で回答あり: ${withResp.length}件`);
  for (const r of withResp) {
    const resp = r.responses || [];
    const yes = resp.filter(x => x.response === "◎");
    const maybe = resp.filter(x => x.response === "△");
    const no = resp.filter(x => x.response === "×");
    console.log(`  [${r.checkoutDate}] ◎${yes.length} △${maybe.length} ×${no.length}`);
  }

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
