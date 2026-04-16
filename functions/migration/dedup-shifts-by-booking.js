/**
 * 同一 bookingId のシフトが複数ある場合、最古1件残して削除
 * 同時に、シフトの日付を JST 午前0時 (= UTC 15:00 前日) で統一保存
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const snap = await db.collection("shifts").get();
  const groups = {};
  snap.docs.forEach(d => {
    const x = d.data();
    if (!x.bookingId) return; // 手動作成は触らない
    (groups[x.bookingId] = groups[x.bookingId] || []).push({ ref: d.ref, id: d.id, data: x });
  });

  let dupDel = 0;
  const orphanChecklists = [];

  for (const [bid, arr] of Object.entries(groups)) {
    if (arr.length <= 1) continue;
    arr.sort((a, b) => {
      const ta = a.data.createdAt?.toMillis?.() || 0;
      const tb = b.data.createdAt?.toMillis?.() || 0;
      return ta - tb;
    });
    console.log(`booking=${bid}: ${arr.length}件 → 最古1件残して削除`);
    for (let i = 1; i < arr.length; i++) {
      orphanChecklists.push(arr[i].id);
      await arr[i].ref.delete();
      dupDel++;
    }
  }

  // 対応する孤児 checklist も削除
  if (orphanChecklists.length) {
    const clSnap = await db.collection("checklists").get();
    let clDel = 0;
    for (const d of clSnap.docs) {
      if (orphanChecklists.includes(d.data().shiftId)) {
        await d.ref.delete(); clDel++;
      }
    }
    console.log(`孤児checklist削除: ${clDel}件`);
  }

  console.log(`\n重複 shift 削除: ${dupDel}件`);

  // 最終状態
  const final = await db.collection("shifts").get();
  console.log(`残 shifts: ${final.size}件`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
