// active 物件で inspection.enabled=true かつ未来の confirmed 予約に対して
// 不足している pre_inspection shift + recruitment を一括生成
const a = require("firebase-admin");
a.initializeApp({ projectId: "minpaku-v2" });
const db = a.firestore();
const { addRecruitmentToActiveStaff } = require("../utils/inactiveStaff");

const isExecute = process.argv.includes("--execute");
console.log(`mode: ${isExecute ? "EXECUTE" : "DRY-RUN (実行は --execute)"}`);

(async () => {
  const today = new Date(); today.setUTCHours(0,0,0,0);
  const todayStr = today.toISOString().slice(0,10);
  const propsSnap = await db.collection("properties").where("active","==",true).get();
  const props = propsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.inspection?.enabled);
  console.log(`inspection.enabled=true active 物件: ${props.length}件`);
  let totalCreated = 0;
  for (const p of props) {
    const ins = p.inspection || {};
    // 未来 (今日以降) の confirmed 予約
    const bSnap = await db.collection("bookings")
      .where("propertyId","==",p.id)
      .where("status","==","confirmed")
      .where("checkIn",">=",todayStr)
      .get();
    for (const bd of bSnap.docs) {
      const b = bd.data();
      const ci = b.checkIn;
      if (!ci) continue;
      // pendingApproval のみスキップ (unverified は onBookingChange 本体も無視するため除外しない)
      if (b.pendingApproval === true) continue;
      // 期間フィルタ
      if (ins.recurYearly) {
        const md = ci.slice(5);
        const s = ins.recurStart || "01-01";
        const e = ins.recurEnd || "12-31";
        if (s <= e) { if (md < s || md > e) continue; }
        else { if (md < s && md > e) continue; }
      } else {
        if (ins.periodStart && ci < ins.periodStart) continue;
        if (ins.periodEnd && ci > ins.periodEnd) continue;
      }
      // 同日 CO の予約あればスキップ (清掃兼用)
      const coSame = await db.collection("bookings")
        .where("propertyId","==",p.id).where("checkOut","==",ci).limit(1).get();
      if (!coSame.empty) continue;
      // 既存 shift / recruitment 確認
      const checkInDate = new Date(ci + "T00:00:00.000Z");
      const sx = await db.collection("shifts")
        .where("propertyId","==",p.id).where("date","==",checkInDate).where("workType","==","pre_inspection").limit(1).get();
      const rx = await db.collection("recruitments")
        .where("propertyId","==",p.id).where("checkoutDate","==",ci).where("workType","==","pre_inspection").limit(1).get();
      if (!sx.empty && !rx.empty) continue;
      console.log(`[要生成] ${p.name} ${ci} (booking=${bd.id} shift=${sx.empty?"無":"有"} recruitment=${rx.empty?"無":"有"})`);
      if (!isExecute) continue;
      const now = a.firestore.FieldValue.serverTimestamp();
      if (sx.empty) {
        await db.collection("shifts").add({
          date: checkInDate,
          propertyId: p.id, propertyName: p.name || "",
          bookingId: bd.id,
          workType: "pre_inspection",
          staffId: null, staffName: null, staffIds: [],
          startTime: p.inspectionStartTime || "10:00",
          status: "unassigned", assignMethod: "auto_backfill",
          createdAt: now, updatedAt: now,
        });
      }
      if (rx.empty) {
        const recRef = await db.collection("recruitments").add({
          checkoutDate: ci,
          propertyId: p.id, propertyName: p.name || "",
          bookingId: bd.id,
          workType: "pre_inspection",
          status: "募集中",
          selectedStaff: "", selectedStaffIds: [],
          memo: `直前点検: ゲスト ${b.guestName || "不明"} (${b.source || ""})`,
          responses: [],
          createdAt: now, updatedAt: now,
        });
        try { await addRecruitmentToActiveStaff(db, recRef.id); } catch (e) { console.warn("addRecruitmentToActiveStaff:", e.message); }
      }
      totalCreated++;
    }
  }
  console.log(`\n=== 生成数: ${totalCreated}件 ${isExecute ? "" : "(dry-run)"} ===`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
