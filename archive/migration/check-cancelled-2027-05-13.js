// 2027-05-13 〜 2027-08-17 の長期キャンセル予約を調査
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  // CI が 2027-05-13 の bookings 全件 (status 問わず)
  const snap = await db.collection("bookings")
    .where("checkIn", "==", "2027-05-13")
    .get();
  console.log(`=== CI=2027-05-13 bookings: ${snap.size}件 ===`);
  snap.docs.forEach(d => {
    const x = d.data();
    console.log(`\n[${d.id}]`);
    console.log(`  CI=${x.checkIn} CO=${x.checkOut}`);
    console.log(`  source=${x.source} status=${x.status} guestName=${x.guestName} propertyId=${x.propertyId}`);
    console.log(`  unverified=${x.unverified} pendingApproval=${x.pendingApproval} manualOverride=${x.manualOverride}`);
    console.log(`  icalUid=${x.icalUid}`);
    console.log(`  cancelledAt=${x.cancelledAt?.toDate?.()?.toISOString()}`);
    console.log(`  createdAt=${x.createdAt?.toDate?.()?.toISOString()}`);
    console.log(`  updatedAt=${x.updatedAt?.toDate?.()?.toISOString()}`);
    console.log(`  notes=${(x.notes || "").slice(0, 200)}`);
  });
  // CO=2027-08-17 もチェック
  const snap2 = await db.collection("bookings")
    .where("checkOut", "==", "2027-08-17")
    .get();
  console.log(`\n=== CO=2027-08-17 bookings: ${snap2.size}件 ===`);
  snap2.docs.forEach(d => {
    const x = d.data();
    console.log(`[${d.id}] CI=${x.checkIn} status=${x.status} src=${x.source} prop=${x.propertyId} icalUid=${x.icalUid}`);
  });
  // 5/13 9:29 前後のキャンセル送信ログを Cloud Logs から見たい (このスクリプトは Firestore のみ)
  // notifications コレクション (送信履歴)
  try {
    const since = new Date("2026-05-13T00:00:00.000Z");
    const until = new Date("2026-05-13T23:59:59.000Z");
    const ns = await db.collection("notifications")
      .where("sentAt", ">=", since)
      .where("sentAt", "<=", until)
      .limit(50)
      .get();
    console.log(`\n=== notifications 5/13 0:00-23:59 UTC: ${ns.size}件 ===`);
    ns.docs.forEach(d => {
      const x = d.data();
      const sub = x.title || x.subject || "";
      const blob = JSON.stringify(x);
      if (/cancel|キャンセル|2027/i.test(sub) || /2027-05-13|2027-08-17/.test(blob)) {
        console.log(`[${d.id}] ${sub} sentAt=${x.sentAt?.toDate?.()?.toISOString()}`);
        console.log(`  type=${x.notifyKey || x.type} body=${(x.body || "").slice(0, 200)}`);
      }
    });
  } catch (e) {
    console.log("notifications query error:", e.message);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
