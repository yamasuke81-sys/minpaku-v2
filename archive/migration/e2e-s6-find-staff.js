// シフトが入っているスタッフ × 月を探す
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const snap = await db.collection("shifts").get();
  const byMonthStaff = {};
  for (const d of snap.docs) {
    const x = d.data();
    const date = x.date?.toDate ? x.date.toDate() : new Date(x.date);
    if (!date || isNaN(date)) continue;
    const ym = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    const sid = x.staffId;
    if (!sid) continue;
    const key = `${ym}|${sid}`;
    if (!byMonthStaff[key]) byMonthStaff[key] = { count: 0, ym, sid, name: x.staffName || "?" };
    byMonthStaff[key].count++;
  }
  console.log(`staffId 付きシフトの月別:`);
  Object.values(byMonthStaff)
    .sort((a, b) => a.ym.localeCompare(b.ym))
    .forEach(r => console.log(`  ${r.ym} ${r.sid} (${r.name}): ${r.count}件`));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
