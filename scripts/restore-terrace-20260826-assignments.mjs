/**
 * the Terrace 長浜 2026-08-26〜27 予約の清掃・直前点検 割当復旧（単発スクリプト）
 *
 * 背景:
 *   Booking.com 予約 5990618442 (Tomoko Miyama, CI 8/26 / CO 8/27) が 2026-08-12 14:54 に
 *   キャンセル検知され、onBookingChange の「キャンセル連動削除」で
 *     - 清掃 shift/recruitment auto_{bookingId}_cleaning_2026-08-27
 *     - 直前点検 shift Pucj9USF1OXlhrKWQEdw / recruitment 1d6yGC6g2RAG9Un5Lkqb
 *   が削除された。その約1.5時間後に同一ゲストの再予約 5167790262 の確定メールが
 *   同じ bookings ドキュメントへ照合され confirmed に復帰、募集が新規生成された（＝空の募集）。
 *   さらに直前点検は同時二重発火で 2 セット生成されている。
 *
 * やること:
 *   1) 重複した直前点検セット（募集・シフト・チェックリスト）の片方を削除
 *   2) キャンセル前の確定メンバーを復元
 *        直前点検 8/26 : 橋元優奈
 *        清掃     8/27 : 橋元優奈, 猪島千晶
 *      （Cloud Logging の onRecruitmentChange shift同期ログ 2026-08-01 から復元）
 *
 * 通知は出さない:
 *   onRecruitmentChange は responses が増えたときだけ通知する（早期 return）。
 *   本スクリプトは responses を触らず status/selectedStaffIds のみ更新するため通知は発火しない。
 *   shift 側はトリガーが自動同期するが、取りこぼし対策として明示更新もする。
 *
 * 使い方:
 *   node scripts/restore-terrace-20260826-assignments.mjs          # dry-run
 *   node scripts/restore-terrace-20260826-assignments.mjs --apply  # 実書き込み
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");

const BOOKING_ID = "ical_7253811f3931278394cb928226739462@booking.com";
const PROPERTY_ID = "tsZybhDMcPrxqgcRy7wp";

const STAFF = {
  mjNoSlT3S8QhVSd30Ujv: "橋元優奈",
  "33fQMMfon9FfmUNfGtDx": "猪島千晶",
};

// 削除する重複セット（後発 .225 側）。残すのは .212 側の 49OfiCD8mEomgR1P8LKl / 5EXMnzLuc90MSdJaj8Af
const DUP_DELETE = {
  recruitment: "QdPqTj82QR4EyQSiRIMF",
  shift: "6LukyguQr3eHBWTp47mb",
  checklist: "sewAqc7gD0lJ4Cl789Mx",
};

// 復元対象
const TARGETS = [
  {
    label: "直前点検 8/26",
    recruitmentId: "49OfiCD8mEomgR1P8LKl",
    shiftId: "5EXMnzLuc90MSdJaj8Af",
    staffIds: ["mjNoSlT3S8QhVSd30Ujv"],
  },
  {
    label: "清掃 8/27",
    recruitmentId: `auto_${BOOKING_ID}_cleaning_2026-08-27`,
    shiftId: `auto_${BOOKING_ID}_cleaning_2026-08-27`,
    staffIds: ["mjNoSlT3S8QhVSd30Ujv", "33fQMMfon9FfmUNfGtDx"],
  },
];

admin.initializeApp({
  credential: admin.credential.cert(
    require("../.credentials/minpaku-v2-firebase-adminsdk-fbsvc-dd291cd17e.json")
  ),
});
const db = admin.firestore();
const now = admin.firestore.FieldValue.serverTimestamp();

const log = (...a) => console.log(...a);

async function main() {
  log(`=== ${APPLY ? "APPLY(実書き込み)" : "DRY-RUN(確認のみ)"} ===\n`);

  // --- 事前検証: 削除対象が本当に重複か（同一 bookingId・同一日・未割当）を確認 ---
  const dupShift = await db.collection("shifts").doc(DUP_DELETE.shift).get();
  const dupRec = await db.collection("recruitments").doc(DUP_DELETE.recruitment).get();
  if (!dupShift.exists || !dupRec.exists) {
    log("⚠️ 重複セットが既に存在しません。削除はスキップします。");
  } else {
    const s = dupShift.data();
    const r = dupRec.data();
    const okShift = s.bookingId === BOOKING_ID && s.workType === "pre_inspection" && s.status === "unassigned";
    const okRec = r.bookingId === BOOKING_ID && r.workType === "pre_inspection" && r.checkoutDate === "2026-08-26";
    log(`重複チェック shift=${okShift ? "OK" : "NG"} (status=${s.status}, staffIds=${JSON.stringify(s.staffIds || [])})`);
    log(`重複チェック recruitment=${okRec ? "OK" : "NG"} (status=${r.status}, responses=${(r.responses || []).length}件)`);
    if (!okShift || !okRec) {
      throw new Error("重複と断定できないため中止（手動確認が必要）");
    }
    if (APPLY) {
      await db.collection("checklists").doc(DUP_DELETE.checklist).delete();
      await db.collection("shifts").doc(DUP_DELETE.shift).delete();
      await db.collection("recruitments").doc(DUP_DELETE.recruitment).delete();
      log(`🗑 重複セット削除: recruitment=${DUP_DELETE.recruitment} shift=${DUP_DELETE.shift} checklist=${DUP_DELETE.checklist}`);
    } else {
      log(`(dry) 削除予定: recruitment=${DUP_DELETE.recruitment} shift=${DUP_DELETE.shift} checklist=${DUP_DELETE.checklist}`);
    }
  }
  log("");

  // --- 割当復元 ---
  for (const t of TARGETS) {
    const names = t.staffIds.map((id) => STAFF[id]).join(",");
    const recRef = db.collection("recruitments").doc(t.recruitmentId);
    const shiftRef = db.collection("shifts").doc(t.shiftId);
    const [recSnap, shiftSnap] = await Promise.all([recRef.get(), shiftRef.get()]);

    if (!recSnap.exists) throw new Error(`募集が存在しない: ${t.recruitmentId}`);
    if (!shiftSnap.exists) throw new Error(`シフトが存在しない: ${t.shiftId}`);

    const rec = recSnap.data();
    log(`[${t.label}] 現状 募集: status=${rec.status} selectedStaff="${rec.selectedStaff || ""}" responses=${(rec.responses || []).length}件`);
    log(`[${t.label}] 現状 シフト: status=${shiftSnap.data().status} staffIds=${JSON.stringify(shiftSnap.data().staffIds || [])}`);
    log(`[${t.label}] 復元先: ${names} (${t.staffIds.join(", ")})`);

    if (!APPLY) {
      log("");
      continue;
    }

    // 募集: responses は触らない（触ると onRecruitmentChange が通知を出す）
    await recRef.update({
      status: "スタッフ確定済み",
      selectedStaff: names,
      selectedStaffIds: t.staffIds,
      confirmedAt: now,
      updatedAt: now,
      restoreNote: "2026-08-12のキャンセル→同名再予約でリセットされた割当を復旧(キャンセル前メンバー)",
    });

    // シフト: トリガーでも同期されるが、確実にするため明示更新
    await shiftRef.update({
      staffIds: t.staffIds,
      staffId: t.staffIds[0],
      staffName: STAFF[t.staffIds[0]],
      status: "assigned",
      assignMethod: "manual_confirm",
      updatedAt: now,
    });

    log(`✅ [${t.label}] 復元完了\n`);
  }

  if (APPLY) {
    // --- 結果検証 ---
    log("=== 検証 ===");
    for (const t of TARGETS) {
      const [r, s] = await Promise.all([
        db.collection("recruitments").doc(t.recruitmentId).get(),
        db.collection("shifts").doc(t.shiftId).get(),
      ]);
      log(`[${t.label}] 募集 status=${r.data().status} selectedStaff="${r.data().selectedStaff}"`);
      log(`[${t.label}] シフト status=${s.data().status} staffIds=${JSON.stringify(s.data().staffIds)}`);
    }
    const dup = await db.collection("shifts")
      .where("bookingId", "==", BOOKING_ID)
      .where("workType", "==", "pre_inspection")
      .get();
    log(`直前点検シフト残数: ${dup.size} 件 (期待値 1)`);
  }
}

main()
  .then(() => log("\n完了"))
  .catch((e) => {
    console.error("エラー:", e.message);
    process.exitCode = 1;
  });
