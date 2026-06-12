// S2 問題データ修復:
//  1. cancelled 予約由来の残留 rec 1件 + shift 3件 を削除
//  2. River Cowen の recruitment (selectedStaffIds=[] なのに確定済み) を「募集中」にリセット
//  3. takashi shimizu (2026-05-05) の shift を admin で新規作成
// 全操作前に対象ドキュメントを出力、--execute を付けた時のみ実際に書き込み
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const EXECUTE = process.argv.includes("--execute");

(async () => {
  const pid = "tsZybhDMcPrxqgcRy7wp";
  const bkSnap = await db.collection("bookings").where("propertyId", "==", pid).get();
  const bkById = new Map(bkSnap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));

  const recSnap = await db.collection("recruitments").where("propertyId", "==", pid).get();
  const shSnap = await db.collection("shifts").where("propertyId", "==", pid).get();

  const toDate = (v) => v?.toDate ? v.toDate() : (typeof v === "string" ? new Date(v) : null);
  const isCancelled = (s) => String(s || "").toLowerCase().includes("cancel");

  console.log(`モード: ${EXECUTE ? "🔴 EXECUTE (書き込み実行)" : "🟢 DRY-RUN (出力のみ)"}\n`);

  // === 1. cancelled 残留 削除 ===
  console.log("=== 1. cancelled 予約由来の残留削除 ===");
  const deleteRecIds = [];
  recSnap.docs.forEach(d => {
    const b = bkById.get(d.data().bookingId);
    if (b && isCancelled(b.status)) {
      console.log(`  [DEL rec] ${d.id}  bookingId=${d.data().bookingId}  checkoutDate=${d.data().checkoutDate}  status=${d.data().status}`);
      deleteRecIds.push(d.id);
    }
  });
  const deleteShIds = [];
  shSnap.docs.forEach(d => {
    const b = bkById.get(d.data().bookingId);
    if (b && isCancelled(b.status)) {
      const date = toDate(d.data().date)?.toISOString()?.substring(0, 10);
      console.log(`  [DEL shift] ${d.id}  bookingId=${d.data().bookingId}  date=${date}  status=${d.data().status}  staffId=${d.data().staffId}`);
      deleteShIds.push(d.id);
    }
  });
  if (EXECUTE) {
    for (const id of deleteRecIds) await db.collection("recruitments").doc(id).delete();
    for (const id of deleteShIds) await db.collection("shifts").doc(id).delete();
    console.log(`  ✅ ${deleteRecIds.length} rec + ${deleteShIds.length} shift 削除完了`);
  } else {
    console.log(`  (DRY-RUN) ${deleteRecIds.length} rec + ${deleteShIds.length} shift 削除予定`);
  }

  // === 2. River Cowen rec リセット ===
  console.log("\n=== 2. 'スタッフ確定済み' かつ selectedStaffIds=[] の rec を '募集中' に戻す ===");
  const resetIds = [];
  recSnap.docs.forEach(d => {
    const x = d.data();
    const sids = Array.isArray(x.selectedStaffIds) ? x.selectedStaffIds : [];
    if (x.status === "スタッフ確定済み" && sids.length === 0) {
      console.log(`  [RESET rec] ${d.id}  bookingId=${x.bookingId}  checkoutDate=${x.checkoutDate}`);
      resetIds.push(d.id);
    }
  });
  if (EXECUTE) {
    for (const id of resetIds) {
      await db.collection("recruitments").doc(id).update({
        status: "募集中",
        confirmedAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    console.log(`  ✅ ${resetIds.length} rec リセット完了`);
  } else {
    console.log(`  (DRY-RUN) ${resetIds.length} rec リセット予定`);
  }

  // === 3. takashi shimizu の shift 再生成 ===
  // 条件: confirmed 未来予約で shift が紐付いていないものを検出 → shift 生成
  console.log("\n=== 3. shift 欠落の confirmed 未来予約に shift を生成 ===");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // 削除後の状態を仮想的に考慮するため deleteShIds をセット化
  const deleteShSet = new Set(deleteShIds);
  const shiftByBookingAfterDel = new Map();
  shSnap.docs.forEach(d => {
    if (deleteShSet.has(d.id)) return;
    const bid = d.data().bookingId;
    if (bid) shiftByBookingAfterDel.set(bid, d.id);
  });

  const propDoc = await db.collection("properties").doc(pid).get();
  const propData = propDoc.data() || {};
  const startTime = propData.cleaningStartTime || "10:30";

  const targets = [];
  for (const b of bkById.values()) {
    const co = toDate(b.checkOut);
    if (!co || co < today) continue;
    if (isCancelled(b.status)) continue;
    if (b.status !== "confirmed") continue;
    if (shiftByBookingAfterDel.has(b.id)) continue;
    // 同日同物件に既に別shiftがあるか (bookingId違いでも)
    const dObj = new Date(co); dObj.setHours(0, 0, 0, 0);
    const sameDayShift = shSnap.docs.find(d => {
      if (deleteShSet.has(d.id)) return false;
      if (d.data().propertyId !== pid) return false;
      const dd = toDate(d.data().date);
      return dd && dd.getTime() === dObj.getTime();
    });
    if (sameDayShift) {
      console.log(`  [SKIP] ${b.id.substring(0, 16)} (${co.toISOString().substring(0,10)}) 同日既存shift=${sameDayShift.id}`);
      continue;
    }
    targets.push({ b, coDate: dObj, coStr: co.toISOString().substring(0, 10) });
  }

  targets.forEach(t => {
    console.log(`  [ADD shift] booking=${t.b.id}  date=${t.coStr}  guest=${t.b.guestName}`);
  });

  if (EXECUTE) {
    const now = new Date();
    for (const t of targets) {
      await db.collection("shifts").add({
        date: t.coDate,
        propertyId: pid,
        propertyName: propData.name || "",
        bookingId: t.b.id,
        workType: "cleaning_by_count",
        staffId: null,
        staffName: null,
        startTime,
        status: "unassigned",
        assignMethod: "auto",
        createdAt: now,
        updatedAt: now,
      });
    }
    console.log(`  ✅ ${targets.length} shift 生成完了`);
  } else {
    console.log(`  (DRY-RUN) ${targets.length} shift 生成予定`);
  }

  console.log("\n完了。--execute を付けて再実行すると反映されます。");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
