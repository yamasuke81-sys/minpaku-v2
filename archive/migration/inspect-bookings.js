const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const today = new Date(); today.setHours(0,0,0,0);
  const snap = await db.collection("bookings").get();
  const future = snap.docs.filter(d => {
    const co = d.data().checkOut;
    if (!co) return false;
    const dt = typeof co === "string" ? new Date(co) : co.toDate?.() || new Date(co);
    dt.setHours(0,0,0,0);
    return dt >= today;
  });
  console.log("未来予約(" + future.length + "件) の全フィールド(上位3件):");
  future.slice(0, 3).forEach(d => {
    console.log("--- " + d.id + " ---");
    console.log(JSON.stringify(d.data(), null, 2));
  });
  console.log("\n--- 全未来予約のキーフィールド一覧 ---");
  future.forEach(d => {
    const x = d.data();
    console.log(`${d.id.padEnd(30)} checkOut=${x.checkOut} / property=${x.propertyId || "(空)"} / name=${x.propertyName||""} / guestName=${x.guestName||""} / source=${x.source||""} / syncSource=${x.syncSource||""} / icalUrl=${(x.icalUrl||"").substring(0,60)}`);
  });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
