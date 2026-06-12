// S4 (スタッフ確定操作) 検証: selectionMethod, 現在の rec 状態, 確定API実装確認
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const pid = "tsZybhDMcPrxqgcRy7wp";
  const toDate = (v) => v?.toDate ? v.toDate() : (typeof v === "string" ? new Date(v) : null);

  // 物件設定
  const pd = await db.collection("properties").doc(pid).get();
  const p = pd.data();
  console.log(`=== 物件: ${p.name} ===`);
  console.log(`  selectionMethod: ${p.selectionMethod || "(未設定=デフォルト ownerConfirm)"}`);
  console.log(`  cleaningRequiredCount: ${p.cleaningRequiredCount}`);
  console.log(`  cleaningStartTime: ${p.cleaningStartTime}`);
  console.log(`  inspection.enabled: ${p.inspection?.enabled}`);
  console.log(`  inspection.requiredCount: ${p.inspection?.requiredCount}`);

  // recruitments 全件 + shifts 紐付け
  console.log("\n=== recruitments / shifts 現状 ===");
  const recSnap = await db.collection("recruitments").where("propertyId", "==", pid).get();
  const shSnap = await db.collection("shifts").where("propertyId", "==", pid).get();
  const shByBookingId = new Map();
  shSnap.docs.forEach(d => { if (d.data().bookingId) shByBookingId.set(d.data().bookingId, { id: d.id, ...d.data() }); });

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const sorted = recSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(r => r.checkoutDate >= today.toISOString().substring(0, 10))
    .sort((a, b) => a.checkoutDate.localeCompare(b.checkoutDate));

  sorted.forEach(r => {
    const sh = shByBookingId.get(r.bookingId);
    const shMark = sh ? `shift=${sh.id.substring(0,8)} staffId=${sh.staffId||"null"} status=${sh.status}` : "shift=❌";
    const resSummary = (r.responses || []).map(x => `${x.staffName}${x.response}`).join(",");
    console.log(`  [${r.checkoutDate}] ${r.status.padEnd(12)} sids=${JSON.stringify(r.selectedStaffIds||[])}`);
    console.log(`     ${shMark}`);
    console.log(`     responses: ${resSummary || "(なし)"}`);
  });

  // 確定APIが実装されているか確認
  console.log("\n=== 確定API (functions/api/recruitment.js) ===");
  const fs = require("fs");
  const src = fs.readFileSync("api/recruitment.js", "utf8");
  const hasConfirm = src.includes("confirm") || src.includes("確定");
  const hasSelectStaff = src.includes("selectedStaffIds");
  console.log(`  confirm/確定キーワード: ${hasConfirm}`);
  console.log(`  selectedStaffIds 処理: ${hasSelectStaff}`);
  const match = src.match(/(?:router\.(?:put|post|patch)|app\.(?:put|post|patch))\([^)]+\)/g) || [];
  console.log(`  エンドポイント:`);
  match.slice(0, 20).forEach(m => console.log(`    ${m}`));

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
