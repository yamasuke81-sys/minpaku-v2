// 未来 shift の date が UTC midnight かどうかを検証し、
// 対応 booking.checkOut と 1日ズレていないか確認するスクリプト
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const today = new Date().toISOString().slice(0, 10);

  // 全物件の未来 shift を取得
  const shiftSnap = await db.collection("shifts").get();

  let ngCount = 0;
  let okCount = 0;

  for (const doc of shiftSnap.docs) {
    const s = doc.data();
    const dateTs = s.date;
    if (!dateTs) continue;

    const dateObj = dateTs.toDate();
    const dateIso = dateObj.toISOString(); // e.g. "2026-05-03T00:00:00.000Z"
    const dateYmd = dateIso.slice(0, 10);  // "2026-05-03"

    // 過去は対象外
    if (dateYmd < today) continue;

    const utcH = dateObj.getUTCHours();
    const utcM = dateObj.getUTCMinutes();

    if (utcH !== 0 || utcM !== 0) {
      console.log(`[UTC midnight NG] shiftId=${doc.id} date=${dateIso} workType=${s.workType || "-"} propertyId=${s.propertyId}`);
      ngCount++;
      continue;
    }

    // booking との日付照合 (cleaning のみ)
    if (s.bookingId && s.workType !== "pre_inspection") {
      const bookingDoc = await db.collection("bookings").doc(s.bookingId).get();
      if (bookingDoc.exists) {
        const b = bookingDoc.data();
        const checkOut = b.checkOut; // "YYYY-MM-DD"
        if (checkOut && checkOut !== dateYmd) {
          console.log(`[日付ズレ] shiftId=${doc.id} shift.date=${dateYmd} booking.checkOut=${checkOut} diff=${checkOut > dateYmd ? "+1" : "-1"}`);
          ngCount++;
          continue;
        }
      }
    }

    okCount++;
  }

  console.log(`\n結果: OK=${okCount}, NG=${ngCount}`);
  if (ngCount === 0) {
    console.log("全 shift の日付が正常です。");
  } else {
    console.log(`${ngCount} 件の異常 shift があります。`);
  }

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
