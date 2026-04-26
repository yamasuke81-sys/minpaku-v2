/**
 * shifts.staffIds を recruitments.selectedStaffIds で修復するスクリプト
 *
 * 問題: shifts コレクションの staffIds フィールドが正しく維持されておらず、
 *       複数スタッフ確定時も1名しか反映されない、外れたスタッフが残る等の不整合がある。
 * 対処: 確定済み recruitment の selectedStaffIds を正として shifts に上書きする。
 *
 * 使い方:
 *   cd functions
 *   node migration/repair-shifts-from-recruitments.js --dry-run   # 確認のみ（書き込みなし）
 *   node migration/repair-shifts-from-recruitments.js             # 本実行
 */
const admin = require("firebase-admin");

admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const isDryRun = process.argv.includes("--dry-run");

/** "YYYY-MM-DD" 形式の日付文字列から JST 当日の Timestamp 範囲を返す */
function dateStrToJstRange(dateStr) {
  const dayStart = new Date(`${dateStr}T00:00:00+09:00`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  return { dayStart, dayEnd };
}

/** Timestamp or string の checkoutDate を "YYYY-MM-DD" に正規化する */
function normalizeCheckoutDate(val) {
  if (!val) return null;
  if (typeof val === "string") return val.slice(0, 10);
  // Firestore Timestamp
  if (val.toDate) return val.toDate().toISOString().slice(0, 10);
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return null;
}

/** staffId から staffName を解決する（staff コレクション参照） */
const staffNameCache = {};
async function resolveStaffName(staffId) {
  if (!staffId) return null;
  if (staffNameCache[staffId] !== undefined) return staffNameCache[staffId];
  try {
    const doc = await db.collection("staff").doc(staffId).get();
    staffNameCache[staffId] = doc.exists ? (doc.data().name || null) : null;
  } catch (_) {
    staffNameCache[staffId] = null;
  }
  return staffNameCache[staffId];
}

async function main() {
  console.log(`=== shifts 修復スクリプト (${isDryRun ? "DRY RUN — 書き込みなし" : "本実行 — Firestore に書き込む"}) ===\n`);

  // 確定済み recruitment を全件取得
  const recruitmentsSnap = await db.collection("recruitments")
    .where("status", "==", "スタッフ確定済み")
    .get();

  console.log(`確定済み recruitment 件数: ${recruitmentsSnap.size}\n`);

  let updated = 0;
  let skipped = 0;
  let notFound = 0;
  let errors = 0;

  for (const rDoc of recruitmentsSnap.docs) {
    const r = rDoc.data();
    const pid = r.propertyId;
    const dateStr = normalizeCheckoutDate(r.checkoutDate);
    const workType = r.workType === "pre_inspection" ? "pre_inspection" : "cleaning_by_count";
    const selectedStaffIds = Array.isArray(r.selectedStaffIds) ? r.selectedStaffIds.filter(Boolean) : [];

    if (!pid || !dateStr || selectedStaffIds.length === 0) {
      console.log(`[skip] recruitment=${rDoc.id} — propertyId/checkoutDate/selectedStaffIds が不完全`);
      skipped++;
      continue;
    }

    // propertyId + checkoutDate + workType で対応する shift を検索
    // checkoutDate は Timestamp で保存されているため範囲検索
    const { dayStart, dayEnd } = dateStrToJstRange(dateStr);
    let shiftSnap;
    try {
      shiftSnap = await db.collection("shifts")
        .where("propertyId", "==", pid)
        .where("date", ">=", dayStart)
        .where("date", "<", dayEnd)
        .where("workType", "==", workType)
        .get();
    } catch (e) {
      console.error(`[error] recruitment=${rDoc.id} shift 検索失敗: ${e.message}`);
      errors++;
      continue;
    }

    if (shiftSnap.empty) {
      console.log(`[not found] recruitment=${rDoc.id} (${dateStr} / ${pid} / ${workType}) — 対応する shift なし`);
      notFound++;
      continue;
    }

    // 複数 shift が見つかった場合も全件修復する（通常は1件のはず）
    for (const sDoc of shiftSnap.docs) {
      const s = sDoc.data();
      const currentStaffIds = Array.isArray(s.staffIds) ? s.staffIds : [];
      const currentStaffId = s.staffId || null;

      // 変更前後の比較
      const newFirstStaffId = selectedStaffIds[0] || null;
      const newFirstStaffName = await resolveStaffName(newFirstStaffId);

      const changed =
        JSON.stringify(currentStaffIds.slice().sort()) !== JSON.stringify(selectedStaffIds.slice().sort()) ||
        currentStaffId !== newFirstStaffId;

      console.log(`[${changed ? (isDryRun ? "will update" : "update") : "no change"}] shift=${sDoc.id}`);
      console.log(`  recruitment=${rDoc.id}  date=${dateStr}  workType=${workType}`);
      console.log(`  staffIds: ${JSON.stringify(currentStaffIds)} → ${JSON.stringify(selectedStaffIds)}`);
      console.log(`  staffId:  ${currentStaffId} → ${newFirstStaffId}  name: ${s.staffName} → ${newFirstStaffName}`);

      if (!changed) {
        skipped++;
        continue;
      }

      if (!isDryRun) {
        try {
          await sDoc.ref.update({
            staffIds: selectedStaffIds,
            staffId: newFirstStaffId,
            staffName: newFirstStaffName,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } catch (e) {
          console.error(`  [error] 書き込み失敗: ${e.message}`);
          errors++;
          continue;
        }
      }
      updated++;
    }
  }

  console.log("\n=== 結果 ===");
  console.log(`  更新${isDryRun ? "予定" : "済み"}: ${updated}`);
  console.log(`  変更なし/スキップ: ${skipped}`);
  console.log(`  対応 shift なし:   ${notFound}`);
  console.log(`  エラー:            ${errors}`);
  if (isDryRun) {
    console.log("\n※ DRY RUN のため Firestore への書き込みは行われていません。");
    console.log("  本実行する場合は --dry-run を外して再実行してください。");
  }
}

main().catch(e => {
  console.error("致命的エラー:", e);
  process.exit(1);
});
