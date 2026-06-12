#!/usr/bin/env node
/**
 * 十日市のりこ (RDH4s0nThw04xJb8JQnp) / YADO KOMACHI Hiroshima (RZV9IwtQgMAsvrdM3j8J) の
 * 手動予約 (pka359fG3rTXIvazyOFs / 4gCiyqFtZxnhWUinz9Gi) に対応する
 * 清掃シフト + 募集を手動生成する。
 *
 * - 物件の cleaningRequiredCount が未設定 or 0 なら 1 を設定
 * - 既に同日同物件の shifts/recruitments があればスキップ
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

// YYYY-MM-DD → UTC midnight Date
function toUtcMidnight(s) {
  if (!s) return null;
  return new Date(s + "T00:00:00.000Z");
}

const TARGETS = [
  { propertyId: "RDH4s0nThw04xJb8JQnp", bookingId: "pka359fG3rTXIvazyOFs" }, // 十日市のりこ
  { propertyId: "RZV9IwtQgMAsvrdM3j8J", bookingId: "4gCiyqFtZxnhWUinz9Gi" }, // YADO KOMACHI
];

(async () => {
  const now = new Date();
  const report = [];

  for (const { propertyId, bookingId } of TARGETS) {
    console.log(`\n===== ${propertyId} / ${bookingId} =====`);

    // 1) 物件ドキュメント
    const propRef = db.collection("properties").doc(propertyId);
    const propSnap = await propRef.get();
    if (!propSnap.exists) {
      console.log(`  物件 ${propertyId} が存在しません → スキップ`);
      continue;
    }
    const propData = propSnap.data();
    const propertyName = propData.name || "";
    console.log(`  物件名: ${propertyName}`);
    console.log(`  cleaningRequiredCount (現在): ${propData.cleaningRequiredCount}`);

    if (!propData.cleaningRequiredCount || propData.cleaningRequiredCount < 1) {
      await propRef.update({ cleaningRequiredCount: 1, updatedAt: now });
      console.log(`  → cleaningRequiredCount を 1 に設定`);
    }

    // 2) 予約取得
    const bkRef = db.collection("bookings").doc(bookingId);
    const bkSnap = await bkRef.get();
    if (!bkSnap.exists) {
      console.log(`  予約 ${bookingId} が存在しません → スキップ`);
      continue;
    }
    const bk = bkSnap.data();
    const { checkIn, checkOut, guestName, source } = bk;
    console.log(`  CI=${checkIn} / CO=${checkOut} / guest=${guestName} / source=${source}`);
    if (!checkOut) {
      console.log(`  checkOut 未設定 → スキップ`);
      continue;
    }

    const coDate = toUtcMidnight(checkOut);

    // 3) shifts 重複チェック
    const existingShifts = await db.collection("shifts")
      .where("date", "==", coDate)
      .where("propertyId", "==", propertyId)
      .get();

    let createdShiftId = null;
    if (existingShifts.empty) {
      const shiftRef = await db.collection("shifts").add({
        date: coDate,
        propertyId,
        propertyName,
        bookingId,
        workType: "cleaning_by_count",
        staffId: null,
        staffName: null,
        startTime: propData.cleaningStartTime || "10:30",
        status: "unassigned",
        assignMethod: "auto",
        createdAt: now,
        updatedAt: now,
      });
      createdShiftId = shiftRef.id;
      console.log(`  + shift 作成: ${createdShiftId}`);
    } else {
      console.log(`  = shift 既存 (${existingShifts.docs.map(d => d.id).join(",")}) → スキップ`);
    }

    // 4) recruitments 重複チェック
    const existingRecs = await db.collection("recruitments")
      .where("checkoutDate", "==", checkOut)
      .where("propertyId", "==", propertyId)
      .get();

    let createdRecId = null;
    if (existingRecs.empty) {
      const memo = `ゲスト: ${guestName || "不明"} (${source || "不明"})`;
      const recRef = await db.collection("recruitments").add({
        checkoutDate: checkOut,
        propertyId,
        propertyName,
        bookingId,
        workType: "cleaning",
        status: "募集中",
        selectedStaff: "",
        selectedStaffIds: [],
        memo,
        responses: [],
        manualCreated: false,
        createdAt: now,
        updatedAt: now,
      });
      createdRecId = recRef.id;
      console.log(`  + recruitment 作成: ${createdRecId}`);
    } else {
      console.log(`  = recruitment 既存 (${existingRecs.docs.map(d => d.id).join(",")}) → スキップ`);
    }

    report.push({ propertyId, bookingId, createdShiftId, createdRecId });
  }

  console.log(`\n\n===== サマリー =====`);
  let shiftCount = 0, recCount = 0;
  report.forEach(r => {
    if (r.createdShiftId) shiftCount++;
    if (r.createdRecId) recCount++;
    console.log(`  ${r.propertyId} / ${r.bookingId}: shift=${r.createdShiftId || "-"}, rec=${r.createdRecId || "-"}`);
  });
  console.log(`作成件数: shifts=${shiftCount}, recruitments=${recCount}`);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
