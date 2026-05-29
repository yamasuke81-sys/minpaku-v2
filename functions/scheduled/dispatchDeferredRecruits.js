/**
 * 30日繰延された通知の自動発火 (毎日 JST 08:00)
 *
 * 対象1: recruit_start
 *   recruitments.{id}.notifyDeferred === true && status === "募集中" を走査し、
 *   作業日 (checkoutDate) が 30日以内に入ったら recruit_start を発火、
 *   notifyDeferred=false / notifyDeferredFiredAt をセット。
 *
 * 対象2: timee_posting
 *   bookings.{id}.timeeNotifyDeferred === true で status が cancelled でない予約を走査し、
 *   作業日 (checkOut) が 30日以内に入ったら timee_posting を発火、
 *   timeeNotifyDeferred=false / timeeNotifySentAt をセット。
 *
 * 設計判断:
 * - 物件側で deferUntil30Days を後から OFF にした場合でも、既に保留中のドキュメントは
 *   本バッチで作業日 30日以内になった時点で自動発火する。
 *   ※ 即時発火させたい場合は手動操作 (募集なら詳細モーダルの「募集通知」ボタン等)。
 */
const admin = require("firebase-admin");
const { notifyByKey, getNotificationSettings_ } = require("../utils/lineNotify");
const { daysUntilJst, DEFER_THRESHOLD_DAYS } = require("../utils/recruitDeferral");
const { buildTimeeAutofillUrl_ } = require("../utils/timeeAutofill");

module.exports = async function dispatchDeferredRecruits() {
  const db = admin.firestore();
  const now = new Date();
  console.log(`[dispatchDeferredRecruits] 起動 ${now.toISOString()}`);

  // ===== 対象2: timee_posting (bookings.timeeNotifyDeferred) =====
  // recruit_start より先に処理してから recruit_start 処理へ
  try {
    await _dispatchDeferredTimee_(db, now);
  } catch (e) {
    console.error("[dispatchDeferredRecruits] timee_posting 処理エラー:", e);
  }

  // ===== 対象1: recruit_start (recruitments.notifyDeferred) =====
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
    const appUrl = settings?.appUrl || "https://v2-5-relay.web.app";

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

/**
 * timee_posting 用の繰延通知発火
 * bookings.timeeNotifyDeferred === true の予約を走査し、checkOut が 30日以内なら通知発火
 */
async function _dispatchDeferredTimee_(db, now) {
  const snap = await db.collection("bookings")
    .where("timeeNotifyDeferred", "==", true)
    .get();
  if (snap.empty) {
    console.log("[dispatchDeferredRecruits/timee] 対象なし");
    return;
  }

  // 物件マスタを必要な分だけキャッシュ
  const propCache = {};
  const getProperty = async (pid) => {
    if (!pid) return null;
    if (propCache[pid] !== undefined) return propCache[pid];
    try {
      const d = await db.collection("properties").doc(pid).get();
      propCache[pid] = d.exists ? d.data() : null;
    } catch (_) {
      propCache[pid] = null;
    }
    return propCache[pid];
  };

  let fired = 0;
  let stillDeferred = 0;

  for (const docSnap of snap.docs) {
    const b = docSnap.data();
    const bookingId = docSnap.id;

    // キャンセル済予約は通知抑止 + フラグ解除
    const status = String(b.status || "").toLowerCase();
    if (status.includes("cancel") || b.status === "キャンセル") {
      await docSnap.ref.update({
        timeeNotifyDeferred: false,
        timeeNotifyDeferredSkippedAt: admin.firestore.FieldValue.serverTimestamp(),
        timeeNotifyDeferredSkipReason: "cancelled",
      });
      continue;
    }

    const checkOut = b.checkOut;
    if (!checkOut) continue;

    const diff = daysUntilJst(checkOut, now);
    if (diff > DEFER_THRESHOLD_DAYS) {
      stillDeferred++;
      continue;
    }
    if (diff < 0) {
      await docSnap.ref.update({
        timeeNotifyDeferred: false,
        timeeNotifyDeferredSkippedAt: admin.firestore.FieldValue.serverTimestamp(),
        timeeNotifyDeferredSkipReason: "past",
      });
      continue;
    }

    const propertyData = await getProperty(b.propertyId) || {};
    const propertyName = propertyData.name || b.propertyName || "";
    const guestName = b.guestName || "";
    const source = b.source || "";
    const checkIn = b.checkIn || "";

    // 物件側で timee_posting が disabled に切り替わっていた場合は通知抑止
    const ovs = (propertyData.channelOverrides || {}).timee_posting || {};
    if (ovs.enabled === false) {
      await docSnap.ref.update({
        timeeNotifyDeferred: false,
        timeeNotifyDeferredSkippedAt: admin.firestore.FieldValue.serverTimestamp(),
        timeeNotifyDeferredSkipReason: "disabled",
      });
      continue;
    }

    // URL生成 (onBookingChange と同じロジック)
    const tf = propertyData.timeeAutofill;
    const urlGroup = buildTimeeAutofillUrl_(tf, checkOut, "group_limited");
    const urlNewWorker = buildTimeeAutofillUrl_(tf, checkOut, "new_worker_for_client_limited");

    let bodyText;
    if (urlGroup || urlNewWorker) {
      const lines = [
        `🕐 タイミー募集依頼`,
        ``,
        `チェックアウト: ${checkOut}`,
        `物件: ${propertyName}`,
      ];
      if (guestName) lines.push(`ゲスト: ${guestName}${source ? `（${source}）` : ""}`);
      lines.push(``, `▼ PC Chrome でタップ → 自動入力 → 「求人を作成」`);
      if (urlGroup) lines.push(``, `▶ グループ限定で募集を作成`, urlGroup);
      if (urlNewWorker) lines.push(``, `▶ 初回ワーカー限定で募集を作成`, urlNewWorker);
      lines.push(``, `▼ スマホ完結 (Dispatch コピペ用)`,
        `/timee-post ${bookingId} group_limited`,
        `/timee-post ${bookingId} new_worker_for_client_limited`);
      bodyText = lines.join("\n");
    } else {
      bodyText = `🕐 タイミー募集依頼\n\nチェックアウト: ${checkOut}\n物件: ${propertyName}\n\nこの物件に timeeAutofill 設定が未投入のため、手動で投稿してください。\n\nタイミー: https://app-new.taimee.co.jp/account`;
    }

    try {
      await notifyByKey(db, "timee_posting", {
        title: `タイミー募集依頼: ${checkOut} ${propertyName}`,
        body: bodyText,
        vars: {
          date: checkOut,
          checkin: checkIn || "",
          property: propertyName || "",
          guest: guestName || "",
          site: source || "",
          url: urlGroup || urlNewWorker || "https://app-new.taimee.co.jp/account",
          urlGroup: urlGroup || "",
          urlNewWorker: urlNewWorker || "",
        },
        propertyId: b.propertyId || null,
      });
      await docSnap.ref.update({
        timeeNotifyDeferred: false,
        timeeNotifySentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      fired++;
      console.log(`[dispatchDeferredRecruits/timee] 発火 ${bookingId} (${checkOut}, ${propertyName})`);
    } catch (e) {
      console.error(`[dispatchDeferredRecruits/timee] 通知失敗 ${bookingId}:`, e);
    }
  }

  console.log(`[dispatchDeferredRecruits/timee] 完了 fired=${fired} stillDeferred=${stillDeferred} total=${snap.size}`);
}
