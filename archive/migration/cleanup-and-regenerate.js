/**
 * 1回限りの大掃除 + 再生成スクリプト
 *
 * 動作:
 *   Step 1: syncSettings 2件に propertyId/propertyName を設定
 *   Step 2: 既存 bookings 115件全て propertyId/propertyName を埋める
 *            (全てthe Terrace長浜の iCal 由来)
 *   Step 3: shifts / recruitments / checklists を全削除
 *   Step 4: 未来分の有効な bookings から shifts と recruitments を再生成
 *            (status=cancelled / guestName空 はスキップ)
 *   Step 5: onShiftCreated トリガーが走って checklists が自動生成される
 *
 * 実行:
 *   node migration/cleanup-and-regenerate.js --dry-run
 *   node migration/cleanup-and-regenerate.js
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const TERRACE_PROPERTY_ID = "tsZybhDMcPrxqgcRy7wp";
const TERRACE_PROPERTY_NAME = "the Terrace 長浜";
const DRY = process.argv.includes("--dry-run");

async function deleteCollection(name) {
  const snap = await db.collection(name).get();
  console.log(`[${name}] ${snap.size}件削除 ${DRY ? "(DRY)" : ""}`);
  if (DRY) return;
  const batches = [];
  let batch = db.batch();
  let n = 0;
  for (const doc of snap.docs) {
    batch.delete(doc.ref);
    n++;
    if (n % 400 === 0) { batches.push(batch.commit()); batch = db.batch(); }
  }
  batches.push(batch.commit());
  await Promise.all(batches);
}

(async () => {
  console.log("=== クリーンアップ＆再生成 ===");
  if (DRY) console.log("※ DRY RUN（書き込みしない）");

  // Step 1: syncSettings の propertyId 補完
  console.log("\nStep 1: syncSettings 補完");
  const settings = await db.collection("syncSettings").get();
  for (const s of settings.docs) {
    const d = s.data();
    if (!d.propertyId) {
      console.log(`  ${s.id} (${d.platform}) → propertyId 設定`);
      if (!DRY) await s.ref.update({
        propertyId: TERRACE_PROPERTY_ID,
        propertyName: TERRACE_PROPERTY_NAME
      });
    }
  }

  // Step 2: bookings 全件に propertyId を設定
  console.log("\nStep 2: bookings に propertyId を埋める");
  const bookings = await db.collection("bookings").get();
  let bookingFixed = 0;
  const batch2 = db.batch();
  for (const b of bookings.docs) {
    const d = b.data();
    if (d.propertyId !== TERRACE_PROPERTY_ID || !d.propertyName) {
      batch2.update(b.ref, {
        propertyId: TERRACE_PROPERTY_ID,
        propertyName: TERRACE_PROPERTY_NAME,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      bookingFixed++;
    }
  }
  console.log(`  ${bookingFixed}件を修正 ${DRY ? "(DRY)" : ""}`);
  if (!DRY && bookingFixed > 0) await batch2.commit();

  // Step 3: shifts / recruitments / checklists 削除
  console.log("\nStep 3: 削除");
  await deleteCollection("shifts");
  await deleteCollection("recruitments");
  await deleteCollection("checklists");

  // Step 4: 未来の有効bookingから shifts / recruitments 再生成
  console.log("\nStep 4: shifts / recruitments 再生成");
  const today = new Date(); today.setHours(0,0,0,0);
  const valid = bookings.docs.filter(d => {
    const x = d.data();
    if (x.status === "cancelled") return false;
    if (!x.guestName || x.guestName === "Reserved" || !x.guestName.trim()) return false;
    if (!x.checkOut) return false;
    const co = new Date(x.checkOut); co.setHours(0,0,0,0);
    return co >= today;
  });
  console.log(`  対象: ${valid.length}件(有効な未来予約)`);

  const now = new Date();
  let shiftCreated = 0, recruitCreated = 0;
  for (const b of valid) {
    const x = b.data();
    const checkOutDate = new Date(x.checkOut); checkOutDate.setHours(0,0,0,0);

    // shift
    if (!DRY) {
      await db.collection("shifts").add({
        date: checkOutDate,
        propertyId: TERRACE_PROPERTY_ID,
        propertyName: TERRACE_PROPERTY_NAME,
        bookingId: b.id,
        staffId: null,
        staffName: null,
        staffIds: [],
        startTime: "10:30",
        status: "unassigned",
        assignMethod: "auto",
        createdAt: now,
        updatedAt: now,
      });
    }
    shiftCreated++;

    // recruitment
    if (!DRY) {
      await db.collection("recruitments").add({
        checkoutDate: x.checkOut,
        propertyId: TERRACE_PROPERTY_ID,
        propertyName: TERRACE_PROPERTY_NAME,
        bookingId: b.id,
        status: "募集中",
        selectedStaff: "",
        selectedStaffIds: [],
        notifyMethod: "LINE",
        memo: "",
        confirmedAt: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    recruitCreated++;
  }
  console.log(`  shifts: ${shiftCreated}件作成 ${DRY ? "(DRY)" : ""}`);
  console.log(`  recruitments: ${recruitCreated}件作成 ${DRY ? "(DRY)" : ""}`);
  if (!DRY) console.log("  → onShiftCreated トリガー経由で checklists も自動生成されます");

  console.log("\n完了");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
