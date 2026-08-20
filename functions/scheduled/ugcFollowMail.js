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
const { sendDiscord_ } = require("../utils/lineNotify");

// 何日前のチェックアウトまで遡って拾うか
const LOOKBACK_DAYS = 3;

// この日以降にチェックアウトした予約だけが対象 (キャンペーン開始日)
const CAMPAIGN_START_DATE = "2026-08-20";

// 送った実物を後から開くための控えの置き場。
// ★宿の Gmail(the.terrace.nagahama01 等)はやますけのブラウザにサインインしていないため、
//   そのアカウントへのリンクを貼っても黙って別のメールボックス(yamasuke81)が開いてしまう。
//   そこで BCC で 81hassac に控えを残し、そこを指す検索リンクを通知に載せる。
const ARCHIVE_BCC = "81hassac@gmail.com";

/** 控え(BCC先)で該当メールを開くGmail検索URL。authuser はサインイン済みなら正しく解決する */
function archiveSearchUrl_(guestEmail) {
  const q = `to:${guestEmail} subject:ご滞在ありがとうございました`;
  return `https://mail.google.com/mail/?authuser=${ARCHIVE_BCC}#search/${encodeURIComponent(q)}`;
}

/** 行単位で limit 以内のかたまりに割る (行の途中では切らない) */
function splitLines_(text, limit) {
  const chunks = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (buf && (buf.length + line.length + 1) > limit) { chunks.push(buf); buf = ""; }
    buf = buf ? `${buf}\n${line}` : line;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/** Discord は1投稿1900字まで。分割して順に送る */
async function postChunks_(url, text) {
  for (const c of splitLines_(text, 1850)) {
    const r = await sendDiscord_(url, c);
    if (!r || r.success === false) {
      console.warn("[ugcFollowMail] 秘書通知に失敗:", r && r.error);
      return false;
    }
  }
  return true;
}

/**
 * 送信結果を Discord の #民泊管理 へ報告する (settings/notifications.discordOwnerWebhookUrl)
 *
 * 送るものが無い日は呼ばない = 無音。通知の失敗でメール送信自体を巻き添えにしない。
 * 本文は載せない(やますけ指示 2026-08-20)。中身は「送信したメールを開く」リンクから確認する。
 */
async function notifySecretary_(db, todayJst, sent, failed) {
  try {
    const s = (await db.collection("settings").doc("notifications").get()).data() || {};
    const url = s.discordOwnerWebhookUrl;
    if (!url) {
      console.warn("[ugcFollowMail] discordOwnerWebhookUrl 未設定のため秘書通知をスキップ");
      return;
    }

    const head = [`## 📸 UGC案内メールを送信しました (${todayJst})`, ""];
    if (sent.length > 0) {
      head.push(`### 送信 ${sent.length}件`);
      for (const r of sent) {
        head.push(`- **${r.name}** 様 (${r.propertyName} / ${r.checkOut} チェックアウト)`);
        head.push(`  ${r.email}`);
        head.push(`  🔗 [送信したメールを開く](${archiveSearchUrl_(r.email)})`);
      }
    }
    if (failed.length > 0) {
      head.push("");
      head.push(`### 🚨 送信に失敗 ${failed.length}件 (翌日の実行で自動的に再試行します)`);
      for (const r of failed) head.push(`- ${r.name} 様 (${r.propertyName}) — ${r.error}`);
    }
    head.push("");
    head.push(`応募が来たら https://setouchi-stay.com/ugc の回答スプレッドシートに入ります。`);
    await postChunks_(url, head.join("\n"));
  } catch (e) {
    // 通知の失敗でメール送信の成否を汚さない
    console.warn("[ugcFollowMail] 秘書通知でエラー:", e.message);
  }
}

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
    const sentList = [];  // 秘書(#民泊管理)へ報告する明細
    const failedList = []; // 送信に失敗したもの

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
          // BCC で控えを残す。宿の Gmail はブラウザにサインインしていないので、
          // ここに控えが無いと「送ったメールを開く」導線が作れない
          await sendNotificationEmail_(b.email, subject, body, senderGmail || null, { bcc: [ARCHIVE_BCC] });

          // 送信できたときだけ記録する (失敗時は翌日の実行で再試行される)
          await doc.ref.update({
            ugcFollowMailSentAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          sentTotal++;
          sentList.push({ name: b.guestName || "(名前なし)", email: b.email, propertyName, checkOut: day });
          console.log(`[ugcFollowMail] 送信: ${doc.id} ${propertyName} CO=${day}`);
        } catch (mailErr) {
          failedList.push({ name: b.guestName || "(名前なし)", email: b.email, propertyName, error: mailErr.message });
          console.warn(`[ugcFollowMail] 送信失敗 ${doc.id}:`, mailErr.message);
        }
      }
    }

    console.log(`[ugcFollowMail] 完了: ${sentTotal}件送信 / ${skipped}件スキップ`);

    // 秘書(#民泊管理)へ報告。送るものが無い日は無音にする(毎日通知するとノイズになる)
    if (sentList.length > 0 || failedList.length > 0) {
      await notifySecretary_(db, todayJst, sentList, failedList);
    }
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
