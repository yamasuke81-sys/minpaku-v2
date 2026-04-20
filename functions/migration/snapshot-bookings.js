// 現状 bookings のスナップショット保存 (A-1 修正後の誤キャンセル復旧用)
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const toDate = (v) => v?.toDate ? v.toDate() : (typeof v === "string" ? new Date(v) : null);

  const snap = await db.collection("bookings").get();
  const confirmedFuture = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(x => x.status === "confirmed" && toDate(x.checkOut) && toDate(x.checkOut) >= today);

  // スナップショット保存 (__name__ ソート)
  confirmedFuture.sort((a, b) => a.id.localeCompare(b.id));

  const outPath = path.join(__dirname, `../../temp/bookings-snapshot-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const payload = confirmedFuture.map(b => ({
    id: b.id,
    propertyId: b.propertyId,
    propertyName: b.propertyName,
    source: b.source,
    syncSource: b.syncSource,
    status: b.status,
    checkIn: toDate(b.checkIn)?.toISOString(),
    checkOut: toDate(b.checkOut)?.toISOString(),
    guestName: b.guestName,
    createdAt: toDate(b.createdAt)?.toISOString(),
  }));
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

  console.log(`confirmed 未来予約: ${confirmedFuture.length}件`);
  console.log(`保存先: ${outPath}`);
  console.log(`\n内訳 (propertyName | source | checkIn~checkOut | guestName | id):`);
  confirmedFuture.forEach(b => {
    console.log(`  ${(b.propertyName||"?").substring(0,16).padEnd(16)} | ${(b.source||"?").padEnd(12)} | ${toDate(b.checkIn)?.toISOString()?.substring(0,10)}~${toDate(b.checkOut)?.toISOString()?.substring(0,10)} | ${(b.guestName||"").padEnd(24)} | ${b.id}`);
  });

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
