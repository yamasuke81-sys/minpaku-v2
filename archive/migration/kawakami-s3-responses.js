// S3: スタッフ回答 (responses) の検証
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const PID = "tsZybhDMcPrxqgcRy7wp";

(async () => {
  console.log("=== S3: スタッフ回答検証 ===\n");

  // 全スタッフ
  const staffSnap = await db.collection("staff").where("active", "==", true).get();
  const staffByProp = staffSnap.docs.filter(d => {
    const s = d.data();
    const ids = s.assignedPropertyIds || [];
    return ids.includes(PID);
  });
  console.log(`物件担当 active スタッフ: ${staffByProp.length}名`);
  for (const d of staffByProp) {
    const s = d.data();
    const lineOk = s.lineUserId ? "LINE✓" : "LINE❌";
    const authOk = s.authUid ? "auth✓" : "auth❌";
    console.log(`  ${d.id}: ${s.name} ${lineOk} ${authOk} isOwner=${s.isOwner || false}`);
  }

  // 最近の recruitments の responses
  console.log("\n--- 最近の recruitments の responses ---");
  const today = new Date().toISOString().slice(0, 10);
  const recSnap = await db.collection("recruitments").where("propertyId", "==", PID).get();
  const recent = recSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(r => (r.checkoutDate || "") >= today)
    .sort((a, b) => (a.checkoutDate || "").localeCompare(b.checkoutDate || ""))
    .slice(0, 10);
  for (const r of recent) {
    const resp = r.responses || [];
    const summary = resp.map(x => `${x.staffName}(${x.response})`).join(", ") || "(回答0)";
    console.log(`  [${r.checkoutDate}] ${r.status.padEnd(12)} 回答${resp.length}件: ${summary}`);
  }

  // responses 全くないもの件数
  const noResponse = recent.filter(r => (r.responses || []).length === 0).length;
  const withResponse = recent.filter(r => (r.responses || []).length > 0).length;
  console.log(`\n  回答あり: ${withResponse}件 / 回答なし: ${noResponse}件`);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
