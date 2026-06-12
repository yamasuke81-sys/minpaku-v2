#!/usr/bin/env node
// YADO KOMACHI 5/7 の shift.staffIds 残存をクリア
// 背景: reopen 時に shift.staffIds がクリアされず、my-checklist に旧スタッフが残る
//       onRecruitmentChange.js の reopen 逆遷移ハンドラ追加で今後は防止されるが、
//       既に残っているレコードを実データで一度だけクリアする
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const DRY_RUN = process.argv.includes("--dry-run");

(async () => {
  const propsSnap = await db.collection("properties")
    .where("name", "==", "YADO KOMACHI Hiroshima")
    .limit(1).get();
  if (propsSnap.empty) { console.error("物件未検出"); process.exit(1); }
  const propId = propsSnap.docs[0].id;
  console.log("propertyId:", propId);

  const dt = new Date("2026-05-07T00:00:00.000Z");
  const shiftSnap = await db.collection("shifts")
    .where("propertyId", "==", propId)
    .where("workType", "==", "cleaning_by_count")
    .get();

  // date 比較は JS 側で文字列マッチ
  const targets = shiftSnap.docs.filter(d => {
    const sd = d.data();
    const ds = sd.date?.toDate ? sd.date.toDate().toISOString().slice(0,10) : String(sd.date).slice(0,10);
    return ds === "2026-05-07";
  });
  console.log(`5/7 shift 件数: ${targets.length} (DRY_RUN=${DRY_RUN})`);

  for (const sd of targets) {
    const cur = sd.data();
    console.log(`shift ${sd.id}: staffId=${cur.staffId} staffIds=${JSON.stringify(cur.staffIds)} status=${cur.status}`);
    if (cur.status === "completed") { console.log("  -> completed スキップ"); continue; }
    if (DRY_RUN) { console.log("  -> DRY_RUN なので未実行"); continue; }
    await sd.ref.update({
      staffId: null,
      staffName: null,
      staffIds: [],
      status: "unassigned",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log("  -> クリア完了");
  }
})().catch(e => { console.error(e); process.exit(1); });
