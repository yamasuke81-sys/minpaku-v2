#!/usr/bin/env node
// add-day-of-recruit-timings.js で追加した
// { timing:"beforeEvent", beforeDays:0, beforeTime:"08:00" or "20:00" } を
// channelOverrides.staff_undecided.timings[] から除去するロールバック。
// 既存 timings は保持する。
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const NOTIFY_TYPE = "staff_undecided";
const REMOVE_TIMES = new Set(["08:00", "20:00"]);

const isExecute = process.argv.includes("--execute");
console.log(`mode: ${isExecute ? "EXECUTE" : "DRY-RUN (実行は --execute)"}`);

(async () => {
  const propsSnap = await db.collection("properties").where("active", "==", true).get();
  let updatedCount = 0;
  let skippedCount = 0;
  for (const pd of propsSnap.docs) {
    const prop = pd.data() || {};
    const ov = prop.channelOverrides || {};
    const cur = ov[NOTIFY_TYPE] || {};
    const timings = Array.isArray(cur.timings) ? cur.timings : [];
    const filtered = timings.filter(t => !(
      t && t.timing === "beforeEvent"
        && parseInt(t.beforeDays, 10) === 0
        && REMOVE_TIMES.has(String(t.beforeTime || ""))
    ));
    if (filtered.length === timings.length) {
      console.log(`  [skip] ${prop.name || pd.id} : 対象なし`);
      skippedCount++;
      continue;
    }
    console.log(`  [del ] ${prop.name || pd.id} : timings ${timings.length}→${filtered.length}`);
    if (isExecute) {
      await pd.ref.update({
        [`channelOverrides.${NOTIFY_TYPE}.timings`]: filtered,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    updatedCount++;
  }
  console.log(`\n=== 更新: ${updatedCount}件 / skip: ${skippedCount}件 ${isExecute ? "" : "(dry-run)"} ===`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
