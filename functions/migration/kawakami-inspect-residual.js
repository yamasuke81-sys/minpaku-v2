// 残存課題の詳細調査: 未解決 conflict + 再非アクティブ化したスタッフ
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  console.log("=== 残存課題調査 ===\n");

  // A. 未解決 conflict
  console.log("A. 未解決 bookingConflicts");
  const confSnap = await db.collection("bookingConflicts").get();
  for (const d of confSnap.docs) {
    const c = d.data();
    const at = c.detectedAt?.toDate ? c.detectedAt.toDate().toISOString() : c.detectedAt;
    const ra = c.resolvedAt?.toDate ? c.resolvedAt.toDate().toISOString() : "未設定";
    console.log(`  ${d.id}:`);
    console.log(`    resolved: ${c.resolved}`);
    console.log(`    detectedAt: ${at}`);
    console.log(`    resolvedAt: ${ra}`);
    console.log(`    bookingIds: ${JSON.stringify(c.bookingIds)}`);
    // 該当 booking の状態
    for (const bid of (c.bookingIds || [])) {
      const b = await db.collection("bookings").doc(bid).get();
      if (b.exists) {
        const bd = b.data();
        console.log(`    booking ${bid}: status=${bd.status} ${bd.checkIn}→${bd.checkOut}`);
      } else {
        console.log(`    booking ${bid}: ❌ 不在`);
      }
    }
  }

  // B. 非アクティブ化したスタッフ
  console.log("\nB. 現在非アクティブのスタッフ");
  const staffSnap = await db.collection("staff").get();
  const inactive = staffSnap.docs.filter(d => d.data().active === false);
  console.log(`  ${inactive.length}名\n`);
  for (const d of inactive) {
    const s = d.data();
    console.log(`  ${d.id}: ${s.name}`);
    console.log(`    reason: ${s.inactiveReason || "?"}`);
    console.log(`    pendingRecruitmentIds: ${(s.pendingRecruitmentIds || []).length}件`);
    console.log(`    isTimee: ${s.isTimee || false}`);
  }

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
