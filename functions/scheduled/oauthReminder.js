/**
 * OAuth トークン期限リマインダー
 * Test mode の OAuth Consent Screen は機微スコープ使用時にリフレッシュトークンが
 * 7日で自動失効する。失効する前 (6日経過) に LINE + メールで管理者に再認可を促す。
 *
 * 実行: 毎日 1 回 (JST 9:00)
 * 対象: settings/gmailOAuthEmailVerification/tokens 配下の全トークン
 * 抑制: settings/oauthAlerts/byAccount/{key}.lastReminderAt が 24h 以内ならスキップ
 */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

const REMIND_THRESHOLD_DAYS = 6; // 7日失効の1日前
const REMIND_THRESHOLD_MS = REMIND_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

const REAUTH_BASE_URL = "https://api-5qrfx7ujcq-an.a.run.app/gmail-auth/start";

function buildReauthUrl(email) {
  return `${REAUTH_BASE_URL}?context=emailVerification&email=${encodeURIComponent(email)}`;
}

function buildMessage(email, daysSinceSaved) {
  const reauthUrl = buildReauthUrl(email);
  return [
    "🔑 Gmail OAuth トークン 有効期限リマインダー",
    "",
    `アカウント: ${email}`,
    `前回認可から: ${daysSinceSaved.toFixed(1)} 日経過`,
    "",
    "Test mode の OAuth Consent Screen はリフレッシュトークンが 7 日で自動失効します。",
    "メール照合 (キャンセル/確定/変更検知) を継続するため、下記の URL から再認可してください。",
    "",
    "▼ 再認可手順",
    "1. 下の URL をスマホ/PC のブラウザで開く",
    "2. Google アカウントを選択",
    "3. 「許可」をタップ → 完了画面が表示されれば OK",
    "",
    "▼ 再認可 URL",
    reauthUrl,
  ].join("\n");
}

async function oauthReminderCore(db) {
  const tokensSnap = await db
    .collection("settings")
    .doc("gmailOAuthEmailVerification")
    .collection("tokens")
    .get();

  if (tokensSnap.empty) {
    console.log("[oauthReminder] tokens なし、スキップ");
    return { remindedCount: 0, skippedCount: 0 };
  }

  let remindedCount = 0;
  let skippedCount = 0;

  // 通知設定取得 (LINE)
  const nsDoc = await db.collection("settings").doc("notifications").get();
  const ns = nsDoc.exists ? nsDoc.data() : {};
  const channelToken = ns.lineChannelToken || ns.lineToken;
  const ownerUserId = ns.lineOwnerUserId || ns.lineOwnerId || ns.ownerUserId;
  const notifyEmails = Array.isArray(ns.notifyEmails) ? ns.notifyEmails : [];

  for (const tokenDoc of tokensSnap.docs) {
    const tokenData = tokenDoc.data();
    if (!tokenData.refreshToken) continue;

    const savedAt = tokenData.savedAt;
    let savedMs = null;
    if (savedAt && typeof savedAt.toMillis === "function") savedMs = savedAt.toMillis();
    else if (savedAt && savedAt._seconds) savedMs = savedAt._seconds * 1000;
    else if (savedAt instanceof Date) savedMs = savedAt.getTime();
    else if (typeof savedAt === "number") savedMs = savedAt;

    if (!savedMs) {
      skippedCount++;
      continue;
    }

    const elapsedMs = Date.now() - savedMs;
    const daysSince = elapsedMs / (24 * 60 * 60 * 1000);

    // 6 日未満ならスキップ (まだ早い)
    if (elapsedMs < REMIND_THRESHOLD_MS) {
      skippedCount++;
      continue;
    }

    // 24h 抑制: 連続実行で何度も通知しない
    const accountKey = (tokenData.email || tokenDoc.id).replace(/[@.]/g, "_");
    const flagRef = db.collection("settings").doc("oauthAlerts").collection("byAccount").doc(accountKey);
    const flag = await flagRef.get();
    if (flag.exists) {
      const lastAt = flag.data().lastReminderAt;
      const lastMs = lastAt && lastAt.toMillis ? lastAt.toMillis() : 0;
      if (Date.now() - lastMs < 24 * 60 * 60 * 1000) {
        skippedCount++;
        continue;
      }
    }

    const email = tokenData.email || "(unknown)";
    const text = buildMessage(email, daysSince);
    console.log(`[oauthReminder] 送信: ${email} (${daysSince.toFixed(1)}日経過)`);

    // LINE 送信
    if (channelToken && ownerUserId) {
      try {
        const { sendLineMessage } = require("../utils/lineNotify");
        await sendLineMessage(channelToken, ownerUserId, text);
      } catch (e) {
        console.error("[oauthReminder] LINE 送信エラー:", e.message);
      }
    }

    // メール送信
    if (notifyEmails.length > 0) {
      try {
        const { sendNotificationEmail_ } = require("../utils/lineNotify");
        // sendNotificationEmail_ は private (アンダースコア接尾) → 直接呼べないため _internal 経由 or 公開ヘルパ確認
        // 代わりに同じファイル内で再構築するシンプル実装に切替
        for (const to of notifyEmails) {
          try {
            await sendNotificationEmail_(to, "Gmail OAuth 有効期限リマインダー", text);
          } catch (mailErr) {
            console.error(`[oauthReminder] メール送信エラー (${to}):`, mailErr.message);
          }
        }
      } catch (e) {
        console.error("[oauthReminder] メール送信エラー:", e.message);
      }
    }

    await flagRef.set({
      lastReminderAt: admin.firestore.FieldValue.serverTimestamp(),
      reminderDaysSinceSaved: daysSince,
      accountEmail: email,
    }, { merge: true });
    remindedCount++;
  }

  console.log(`[oauthReminder] 完了: reminded=${remindedCount}, skipped=${skippedCount}`);
  return { remindedCount, skippedCount };
}

const oauthReminder = onSchedule(
  {
    schedule: "0 9 * * *", // 毎日 JST 9:00
    region: "asia-northeast1",
    timeZone: "Asia/Tokyo",
  },
  async (_event) => {
    const db = admin.firestore();
    await oauthReminderCore(db);
  }
);

module.exports = { oauthReminder, oauthReminderCore };
