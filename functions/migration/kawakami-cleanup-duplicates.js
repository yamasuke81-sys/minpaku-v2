// デバッグ残骸の重複データ掃除
// 方針:
//  1. 4/20 shift 重複 → JST midnight 由来の古い方 (YU63Bb7o) を削除
//  2. 11-12月の対応 booking がない残骸 checklist+shift を削除
//  3. 6/15 の E2E テスト残骸 (laundry_put_out/expense shift + checklist) を削除
//  4. booking=null or booking cancelled なのに残っている全 shift を削除
//  5. shift 削除に連動して対応 checklist も削除
//
// 使い方:
//   node migration/kawakami-cleanup-duplicates.js           # dry-run
//   node migration/kawakami-cleanup-duplicates.js --execute
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2", credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const DRY = !process.argv.includes("--execute");

function isCancelled(s) {
  const x = String(s || "").toLowerCase();
  return x.includes("cancel") || s === "キャンセル" || s === "キャンセル済み";
}

async function deleteShiftAndRelated(shiftDoc) {
  // checklist 削除
  const cls = await db.collection("checklists").where("shiftId", "==", shiftDoc.id).get();
  for (const c of cls.docs) {
    if (!DRY) await c.ref.delete();
  }
  // laundry 記録削除 (sourceShiftId があるなら)
  const lds = await db.collection("laundry").where("sourceShiftId", "==", shiftDoc.id).get();
  for (const l of lds.docs) {
    if (!DRY) await l.ref.delete();
  }
  // shift 本体削除
  if (!DRY) await shiftDoc.ref.delete();
  return { checklistCount: cls.size, laundryCount: lds.size };
}

