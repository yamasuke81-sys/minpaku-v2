/**
 * 現在の bookings / shifts / recruitments / checklists の件数と概要を出力
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const today = new Date(); today.setHours(0,0,0,0);

  const [b, s, r, c] = await Promise.all([
    db.collection("bookings").get(),
    db.collection("shifts").get(),
    db.collection("recruitments").get(),
    db.collection("checklists").get(),
  ]);

  const bFuture = b.docs.filter(d => {
    const co = d.data().checkOut;
    if (!co) return false;
    const dt = typeof co === "string" ? new Date(co) : co.toDate?.() || new Date(co);
    dt.setHours(0,0,0,0);
    return dt >= today;
  });

  console.log("=== 現状 ===");
  console.log(`bookings: 全${b.size}件 / 未来分(checkOut今日以降): ${bFuture.length}件`);
  console.log(`shifts: ${s.size}件`);
  console.log(`recruitments: ${r.size}件`);
  console.log(`checklists: ${c.size}件`);

  // bookings の内訳 (property別、未来のみ)
  const byProp = {};
  bFuture.forEach(d => {
    const pid = d.data().propertyId || "(unset)";
    byProp[pid] = (byProp[pid]||0) + 1;
  });
  console.log("\n未来予約の物件内訳:");
  Object.entries(byProp).forEach(([pid, n]) => console.log(`  ${pid}: ${n}件`));

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
