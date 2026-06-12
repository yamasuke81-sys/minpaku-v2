// 川上総合ヘルスチェック: TZ修正後の整合性 + 全体データの妥当性検証
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const PROPS = ["tsZybhDMcPrxqgcRy7wp", "RZV9IwtQgMAsvrdM3j8J"]; // the Terrace 長浜, YADO KOMACHI

function isCancelled(s) {
  const x = String(s || "").toLowerCase();
  return x.includes("cancel") || s === "キャンセル" || s === "キャンセル済み";
}

const issues = [];
const add = (level, msg) => issues.push({ level, msg });

(async () => {
  console.log("=== 川上総合ヘルスチェック ===\n");

  // H1. 全 shift の date が UTC midnight か
  console.log("H1. shift.date UTC midnight 検証");
  const shSnap = await db.collection("shifts").get();
  let badDate = 0, goodDate = 0;
  for (const d of shSnap.docs) {
    const s = d.data();
    const date = s.date?.toDate ? s.date.toDate() : null;
    if (!date) continue;
    if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0) {
      goodDate++;
    } else {
      badDate++;
      if (badDate <= 3) add("warn", `shift ${d.id} date ≠ UTC midnight: ${date.toISOString()}`);
    }
  }
  console.log(`  UTC midnight: ${goodDate}件 / 不正: ${badDate}件`);
  if (badDate > 0) add("warn", `shift.date が UTC midnight でない: ${badDate}件`);

  // H2. shift ⇔ booking 整合性
  console.log("\nH2. shift ⇔ booking 整合性");
  const bSnap = await db.collection("bookings").get();
  const bMap = new Map();
  for (const d of bSnap.docs) bMap.set(d.id, d.data());
  let orphanShift = 0, dateMismatch = 0;
  for (const d of shSnap.docs) {
    const s = d.data();
    if (!s.bookingId) continue;
    const b = bMap.get(s.bookingId);
    if (!b) { orphanShift++; continue; }
    if (isCancelled(b.status)) { orphanShift++; continue; }
    const dstr = s.date?.toDate ? s.date.toDate().toISOString().slice(0, 10) : String(s.date).slice(0, 10);
    const expect = s.workType === "pre_inspection" ? b.checkIn : b.checkOut;
    if (dstr !== expect) {
      dateMismatch++;
      if (dateMismatch <= 3) add("error", `shift ${d.id} 日付不整合: shift=${dstr} booking.${s.workType === "pre_inspection" ? "checkIn" : "checkOut"}=${expect}`);
    }
  }
  console.log(`  ghost: ${orphanShift}件 / 日付不整合: ${dateMismatch}件`);
  if (orphanShift > 0) add("warn", `ghost shift (booking不在/キャンセル): ${orphanShift}件`);
  if (dateMismatch > 0) add("error", `日付不整合 shift: ${dateMismatch}件`);

  // H3. recruitment ⇔ shift 整合性
  console.log("\nH3. recruitment ⇔ shift 整合性");
  const recSnap = await db.collection("recruitments").get();
  let recConfirmedNoStaff = 0, recConfirmedNoShift = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const d of recSnap.docs) {
    const r = d.data();
    if ((r.checkoutDate || "") < today) continue;
    if (r.status !== "スタッフ確定済み") continue;
    if (!(r.selectedStaffIds || []).length) {
      recConfirmedNoStaff++;
      if (recConfirmedNoStaff <= 3) add("error", `rec ${d.id}: 確定済みだが selectedStaffIds=[] (selectedStaff="${r.selectedStaff}")`);
      continue;
    }
    const shifts = shSnap.docs.filter(s => s.data().bookingId === r.bookingId);
    const match = shifts.find(s => {
      const sd = s.data();
      const dstr = sd.date?.toDate ? sd.date.toDate().toISOString().slice(0, 10) : "";
      return dstr === r.checkoutDate;
    });
    if (!match) {
      recConfirmedNoShift++;
      if (recConfirmedNoShift <= 3) add("error", `rec ${d.id} [${r.checkoutDate}] 確定済みだが shift 不在`);
    } else if (!match.data().staffId) {
      add("error", `rec ${d.id} [${r.checkoutDate}] shift.staffId 未設定`);
    }
  }
  console.log(`  確定済み×staffIds=[]: ${recConfirmedNoStaff}件 / 確定済み×shift不在: ${recConfirmedNoShift}件`);

  // H4. checklist ⇔ shift 整合性
  console.log("\nH4. checklist ⇔ shift 整合性");
  const clSnap = await db.collection("checklists").get();
  const shIds = new Set(shSnap.docs.map(d => d.id));
  let orphanCl = 0, shiftNoCl = 0;
  for (const d of clSnap.docs) {
    if (!shIds.has(d.data().shiftId)) orphanCl++;
  }
  const clByShift = new Set(clSnap.docs.map(d => d.data().shiftId));
  for (const d of shSnap.docs) {
    const s = d.data();
    const dstr = s.date?.toDate ? s.date.toDate().toISOString().slice(0, 10) : "";
    if (dstr >= today && !clByShift.has(d.id)) shiftNoCl++;
  }
  console.log(`  孤児 checklist: ${orphanCl}件 / shift without checklist: ${shiftNoCl}件`);
  if (orphanCl > 0) add("warn", `孤児 checklist: ${orphanCl}件`);
  if (shiftNoCl > 0) add("warn", `未来 shift で checklist 未生成: ${shiftNoCl}件`);

  // H5. 未来の shift で staffId null が異常多くないか
  console.log("\nH5. 未来 shift のアサイン状況");
  const futureShifts = shSnap.docs.filter(d => {
    const s = d.data();
    const dstr = s.date?.toDate ? s.date.toDate().toISOString().slice(0, 10) : "";
    return dstr >= today;
  });
  const assigned = futureShifts.filter(d => d.data().staffId).length;
  console.log(`  未来 shifts: ${futureShifts.length}件 (assigned: ${assigned}件 / unassigned: ${futureShifts.length - assigned}件)`);

  // H6. conflict 状態
  console.log("\nH6. bookingConflicts");
  const confSnap = await db.collection("bookingConflicts").get();
  const unresolved = confSnap.docs.filter(d => d.data().resolved !== true).length;
  console.log(`  total: ${confSnap.size}件 / 未解決: ${unresolved}件`);
  if (unresolved > 0) add("info", `未解決 conflict: ${unresolved}件`);

  // H7. active スタッフ
  console.log("\nH7. スタッフ状態");
  const staffSnap = await db.collection("staff").get();
  const activeStaff = staffSnap.docs.filter(d => d.data().active !== false).length;
  console.log(`  全: ${staffSnap.size}名 / active: ${activeStaff}名`);

  // H8. 通知設定 channelOverrides を持つ物件
  console.log("\nH8. 物件別通知オーバーライド");
  for (const pid of PROPS) {
    const p = (await db.collection("properties").doc(pid).get()).data();
    const co = p.channelOverrides || {};
    const keys = Object.keys(co);
    console.log(`  ${p.name}: ${keys.length} チャネル上書き中 (${keys.slice(0, 5).join(", ")}${keys.length > 5 ? "..." : ""})`);
  }

  // ========== サマリ ==========
  console.log(`\n\n=== 結果サマリ ===`);
  console.log(`ERROR: ${issues.filter(x => x.level === "error").length}件`);
  console.log(`WARN : ${issues.filter(x => x.level === "warn").length}件`);
  console.log(`INFO : ${issues.filter(x => x.level === "info").length}件`);
  for (const i of issues) {
    const icon = i.level === "error" ? "❌" : i.level === "warn" ? "⚠️" : "ℹ️";
    console.log(`  ${icon} [${i.level}] ${i.msg}`);
  }
  const errorCount = issues.filter(x => x.level === "error").length;
  process.exit(errorCount > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