(async () => {
  console.log(`モード: ${DRY ? "dry-run (削除しない)" : "EXECUTE (実削除)"}\n`);

  const bSnap = await db.collection("bookings").get();
  const bMap = new Map(bSnap.docs.map(d => [d.id, d.data()]));

  const shSnap = await db.collection("shifts").get();
  const targets = [];

  // ---- ステップ 1: ghost shift (booking なし or cancelled) ----
  console.log("ステップ 1: booking なし / cancelled に紐付く shift");
  for (const d of shSnap.docs) {
    const s = d.data();
    if (!s.bookingId) continue;
    const b = bMap.get(s.bookingId);
    let reason = null;
    if (!b) reason = "booking 不在";
    else if (isCancelled(b.status)) reason = "booking cancelled";
    if (reason) targets.push({ doc: d, reason, kind: "ghost" });
  }

  // ---- ステップ 2: 同一 booking+date+workType で複数 shift ----
  console.log("ステップ 2: 同一キーで重複する shift (古い方を削除)");
  const shKey = new Map();
  for (const d of shSnap.docs) {
    const s = d.data();
    const date = s.date?.toDate ? s.date.toDate().toISOString().slice(0, 10) : String(s.date || "").slice(0, 10);
    const k = `${s.bookingId || "(none)"}|${date}|${s.workType || "?"}|${s.propertyId}`;
    if (!shKey.has(k)) shKey.set(k, []);
    shKey.get(k).push({ doc: d, data: s });
  }
  for (const [k, arr] of shKey.entries()) {
    if (arr.length <= 1) continue;
    if (k.startsWith("(none)")) continue; // bookingId なしは別扱い
    // createdAt 新しい方を残す、古い方を削除
    arr.sort((a, b) => {
      const ta = a.data.createdAt?.toDate?.()?.getTime() || 0;
      const tb = b.data.createdAt?.toDate?.()?.getTime() || 0;
      return tb - ta; // 新しい順
    });
    for (let i = 1; i < arr.length; i++) {
      targets.push({ doc: arr[i].doc, reason: `重複 (${k} のうち古い方)`, kind: "dup" });
    }
  }

  // ---- ステップ 3: 過去の日付 (今日より前) で status=unassigned/assigned な shift は残す (historical) ----
  // ---- ただし bookingId なしで workType が laundry_* なものは E2E テスト残骸の可能性大 ----
  console.log("ステップ 3: bookingId なしの laundry_* shift (E2E 残骸)");
  for (const d of shSnap.docs) {
    const s = d.data();
    if (s.bookingId) continue;
    if (!(s.workType || "").startsWith("laundry_")) continue;
    // すでに ghost に含まれてなければ追加
    if (!targets.find(t => t.doc.id === d.id)) {
      targets.push({ doc: d, reason: "bookingId なしの laundry shift (E2E 残骸)", kind: "e2e_laundry" });
    }
  }

  // ---- ステップ 4: 対応 booking が未来日と合ってるかチェック + 同日 laundry shift 重複 ----
  console.log("ステップ 4: 同日 laundry shift が 2件以上 (E2E 残骸)");
  const lShiftByKey = new Map();
  for (const d of shSnap.docs) {
    const s = d.data();
    if (!(s.workType || "").startsWith("laundry_")) continue;
    const date = s.date?.toDate ? s.date.toDate().toISOString().slice(0, 10) : String(s.date || "").slice(0, 10);
    const k = `${date}|${s.propertyId}|${s.workType}|${s.staffId || "nostaff"}`;
    if (!lShiftByKey.has(k)) lShiftByKey.set(k, []);
    lShiftByKey.get(k).push(d);
  }
  for (const [k, arr] of lShiftByKey.entries()) {
    if (arr.length <= 1) continue;
    // 一番新しいものだけ残して他を削除候補に
    arr.sort((a, b) => {
      const ta = a.data().createdAt?.toDate?.()?.getTime() || 0;
      const tb = b.data().createdAt?.toDate?.()?.getTime() || 0;
      return tb - ta;
    });
    for (let i = 1; i < arr.length; i++) {
      if (!targets.find(t => t.doc.id === arr[i].id)) {
        targets.push({ doc: arr[i], reason: `同日 laundry shift 重複 (${k} 古い方)`, kind: "e2e_laundry_dup" });
      }
    }
  }

  // 重複排除 (同じ doc が複数理由で入る可能性)
  const uniqueTargets = [];
  const seen = new Set();
  for (const t of targets) {
    if (seen.has(t.doc.id)) continue;
    seen.add(t.doc.id);
    uniqueTargets.push(t);
  }

  console.log(`\n削除対象 shift: ${uniqueTargets.length}件\n`);
  const byKind = {};
  for (const t of uniqueTargets) byKind[t.kind] = (byKind[t.kind] || 0) + 1;
  for (const [k, n] of Object.entries(byKind)) console.log(`  ${k}: ${n}件`);

  console.log("\n詳細:");
  for (const t of uniqueTargets.slice(0, 30)) {
    const s = t.doc.data();
    const date = s.date?.toDate ? s.date.toDate().toISOString().slice(0, 10) : "";
    console.log(`  [${date}] ${t.doc.id.substring(0, 10)} ${s.workType} staff=${s.staffName || s.staffId || "?"} 理由=${t.reason}`);
  }
  if (uniqueTargets.length > 30) console.log(`  ... 他 ${uniqueTargets.length - 30}件`);

  if (DRY) {
    console.log("\n→ --execute で削除");
    process.exit(0);
  }

  console.log("\n--- 削除実行 ---");
  let totalCl = 0, totalL = 0;
  for (const t of uniqueTargets) {
    const result = await deleteShiftAndRelated(t.doc);
    totalCl += result.checklistCount;
    totalL += result.laundryCount;
  }
  console.log(`\nshift ${uniqueTargets.length}件 / 連動 checklist ${totalCl}件 / 連動 laundry ${totalL}件 削除完了`);

  // ---- 孤児 checklist (shift 削除済で対応 shift がない checklist) を掃除 ----
  console.log("\n孤児 checklist の最終掃除");
  const shNow = await db.collection("shifts").get();
  const shIds = new Set(shNow.docs.map(d => d.id));
  const clSnap = await db.collection("checklists").get();
  let orphanCl = 0;
  for (const d of clSnap.docs) {
    const c = d.data();
    if (!c.shiftId || !shIds.has(c.shiftId)) {
      await d.ref.delete();
      orphanCl++;
    }
  }
  console.log(`孤児 checklist: ${orphanCl}件 削除`);

  // ---- 孤児 laundry ----
  console.log("\n孤児 laundry の最終掃除");
  const lSnap = await db.collection("laundry").get();
  let orphanL = 0;
  for (const d of lSnap.docs) {
    const l = d.data();
    if (l.sourceShiftId && !shIds.has(l.sourceShiftId)) {
      await d.ref.delete();
      orphanL++;
    }
  }
  console.log(`孤児 laundry: ${orphanL}件 削除`);

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
