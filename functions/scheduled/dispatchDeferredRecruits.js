/**
 * 30日繰延された募集の自動発火 (毎日 JST 08:00)
 *
 * recruitments.{id}.notifyDeferred === true の募集を走査し、
 * 作業日 (checkoutDate) が今日から 30日以内に入ったタイミングで
 * recruit_start を発火させ notifyDeferred=false / notifyDeferredFiredAt をセットする。
 *
 * 設計判断:
 * - settings の deferUntil30Days を後から OFF にした場合でも、既に notifyDeferred=true で
 *   保留中の募集は本バッチで通知される (作業日が 30日以内に入った時点)。
 *   ※ 即時発火させたい場合は手動で募集詳細モーダルの「募集通知」ボタンを使用。
 * - status === "募集中" のみが対象。スタッフ確定済 / キャンセル分は対象外。
 */
const admin = require("firebase-admin");
const { notifyByKey, getNotificationSettings_ } = require("../utils/lineNotify");
const { daysUntilJst, DEFER_THRESHOLD_DAYS } = require("../utils/recruitDeferral");

module.exports = async function dispatchDeferredRecruits() {
  const db = admin.firestore();
  const now = new Date();
  console.log(`[dispatchDeferredRecruits] 起動 ${now.toISOString()}`);

  try {
    const snap = await db.collection("recruitments")
      .where("notifyDeferred", "==", true)
      .where("status", "==", "募集中")
      .get();

    if (snap.empty) {
      console.log("[dispatchDeferredRecruits] 対象なし");
      return;
    }

    const { settings } = await getNotificationSettings_(db);
    const appUrl = settings?.appUrl || "https://minpaku-v2.web.app";

    let fired = 0;
    let stillDeferred = 0;

    for (const docSnap of snap.docs) {
      const r = docSnap.data();
      const recruitmentId = docSnap.id;
      const workDate = r.checkoutDate;
      if (!workDate) {
        console.warn(`[dispatchDeferredRecruits] checkoutDate 欠落 → skip ${recruitmentId}`);
        continue;
      }

      const diff = daysUntilJst(workDate, now);
      if (diff > DEFER_THRESHOLD_DAYS) {
        // まだ 30日より先 → 据え置き
        stillDeferred++;
        continue;
      }

      // 過去日は通知しない (キャンセル漏れ等)
      if (diff < 0) {
        console.warn(`[dispatchDeferredRecruits] 過去日のため通知抑止 ${recruitmentId} (${workDate})`);
        await docSnap.ref.update({
          notifyDeferred: false,
          notifyDeferredSkippedAt: admin.firestore.FieldValue.serverTimestamp(),
          notifyDeferredSkipReason: "past",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        continue;
      }

      // 通知発火
      const propertyName = r.propertyName || "";
      const memo = r.memo || "";
      const work = r.workType === "pre_inspection" ? "直前点検" : "清掃";
      const recruitUrl = `${appUrl.replace(/\/$/, "")}/#/my-recruitment/${recruitmentId}`;

      try {
        await notifyByKey(db, "recruit_start", {
          title: `${work}スタッフ募集: ${workDate}`,
          body: `【${work}スタッフ募集】\n${workDate} ${propertyName}\n${memo}\n回答: ${recruitUrl}`,
          vars: {
            date: workDate,
            checkoutDate: workDate,
            property: propertyName,
            propertyName,
            work,
            url: recruitUrl,
            memo,
          },
          propertyId: r.propertyId || null,
        });
        await docSnap.ref.update({
          notifyDeferred: false,
          notifyDeferredFiredAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        fired++;
        console.log(`[dispatchDeferredRecruits] 発火 ${recruitmentId} (${workDate}, ${work}, ${propertyName})`);
      } catch (e) {
        console.error(`[dispatchDeferredRecruits] 通知失敗 ${recruitmentId}:`, e);
      }
    }

    console.log(`[dispatchDeferredRecruits] 完了 fired=${fired} stillDeferred=${stillDeferred} total=${snap.size}`);
  } catch (e) {
    console.error("[dispatchDeferredRecruits] エラー:", e);
    try {
      await db.collection("error_logs").add({
        functionName: "dispatchDeferredRecruits",
        error: e.message, stack: (e.stack || "").slice(0, 500),
        severity: "error", createdAt: new Date(),
      });
    } catch (_) { /* ignore */ }
  }
};
