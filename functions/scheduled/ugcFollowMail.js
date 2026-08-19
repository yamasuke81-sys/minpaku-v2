/**
 * チェックアウト後のお礼 + UGCキャンペーン案内メール (毎日 JST 10:00)
 *
 * 設計SSOT: setouchi-stay-sites/marketing/UGC_CASHBACK_CAMPAIGN.md
 *
 * 「昨日チェックアウトした予約」を拾って、ゲスト本人へ1通だけ送る。
 * 文面と対象判定は utils/ugcFollowMail-logic.js (純粋関数・テスト済み) が持つ。
 *
 * 取りこぼしの救済:
 *   関数が落ちた日や、名簿提出が遅れてメールアドレスが後から入った予約を拾うため、
 *   直近 LOOKBACK_DAYS 日分のチェックアウトを毎回見る。二重送信は
 *   bookings.ugcFollowMailSentAt (送信時刻) で防ぐ。
 *
 * 初回デプロイ時の暴発防止:
 *   CAMPAIGN_START_DATE より前にチェックアウトした予約には送らない。
 *   過去の宿泊者へ突然「先日はご滞在…」が飛ぶ事故を構造的に防ぐ。
 *
 * 緊急停止:
 *   settings/marketing.ugcFollowMailEnabled を false にすると送信しない。
 */
const admin = require("firebase-admin");
const { nowJst, addDays } = require("../utils/dateUtils");
const { sendNotificationEmail_, resolveSenderGmail_ } = require("../utils/lineNotify");
const { getOptoutSecret_, buildOptoutUrl, isSuppressed_ } = require("../utils/marketingOptout");
const { isEligibleBooking, buildUgcFollowMail } = require("../utils/ugcFollowMail-logic");

// 何日前のチェックアウトまで遡って拾うか
const LOOKBACK_DAYS = 3;

// この日以降にチェックアウトした予約だけが対象 (キャンペーン開始日)
const CAMPAIGN_START_DATE = "2026-08-20";

module.exports = async function ugcFollowMail() {
  const db = admin.firestore();
  const { date: todayJst } = nowJst();

  console.log(`[ugcFollowMail] 起動 JST=${todayJst}`);

  try {
    const settings = await db.collection("settings").doc("marketing").get();
    if (settings.exists && settings.data().ugcFollowMailEnabled === false) {
      console.log("[ugcFollowMail] settings/marketing.ugcFollowMailEnabled=false のため停止中");
      return;
    }

    const secret = await getOptoutSecret_();
    const propertyNames = new Map(); // propertyId -> 表示名 (物件ドキュメントの読み込みを1回で済ませる)
    let sentTotal = 0;
    let skipped = 0;

    // 昨日から LOOKBACK_DAYS 日前まで、1日ずつ等値クエリで引く
    // (checkOut の等値なら単一フィールドインデックスで足り、複合インデックスが要らない)
    for (let back = 1; back <= LOOKBACK_DAYS; back++) {
      const day = addDays(todayJst, -back);
      if (day < CAMPAIGN_START_DATE) continue;

      const snap = await db.collection("bookings").where("checkOut", "==", day).get();
      if (snap.empty) continue;

      for (const doc of snap.docs) {
        const b = doc.data() || {};
        const check = isEligibleBooking(b);
        if (!check.ok) {
          skipped++;
          continue;
        }

        // 配信停止済みなら送らない
        if (await isSuppressed_(db, b.email)) {
          console.log(`[ugcFollowMail] 配信停止済みのためスキップ: ${doc.id}`);
          skipped++;
          continue;
        }

        const propertyId = b.propertyId;
        if (!propertyNames.has(propertyId)) {
          const p = await db.collection("properties").doc(propertyId).get();
          propertyNames.set(propertyId, (p.exists && p.data().name) || "");
        }
        const propertyName = b.propertyName || propertyNames.get(propertyId) || "当宿";

        try {
          const { subject, body } = buildUgcFollowMail({
            guestName: b.guestName,
            propertyId,
            propertyName,
            checkIn: b.checkIn,
            checkOut: b.checkOut,
            optoutUrl: buildOptoutUrl(b.email, secret),
          });

          const senderGmail = await resolveSenderGmail_(db, propertyId);
          await sendNotificationEmail_(b.email, subject, body, senderGmail || null);

          // 送信できたときだけ記録する (失敗時は翌日の実行で再試行される)
          await doc.ref.update({
            ugcFollowMailSentAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          sentTotal++;
          console.log(`[ugcFollowMail] 送信: ${doc.id} ${propertyName} CO=${day}`);
        } catch (mailErr) {
          console.warn(`[ugcFollowMail] 送信失敗 ${doc.id}:`, mailErr.message);
        }
      }
    }

    console.log(`[ugcFollowMail] 完了: ${sentTotal}件送信 / ${skipped}件スキップ`);
  } catch (e) {
    console.error("[ugcFollowMail] エラー:", e);
    try {
      await db.collection("error_logs").add({
        functionName: "ugcFollowMail",
        error: e.message,
        stack: e.stack?.slice(0, 500),
        severity: "warning",
        createdAt: new Date(),
      });
    } catch (_) { /* 無視 */ }
  }
};
