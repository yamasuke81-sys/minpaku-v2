#!/usr/bin/env node
/**
 * checklists の重複調査 (同 shiftId or 同 propertyId+checkoutDate)
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

(async () => {
  const snap = await db.collection("checklists").get();
  console.log(`total checklists: ${snap.size}`);

  const byShift = {};
  const byPropDate = {};
  snap.docs.forEach((d) => {
    const c = d.data();
    const sid = c.shiftId || "-";
    const co = typeof c.checkoutDate === "string" ? c.checkoutDate
      : (c.checkoutDate && c.checkoutDate.toDate ? c.checkoutDate.toDate().toISOString().slice(0, 10) : String(c.checkoutDate || ""));
    const key = `${c.propertyId || "-"}|${co}`;
    (byShift[sid] = byShift[sid] || []).push({ id: d.id, status: c.status, createdAt: c.createdAt, propertyId: c.propertyId, co });
    (byPropDate[key] = byPropDate[key] || []).push({ id: d.id, shiftId: sid, status: c.status, createdAt: c.createdAt });
  });

  console.log("\n=== shiftId 重複 ===");
  Object.entries(byShift).forEach(([sid, list]) => {
    if (sid === "-") return; // shift 未紐付は別途
    if (list.length > 1) {
      console.log(`shiftId=${sid} / ${list.length} 件`);
      list.forEach(x => {
        const ca = x.createdAt && x.createdAt.toDate ? x.createdAt.toDate().toISOString() : "-";
        console.log(`  ${x.id} / status=${x.status} / createdAt=${ca}`);
      });
    }
  });

  const noShift = byShift["-"] || [];
  console.log(`\n=== shiftId 無し: ${noShift.length} 件 ===`);
  noShift.slice(0, 20).forEach(x => {
    console.log(`  ${x.id} / prop=${x.propertyId} / co=${x.co} / status=${x.status}`);
  });

  console.log("\n=== propertyId+checkoutDate 重複 (2件以上) ===");
  Object.entries(byPropDate).forEach(([key, list]) => {
    if (list.length > 1) {
      console.log(`${key} / ${list.length} 件`);
      list.forEach(x => {
        const ca = x.createdAt && x.createdAt.toDate ? x.createdAt.toDate().toISOString() : "-";
        console.log(`  ${x.id} / shiftId=${x.shiftId} / status=${x.status} / createdAt=${ca}`);
      });
    }
  });

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
