/**
 * Webアプリ管理者 (西山管理者) の 4/20, 4/26 shift 状況調査 (readonly)
 *
 * 目的:
 *   スタッフ確定したのに請求書に反映されない原因を特定する。
 *   shifts コレクションで staffId=ziTig6tefnj5NvkgN4fG の 2026-04 分を全て表示。
 */
const admin = require("firebase-admin");

admin.initializeApp({
  projectId: "minpaku-v2",
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();

const OWNER_STAFF_ID = "ziTig6tefnj5NvkgN4fG";

(async () => {
  console.log(`==== shifts (staffId=${OWNER_STAFF_ID}, 2026-04) ====\n`);

  const start = new Date(2026, 3, 1);       // 2026-04-01 00:00
  const end   = new Date(2026, 4, 0, 23, 59, 59); // 2026-04-30 23:59

  const snap = await db.collection("shifts")
    .where("staffId", "==", OWNER_STAFF_ID)
    .where("date", ">=", start)
    .where("date", "<=", end)
    .get();

  console.log(`total: ${snap.size}`);
  snap.forEach(d => {
    const data = d.data();
    const dateStr = data.date?.toDate?.().toISOString?.().slice(0,10) || String(data.date);
    console.log(`  [${d.id}] date=${dateStr} status=${data.status} propertyId=${data.propertyId} bookingId=${data.bookingId} workType=${data.workType}`);
  });

  console.log(`\n==== recruitments (propertyId=tsZybhDMcPrxqgcRy7wp, 2026-04) で確定済 ====\n`);
  const recSnap = await db.collection("recruitments")
    .where("propertyId", "==", "tsZybhDMcPrxqgcRy7wp")
    .get();

  recSnap.forEach(d => {
    const r = d.data();
    if (!r.checkoutDate?.startsWith?.("2026-04")) return;
    console.log(`  [${d.id}] checkoutDate=${r.checkoutDate} status=${r.status} selectedStaff="${r.selectedStaff || ""}" selectedStaffIds=${JSON.stringify(r.selectedStaffIds || [])} bookingId=${r.bookingId || "-"}`);
  });

  console.log(`\n==== 全 shifts の 4/20, 4/26 (スタッフ問わず) ====\n`);
  for (const dd of ["2026-04-20", "2026-04-26"]) {
    const [yy, mm, dn] = dd.split("-").map(Number);
    const dayStart = new Date(yy, mm - 1, dn);
    const dayEnd = new Date(yy, mm - 1, dn, 23, 59, 59);
    const ds = await db.collection("shifts")
      .where("date", ">=", dayStart)
      .where("date", "<=", dayEnd)
      .where("propertyId", "==", "tsZybhDMcPrxqgcRy7wp")
      .get();
    console.log(`[${dd}] ${ds.size}件`);
    ds.forEach(d => {
      const data = d.data();
      console.log(`  [${d.id}] staffId=${data.staffId || "null"} staffName="${data.staffName || ""}" status=${data.status} workType=${data.workType} bookingId=${data.bookingId}`);
    });
  }

  console.log("\n==== 完了 ====");
  process.exit(0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
