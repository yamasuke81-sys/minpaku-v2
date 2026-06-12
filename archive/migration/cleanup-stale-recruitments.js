#!/usr/bin/env node
/**
 * 募集中レコードの一括クリーンアップ (2026-06-13 やますけ承認済み)
 *
 * Phase A: 日付変更で残った重複募集の削除
 *   同一 bookingId × workType に複数の「募集中」があり、予約の現在の checkOut と
 *   一致する募集が1件以上ある場合、不一致側を削除する (将来日付含む)。
 *   安全条件: 回答ゼロ / 選定なし / manualDateChange でないこと。
 *   紐づく未割当シフトと未完了チェックリストも併せて削除。
 *
 * Phase B: 過去日付の「募集中」を「期限切れ」に変更
 *   checkoutDate < 今日(JST) の募集中を status="期限切れ" に更新 (削除しない)。
 *
 * 使い方:
 *   node migration/cleanup-stale-recruitments.js          # dry-run (変更なし)
 *   node migration/cleanup-stale-recruitments.js --apply  # 実行
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const { removeRecruitmentFromAllStaff } = require("../utils/inactiveStaff");

const APPLY = process.argv.includes("--apply");

const toDateStr = (v) => {
  if (!v) return "";
  if (typeof v === "string") return v.slice(0, 10);
  if (v.toDate) return v.toDate().toISOString().slice(0, 10);
  return "";
};

const isCancelled = (s) => {
  const x = String(s || "").toLowerCase();
  return x.includes("cancel") || s === "キャンセル" || s === "キャンセル済み";
};

(async () => {
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // JST
  console.log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} / 本日(JST)=${today}`);

  const snap = await db.collection("recruitments").where("status", "==", "募集中").get();
  console.log(`status=募集中: ${snap.size} 件`);

  const docs = snap.docs.map((d) => {
    const r = d.data();
    return {
      id: d.id, ref: d.ref,
      co: toDateStr(r.checkoutDate || r.checkOutDate),
      bookingId: r.bookingId || "",
      workType: r.workType === "pre_inspection" ? "pre_inspection" : "cleaning",
      prop: r.propertyName || "-",
      responses: r.responses || [],
      selectedStaff: r.selectedStaff || "",
      selectedStaffIds: r.selectedStaffIds || [],
      manualDateChange: r.manualDateChange === true,
    };
  });

  // ===== Phase A: 重複削除 =====
  console.log("\n===== Phase A: 日付不一致の重複削除 =====");
  const byKey = {};
  docs.forEach((r) => {
    if (!r.bookingId) return;
    // 直前点検は点検日=checkIn日のため booking.checkOut と不一致が正常 → 清掃のみ対象
    if (r.workType !== "cleaning") return;
    const key = `${r.bookingId}|${r.workType}`;
    (byKey[key] = byKey[key] || []).push(r);
  });

  const deletedIds = new Set();
  let delRec = 0, delShift = 0, delChecklist = 0, skipped = 0;

  for (const [key, list] of Object.entries(byKey)) {
    if (list.length < 2) continue;
    const bookingId = key.split("|")[0];
    const bDoc = await db.collection("bookings").doc(bookingId).get();
    if (!bDoc.exists) { console.log(`[skip] booking不在 ${bookingId} (delete-orphan-recruitments の領分)`); skipped++; continue; }
    const bd = bDoc.data();
    if (isCancelled(bd.status)) { console.log(`[skip] bookingキャンセル済 ${bookingId}`); skipped++; continue; }
    const bco = toDateStr(bd.checkOut);
    const matches = list.filter((r) => r.co === bco);
    if (matches.length === 0) { console.log(`[skip] 正の募集なし ${bookingId} (booking checkOut=${bco})`); skipped++; continue; }

    for (const r of list) {
      if (r.co === bco) continue; // 正は残す
      const hasResp = r.responses.length > 0 || !(await r.ref.collection("responses").limit(1).get()).empty;
      if (hasResp || r.selectedStaff || r.selectedStaffIds.length > 0 || r.manualDateChange) {
        console.log(`[skip] 安全条件NG ${r.id} (resp=${hasResp} sel=${r.selectedStaff} manual=${r.manualDateChange})`);
        skipped++;
        continue;
      }
      console.log(`[削除] ${r.id} / ${r.co} (正=${bco}) / ${r.prop}`);
      if (APPLY) {
        await removeRecruitmentFromAllStaff(db, r.id);
        await r.ref.delete();
      }
      deletedIds.add(r.id);
      delRec++;

      // 紐づく未割当シフト + 未完了チェックリストの削除
      const shSnap = await db.collection("shifts").where("recruitmentId", "==", r.id).get();
      for (const sd of shSnap.docs) {
        const s = sd.data();
        const assigned = s.staffId || (Array.isArray(s.staffIds) && s.staffIds.length > 0);
        if (assigned || s.status === "completed") { console.log(`  [skip] shift ${sd.id} (割当済/完了)`); continue; }
        const clSnap = await db.collection("checklists").where("shiftId", "==", sd.id).get();
        for (const cd of clSnap.docs) {
          if (cd.data().status === "completed") { console.log(`  [skip] checklist ${cd.id} (完了済)`); continue; }
          console.log(`  [削除] checklist ${cd.id}`);
          if (APPLY) await cd.ref.delete();
          delChecklist++;
        }
        console.log(`  [削除] shift ${sd.id} (${toDateStr(s.date)})`);
        if (APPLY) await sd.ref.delete();
        delShift++;
      }
    }
  }
  console.log(`Phase A 結果: recruitment削除=${delRec} shift削除=${delShift} checklist削除=${delChecklist} skip=${skipped}`);

  // ===== Phase B: 過去日付 → 期限切れ =====
  console.log("\n===== Phase B: 過去日付の募集中 → 期限切れ =====");
  let expired = 0;
  for (const r of docs) {
    if (deletedIds.has(r.id)) continue;
    if (!r.co || r.co >= today) continue;
    console.log(`[期限切れ] ${r.id} / ${r.co} / ${r.prop}`);
    if (APPLY) {
      await r.ref.update({
        status: "期限切れ",
        expiredAt: admin.firestore.FieldValue.serverTimestamp(),
        expiredBy: "cleanup-stale-recruitments",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await removeRecruitmentFromAllStaff(db, r.id);
    }
    expired++;
  }
  console.log(`Phase B 結果: 期限切れ化=${expired}`);
  console.log(`\n${APPLY ? "✅ 適用完了" : "（dry-run: 変更は加えていません。--apply で実行）"}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
