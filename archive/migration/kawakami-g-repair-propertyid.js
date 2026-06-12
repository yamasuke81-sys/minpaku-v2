// guestRegistrations で propertyId 未設定のドキュメントを救済
// bookings テーブルの propertyId + checkIn 一致で紐付ける
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const DRY = !process.argv.includes("--execute");

(async () => {
  console.log(`モード: ${DRY ? "確認のみ" : "実行"}\n`);

  const snap = await db.collection("guestRegistrations").get();
  const missing = snap.docs.filter(d => !d.data().propertyId);
  console.log(`propertyId 未設定: ${missing.length}件\n`);

  if (missing.length === 0) { process.exit(0); }

  // bookings index (checkIn -> [{pid, id, ...}])
  const bSnap = await db.collection("bookings").get();
  const byCheckIn = new Map();
  for (const d of bSnap.docs) {
    const b = d.data();
    if (!b.checkIn || !b.propertyId) continue;
    if (!byCheckIn.has(b.checkIn)) byCheckIn.set(b.checkIn, []);
    byCheckIn.get(b.checkIn).push({ id: d.id, pid: b.propertyId, name: b.guestName });
  }

  let resolved = 0, unresolved = 0;
  for (const d of missing) {
    const g = d.data();
    const candidates = byCheckIn.get(g.checkIn) || [];
    // checkIn 一致 + 名前一致 or 単一候補
    let match = null;
    if (candidates.length === 1) match = candidates[0];
    else {
      const nameMatch = candidates.find(c => c.name && g.guestName && (c.name === g.guestName || c.name.includes(g.guestName) || g.guestName.includes(c.name)));
      if (nameMatch) match = nameMatch;
    }

    if (match) {
      resolved++;
      console.log(`  ${d.id} [${g.checkIn}] ${g.guestName || "?"} → pid=${match.pid} (from booking ${match.id})`);
      if (!DRY) {
        await d.ref.update({
          propertyId: match.pid,
          bookingId: match.id,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    } else {
      unresolved++;
      console.log(`  ❌ ${d.id} [${g.checkIn}] ${g.guestName || "?"} (候補: ${candidates.length}件)`);
    }
  }

  console.log(`\n解決: ${resolved}件 / 未解決: ${unresolved}件`);
  console.log(DRY ? "\n→ --execute で実行" : "\n実行完了");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
