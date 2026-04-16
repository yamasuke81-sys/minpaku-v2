/**
 * キャンセル済み予約に対応する recruitments / shifts を手動削除
 * (onBookingChange が走らなかったケース対応)
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const isCancelled = (s) => {
    const x = String(s || "").toLowerCase();
    return x.includes("cancel") || s === "キャンセル" || s === "キャンセル済み";
  };

  const recSnap = await db.collection("recruitments").get();
  let removedRec = 0, removedShift = 0;
  for (const r of recSnap.docs) {
    const x = r.data();
    if (!x.bookingId) continue;
    // 確定済みは触らない
    if (x.status === "スタッフ確定済み") continue;
    const bDoc = await db.collection("bookings").doc(x.bookingId).get();
    if (!bDoc.exists) {
      // 予約自体がない → orphan
      console.log(`[orphan] recruitment ${r.id} → booking ${x.bookingId} 不在`);
      await r.ref.delete();
      removedRec++;
      continue;
    }
    const bd = bDoc.data();
    if (!isCancelled(bd.status)) continue;

    // 同日同物件に他のactive予約があるか
    const others = await db.collection("bookings")
      .where("propertyId", "==", x.propertyId)
      .where("checkOut", "==", x.checkoutDate)
      .get();
    const stillHasActive = others.docs.some(d => d.id !== x.bookingId && !isCancelled(d.data().status));
    if (stillHasActive) {
      console.log(`[skip] recruitment ${r.id} 別active予約あり`);
      continue;
    }

    console.log(`[delete] recruitment ${r.id} (${x.checkoutDate}, booking=${x.bookingId} cancelled)`);
    await r.ref.delete();
    removedRec++;

    // 対応する shift も削除
    const coDate = new Date(x.checkoutDate); coDate.setHours(0,0,0,0);
    const shSnap = await db.collection("shifts")
      .where("propertyId", "==", x.propertyId)
      .where("date", "==", coDate).get();
    for (const s of shSnap.docs) {
      const sd = s.data();
      if (sd.bookingId && sd.bookingId !== x.bookingId) continue;
      const cls = await db.collection("checklists").where("shiftId", "==", s.id).get();
      for (const c of cls.docs) await c.ref.delete();
      await s.ref.delete();
      removedShift++;
      console.log(`  → shift ${s.id} 削除`);
    }
  }
  console.log(`\n=== 完了 ===\nrecruitment: ${removedRec}件 / shift: ${removedShift}件 削除`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
