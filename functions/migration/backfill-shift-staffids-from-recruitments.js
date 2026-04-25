#!/usr/bin/env node
// 確定済み recruitment から対応する shift に staffId/staffIds を補完する
// 対象: status="スタッフ確定済み" かつ selectedStaffIds が空でない recruitment
// マッチ: propertyId + date(checkoutDate) で shifts を検索
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const DRY_RUN = process.argv.includes("--dry-run");

(async () => {
  const recSnap = await db.collection("recruitments")
    .where("status", "==", "スタッフ確定済み")
    .get();
  console.log(`確定済み recruitments: ${recSnap.size}`);
  let updated = 0, skipped = 0, missing = 0, alreadyOk = 0;

  for (const r of recSnap.docs) {
    const data = r.data();
    const ids = data.selectedStaffIds || [];
    if (!ids.length || !data.propertyId || !data.checkoutDate) { skipped++; continue; }
    const dt = new Date(data.checkoutDate);
    const shiftSnap = await db.collection("shifts")
      .where("propertyId", "==", data.propertyId)
      .where("date", "==", dt)
      .limit(1).get();
    if (shiftSnap.empty) {
      console.log(`  [MISSING] recruitment=${r.id} ${data.checkoutDate} ${data.propertyId} → shift 無し、新規作成`);
      missing++;
      if (!DRY_RUN) {
        const firstName = (data.selectedStaff || "").split(",")[0]?.trim() || null;
        await db.collection("shifts").add({
          date: dt,
          propertyId: data.propertyId,
          propertyName: data.propertyName || "",
          bookingId: data.bookingId || null,
          workType: data.workType === "pre_inspection" ? "pre_inspection" : "cleaning_by_count",
          staffId: ids[0],
          staffName: firstName,
          staffIds: ids,
          startTime: "10:30",
          status: "assigned",
          assignMethod: "backfill_from_recruitment",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      continue;
    }
    const sd = shiftSnap.docs[0];
    const cur = sd.data();
    const curIds = Array.isArray(cur.staffIds) ? cur.staffIds : [];
    const same = cur.staffId === ids[0] &&
      curIds.length === ids.length &&
      curIds.every((x, i) => x === ids[i]);
    if (same) { alreadyOk++; continue; }
    console.log(`  [UPDATE] shift=${sd.id} (${data.checkoutDate}) staffId: ${cur.staffId} → ${ids[0]}, staffIds: ${JSON.stringify(curIds)} → ${JSON.stringify(ids)}`);
    if (!DRY_RUN) {
      const firstName = (data.selectedStaff || "").split(",")[0]?.trim() || null;
      await sd.ref.update({
        staffId: ids[0],
        staffName: firstName,
        staffIds: ids,
        status: cur.status === "completed" ? "completed" : "assigned",
        assignMethod: "backfill_from_recruitment",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    updated++;
  }
  console.log(`\n結果: updated=${updated}, alreadyOk=${alreadyOk}, missing=${missing}, skipped=${skipped} (DRY_RUN=${DRY_RUN})`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
