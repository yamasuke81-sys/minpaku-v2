#!/usr/bin/env node
/**
 * 追加診断 (読み取り専用):
 * 1. 重複グループごとに booking の現在の checkOut / status と照合し、どれが正か判定
 * 2. 過去日付の募集中 39件に responses が付いているか確認
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
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const snap = await db.collection("recruitments").where("status", "==", "募集中").get();

  const byBooking = {};
  const stale = [];
  snap.docs.forEach((d) => {
    const r = d.data();
    const co = toDateStr(r.checkoutDate || r.checkOutDate);
    const rec = { id: d.id, co, workType: r.workType || "-", prop: r.propertyName || "-", bookingId: r.bookingId || "", ref: d.ref };
    if (co && co < today) stale.push(rec);
    if (r.bookingId) (byBooking[r.bookingId] = byBooking[r.bookingId] || []).push(rec);
  });

  const dups = Object.entries(byBooking).filter(([, l]) => l.length > 1);
  console.log(`=== 重複グループ照合 (${dups.length} グループ) ===`);
  for (const [bid, list] of dups) {
    const bDoc = await db.collection("bookings").doc(bid).get();
    const bd = bDoc.exists ? bDoc.data() : null;
    const bco = bd ? toDateStr(bd.checkOut) : "(booking不在)";
    const bstatus = bd ? bd.status : "-";
    console.log(`\nbooking=${bid.slice(0, 40)}... checkOut=${bco} status=${bstatus}`);
    for (const r of list) {
      const respSnap = await r.ref.collection("responses").get();
      const match = r.co === bco ? "✓一致" : "✗不一致";
      console.log(`  ${r.id} / ${r.co} ${match} / responses=${respSnap.size}`);
    }
  }

  console.log(`\n=== 過去日付39件の responses 有無 ===`);
  let withResp = 0;
  for (const r of stale) {
    const respSnap = await r.ref.collection("responses").get();
    if (respSnap.size > 0) {
      withResp++;
      const names = respSnap.docs.map((d) => `${d.data().staffName || "?"}:${d.data().response || "?"}`).join(", ");
      console.log(`  ${r.id} / ${r.co} / ${r.prop} / responses=${respSnap.size} (${names})`);
    }
  }
  console.log(`responses あり: ${withResp} / ${stale.length} 件`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
