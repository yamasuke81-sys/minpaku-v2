#!/usr/bin/env node
/**
 * 2026-04-22 クリーンアップ:
 *   - のりこ手動予約 (K1PRekkKR8xl08gFrvRV) 削除
 *   - the Terrace 5/5 CO 重複 recruitment (kYh2sV88ygpsr1XuVDxL) 削除、MHQZp3V4shenQdJP1ulT を残す
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

(async () => {
  // 1. のりこ手動予約削除
  const bookingId = "K1PRekkKR8xl08gFrvRV";
  const bRef = db.collection("bookings").doc(bookingId);
  const bSnap = await bRef.get();
  if (bSnap.exists) {
    const b = bSnap.data();
    console.log(`削除対象 booking: ${bookingId} / ${b.guestName} / CI=${b.checkIn} / CO=${b.checkOut}`);
    await bRef.delete();
    console.log("  ✓ booking 削除完了");
  } else {
    console.log(`booking ${bookingId} は既に存在しません`);
  }

  // 2. 重複 recruitment 削除 (kYh2sV88ygpsr1XuVDxL、新しい方)
  const recruitId = "kYh2sV88ygpsr1XuVDxL";
  const rRef = db.collection("recruitments").doc(recruitId);
  const rSnap = await rRef.get();
  if (rSnap.exists) {
    const r = rSnap.data();
    console.log(`削除対象 recruitment: ${recruitId} / propertyId=${r.propertyId} / CO=${r.checkoutDate} / responses=${(r.responses || []).length}`);
    await rRef.delete();
    console.log("  ✓ recruitment 削除完了");
  } else {
    console.log(`recruitment ${recruitId} は既に存在しません`);
  }

  // 関連 shifts / checklists も削除 (recruitId で紐付くもの)
  const sSnap = await db.collection("shifts").where("recruitmentId", "==", recruitId).get();
  for (const d of sSnap.docs) {
    await d.ref.delete();
    console.log(`  ✓ shift ${d.id} 削除`);
    const cSnap = await db.collection("checklists").where("shiftId", "==", d.id).get();
    for (const cd of cSnap.docs) {
      await cd.ref.delete();
      console.log(`    ✓ checklist ${cd.id} 削除`);
    }
  }

  // のりこ予約の shifts / recruitments も削除
  const sSnap2 = await db.collection("shifts").where("bookingId", "==", bookingId).get();
  for (const d of sSnap2.docs) {
    await d.ref.delete();
    console.log(`  ✓ shift ${d.id} (のりこ) 削除`);
  }
  const rSnap2 = await db.collection("recruitments").where("bookingId", "==", bookingId).get();
  for (const d of rSnap2.docs) {
    await d.ref.delete();
    console.log(`  ✓ recruitment ${d.id} (のりこ) 削除`);
  }

  console.log("\n完了");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
