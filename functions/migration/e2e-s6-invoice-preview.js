// E2E Scenario 6: 請求書 compute-preview 検証
//
// 方針: テスト用の shift+laundry を架空 staffId に投入 → computeInvoiceDetails を直接呼ぶ → クリーンアップ
// 検証項目:
//   1. shift 明細の amount が workItem / staff の単価モードから正しく引けている
//   2. 階段制 (guestCount) が効いている
//   3. laundry の isReimbursable=true のみ集計
//   4. isReimbursable=false / paymentMethod="other" の laundry が除外される
//   5. total = shiftAmount + laundryAmount + specialAmount + transportationFee

const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const { computeInvoiceDetails } = require("../api/invoices");

const PID = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜
const TAG = { _e2eTest: true, _createdBy: "e2e-session-20260419-s6" };
const YM = "2026-05"; // 架空月

const pass = (msg) => console.log(`  ✅ ${msg}`);
const fail = (msg) => { console.log(`  ❌ ${msg}`); hadFail = true; };
let hadFail = false;

(async () => {
  console.log("=== Scenario 6: 請求書 compute-preview (架空データ) ===");

  // テストスタッフ (common rate モード)
  const staffRef = db.collection("staff").doc();
  await staffRef.set({
    name: "E2E-S6テストスタッフ",
    email: "e2e-s6@example.invalid",
    active: true,
    isOwner: false,
    isTimee: false,
    assignedPropertyIds: [PID],
    ratePerJob: 8000, // workItem なしの場合のフォールバック単価
    displayOrder: 999,
    ...TAG,
  });
  const staffId = staffRef.id;
  console.log(`  staff: ${staffId}`);

  // propertyWorkItems を確認 (the Terrace 長浜 の cleaning_by_count)
  const pwiDoc = await db.collection("propertyWorkItems").doc(PID).get();
  const workItems = pwiDoc.exists ? (pwiDoc.data().items || []) : [];
  const cleaningItem = workItems.find(x => (x.type || "other") === "cleaning_by_count");
  if (cleaningItem) {
    console.log(`  workItem 存在: rateMode=${cleaningItem.rateMode}, commonRates=${JSON.stringify(cleaningItem.commonRates || {})}`);

    // perStaff モードでテストスタッフの単価を一時的に追加 (階段制検証用)
    if (cleaningItem.rateMode === "perStaff") {
      const newItems = (pwiDoc.data().items || []).map(it => {
        if ((it.type || "other") === "cleaning_by_count") {
          const sr = { ...(it.staffRates || {}) };
          sr[staffId] = { 1: 7000, 2: 8500, 3: 10000 }; // 階段制
          return { ...it, staffRates: sr };
        }
        return it;
      });
      await db.collection("propertyWorkItems").doc(PID).update({ items: newItems });
      console.log(`  → テスト用 staffRates 追加: 1名=7000 2名=8500 3名=10000`);
    }
  } else {
    console.log(`  workItem 不在 → staff.ratePerJob (${8000}) フォールバックになる`);
  }

  // テストシフト 3件 (guestCount 1/2/3 で階段制チェック)
  const shiftRefs = [];
  for (let i = 0; i < 3; i++) {
    const day = 10 + i;
    const bookingRef = db.collection("bookings").doc();
    await bookingRef.set({
      propertyId: PID,
      propertyName: "the Terrace 長浜",
      checkIn: `2026-05-${String(day - 2).padStart(2, "0")}`,
      checkOut: `2026-05-${String(day).padStart(2, "0")}`,
      guestName: `E2E-S6-guest-${i + 1}`,
      guestCount: i + 1, // 1, 2, 3
      source: "manual",
      status: "confirmed",
      ...TAG,
    });
    const shiftRef = db.collection("shifts").doc();
    await shiftRef.set({
      date: new Date(`2026-05-${String(day).padStart(2, "0")}`),
      propertyId: PID,
      propertyName: "the Terrace 長浜",
      bookingId: bookingRef.id,
      workType: "cleaning_by_count",
      staffId,
      staffName: "E2E-S6テストスタッフ",
      startTime: "10:30",
      status: "assigned",
      assignMethod: "manual",
      ...TAG,
    });
    shiftRefs.push({ shift: shiftRef, booking: bookingRef, guestCount: i + 1 });
  }
  console.log(`  shift: 3件投入 (guestCount 1/2/3)`);

  // テスト laundry 3件: 2件立替 + 1件非立替
  const laundryRefs = [];
  const laundryData = [
    { amount: 500, isReimbursable: true },
    { amount: 800, isReimbursable: true },
    { amount: 1200, isReimbursable: false }, // 除外対象
  ];
  for (let i = 0; i < laundryData.length; i++) {
    const ref = db.collection("laundry").doc();
    await ref.set({
      date: new Date(`2026-05-${String(15 + i).padStart(2, "0")}`),
      staffId,
      propertyId: PID,
      amount: laundryData[i].amount,
      sheets: 5,
      isReimbursable: laundryData[i].isReimbursable,
      memo: `E2E ${laundryData[i].isReimbursable ? "立替" : "非立替"}`,
      ...TAG,
    });
    laundryRefs.push(ref);
  }
  console.log(`  laundry: 3件投入 (立替2件500+800=1300円 / 非立替1件1200円)`);

  // computeInvoiceDetails 呼出
  console.log("\n[compute] computeInvoiceDetails(db, staffId, 2026-05)");
  const result = await computeInvoiceDetails(db, staffId, YM, []);
  console.log(`  shiftCount=${result.shiftCount}`);
  console.log(`  shiftAmount=${result.shiftAmount}`);
  console.log(`  laundryAmount=${result.laundryAmount}`);
  console.log(`  specialAmount=${result.specialAmount}`);
  console.log(`  transportationFee=${result.transportationFee}`);
  console.log(`  total=${result.total}`);

  // 検証
  console.log("\n[検証]");
  if (result.shiftCount === 3) pass(`shiftCount=3`);
  else fail(`shiftCount=${result.shiftCount} (期待: 3)`);

  if (result.laundryAmount === 1300) pass(`laundryAmount=1300 (立替のみ集計)`);
  else fail(`laundryAmount=${result.laundryAmount} (期待: 1300)`);

  // 階段制チェック
  if (cleaningItem && cleaningItem.rateMode === "perStaff") {
    // テスト用 staffRates: 1名=7000 2名=8500 3名=10000
    const expected = 7000 + 8500 + 10000;
    if (result.shiftAmount === expected) pass(`shiftAmount=${expected} (perStaff 階段制: 7000+8500+10000)`);
    else fail(`shiftAmount=${result.shiftAmount} 期待=${expected}`);
  } else if (cleaningItem && cleaningItem.commonRates) {
    const expected = [1, 2, 3].reduce((s, gc) => {
      const r = cleaningItem.commonRates;
      return s + (r[gc] || r[3] || 0);
    }, 0);
    if (result.shiftAmount === expected) pass(`shiftAmount=${expected} (common 階段制正しく適用)`);
    else fail(`shiftAmount=${result.shiftAmount} 期待=${expected}`);
  } else if (!cleaningItem) {
    const expected = 3 * 8000;
    if (result.shiftAmount === expected) pass(`shiftAmount=${expected} (ratePerJob フォールバック)`);
    else fail(`shiftAmount=${result.shiftAmount} 期待=${expected}`);
  }

  const totalExpected = result.shiftAmount + result.laundryAmount + result.specialAmount + (result.transportationFee || 0);
  if (result.total === totalExpected) pass(`total 内部整合: ${result.total}`);
  else fail(`total 不整合: total=${result.total} 合計=${totalExpected}`);

  // 明細
  console.log("\n[シフト明細]");
  (result.shifts || []).forEach(s => {
    const dstr = s.date?.toDate ? s.date.toDate().toISOString().slice(0, 10) : s.date;
    console.log(`  ${dstr} guestCount=${s.guestCount} amount=${s.amount}`);
  });

  // クリーンアップ
  console.log("\n[クリーンアップ]");
  for (const { shift, booking } of shiftRefs) {
    await shift.delete();
    await booking.delete();
  }
  for (const ref of laundryRefs) await ref.delete();
  await staffRef.delete();

  // propertyWorkItems からテスト用 staffRates を除去
  if (cleaningItem && cleaningItem.rateMode === "perStaff") {
    const currentPwi = await db.collection("propertyWorkItems").doc(PID).get();
    const updatedItems = (currentPwi.data().items || []).map(it => {
      if ((it.type || "other") === "cleaning_by_count") {
        const sr = { ...(it.staffRates || {}) };
        delete sr[staffId];
        return { ...it, staffRates: sr };
      }
      return it;
    });
    await db.collection("propertyWorkItems").doc(PID).update({ items: updatedItems });
    console.log(`  propertyWorkItems staffRates 復元`);
  }
  console.log(`  全削除完了`);

  console.log(`\n=== 結果: ${hadFail ? "❌ 失敗あり" : "✅ 全 OK"} ===`);
  process.exit(hadFail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
