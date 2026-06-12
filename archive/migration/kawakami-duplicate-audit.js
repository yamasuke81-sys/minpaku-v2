// デバッグ残骸/重複データの全数調査
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

function isCancelled(s) {
  const x = String(s || "").toLowerCase();
  return x.includes("cancel") || s === "キャンセル" || s === "キャンセル済み";
}

(async () => {
  console.log("=== デバッグ残骸/重複 全数調査 ===\n");

  // -------- A. _e2eTest フラグ付き残骸 --------
  console.log("A. _e2eTest フラグ付きドキュメント");
  const COLS = ["staff","recruitments","shifts","bookings","guestRegistrations","laundry","invoices","checklists","bookingConflicts"];
  let e2eTotal = 0;
  for (const c of COLS) {
    const s = await db.collection(c).where("_e2eTest", "==", true).get();
    if (s.size > 0) {
      console.log(`  ${c}: ${s.size}件`);
      e2eTotal += s.size;
    }
  }
  console.log(`  合計: ${e2eTotal}件\n`);

  // -------- B. shift 重複 (同一 bookingId + 同一 date + 同一 workType) --------
  console.log("B. shift 重複 (同 booking + 同日 + 同 workType)");
  const shSnap = await db.collection("shifts").get();
  const shKey = new Map();
  for (const d of shSnap.docs) {
    const s = d.data();
    const date = s.date?.toDate ? s.date.toDate().toISOString().slice(0, 10) : String(s.date || "").slice(0, 10);
    const k = `${s.bookingId || "(none)"}|${date}|${s.workType || "?"}|${s.propertyId}`;
    if (!shKey.has(k)) shKey.set(k, []);
    shKey.get(k).push({ id: d.id, ...s });
  }
  let shDup = 0;
  for (const [k, arr] of shKey.entries()) {
    if (arr.length > 1) {
      shDup++;
      console.log(`  [${k}] ${arr.length}件: ${arr.map(x => x.id.substring(0,8)).join(", ")}`);
    }
  }
  console.log(`  重複グループ: ${shDup}件\n`);

  // -------- C. recruitment 重複 (同一 bookingId + 同一 workType) --------
  console.log("C. recruitment 重複");
  const recSnap = await db.collection("recruitments").get();
  const recKey = new Map();
  for (const d of recSnap.docs) {
    const r = d.data();
    const k = `${r.bookingId || "(none)"}|${r.checkoutDate}|${r.workType || "?"}`;
    if (!recKey.has(k)) recKey.set(k, []);
    recKey.get(k).push({ id: d.id, ...r });
  }
  let recDup = 0;
  for (const [k, arr] of recKey.entries()) {
    if (arr.length > 1) {
      recDup++;
      console.log(`  [${k}] ${arr.length}件: ${arr.map(x => x.id.substring(0,8) + "(" + x.status + ")").join(", ")}`);
    }
  }
  console.log(`  重複グループ: ${recDup}件\n`);

  // -------- D. checklist 重複 (同一 shiftId で 2件以上) --------
  console.log("D. checklist 重複 (同 shiftId)");
  const clSnap = await db.collection("checklists").get();
  const clByShift = new Map();
  for (const d of clSnap.docs) {
    const c = d.data();
    const k = c.shiftId;
    if (!k) continue;
    if (!clByShift.has(k)) clByShift.set(k, []);
    clByShift.get(k).push({ id: d.id, ...c });
  }
  let clDup = 0;
  for (const [k, arr] of clByShift.entries()) {
    if (arr.length > 1) {
      clDup++;
      console.log(`  shift ${k.substring(0,10)} に ${arr.length} checklists: ${arr.map(x => x.id.substring(0,8)).join(", ")}`);
    }
  }
  console.log(`  重複グループ: ${clDup}件\n`);

  // -------- E. checklist 同一日同一物件で複数 (UI のスクショの状態) --------
  console.log("E. checklist 同日同物件の複数件 (UI 重複表示原因)");
  const clByDate = new Map();
  const today = new Date().toISOString().slice(0, 10);
  for (const d of clSnap.docs) {
    const c = d.data();
    const date = c.checkoutDate?.toDate ? c.checkoutDate.toDate().toISOString().slice(0, 10) : String(c.checkoutDate || "").slice(0, 10);
    const k = `${date}|${c.propertyId}`;
    if (!clByDate.has(k)) clByDate.set(k, []);
    clByDate.get(k).push({ id: d.id, shiftId: c.shiftId, status: c.status, workType: c.workType });
  }
  let clDateDup = 0;
  for (const [k, arr] of clByDate.entries()) {
    if (arr.length > 1) {
      clDateDup++;
      console.log(`  [${k}] ${arr.length}件`);
      for (const c of arr) console.log(`    - ${c.id.substring(0,8)} shiftId=${(c.shiftId||"").substring(0,10)} status=${c.status} workType=${c.workType}`);
    }
  }
  console.log(`  同日重複グループ: ${clDateDup}件\n`);

  // -------- F. laundry 重複 (同一 sourceChecklistId + sourceField/sourceAction) --------
  console.log("F. laundry 重複");
  const lSnap = await db.collection("laundry").get();
  const lKey = new Map();
  for (const d of lSnap.docs) {
    const l = d.data();
    const k = `${l.sourceChecklistId || "(none)"}|${l.sourceField || l.sourceAction || "?"}`;
    if (!lKey.has(k)) lKey.set(k, []);
    lKey.get(k).push({ id: d.id, ...l });
  }
  let lDup = 0;
  for (const [k, arr] of lKey.entries()) {
    if (arr.length > 1 && k.startsWith("(none)") === false) {
      lDup++;
      console.log(`  [${k}] ${arr.length}件: ${arr.map(x => x.id.substring(0,8)).join(", ")}`);
    }
  }
  console.log(`  重複グループ: ${lDup}件\n`);

  // -------- G. bookings 重複 (同一 propertyId + checkIn + checkOut + guestName) --------
  console.log("G. bookings 重複 (同物件同期間同名)");
  const bSnap = await db.collection("bookings").get();
  const bKey = new Map();
  for (const d of bSnap.docs) {
    const b = d.data();
    if (isCancelled(b.status)) continue;
    const k = `${b.propertyId}|${b.checkIn}|${b.checkOut}|${b.guestName || ""}`;
    if (!bKey.has(k)) bKey.set(k, []);
    bKey.get(k).push({ id: d.id, ...b });
  }
  let bDup = 0;
  for (const [k, arr] of bKey.entries()) {
    if (arr.length > 1) {
      bDup++;
      console.log(`  [${k}] ${arr.length}件: ${arr.map(x => x.id.substring(0,15)).join(", ")}`);
    }
  }
  console.log(`  重複グループ: ${bDup}件\n`);

  // -------- H. E2E タグなし残骸系 --------
  console.log("H. バックフィル系 assignMethod が入ってる shift");
  const backfills = shSnap.docs.filter(d => {
    const m = d.data().assignMethod || "";
    return m.includes("backfill") || m.includes("repair");
  });
  console.log(`  ${backfills.length}件 (assignMethod に backfill/repair 含む)`);
  for (const d of backfills.slice(0, 10)) {
    const s = d.data();
    const date = s.date?.toDate ? s.date.toDate().toISOString().slice(0,10) : "";
    console.log(`    ${d.id.substring(0,10)} [${date}] ${s.workType} ${s.assignMethod}`);
  }

  console.log("\n=== 完了 ===");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
