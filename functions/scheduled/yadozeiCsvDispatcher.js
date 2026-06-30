/**
 * yadozeiCsvDispatcher — 宿泊税CSV 自動取得スケジューラ
 *
 * 毎日 04:00 JST に起動。
 * properties をスキャンして yadozei.schedule.enabled === true かつ
 * 今日の日が schedule.dayOfMonth と一致する物件のジョブを yadozeiQueue に投入する。
 *
 * - targetMonths=1 なら前月のみ、2 なら前月+前々月 のように複数月をまとめてキューイング
 * - 重複防止: 当日同 pid+kind+ym で status="done" のジョブがあれば skip
 *
 * 起動: onSchedule({ schedule: "0 4 * * *", region: "asia-northeast1", timeZone: "Asia/Tokyo" })
 */
const admin = require("firebase-admin");

// JST の "今日" を Date (UTC基底) として返す
function _jstToday() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth() + 1, // 1-12
    day: jst.getUTCDate(),
  };
}

// n ヶ月前の yearMonth ("YYYY-MM")
function _monthsAgoYm(n) {
  const { year, month } = _jstToday();
  // 0-index で計算
  const idx0 = (year * 12 + (month - 1)) - n;
  const y = Math.floor(idx0 / 12);
  const m = (idx0 % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

module.exports = async function yadozeiCsvDispatcher(event) {
  const db = admin.firestore();
  const today = _jstToday();
  console.log(`[yadozei] dispatcher start: JST ${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`);

  let scanned = 0;
  let enqueued = 0;
  let skippedDup = 0;
  let skippedConfig = 0;

  try {
    const propsSnap = await db.collection("properties")
      .where("active", "==", true)
      .get();

    // 当日 00:00 JST = UTC 15:00 (前日)
    const jstMidnight = new Date(Date.UTC(today.year, today.month - 1, today.day) - 9 * 60 * 60 * 1000);
    const sinceTs = admin.firestore.Timestamp.fromDate(jstMidnight);

    for (const pDoc of propsSnap.docs) {
      const prop = pDoc.data();
      const pid = pDoc.id;
      const yadozei = prop.yadozei || {};
      const schedule = yadozei.schedule || {};

      if (schedule.enabled !== true) {
        scanned++;
        continue;
      }

      const dayOfMonth = Number(schedule.dayOfMonth) || 2;
      if (today.day !== dayOfMonth) {
        scanned++;
        continue;
      }

      const targetMonths = Math.max(1, Math.min(3, Number(schedule.targetMonths) || 1));

      // 取得対象月リスト (前月, 前々月, ...)
      const yms = [];
      for (let i = 1; i <= targetMonths; i++) {
        yms.push(_monthsAgoYm(i));
      }

      // OTA ごとにキュー投入
      const otaConfigs = [
        { ota: "airbnb", kind: "airbnb_csv_fetch", cfg: yadozei.airbnb },
        { ota: "booking", kind: "booking_csv_fetch", cfg: yadozei.booking },
      ];

      for (const { ota, kind, cfg } of otaConfigs) {
        if (!cfg || cfg.enabled !== true) {
          skippedConfig++;
          continue;
        }

        const listingId = ota === "airbnb" ? (cfg.listingId || "").trim() : "";
        const bookingPropertyId = ota === "booking" ? (cfg.propertyId || "").trim() : "";
        if (ota === "airbnb" && !listingId) {
          skippedConfig++;
          continue;
        }
        if (ota === "booking" && !bookingPropertyId) {
          skippedConfig++;
          continue;
        }

        for (const ym of yms) {
          // 重複チェック: 当日同 pid+kind+ym で done のジョブがあれば skip
          const dupSnap = await db.collection("yadozeiQueue")
            .where("propertyId", "==", pid)
            .where("kind", "==", kind)
            .where("yearMonth", "==", ym)
            .where("status", "==", "done")
            .where("completedAt", ">", sinceTs)
            .limit(1)
            .get();
          if (!dupSnap.empty) {
            skippedDup++;
            continue;
          }

          const jobData = {
            kind,
            propertyId: pid,
            propertyName: prop.name || pid,
            yearMonth: ym,
            params: kind === "airbnb_csv_fetch"
              ? { listingId }
              : { bookingPropertyId },
            status: "pending",
            result: null,
            createdBy: "scheduler",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            startedAt: null,
            completedAt: null,
            error: null,
            retries: 0,
          };

          await db.collection("yadozeiQueue").add(jobData);
          enqueued++;
          console.log(`[yadozei] enqueued: kind=${kind} property=${prop.name || pid} ym=${ym}`);
        }
      }

      scanned++;
    }

    console.log(`[yadozei] dispatcher done: scanned=${scanned} enqueued=${enqueued} skippedDup=${skippedDup} skippedConfig=${skippedConfig}`);
  } catch (e) {
    console.error("[yadozei] dispatcher エラー:", e);
    throw e;
  }
};
