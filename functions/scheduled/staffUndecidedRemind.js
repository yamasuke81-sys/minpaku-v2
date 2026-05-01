/**
 * スタッフ未確定リマインド (毎時実行 JST)
 *
 * 物件別 channelOverrides.staff_undecided.timings[] に従って発火。
 *
 * timings 構造例:
 *   [{ mode:"event", timing:"beforeEvent", beforeDays:3, beforeTime:"11:00" }, ...]
 *
 * → JST 11時に走った時、各物件で beforeDays=3 のタイミングを抽出し、
 *   `checkoutDate (清掃日) = todayJST + 3日` の status="募集中" の
 *   recruitment を通知。
 *
 * 後方互換: timings 未設定なら従来動作 (今日〜3日以内の募集中をまとめて毎日11時通知)
 *   → cron が毎時になったため、未設定物件は毎朝11時のみ動作するよう hourJst===11 を判定
 *
 * 重複防止: recruitments.{id}.staffUndecidedSentKeys[] に
 *   "YYYY-MM-DD_HH_dN" を記録 (timings 経路) または
 *   "YYYY-MM-DD_legacy" (後方互換 経路)
 */
const admin = require("firebase-admin");
const { notifyByKey } = require("../utils/lineNotify");

const APP_URL = "https://minpaku-v2.web.app";
const NOTIFY_TYPE = "staff_undecided";

function nowJst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = async function staffUndecidedRemind() {
  const db = admin.firestore();
  const { date: todayJst, hour: hourJst } = nowJst();
  console.log(`[staffUndecidedRemind] 起動 JST=${todayJst} ${String(hourJst).padStart(2, "0")}:00`);

  try {
    // 物件 timings から (propertyId, beforeDays, targetCheckoutDate) を抽出
    const propsSnap = await db.collection("properties").get();
    const targets = [];
    const legacyPropertyIds = new Set(); // timings 未設定の物件 (後方互換動作)

    for (const pd of propsSnap.docs) {
      const prop = pd.data() || {};
      if (prop.active === false) continue;
      const ov = (prop.channelOverrides || {})[NOTIFY_TYPE] || {};
      if (ov.enabled === false) continue;
      const timings = Array.isArray(ov.timings) ? ov.timings : [];
      if (timings.length === 0) {
        legacyPropertyIds.add(pd.id);
        continue;
      }
      for (const t of timings) {
        if (t.timing !== "beforeEvent") continue;
        const beforeDays = parseInt(t.beforeDays, 10);
        if (!Number.isFinite(beforeDays) || beforeDays < 0) continue;
        const m = String(t.beforeTime || "").match(/^(\d{1,2}):(\d{2})$/);
        if (!m) continue;
        if (parseInt(m[1], 10) !== hourJst) continue;
        targets.push({
          propertyId: pd.id,
          propertyName: prop.name || pd.id,
          beforeDays,
          targetCheckoutDate: addDays(todayJst, beforeDays),
        });
      }
    }

    let sentCount = 0;

    // === 1) timings 経路 ===
    for (const tgt of targets) {
      const recSnap = await db.collection("recruitments")
        .where("propertyId", "==", tgt.propertyId)
        .where("checkoutDate", "==", tgt.targetCheckoutDate)
        .where("status", "==", "募集中")
        .get();
      if (recSnap.empty) continue;

      for (const rd of recSnap.docs) {
        const r = rd.data();
        const key = `${todayJst}_${String(hourJst).padStart(2, "0")}_d${tgt.beforeDays}`;
        const sentKeys = Array.isArray(r.staffUndecidedSentKeys) ? r.staffUndecidedSentKeys : [];
        if (sentKeys.includes(key)) continue;

        const propertyName = r.propertyName || tgt.propertyName;
        const recruitUrl = `${APP_URL}/#/recruitment`;
        const body = [
          `⚠️ スタッフ未確定 警告 (${tgt.beforeDays}日前)`,
          ``,
          `物件: ${propertyName}`,
          `清掃日: ${r.checkoutDate}`,
          ``,
          `${tgt.beforeDays}日後の清掃スタッフが未確定です。`,
          `募集画面: ${recruitUrl}`,
        ].join("\n");
        const title = `スタッフ未確定 (${tgt.beforeDays}日前): ${propertyName} (${r.checkoutDate})`;
        const result = await notifyByKey(db, NOTIFY_TYPE, {
          title,
          body,
          vars: {
            date: r.checkoutDate, property: propertyName, url: recruitUrl,
            staff: "", count: String((r.responses || []).length),
          },
          propertyId: tgt.propertyId,
        });
        const anySuccess = Object.values(result.sent || {}).some(v => v && v !== 0);
        if (anySuccess) {
          sentCount++;
          try {
            await rd.ref.update({
              staffUndecidedSentKeys: admin.firestore.FieldValue.arrayUnion(key),
            });
          } catch (_) {}
        }
      }
    }

    // === 2) 後方互換 (timings 未設定物件): 毎朝 11時 のみ動作、3日以内の募集中まとめ通知 ===
    if (hourJst === 11 && legacyPropertyIds.size > 0) {
      const limit = addDays(todayJst, 3);
      const recSnap = await db.collection("recruitments")
        .where("status", "==", "募集中")
        .get();
      const legacyTargets = recSnap.docs.filter(d => {
        const data = d.data();
        if (!legacyPropertyIds.has(data.propertyId)) return false;
        const co = data.checkoutDate || "";
        return co >= todayJst && co <= limit;
      });
      for (const rd of legacyTargets) {
        const r = rd.data();
        const key = `${todayJst}_legacy`;
        const sentKeys = Array.isArray(r.staffUndecidedSentKeys) ? r.staffUndecidedSentKeys : [];
        if (sentKeys.includes(key)) continue;

        const propertyName = r.propertyName || r.propertyId || "";
        const recruitUrl = `${APP_URL}/#/recruitment`;
        const body = [
          `⚠️ スタッフ未確定 警告`, ``,
          `物件: ${propertyName}`, `清掃日: ${r.checkoutDate}`, ``,
          `3日以内にスタッフが確定していません。`,
          `募集画面: ${recruitUrl}`,
        ].join("\n");
        const title = `スタッフ未確定: ${propertyName} (${r.checkoutDate})`;
        const result = await notifyByKey(db, NOTIFY_TYPE, {
          title, body,
          vars: {
            date: r.checkoutDate, property: propertyName, url: recruitUrl,
            staff: "", count: String((r.responses || []).length),
          },
          propertyId: r.propertyId || null,
        });
        const anySuccess = Object.values(result.sent || {}).some(v => v && v !== 0);
        if (anySuccess) {
          sentCount++;
          try {
            await rd.ref.update({
              staffUndecidedSentKeys: admin.firestore.FieldValue.arrayUnion(key),
            });
          } catch (_) {}
        }
      }
    }

    console.log(`[staffUndecidedRemind] 完了: ${sentCount}件送信`);
  } catch (e) {
    console.error("[staffUndecidedRemind] エラー:", e);
    try {
      await db.collection("error_logs").add({
        functionName: "staffUndecidedRemind",
        error: e.message,
        stack: e.stack?.slice(0, 500),
        severity: "warning",
        createdAt: new Date(),
      });
    } catch (_) { /* 無視 */ }
  }
};
