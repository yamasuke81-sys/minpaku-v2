/**
 * 11月 孤児 recruitment 削除 (WRITE)
 *
 * bookings 不在なのに残っている recruitment 2件を削除する。
 * 併せて紐づく checklists / shifts があれば除去。
 *
 * DRY_RUN=1 で書き込みせずに対象表示のみ。
 */
const admin = require("firebase-admin");

admin.initializeApp({
  projectId: "minpaku-v2",
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();

const RECRUIT_IDS = ["oi5i2LcNlikfvKTHBMwb", "URNa2lai0YFminMEWu5L"];
const DRY_RUN = process.env.DRY_RUN === "1";

(async () => {
  console.log(`==== 11月 孤児 recruitment 削除 ${DRY_RUN ? "(DRY RUN)" : ""} ====\n`);

  for (const rid of RECRUIT_IDS) {
    const ref = db.collection("recruitments").doc(rid);
    const snap = await ref.get();
    if (!snap.exists) {
      console.log(`[SKIP] ${rid}: 既に存在しない`);
      continue;
    }
    const d = snap.data();
    console.log(`[TARGET] ${rid}  checkoutDate=${d.checkoutDate}, bookingId=${d.bookingId}, status=${d.status}`);

    // 紐づく shifts
    const shiftSnap = await db.collection("shifts").where("recruitmentId", "==", rid).get();
    console.log(`  shifts: ${shiftSnap.size}件`);
    // 紐づく checklists (shiftId 経由)
    const clSnaps = [];
    for (const s of shiftSnap.docs) {
      const clSnap = await db.collection("checklists").where("shiftId", "==", s.id).get();
      clSnap.forEach(c => clSnaps.push(c.ref));
    }
    console.log(`  checklists: ${clSnaps.length}件`);

    if (DRY_RUN) {
      console.log(`  [DRY RUN] 削除対象: recruitment 1件 + shifts ${shiftSnap.size}件 + checklists ${clSnaps.length}件`);
      continue;
    }

    // 削除実行
    for (const c of clSnaps) await c.delete();
    for (const s of shiftSnap.docs) await s.ref.delete();
    await ref.delete();
    console.log(`  [OK] 削除完了`);
  }

  console.log("\n==== 完了 ====");
  process.exit(0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
