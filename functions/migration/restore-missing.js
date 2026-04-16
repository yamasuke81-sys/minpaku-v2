/**
 * active な未来予約に対応する shifts / recruitments / checklists を復元
 * 既存のドキュメントには触らない (追加のみ)
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const isCancelled = (s) => {
  const x = String(s || "").toLowerCase();
  return x.includes("cancel") || s === "キャンセル" || s === "キャンセル済み";
};

(async () => {
  const today = new Date(); today.setHours(0, 0, 0, 0);

  const [bookings, shifts, recruitments, checklists, templates] = await Promise.all([
    db.collection("bookings").get(),
    db.collection("shifts").get(),
    db.collection("recruitments").get(),
    db.collection("checklists").get(),
    db.collection("checklistTemplates").get(),
  ]);

  // active 未来予約を列挙
  const activeFuture = bookings.docs.filter(d => {
    const x = d.data();
    if (isCancelled(x.status)) return false;
    if (!x.propertyId || !x.checkOut) return false;
    if (!x.guestName || x.guestName === "Reserved" || !x.guestName.trim()) return false;
    const co = new Date(x.checkOut); co.setHours(0, 0, 0, 0);
    return co >= today;
  });
  console.log(`active 未来予約: ${activeFuture.length}件`);

  // キー: propertyId|YYYY-MM-DD (JST文字列)
  // 既存 shifts をキーで集合化 (JST日付で比較)
  const shiftKeySet = new Set();
  shifts.docs.forEach(d => {
    const x = d.data();
    if (!x.propertyId || !x.date) return;
    const dt = x.date?.toDate ? x.date.toDate() : new Date(x.date);
    // JST 日付 (UTC + 9時間)
    const jst = new Date(dt.getTime() + 9 * 3600 * 1000);
    const ds = jst.toISOString().slice(0, 10);
    shiftKeySet.add(`${x.propertyId}|${ds}`);
  });

  const recruitKeySet = new Set();
  recruitments.docs.forEach(d => {
    const x = d.data();
    if (x.propertyId && x.checkoutDate) {
      recruitKeySet.add(`${x.propertyId}|${x.checkoutDate}`);
    }
  });

  const tmplByProp = {};
  templates.docs.forEach(d => { tmplByProp[d.id] = d.data(); });
  const checklistByShift = new Set(checklists.docs.map(c => c.data().shiftId).filter(Boolean));

  const now = new Date();
  let shiftCreated = 0, recCreated = 0, clCreated = 0;

  for (const b of activeFuture) {
    const x = b.data();
    const pid = x.propertyId;
    const checkOut = x.checkOut;               // "YYYY-MM-DD" 文字列
    const shiftKey = `${pid}|${checkOut}`;
    const recKey = shiftKey;

    // JST 00:00 基準で shift.date を作る → UTC 15:00 前日
    const [yy, mm, dd] = checkOut.split("-").map(Number);
    const shiftDate = new Date(Date.UTC(yy, mm - 1, dd, -9, 0, 0)); // = JST 00:00

    let shiftId = null;
    if (!shiftKeySet.has(shiftKey)) {
      const ref = await db.collection("shifts").add({
        date: shiftDate,
        propertyId: pid,
        propertyName: x.propertyName || "",
        bookingId: b.id,
        staffId: null, staffName: null, staffIds: [],
        workType: "cleaning",
        startTime: "10:30",
        status: "unassigned",
        assignMethod: "auto",
        createdAt: now,
        updatedAt: now,
      });
      shiftId = ref.id;
      shiftKeySet.add(shiftKey);
      shiftCreated++;
    }

    if (!recruitKeySet.has(recKey)) {
      await db.collection("recruitments").add({
        checkoutDate: checkOut,
        propertyId: pid,
        propertyName: x.propertyName || "",
        bookingId: b.id,
        workType: "cleaning",
        status: "募集中",
        selectedStaff: "",
        selectedStaffIds: [],
        memo: `ゲスト: ${x.guestName || "不明"} (${x.source || "不明"})`,
        responses: [],
        createdAt: now,
        updatedAt: now,
      });
      recruitKeySet.add(recKey);
      recCreated++;
    }

    // checklist
    if (shiftId && tmplByProp[pid]) {
      const tmpl = tmplByProp[pid];
      await db.collection("checklists").add({
        shiftId,
        propertyId: pid,
        propertyName: x.propertyName || "",
        checkoutDate: shiftDate,
        staffIds: [],
        templateVersion: tmpl.version || 1,
        templateSnapshot: tmpl.areas || [],
        itemStates: {},
        beforePhotos: [], afterPhotos: [],
        laundry: { putOut: null, collected: null, stored: null },
        status: "in_progress", completedAt: null, completedBy: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      clCreated++;
    }
  }

  console.log(`\n=== 復元完了 ===`);
  console.log(`shifts: ${shiftCreated}件追加`);
  console.log(`recruitments: ${recCreated}件追加`);
  console.log(`checklists: ${clCreated}件追加`);

  const [ns, nr, nc] = await Promise.all([
    db.collection("shifts").get(),
    db.collection("recruitments").get(),
    db.collection("checklists").get(),
  ]);
  console.log(`最終: shifts=${ns.size} / recruitments=${nr.size} / checklists=${nc.size}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
