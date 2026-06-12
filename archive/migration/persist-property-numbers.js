/**
 * 民泊物件すべてに propertyNumber と color を永続化(既存値は保持)
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const PALETTE = ["#0d6efd","#ffc107","#198754","#dc3545","#6f42c1","#fd7e14","#20c997","#6610f2","#0dcaf0","#d63384"];

(async () => {
  const snap = await db.collection("properties").get();
  const all = snap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() })).filter(p => p.type === "minpaku");

  // 既存 propertyNumber を収集
  const used = new Set(all.map(p => p.propertyNumber).filter(n => typeof n === "number"));
  let nextNum = 1;
  const nextFree = () => { while (used.has(nextNum)) nextNum++; used.add(nextNum); return nextNum++; };

  // 並び順: 既存番号あり → そのまま, 無し → name昇順で最小空き番号を割当
  const assigned = [];
  for (const p of all) {
    const update = {};
    let num = p.propertyNumber;
    if (typeof num !== "number") {
      num = nextFree();
      update.propertyNumber = num;
    }
    if (!p.color) {
      update.color = PALETTE[(num - 1) % PALETTE.length];
    }
    assigned.push({ name: p.name, num, color: p.color || update.color, hasUpdate: Object.keys(update).length > 0 });
    if (Object.keys(update).length > 0) {
      update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
      await p.ref.update(update);
    }
  }

  console.log("=== 結果 ===");
  assigned.sort((a, b) => a.num - b.num).forEach(p => {
    console.log(`  ${p.num}. ${p.name}  色=${p.color}${p.hasUpdate ? " (更新)" : " (既存)"}`);
  });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
