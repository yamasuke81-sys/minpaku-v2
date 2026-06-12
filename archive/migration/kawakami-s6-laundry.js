// S6: ランドリー状況検証
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const PID = "tsZybhDMcPrxqgcRy7wp";

(async () => {
  console.log("=== S6: ランドリー検証 ===\n");

  const snap = await db.collection("laundry").where("propertyId", "==", PID).get();
  console.log(`the Terrace 長浜 の laundry 件数: ${snap.size}`);

  const byMonth = {};
  for (const d of snap.docs) {
    const x = d.data();
    const date = x.date?.toDate ? x.date.toDate() : new Date(x.date);
    if (!date || isNaN(date)) continue;
    const ym = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!byMonth[ym]) byMonth[ym] = [];
    byMonth[ym].push({ id: d.id, ...x });
  }

  console.log(`\n--- 月別集計 ---`);
  for (const ym of Object.keys(byMonth).sort()) {
    const items = byMonth[ym];
    const reimb = items.filter(x => x.isReimbursable === true || x.paymentMethod === "cash" || x.paymentMethod === "credit");
    const total = reimb.reduce((s, x) => s + (x.amount || 0), 0);
    console.log(`  ${ym}: ${items.length}件 (立替: ${reimb.length}件 合計${total}円)`);
  }

  // 最近5件の詳細
  console.log(`\n--- 最近 5 件 ---`);
  const recent = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const ta = a.date?.toDate ? a.date.toDate().getTime() : 0;
      const tb = b.date?.toDate ? b.date.toDate().getTime() : 0;
      return tb - ta;
    })
    .slice(0, 5);
  for (const l of recent) {
    const dstr = l.date?.toDate ? l.date.toDate().toISOString().slice(0, 10) : "?";
    const staffName = l.staffName || l.by?.staffName || "?";
    const reimb = l.isReimbursable === undefined
      ? (l.paymentMethod === "cash" || l.paymentMethod === "credit" ? "(旧)立替" : "(旧)非立替")
      : (l.isReimbursable ? "立替" : "非立替");
    console.log(`  ${dstr} ${staffName} ¥${l.amount || 0} ${reimb} shifts=${l.shiftId?.substring(0,8) || "?"}`);
  }

  // byShift の紐付け確認
  console.log(`\n--- shift 紐付き状況 ---`);
  let withShift = 0, withoutShift = 0;
  for (const d of snap.docs) {
    if (d.data().shiftId) withShift++;
    else withoutShift++;
  }
  console.log(`  shiftId 付き: ${withShift}件 / 無し: ${withoutShift}件`);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
