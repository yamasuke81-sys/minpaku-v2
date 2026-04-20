/**
 * E: 既存ランドリー記録の作業実績バックフィル
 *
 * sourceShiftId が未設定の laundry 記録 (isReimbursable=false を含む) に対し、
 * 対応する shift (laundry_put_out + laundry_expense) を生成する。
 *
 * 対象データ (2026-04-19 時点で判明している 1件):
 *   propertyId=tsZybhDMcPrxqgcRy7wp, paymentMethod=prepaid, amount=1500, isReimbursable=false
 *
 * 使い方:
 *   node backfill-laundry-shifts.js --dry-run   # 確認のみ
 *   node backfill-laundry-shifts.js --execute   # 実際に生成
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const isDryRun = !process.argv.includes("--execute");

/** propertyWorkItems から name で workItem を検索 */
async function findWorkItemByName(propertyId, name) {
  if (!propertyId) return null;
  try {
    const doc = await db.collection("propertyWorkItems").doc(propertyId).get();
    if (!doc.exists) return null;
    const items = doc.data().items || [];
    return items.find(wi => wi.name === name) || null;
  } catch (e) {
    return null;
  }
}

(async () => {
  console.log(`=== ランドリー作業実績バックフィル (${isDryRun ? "DRY RUN" : "EXECUTE"}) ===\n`);

  // sourceShiftId が未設定の laundry 記録を全取得
  const laundrySnap = await db.collection("laundry").get();
  const targets = laundrySnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(l => !l.sourceShiftId);

  console.log(`sourceShiftId 未設定の laundry 記録: ${targets.length}件`);

  // 既存の laundry_put_out shift を sourceChecklistId で索引化
  const shiftsSnap = await db.collection("shifts")
    .where("assignMethod", "==", "auto_laundry")
    .get();
  const existingLaundryShifts = new Set(
    shiftsSnap.docs
      .filter(d => d.data().sourceChecklistId)
      .map(d => `${d.data().sourceChecklistId}__${d.data().sourceAction}`)
  );

  let createdCount = 0;
  let skippedCount = 0;
  const now = new Date();

  for (const laundry of targets) {
    const checklistId = laundry.sourceChecklistId || "";
    const propertyId = laundry.propertyId || "";
    const staffId = laundry.staffId || "";
    const amount = Number(laundry.amount) || 0;
    const paymentMethod = laundry.paymentMethod || "";
    const date = laundry.date || null;

    // 物件名取得
    let propertyName = "";
    try {
      const propDoc = await db.collection("properties").doc(propertyId).get();
      if (propDoc.exists) propertyName = propDoc.data().name || "";
    } catch (e) { /* ignore */ }

    // bookingId 取得 (checklist から)
    let bookingId = "";
    if (checklistId) {
      try {
        const clDoc = await db.collection("checklists").doc(checklistId).get();
        if (clDoc.exists) bookingId = clDoc.data().bookingId || "";
      } catch (e) { /* ignore */ }
    }

    const dstr = date?.toDate ? date.toDate().toISOString().slice(0, 10) : String(date || "?");
    console.log(`\n  laundry ${laundry.id}: ${dstr} propertyId=${propertyId} amount=${amount} paymentMethod=${paymentMethod}`);

    // put_out shift の重複チェック
    const putOutKey = checklistId ? `${checklistId}__put_out` : null;
    if (putOutKey && existingLaundryShifts.has(putOutKey)) {
      console.log(`    → put_out shift 既存のためスキップ`);
      skippedCount++;
      continue;
    }

    const baseShift = {
      staffId,
      propertyId,
      propertyName,
      bookingId,
      date,
      status: "completed",
      assignMethod: "auto_laundry",
      sourceChecklistId: checklistId || `laundry_backfill_${laundry.id}`,
    };

    // shift1: ランドリー出し
    const putOutItemName = "ランドリー出し";
    const putOutItem = await findWorkItemByName(propertyId, putOutItemName);
    const putOutAmount = putOutItem
      ? Number(putOutItem.commonRate || putOutItem.commonRates?.[1] || 0)
      : 0;

    console.log(`    putOut: workItemName="${putOutItemName}" amount=${putOutAmount}`);

    // shift2: 立替
    let expenseName = null;
    let expenseAmount = 0;
    if (amount > 0) {
      if (paymentMethod === "prepaid") {
        expenseName = `ランドリープリカ${amount}`;
      } else {
        expenseName = `ランドリー現金${amount}`;
      }
      const expenseItem = await findWorkItemByName(propertyId, expenseName);
      expenseAmount = expenseItem
        ? Number(expenseItem.commonRate || expenseItem.commonRates?.[1] || amount)
        : amount;
      console.log(`    expense: workItemName="${expenseName}" amount=${expenseAmount}`);
    }

    if (isDryRun) continue;

    // shift1 作成
    const putOutRef = await db.collection("shifts").add({
      ...baseShift,
      workType: "laundry_put_out",
      workItemName: putOutItemName,
      amount: putOutAmount,
      sourceAction: "put_out",
      createdAt: now,
      updatedAt: now,
    });
    createdCount++;
    console.log(`    → put_out shift 作成: ${putOutRef.id}`);

    // laundry ドキュメントに sourceShiftId を記録 (二重カウント防止)
    await db.collection("laundry").doc(laundry.id).update({
      sourceShiftId: putOutRef.id,
    });

    // shift2 作成 (立替あり時)
    if (expenseName && expenseAmount > 0) {
      const expenseRef = await db.collection("shifts").add({
        ...baseShift,
        workType: "laundry_expense",
        workItemName: expenseName,
        amount: expenseAmount,
        sourceAction: "expense",
        createdAt: now,
        updatedAt: now,
      });
      createdCount++;
      console.log(`    → expense shift 作成: ${expenseRef.id}`);
    }
  }

  console.log(`\n--- 結果 ---`);
  console.log(`処理対象: ${targets.length}件 / スキップ: ${skippedCount}件`);
  if (!isDryRun) console.log(`生成: ${createdCount}件`);
  else console.log(`(dry-run: 実際の生成は --execute で実行)`);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
