// S2: 予約→shift/recruitment自動生成 の検証
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const PID = "tsZybhDMcPrxqgcRy7wp";

(async () => {
  console.log("=== S2: 募集自動生成検証 ===\n");

  const today = new Date().toISOString().slice(0, 10);

  // 未来のアクティブ予約
  const bSnap = await db.collection("bookings")
    .where("propertyId", "==", PID).get();
  const active = bSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(b => {
      const s = String(b.status || "").toLowerCase();
      return !s.includes("cancel") && b.status !== "キャンセル" && b.status !== "キャンセル済み";
    })
    .filter(b => (b.checkOut || "") >= today)
    .sort((a, b) => (a.checkOut || "").localeCompare(b.checkOut || ""));
  console.log(`未来アクティブ予約: ${active.length}件\n`);

  // 対応する shift/recruitment が生成されているか
  const shSnap = await db.collection("shifts").where("propertyId", "==", PID).get();
  const recSnap = await db.collection("recruitments").where("propertyId", "==", PID).get();
  const clSnap = await db.collection("checklists").where("propertyId", "==", PID).get();

  const shByBooking = new Map();
  shSnap.docs.forEach(d => { const x = d.data(); if (x.bookingId) shByBooking.set(x.bookingId, { id: d.id, ...x }); });
  const recByBooking = new Map();
  recSnap.docs.forEach(d => { const x = d.data(); if (x.bookingId) recByBooking.set(x.bookingId, { id: d.id, ...x }); });

  let missing = 0;
  let reservedIssue = 0;
  for (const b of active) {
    const sh = shByBooking.get(b.id);
    const rec = recByBooking.get(b.id);
    const cl = sh ? clSnap.docs.find(d => d.data().shiftId === sh.id) : null;
    const nameIsReserved = b.guestName === "Reserved" || (b.guestName || "").includes("Not available");

    const marks = [
      sh ? `shift✓(${sh.status})` : "shift❌",
      rec ? `rec✓(${rec.status})` : "rec❌",
      cl ? `cl✓(${cl.data().status})` : "cl❌",
    ].join(" ");

    const warn = nameIsReserved ? " ⚠Reserved" : "";
    console.log(`  [${b.checkOut}] ${(b.guestName || "?").substring(0,20).padEnd(22)} ${marks}${warn}`);
    console.log(`    bookingId=${b.id}`);
    if (nameIsReserved) reservedIssue++;
    if (!sh || !rec) missing++;
  }

  console.log(`\n--- サマリ ---`);
  console.log(`  shift/rec 未生成: ${missing}件`);
  console.log(`  Reserved 予約 (ブロック扱いが必要): ${reservedIssue}件`);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
