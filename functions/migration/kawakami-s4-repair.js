// S4 救済: 確定済み rec の selectedStaffIds 補完 + shift upsert
// 使い方:
//   node migration/kawakami-s4-repair.js           # dry-run
//   node migration/kawakami-s4-repair.js --execute
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

const PID = "tsZybhDMcPrxqgcRy7wp";
const DRY = !process.argv.includes("--execute");

(async () => {
  console.log(`モード: ${DRY ? "確認のみ" : "実行"}\n`);

  const pd = (await db.collection("properties").doc(PID).get()).data();
  const startTime = pd.cleaningStartTime || "10:30";

  // スタッフ名 → staffId のマップを作成
  const staffSnap = await db.collection("staff").get();
  const nameToId = {};
  for (const d of staffSnap.docs) {
    const s = d.data();
    if (s.name) nameToId[s.name] = d.id;
    // オーナーの別名対応 (例: 西山管理者 / 西山恭介)
    if (s.name === "西山管理者") nameToId["西山恭介"] = d.id;
  }
  console.log(`スタッフ名→ID マップ: ${Object.keys(nameToId).length}件\n`);

  const today = new Date().toISOString().slice(0, 10);
  const recSnap = await db.collection("recruitments").where("propertyId", "==", PID).get();
  const targets = recSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(r => (r.checkoutDate || "") >= today)
    .filter(r => r.status === "スタッフ確定済み")
    .filter(r => !(r.selectedStaffIds?.length) && r.selectedStaff);

  console.log(`救済対象 (確定済み + selectedStaffIds=[] + selectedStaff あり): ${targets.length}件\n`);

  for (const r of targets) {
    const names = (r.selectedStaff || "").split(",").map(s => s.trim()).filter(Boolean);
    const resolvedIds = names.map(n => nameToId[n]).filter(Boolean);
    const unresolved = names.filter(n => !nameToId[n]);

    console.log(`--- [${r.checkoutDate}] rec ${r.id} ---`);
    console.log(`  selectedStaff="${r.selectedStaff}"`);
    console.log(`  解決: ${resolvedIds.length}/${names.length}件 (未解決: ${unresolved.join(", ") || "なし"})`);

    if (resolvedIds.length === 0) {
      console.log(`  ❌ staffId 解決不可 → スキップ`);
      continue;
    }

    // shift を探す
    const shSnap = await db.collection("shifts").where("bookingId", "==", r.bookingId).get();
    const shifts = shSnap.docs.filter(d => {
      const sd = d.data();
      const dstr = sd.date?.toDate ? sd.date.toDate().toISOString().slice(0, 10) : String(sd.date).slice(0, 10);
      return dstr === r.checkoutDate;
    });

    const payload = {
      staffId: resolvedIds[0],
      staffName: staffSnap.docs.find(d => d.id === resolvedIds[0])?.data().name || names[0],
      staffIds: resolvedIds,
      status: "assigned",
      assignMethod: "manual_repair",
      updatedAt: FV.serverTimestamp(),
    };

    if (shifts.length > 0) {
      console.log(`  shift ${shifts[0].id} を update`);
      console.log(`    → staffId=${payload.staffId} staffIds=${JSON.stringify(payload.staffIds)}`);
      if (!DRY) {
        await shifts[0].ref.update(payload);
      }
    } else {
      // 新規作成
      console.log(`  shift 無し → 新規作成`);
      const coDate = new Date(r.checkoutDate);
      const newShift = {
        date: coDate,
        propertyId: PID,
        propertyName: pd.name,
        bookingId: r.bookingId || null,
        workType: r.workType === "pre_inspection" ? "pre_inspection" : "cleaning_by_count",
        startTime,
        createdAt: FV.serverTimestamp(),
        ...payload,
      };
      console.log(`    → staffId=${payload.staffId} staffIds=${JSON.stringify(payload.staffIds)}`);
      if (!DRY) {
        await db.collection("shifts").add(newShift);
      }
    }

    // recruitment.selectedStaffIds も補完
    console.log(`  rec.selectedStaffIds 補完: ${JSON.stringify(resolvedIds)}`);
    if (!DRY) {
      await db.collection("recruitments").doc(r.id).update({
        selectedStaffIds: resolvedIds,
        updatedAt: FV.serverTimestamp(),
      });
    }

    console.log();
  }

  console.log(`\n${DRY ? "→ --execute で実行" : "実行完了"}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
