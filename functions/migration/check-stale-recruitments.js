#!/usr/bin/env node
/**
 * status="募集中" のまま checkoutDate が過去日付の recruitments を診断する (読み取り専用)
 * - 過去日付の募集中を物件別に集計
 * - 同一 bookingId の重複募集も洗い出す
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const toDateStr = (v) => {
  if (!v) return "";
  if (typeof v === "string") return v.slice(0, 10);
  if (v.toDate) return v.toDate().toISOString().slice(0, 10);
  return "";
};

(async () => {
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // JST
  console.log(`本日(JST): ${today}`);

  const snap = await db.collection("recruitments").where("status", "==", "募集中").get();
  console.log(`status=募集中: ${snap.size} 件`);

  const stale = [];
  const byBooking = {};
  snap.docs.forEach((d) => {
    const r = d.data();
    const co = toDateStr(r.checkoutDate || r.checkOutDate);
    if (co && co < today) {
      stale.push({ id: d.id, co, prop: r.propertyName || r.propertyId || "-", workType: r.workType || "-", bookingId: r.bookingId || "-", notifyDeferred: r.notifyDeferred || false });
    }
    if (r.bookingId) (byBooking[r.bookingId] = byBooking[r.bookingId] || []).push({ id: d.id, co, workType: r.workType || "-", prop: r.propertyName || "-" });
  });

  console.log(`\n過去日付の募集中: ${stale.length} 件`);
  const byProp = {};
  stale.forEach((s) => { byProp[s.prop] = (byProp[s.prop] || 0) + 1; });
  Object.entries(byProp).sort((a, b) => b[1] - a[1]).forEach(([p, n]) => console.log(`  ${p}: ${n} 件`));

  console.log(`\n--- 過去日付 詳細 (日付順) ---`);
  stale.sort((a, b) => a.co.localeCompare(b.co)).forEach((s) => {
    console.log(`  ${s.id} / ${s.co} / ${s.prop} / ${s.workType} / booking=${s.bookingId}${s.notifyDeferred ? " / deferred" : ""}`);
  });

  const dups = Object.entries(byBooking).filter(([, l]) => {
    // 同一 bookingId × 同一 workType が複数 → 重複
    const k = {};
    l.forEach((x) => { k[x.workType] = (k[x.workType] || 0) + 1; });
    return Object.values(k).some((n) => n > 1);
  });
  console.log(`\n同一 bookingId × workType の重複 (募集中のみ): ${dups.length} グループ`);
  dups.forEach(([bid, l]) => {
    console.log(`  booking=${bid}:`);
    l.forEach((x) => console.log(`    ${x.id} / ${x.co} / ${x.workType} / ${x.prop}`));
  });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
