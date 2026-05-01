/**
 * 募集リマインド (毎時実行 JST)
 *
 * 物件別 channelOverrides.recruit_remind.timings[] に従って発火。
 *
 * timings 構造例:
 *   [{ mode:"event", timing:"beforeEvent", beforeDays:6, beforeTime:"06:00" }, ...]
 *
 * → JST 06時に走った時、各物件で beforeDays=6 のタイミングを抽出し、
 *   `checkoutDate (清掃日) = todayJST + 6日` の「募集中」recruitment の
 *   未回答スタッフに送信。
 *
 * 重複防止: recruitments.{id}.recruitRemindSentKeys[] に
 *   "YYYY-MM-DD_HH_dN" を記録
 */
const admin = require("firebase-admin");
const { notifyByKey } = require("../utils/lineNotify");

const NOTIFY_TYPE = "recruit_remind";

function nowJst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = async function recruitReminder() {
  const db = admin.firestore();
  const { date: todayJst, hour: hourJst } = nowJst();
  console.log(`[recruitReminder] 起動 JST=${todayJst} ${String(hourJst).padStart(2, "0")}:00`);

  try {
    // 1) 全物件の timings から (propertyId, beforeDays, targetCheckoutDate) を抽出
    const propsSnap = await db.collection("properties").get();
    const targets = [];
    for (const pd of propsSnap.docs) {
      const prop = pd.data() || {};
      if (prop.active === false) continue;
      const ov = (prop.channelOverrides || {})[NOTIFY_TYPE] || {};
      if (ov.enabled === false) continue;
      const timings = Array.isArray(ov.timings) ? ov.timings : [];
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

    if (targets.length === 0) {
      console.log(`[recruitReminder] このタイミング (JST ${hourJst}時) に該当する物件設定なし`);
      return;
    }
    console.log(`[recruitReminder] マッチ: ${targets.length}件`);

    // 2) アクティブ + LINE 連携済みスタッフを取得 (1回だけ)
    const staffSnap = await db.collection("staff").where("active", "==", true).get();
    const lineStaff = staffSnap.docs
      .filter(d => d.data().lineUserId)
      .map(d => ({ id: d.id, ...d.data() }));

    if (lineStaff.length === 0) {
      console.log("[recruitReminder] LINE 連携済みスタッフなし");
      return;
    }

    let sentCount = 0;

    for (const tgt of targets) {
      // (propertyId, checkoutDate) で「募集中」recruitment を取得
      const recSnap = await db.collection("recruitments")
        .where("propertyId", "==", tgt.propertyId)
        .where("checkoutDate", "==", tgt.targetCheckoutDate)
        .where("status", "==", "募集中")
        .get();

      if (recSnap.empty) continue;

      for (const rd of recSnap.docs) {
        const r = rd.data();
        const responses = r.responses || [];
        const respondedIds = new Set(responses.map(x => x.staffId).filter(Boolean));
        // assignedPropertyIds に当該物件を含むスタッフのみ対象
        const unreplied = lineStaff.filter(s => {
          if (respondedIds.has(s.id)) return false;
          const aps = Array.isArray(s.assignedPropertyIds) ? s.assignedPropertyIds : [];
          // assignedPropertyIds 設定なしなら全物件対象とみなす (旧実装互換)
          return aps.length === 0 || aps.includes(tgt.propertyId);
        });
        if (unreplied.length === 0) continue;

        // 重複防止
        const key = `${todayJst}_${String(hourJst).padStart(2, "0")}_d${tgt.beforeDays}`;
        const sentKeys = Array.isArray(r.recruitRemindSentKeys) ? r.recruitRemindSentKeys : [];
        if (sentKeys.includes(key)) {
          console.log(`[recruitReminder] 既送信スキップ rec=${rd.id} key=${key}`);
          continue;
        }

        const baseUrl = process.env.APP_BASE_URL || "https://minpaku-v2.web.app/";
        const recruitUrl = `${baseUrl.replace(/\/$/, "")}/#/my-recruitment`;
        const text = [
          `📋 募集回答のお願い (清掃日 ${tgt.beforeDays}日前)`,
          ``,
          `${r.checkoutDate} ${r.propertyName || tgt.propertyName}`,
          `清掃スタッフ募集にまだ回答がありません。`,
          ``,
          `回答はこちら: ${recruitUrl}`,
        ].join("\n");

        const vars = {
          date: r.checkoutDate,
          checkoutDate: r.checkoutDate,
          property: r.propertyName || tgt.propertyName,
          propertyName: r.propertyName || tgt.propertyName,
          url: recruitUrl,
          count: String(responses.length),
        };

        const result = await notifyByKey(db, NOTIFY_TYPE, {
          title: `リマインド (${tgt.beforeDays}日前): ${r.checkoutDate}`,
          body: text,
          vars,
          propertyId: tgt.propertyId,
          staffIds: unreplied.map(s => s.id),
        });
        const anySuccess = Object.values(result.sent || {}).some(v => v && v !== 0);
        if (anySuccess) {
          sentCount += unreplied.length;
          try {
            await rd.ref.update({
              recruitRemindSentKeys: admin.firestore.FieldValue.arrayUnion(key),
            });
          } catch (e) {
            console.warn(`[recruitReminder] 送信記録失敗 rec=${rd.id}:`, e.message);
          }
        }
      }
    }

    console.log(`[recruitReminder] 完了: ${sentCount}件送信`);
  } catch (e) {
    console.error("[recruitReminder] エラー:", e);
    try {
      await db.collection("error_logs").add({
        functionName: "recruitReminder",
        error: e.message,
        stack: e.stack?.slice(0, 500),
        severity: "warning",
        createdAt: new Date(),
      });
    } catch (_) { /* 無視 */ }
  }
};
