/**
 * Airbnb "Not available" / "Reserved" / "Blocked" を status=cancelled に変更
 * (ホスト側で設定した予約不可期間なので、清掃は不要)
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const snap = await db.collection("bookings").get();
  let fixed = 0;
  for (const d of snap.docs) {
    const x = d.data();
    const gn = String(x.guestName || "");
    const on = String(x._icalOriginalName || "");
    const isBlock = /not available|blocked|reserved/i.test(gn) || /not available|blocked/i.test(on);
    if (!isBlock) continue;
    if (String(x.status || "").toLowerCase().includes("cancel")) continue;

    console.log(`[cancel] ${d.id} guestName=${gn} (${x.checkIn}→${x.checkOut})`);
    await d.ref.update({
      status: "cancelled",
      cancelReason: "Airbnb ホスト側のブロック期間 (Not available / Reserved)",
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    fixed++;
  }
  console.log(`\n=== 完了 ===\n${fixed}件を cancelled 化`);
  console.log("→ onBookingChange トリガーが発火して対応する shift/recruitment が自動削除されます");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
