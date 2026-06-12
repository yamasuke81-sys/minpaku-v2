// 全工程連動チェック: 各トリガー/集計/UI の繋ぎが切れている箇所を洗い出し
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const issues = [];
const note = (area, msg) => { console.log(`  🔸 [${area}] ${msg}`); issues.push({ area, msg }); };
const ok = (area, msg) => console.log(`  ✅ [${area}] ${msg}`);

function isCancelled(s) {
  const x = String(s || "").toLowerCase();
  return x.includes("cancel") || s === "キャンセル";
}

(async () => {
  console.log("=== 全工程連動チェック ===\n");

  // ---------------------------------------------------------
  // 1. 予約 → 作業実績 (shift) の連動
  // ---------------------------------------------------------
  console.log("1️⃣  予約 → 作業実績 (shift) 連動");
  const bSnap = await db.collection("bookings").get();
  const shSnap = await db.collection("shifts").get();
  const today = new Date().toISOString().slice(0, 10);
  const futureActiveBookings = bSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(b => !isCancelled(b.status) && (b.checkOut || "") >= today);

  const shByBid = new Map();
  shSnap.docs.forEach(d => {
    const s = d.data();
    if (!s.bookingId) return;
    if (!shByBid.has(s.bookingId)) shByBid.set(s.bookingId, []);
    shByBid.get(s.bookingId).push({ id: d.id, ...s });
  });

  for (const b of futureActiveBookings) {
    const shifts = shByBid.get(b.id) || [];
    const cleaningShift = shifts.find(s => s.workType === "cleaning_by_count" || s.workType === "cleaning");
    if (!cleaningShift) note("予約→清掃実績", `予約 ${b.checkOut} ${b.guestName} に清掃実績なし`);
  }
  if (issues.filter(i => i.area === "予約→清掃実績").length === 0) ok("予約→清掃実績", `未来 ${futureActiveBookings.length}予約すべてに清掃実績あり`);

  // ---------------------------------------------------------
  // 2. 予約 → 直前点検実績 (物件設定 inspection.enabled で)
  // ---------------------------------------------------------
  console.log("\n2️⃣  予約 → 直前点検実績 連動");
  const propSnap = await db.collection("properties").get();
  const propMap = new Map(propSnap.docs.map(d => [d.id, d.data()]));
  for (const b of futureActiveBookings) {
    const p = propMap.get(b.propertyId);
    if (!p?.inspection?.enabled) continue;
    // 同日に他予約の checkOut があれば不要 (掃除兼ねる)
    const sameDayOut = bSnap.docs.find(d => {
      const x = d.data();
      return x.propertyId === b.propertyId && x.checkOut === b.checkIn && !isCancelled(x.status);
    });
    if (sameDayOut) continue;
    // 期間判定 (簡略化: enabled なら全日対象とみなす)
    const shifts = shByBid.get(b.id) || [];
    const hasInsp = shifts.find(s => s.workType === "pre_inspection");
    if (!hasInsp) note("予約→直前点検", `予約 ${b.checkIn} ${b.guestName} に直前点検実績なし (propertyの inspection.enabled=true)`);
  }
  if (issues.filter(i => i.area === "予約→直前点検").length === 0) ok("予約→直前点検", "設定に応じた直前点検実績がすべて存在");

  // ---------------------------------------------------------
  // 3. 作業実績 → チェックリスト 連動
  // ---------------------------------------------------------
  console.log("\n3️⃣  作業実績 → チェックリスト 連動");
  const clSnap = await db.collection("checklists").get();
  const clByShift = new Set(clSnap.docs.map(d => d.data().shiftId));
  const futureShifts = shSnap.docs.filter(d => {
    const date = d.data().date?.toDate ? d.data().date.toDate().toISOString().slice(0,10) : "";
    return date >= today;
  });
  let clMiss = 0;
  for (const s of futureShifts) {
    if (!clByShift.has(s.id)) {
      clMiss++;
      note("実績→チェックリスト", `実績 ${s.id.substring(0,8)} (${s.data().workType}) にチェックリスト未生成`);
    }
  }
  if (clMiss === 0) ok("実績→チェックリスト", `未来 ${futureShifts.length}実績すべてにチェックリストあり`);

  // ---------------------------------------------------------
  // 4. チェックリスト完了 → 作業実績 status=completed 連動
  // ---------------------------------------------------------
  console.log("\n4️⃣  チェックリスト完了 → 実績ステータス 連動");
  const completedCl = clSnap.docs.filter(d => d.data().status === "completed");
  let mismatch = 0;
  for (const d of completedCl) {
    const shId = d.data().shiftId;
    if (!shId) continue;
    const sh = shSnap.docs.find(s => s.id === shId);
    if (!sh) continue;
    if (sh.data().status !== "completed") {
      mismatch++;
      note("CL完了→実績完了", `チェックリスト ${d.id.substring(0,8)} は完了だが実績は ${sh.data().status}`);
    }
  }
  if (mismatch === 0) ok("CL完了→実績完了", `完了チェックリスト ${completedCl.length}件すべて実績も completed`);

  // ---------------------------------------------------------
  // 5. ランドリー操作 → 請求書計上 連動 (やますけ指摘の件)
  // ---------------------------------------------------------
  console.log("\n5️⃣  ランドリー操作 → 請求書計上 連動");
  const laundrySnap = await db.collection("laundry").get();
  const laundryShiftMissing = [];
  for (const ld of laundrySnap.docs) {
    const l = ld.data();
    // ランドリー記録に対応する「ランドリー出し」実績が同日同スタッフにあるか?
    if (!l.staffId || !l.propertyId) continue;
    const related = shSnap.docs.find(s => {
      const sd = s.data();
      if (sd.staffId !== l.staffId || sd.propertyId !== l.propertyId) return false;
      const sdDate = sd.date?.toDate ? sd.date.toDate().toISOString().slice(0,10) : "";
      const ldDate = l.date?.toDate ? l.date.toDate().toISOString().slice(0,10) : String(l.date).slice(0,10);
      if (sdDate !== ldDate) return false;
      return (sd.workType || "").startsWith("laundry_") || (sd.workTypeName || "").includes("ランドリー");
    });
    if (!related) laundryShiftMissing.push(ld.id);
  }
  if (laundryShiftMissing.length > 0) {
    note("ランドリー→実績", `ランドリー記録 ${laundryShiftMissing.length}件に対応する「ランドリー出し」実績が未生成 → 請求書に労力対価が入らない`);
  } else {
    ok("ランドリー→実績", "ランドリー記録と実績の紐付け OK");
  }

  // 報酬単価の登録状況
  const pwi = await db.collection("propertyWorkItems").doc("tsZybhDMcPrxqgcRy7wp").get();
  if (pwi.exists) {
    const items = pwi.data().items || [];
    const laundryItems = items.filter(i => (i.name || "").includes("ランドリー"));
    console.log(`    → 報酬単価に登録済みランドリー項目: ${laundryItems.length}件 (${laundryItems.map(i=>i.name).join(", ")})`);
  }

  // ---------------------------------------------------------
  // 6. 募集確定 → 作業実績 staffId 反映
  // ---------------------------------------------------------
  console.log("\n6️⃣  募集確定 → 作業実績 staffId 反映");
  const recSnap = await db.collection("recruitments").where("status", "==", "スタッフ確定済み").get();
  let recMismatch = 0;
  for (const r of recSnap.docs) {
    const rd = r.data();
    if (!(rd.selectedStaffIds || []).length) continue;
    const expectStaff = rd.selectedStaffIds[0];
    const related = shSnap.docs.find(s => s.data().bookingId === rd.bookingId && (s.data().date?.toDate ? s.data().date.toDate().toISOString().slice(0,10) : "") === rd.checkoutDate);
    if (!related) continue;
    if (related.data().staffId !== expectStaff) {
      recMismatch++;
      note("募集確定→実績", `rec ${r.id.substring(0,8)} selectedStaffIds=${rd.selectedStaffIds[0].substring(0,8)} だが実績 staffId=${related.data().staffId || "null"}`);
    }
  }
  if (recMismatch === 0) ok("募集確定→実績", `確定済み募集 ${recSnap.size}件すべて実績 staffId 反映済`);

  // ---------------------------------------------------------
  // 7. 予約キャンセル → shift/rec/cl 連動削除
  // ---------------------------------------------------------
  console.log("\n7️⃣  予約キャンセル → 実績/募集/チェックリスト 連動削除");
  const cancelledBookings = bSnap.docs.filter(d => isCancelled(d.data().status));
  let cancelGhost = 0;
  for (const b of cancelledBookings) {
    const shifts = shByBid.get(b.id) || [];
    if (shifts.length > 0) {
      cancelGhost++;
      if (cancelGhost <= 3) note("キャンセル→削除", `キャンセル予約 ${b.id.substring(0,10)} に未削除実績 ${shifts.length}件`);
    }
  }
  if (cancelGhost === 0) ok("キャンセル→削除", `キャンセル予約 ${cancelledBookings.length}件すべて連動削除済`);
  else note("キャンセル→削除", `合計 ${cancelGhost}件のキャンセル予約に未削除実績 (定期cron で 2:00 に削除予定)`);

  // ---------------------------------------------------------
  // 8. ゲストフォーム → 予約への紐付け
  // ---------------------------------------------------------
  console.log("\n8️⃣  ゲストフォーム送信 → 予約紐付け");
  const gSnap = await db.collection("guestRegistrations").get();
  let noLink = 0, linkedOK = 0;
  for (const g of gSnap.docs) {
    const gd = g.data();
    if (gd.bookingId) { linkedOK++; continue; }
    // 対応する confirmed 予約があるはず
    if (gd.checkIn && gd.propertyId) {
      const b = bSnap.docs.find(bd => bd.data().checkIn === gd.checkIn && bd.data().propertyId === gd.propertyId && !isCancelled(bd.data().status));
      if (b) { noLink++; if (noLink <= 3) note("ゲスト→予約", `${gd.checkIn} ${gd.guestName} は予約 ${b.id.substring(0,15)} と突合可能だが未紐付け`); }
    }
  }
  console.log(`    → 紐付け済: ${linkedOK}件 / 未紐付け (紐付け可能): ${noLink}件 / 全体: ${gSnap.size}件`);

  // ---------------------------------------------------------
  // 9. 非アクティブ化 → 募集選定から除外
  // ---------------------------------------------------------
  console.log("\n9️⃣  非アクティブスタッフ → 募集選定・実績から除外");
  const staffSnap = await db.collection("staff").get();
  const inactive = staffSnap.docs.filter(d => d.data().active === false);
  let usedInactive = 0;
  for (const s of inactive) {
    // 非アクティブスタッフが未来シフトに割当られているか
    const assigned = futureShifts.find(sh => sh.data().staffId === s.id || (sh.data().staffIds || []).includes(s.id));
    if (assigned) {
      usedInactive++;
      note("非アクティブ→除外", `非アクティブ ${s.data().name} に未来実績 ${assigned.id.substring(0,8)} 割当中`);
    }
  }
  if (usedInactive === 0) ok("非アクティブ→除外", `非アクティブ ${inactive.length}名すべて未来実績に割当なし`);

  // ---------------------------------------------------------
  // 10. 交通費の重複計上
  // ---------------------------------------------------------
  console.log("\n🔟  交通費の重複計上可能性 (同日複数実績)");
  const byStaffDate = new Map();
  for (const sh of futureShifts) {
    const sd = sh.data();
    if (!sd.staffId) continue;
    const date = sd.date?.toDate ? sd.date.toDate().toISOString().slice(0,10) : "";
    const key = `${sd.staffId}__${date}`;
    byStaffDate.set(key, (byStaffDate.get(key) || 0) + 1);
  }
  const dupDays = Array.from(byStaffDate.entries()).filter(([,n]) => n > 1);
  if (dupDays.length > 0) {
    note("交通費重複", `同日同スタッフ複数実績 ${dupDays.length}件 → 交通費が実績数分計上される (仕様要確認)`);
    dupDays.slice(0, 3).forEach(([key, n]) => console.log(`    同日 ${n}実績: ${key}`));
  } else {
    ok("交通費重複", "同日複数実績なし");
  }

  // ---------------------------------------------------------
  // 11. 請求書 pdfUrl の整合
  // ---------------------------------------------------------
  console.log("\n1️⃣1️⃣  請求書 PDF 整合");
  const invSnap = await db.collection("invoices").get();
  const needsPdf = invSnap.docs.filter(d => {
    const i = d.data();
    return (i.status === "submitted" || i.status === "paid") && !i.pdfUrl;
  });
  if (needsPdf.length > 0) {
    note("請求書→PDF", `確定済み請求書 ${needsPdf.length}件に PDF 未生成`);
  } else {
    ok("請求書→PDF", "確定済み請求書すべて PDF 生成済");
  }

  // ---------------------------------------------------------
  // 12. 通知設定の enabled 状態
  // ---------------------------------------------------------
  console.log("\n1️⃣2️⃣  通知設定状態");
  const n = await db.collection("settings").doc("notifications").get();
  const ch = n.exists ? (n.data().channels || {}) : {};
  const disabled = Object.entries(ch).filter(([,v]) => v.enabled === false);
  for (const [k, v] of disabled) {
    note("通知無効化", `channels.${k}.enabled=false (運用で無効化中かも)`);
  }

  // ================ 結果 ================
  console.log(`\n\n=== 連動穴サマリ ===`);
  const byArea = {};
  for (const i of issues) byArea[i.area] = (byArea[i.area] || 0) + 1;
  for (const [a, n] of Object.entries(byArea)) console.log(`  ${a}: ${n}件`);
  console.log(`\n合計: ${issues.length}件の連動穴`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
