// 濱田 6/13-15 予約 + メール照合状態を調査
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
(async () => {
  // 1. 6/13 CI の bookings (全物件)
  const bSnap = await db.collection("bookings").where("checkIn", "==", "2026-06-13").get();
  console.log(`=== 6/13 CI bookings: ${bSnap.size}件 ===`);
  bSnap.docs.forEach(d => {
    const x = d.data();
    console.log(`[${d.id}] CO=${x.checkOut} src=${x.source} status=${x.status} guest=${x.guestName} prop=${x.propertyId}`);
    console.log(`  emailVerifiedAt=${x.emailVerifiedAt?.toDate?.()?.toISOString()} emailMessageId=${x.emailMessageId}`);
  });
  // 2. 6/14 CI も
  const b2 = await db.collection("bookings").where("checkIn", "==", "2026-06-14").get();
  console.log(`\n=== 6/14 CI bookings: ${b2.size}件 ===`);
  b2.docs.forEach(d => {
    const x = d.data();
    console.log(`[${d.id}] CO=${x.checkOut} src=${x.source} guest=${x.guestName}`);
  });
  // 3. emailVerifications で Hamada / 濱田 / 6月13日 を含むものを探す
  const evSnap = await db.collection("emailVerifications").where("receivedAt", ">=", new Date("2026-05-10")).get();
  console.log(`\n=== emailVerifications (5/10以降): ${evSnap.size}件 ===`);
  const hits = evSnap.docs.filter(d => {
    const x = d.data();
    const blob = JSON.stringify(x).toLowerCase();
    return blob.includes("hamada") || blob.includes("濱田") || blob.includes("瀬戸内海") || blob.includes("6月13日") || blob.includes("2026-06-13");
  });
  console.log(`  そのうち 濱田/6/13 関連: ${hits.length}件`);
  hits.forEach(d => {
    const x = d.data();
    console.log(`[${d.id}]`);
    console.log(`  subject=${x.subject}`);
    console.log(`  from=${x.from} to=${x.to}`);
    console.log(`  account=${x.gmailAccount}`);
    console.log(`  matchedBookingId=${x.matchedBookingId} status=${x.status} kind=${x.kind || x.parsed?.kind}`);
    console.log(`  receivedAt=${x.receivedAt?.toDate?.()?.toISOString()}`);
    console.log(`  parsed=${JSON.stringify(x.parsed || {}).slice(0, 300)}`);
  });
  // 4. 「瀬戸内海ビュー大テラス」物件を探す
  const pSnap = await db.collection("properties").get();
  const matchProps = pSnap.docs.filter(d => {
    const x = d.data();
    return /瀬戸内海|大テラス|terrace|長浜/i.test(x.name || "") || /瀬戸内海|大テラス/i.test(x.airbnbListingName || "");
  });
  console.log(`\n=== 瀬戸内海/大テラス を含む物件: ${matchProps.length}件 ===`);
  matchProps.forEach(d => {
    const x = d.data();
    console.log(`[${d.id}] name=${x.name} airbnbListingName=${x.airbnbListingName} active=${x.active} ownerId=${x.ownerId}`);
  });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
