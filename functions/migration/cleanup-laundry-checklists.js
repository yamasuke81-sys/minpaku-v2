#!/usr/bin/env node
/**
 * workType が清掃系 (cleaning_by_count / pre_inspection / 未設定) でない
 * checklists を削除する (主に laundry_xxx shift に誤生成されたもの)
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const CLEANING_WORK_TYPES = new Set(["cleaning_by_count", "cleaning", "pre_inspection", ""]);

(async () => {
  const snap = await db.collection("checklists").get();
  let deleted = 0;
  const keep = [];
  for (const d of snap.docs) {
    const c = d.data();
    const wt = c.workType || "";
    if (!CLEANING_WORK_TYPES.has(wt)) {
      console.log(`DELETE ${d.id} / shiftId=${c.shiftId} / workType=${wt} / propertyId=${c.propertyId} / co=${c.checkoutDate}`);
      await d.ref.delete();
      deleted++;
    } else {
      keep.push(d.id);
    }
  }
  console.log(`\n削除: ${deleted} 件 / 残: ${keep.length} 件`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
