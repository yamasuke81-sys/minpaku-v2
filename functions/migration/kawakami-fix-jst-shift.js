// JST midnight 保存されてる shift を UTC midnight に修正
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const DRY = !process.argv.includes("--execute");

function toUtcMidnight(dateStr) {
  return new Date(dateStr + "T00:00:00.000Z");
}

(async () => {
  console.log(`モード: ${DRY ? "確認のみ" : "実行"}\n`);

  const snap = await db.collection("shifts").get();
  const targets = [];
  for (const d of snap.docs) {
    const s = d.data();
    const date = s.date?.toDate ? s.date.toDate() : null;
    if (!date) continue;
    if (date.getUTCHours() !== 0 || date.getUTCMinutes() !== 0) {
      // JST midnight (15:00 UTC) かも。
      // 対応する booking から正しい日付を取る
      if (s.bookingId) {
        const b = await db.collection("bookings").doc(s.bookingId).get();
        if (b.exists) {
          const bd = b.data();
          const expect = s.workType === "pre_inspection" ? bd.checkIn : bd.checkOut;
          targets.push({ id: d.id, ref: d.ref, current: date.toISOString(), expect, bookingId: s.bookingId });
        } else {
          console.log(`  ${d.id}: booking ${s.bookingId} 不在 → スキップ`);
        }
      } else {
        console.log(`  ${d.id}: bookingId なし → スキップ`);
      }
    }
  }

  console.log(`JST midnight 保存の shift: ${targets.length}件\n`);
  for (const t of targets) {
    console.log(`  ${t.id}: ${t.current} → ${t.expect}T00:00:00.000Z`);
    if (!DRY) {
      await t.ref.update({ date: toUtcMidnight(t.expect) });
      console.log(`    ✓ 更新完了`);
    }
  }

  console.log(`\n${DRY ? "→ --execute で実行" : "完了"}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
