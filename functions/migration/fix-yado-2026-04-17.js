/**
 * YADO KOMACHI 2026-04-17 救済スクリプト
 * recruitments/Age99LWawy68Eh87OINW の selectedStaffIds を修正し
 * 対応する shift を新規作成する（onShiftCreated → checklist 自動生成）
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

const REC_ID = "Age99LWawy68Eh87OINW";
const STAFF_ID = "ziTig6tefnj5NvkgN4fG"; // 西山管理者（オーナー）

async function main() {
  // --- 1. recruitment 取得 ---
  const recRef = db.collection("recruitments").doc(REC_ID);
  const recDoc = await recRef.get();
  if (!recDoc.exists) {
    console.error(`recruitment ${REC_ID} が見つかりません`);
    process.exit(1);
  }
  const rec = recDoc.data();
  console.log("recruitment:", JSON.stringify({ id: REC_ID, ...rec }, null, 2));

  // --- 2. selectedStaffIds を修正 ---
  if (!(rec.selectedStaffIds || []).includes(STAFF_ID)) {
    await recRef.update({
      selectedStaffIds: [STAFF_ID],
      updatedAt: FV.serverTimestamp(),
    });
    console.log(`selectedStaffIds → [${STAFF_ID}] に更新`);
  } else {
    console.log("selectedStaffIds は既に正しい");
  }

  // --- 3. property から cleaningStartTime を取得 ---
  let cleaningStartTime = "10:30";
  if (rec.propertyId) {
    const propDoc = await db.collection("properties").doc(rec.propertyId).get();
    if (propDoc.exists) cleaningStartTime = propDoc.data().cleaningStartTime || "10:30";
  }
  console.log("cleaningStartTime:", cleaningStartTime);

  // --- 4. 既存 shift を検索 ---
  const shiftDate = new Date(rec.checkoutDate); // "2026-04-17" → UTC midnight
  const shiftSnap = await db.collection("shifts")
    .where("propertyId", "==", rec.propertyId)
    .where("date", "==", shiftDate)
    .limit(1)
    .get();

  if (!shiftSnap.empty) {
    const existing = shiftSnap.docs[0];
    console.log(`既存 shift あり: ${existing.id} — 更新のみ実施`);
    await existing.ref.update({
      staffId: STAFF_ID,
      staffName: rec.selectedStaff?.split(",")[0]?.trim() || "西山管理者",
      staffIds: [STAFF_ID],
      status: "assigned",
      assignMethod: "manual_confirm",
      updatedAt: FV.serverTimestamp(),
    });
    console.log("shift 更新完了:", existing.id);
    return;
  }

  // --- 5. 新規 shift 作成（onShiftCreated → checklist 自動生成） ---
  const shiftRef = await db.collection("shifts").add({
    date: shiftDate,
    propertyId: rec.propertyId,
    propertyName: rec.propertyName || "",
    bookingId: rec.bookingId || null,
    workType: rec.workType === "pre_inspection" ? "pre_inspection" : "cleaning_by_count",
    staffId: STAFF_ID,
    staffName: rec.selectedStaff?.split(",")[0]?.trim() || "西山管理者",
    staffIds: [STAFF_ID],
    startTime: cleaningStartTime,
    status: "assigned",
    assignMethod: "manual_confirm",
    createdAt: FV.serverTimestamp(),
    updatedAt: FV.serverTimestamp(),
  });
  console.log("shift 新規作成:", shiftRef.id);

  // --- 6. checklist が生成されるか 15 秒待機して確認 ---
  console.log("onShiftCreated トリガー待機中 (15秒)...");
  await new Promise(r => setTimeout(r, 15000));

  const clSnap = await db.collection("checklists")
    .where("shiftId", "==", shiftRef.id)
    .limit(1)
    .get();

  if (!clSnap.empty) {
    console.log("✅ checklist 生成確認:", clSnap.docs[0].id);
  } else {
    console.log("⚠️  checklist 未生成 (トリガー遅延の可能性あり — Firestore Console で確認してください)");
  }

  console.log("\n=== 完了 ===");
  console.log("shift id:", shiftRef.id);
  console.log("checklist id:", clSnap.empty ? "(未生成)" : clSnap.docs[0].id);
}

main().catch(e => { console.error(e); process.exit(1); });
