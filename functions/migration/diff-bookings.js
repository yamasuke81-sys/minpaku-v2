// 前回スナップショットと現在の confirmed 未来予約を diff して誤キャンセル検出
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  const snapshotFile = process.argv[2];
  if (!snapshotFile) {
    console.error("使い方: node migration/diff-bookings.js <snapshot.json>");
    process.exit(1);
  }
  const before = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
  const beforeIds = new Set(before.map(x => x.id));
  const beforeMap = new Map(before.map(x => [x.id, x]));

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const toDate = (v) => v?.toDate ? v.toDate() : (typeof v === "string" ? new Date(v) : null);

  const snap = await db.collection("bookings").get();
  const afterAll = new Map();
  snap.docs.forEach(d => afterAll.set(d.id, { id: d.id, ...d.data() }));

  // 1. before (confirmed 未来) の現状
  console.log("=== 前スナップショット (confirmed 未来) の現在状態 ===\n");
  let turnedCancelled = 0;
  before.forEach(b => {
    const a = afterAll.get(b.id);
    if (!a) {
      console.log(`  ❌ 消失: ${b.id}  ${b.propertyName} ${b.checkIn}~${b.checkOut} ${b.guestName}`);
    } else if (String(a.status).toLowerCase().includes("cancel")) {
      console.log(`  ⚠️  CANCELLED: ${b.id}  ${b.propertyName} ${b.checkIn}~${b.checkOut} ${b.guestName}`);
      turnedCancelled++;
    } else {
      // console.log(`  ✅ ${b.id} still confirmed`);
    }
  });

  // 2. 新規発生 (before にない confirmed 未来)
  console.log("\n=== 新規 confirmed 未来予約 (スナップショット後 追加) ===");
  let newCount = 0;
  afterAll.forEach((a, id) => {
    if (beforeIds.has(id)) return;
    const co = toDate(a.checkOut);
    if (!co || co < today) return;
    if (String(a.status).toLowerCase().includes("cancel")) return;
    if (a.status !== "confirmed") return;
    console.log(`  + ${id}  ${a.propertyName} ${toDate(a.checkIn)?.toISOString()?.substring(0,10)}~${co.toISOString().substring(0,10)} ${a.guestName}`);
    newCount++;
  });

  console.log(`\n=== サマリ ===`);
  console.log(`  スナップショット時 confirmed 未来: ${before.length}件`);
  console.log(`  → 現在キャンセル化: ${turnedCancelled}件`);
  console.log(`  新規追加 confirmed 未来: ${newCount}件`);
  console.log(`\n💡 誤キャンセルが疑われる場合: fix-accidental-cancel.js を用意して復旧`);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
