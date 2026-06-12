#!/usr/bin/env node
// 全 active 物件の channelOverrides.staff_undecided.timings[] に
// 当日 08:00 / 当日 20:00 (beforeDays=0) のリマインドを追加。
// 既に同一 (timing=beforeEvent, beforeDays=0, beforeTime=該当時刻) があれば skip。
// 既存 timings は保持し、enabled は触らない。
//
// 使い方:
//   node functions/migration/add-day-of-recruit-timings.js            # dry-run
//   node functions/migration/add-day-of-recruit-timings.js --execute  # 本番反映
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const NOTIFY_TYPE = "staff_undecided";
const ADD_TIMES = ["08:00", "20:00"]; // 当日 (beforeDays=0)

const isExecute = process.argv.includes("--execute");
console.log(`mode: ${isExecute ? "EXECUTE" : "DRY-RUN (実行は --execute)"}`);

function hasSameTiming(timings, beforeTime) {
  return (timings || []).some(t =>
    t && t.timing === "beforeEvent"
      && parseInt(t.beforeDays, 10) === 0
      && String(t.beforeTime || "") === beforeTime
  );
}

(async () => {
  const propsSnap = await db.collection("properties").where("active", "==", true).get();
  console.log(`active 物件: ${propsSnap.size}件`);

  let updatedCount = 0;
  let skippedCount = 0;

  for (const pd of propsSnap.docs) {
    const prop = pd.data() || {};
    const ov = prop.channelOverrides || {};
    const cur = ov[NOTIFY_TYPE] || {};
    const timings = Array.isArray(cur.timings) ? [...cur.timings] : [];

    const toAdd = ADD_TIMES.filter(t => !hasSameTiming(timings, t));
    if (toAdd.length === 0) {
      console.log(`  [skip] ${prop.name || pd.id} : 既に 08:00/20:00 設定済み`);
      skippedCount++;
      continue;
    }

    const newTimings = [...timings];
    for (const t of toAdd) {
      newTimings.push({ timing: "beforeEvent", beforeDays: 0, beforeTime: t });
    }
    console.log(`  [add ] ${prop.name || pd.id} : +${toAdd.join(",")} (timings ${timings.length}→${newTimings.length})`);

    if (isExecute) {
      await pd.ref.update({
        [`channelOverrides.${NOTIFY_TYPE}.timings`]: newTimings,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    updatedCount++;
  }

  console.log(`\n=== 更新: ${updatedCount}件 / skip: ${skippedCount}件 ${isExecute ? "" : "(dry-run)"} ===`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
