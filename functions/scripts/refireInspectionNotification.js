// the Terrace 長浜 5/23 の直前点検完了通知を再発火
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const PROPERTY_ID = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜

  const snap = await db.collection("checklists")
    .where("propertyId", "==", PROPERTY_ID)
    .get();
  console.log(`物件 ${PROPERTY_ID} の checklist 総数: ${snap.size}`);

  // 5月のものだけ抽出してダンプ
  const may = snap.docs
    .map(d => ({ id: d.id, c: d.data() }))
    .filter(({ c }) => {
      const blob = JSON.stringify({
        date: c.date, checkoutDate: c.checkoutDate, checkInDate: c.checkInDate,
        shiftDate: c.shiftDate, inspectionDate: c.inspectionDate
      });
      return blob.includes("2026-05-2");
    })
    .sort((a, b) => {
      const da = a.c.date || a.c.checkoutDate || "";
      const db_ = b.c.date || b.c.checkoutDate || "";
      return da.localeCompare(db_);
    });

  console.log(`5月中下旬の該当: ${may.length}件`);
  for (const { id, c } of may) {
    console.log(`  - id=${id}`);
    console.log(`      workType=${c.workType || "(空)"}  status=${c.status}`);
    console.log(`      date=${c.date}  checkoutDate=${c.checkoutDate}  checkInDate=${c.checkInDate}  shiftDate=${c.shiftDate}  inspectionDate=${c.inspectionDate}`);
    console.log(`      staffName=${c.staffName || "(空)"}  completedAt=${c.completedAt && c.completedAt.toDate ? c.completedAt.toDate().toISOString() : "(なし)"}`);
  }

  // 直前点検かつ completed のものを再発火
  const targets = may.filter(({ c }) => c.workType === "pre_inspection" && c.status === "completed");
  console.log(`\n再発火対象 (pre_inspection + completed): ${targets.length}件`);

  for (const { id } of targets) {
    console.log(`[再発火] id=${id}`);
    const ref = db.collection("checklists").doc(id);
    await ref.update({ status: "in_progress", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    console.log(`  → in_progress (1.5秒待機)`);
    await new Promise(r => setTimeout(r, 1500));
    await ref.update({
      status: "completed",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`  → completed (トリガー発火するはず)`);
  }
})().catch(e => { console.error(e); process.exit(1); });
