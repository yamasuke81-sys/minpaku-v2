#!/usr/bin/env node
/**
 * 同日・同物件・同 workType の recruitments が複数ある重複データを洗い出す診断スクリプト
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

(async () => {
  const snap = await db.collection("recruitments").get();
  console.log(`総 recruitments: ${snap.size} 件`);
  const groups = {};
  snap.docs.forEach((d) => {
    const r = d.data();
    const coRaw = r.checkoutDate || r.checkOutDate || "";
    const co = typeof coRaw === "string" ? coRaw : (coRaw && coRaw.toDate ? coRaw.toDate().toISOString().slice(0, 10) : "");
    const key = `${co}|${r.propertyId || ""}|${r.workType || "cleaning_by_count"}`;
    (groups[key] = groups[key] || []).push({ id: d.id, ...r, _co: co });
  });
  const dups = Object.entries(groups).filter(([, list]) => list.length > 1);
  console.log(`\n重複グループ: ${dups.length} 個`);
  dups.forEach(([key, list]) => {
    console.log(`\n=== ${key} (${list.length} 件) ===`);
    list.forEach((r) => {
      const ca = r.createdAt && r.createdAt.toDate ? r.createdAt.toDate().toISOString() : "-";
      console.log(`  ${r.id} / status=${r.status} / bookingId=${r.bookingId || "-"} / manualCreated=${r.manualCreated || false} / createdAt=${ca} / responses=${(r.responses || []).length} / selectedStaff=${r.selectedStaff || "-"}`);
    });
  });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
