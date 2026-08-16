/**
 * OAuth トークン疎通テスト + リマインダー
 *
 * 毎日 JST 9:00 に各 Gmail OAuth トークンを refreshAccessToken() で叩いて
 * 実際にアクセストークンが取得できるか検証する。失敗したものだけ LINE + メールで
 * 管理者に通知する (24h 抑制 + 復旧検知でフラグクリア)。
 *
 * 対象: settings/gmailOAuthEmailVerification/tokens (物件・メール照合用)
 *      + settings/gmailOAuth/tokens (税理士資料用)
 * 抑制: settings/oauthAlerts/byAccount/{key}.lastFailureAlertAt が 24h 以内ならスキップ
 * 復旧: 直前まで失敗していた token がリフレッシュ成功 → 復旧通知 + フラグクリア
 */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const { google } = require("googleapis");

const REAUTH_BASE_URL = "https://api-5qrfx7ujcq-an.a.run.app/gmail-auth/start";

function buildReauthUrl(email, context) {
  const ctx = context === "emailVerification" || context === "property" ? "emailVerification" : "default";
  return `${REAUTH_BASE_URL}?context=${ctx}&email=${encodeURIComponent(email)}`;
}

function buildFailureMessage(email, context, errorMsg, daysSinceSaved) {
  const reauthUrl = buildReauthUrl(email, context);
  return [
    "🚨 Gmail OAuth 連携が切れています",
    "",
    `アカウント: ${email}`,
    `用途: ${context === "default" ? "税理士資料" : "メール照合 / サンクスメール送信"}`,
    `前回認可から: ${daysSinceSaved != null ? daysSinceSaved.toFixed(1) + " 日経過" : "(不明)"}`,
    `エラー: ${errorMsg}`,
    "",
    "OAuth トークンのリフレッシュに失敗したため、サンクスメール送信や",
    "メール照合 (キャンセル/確定/変更検知) ができない状態です。",
    "下記 URL から再認可してください。",
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

function buildScopeMissingMessage(email, context) {
  const reauthUrl = buildReauthUrl(email, context);
  return [
    "⚠️ Gmail連携にドライブ権限がありません",
    "",
    `アカウント: ${email}`,
    "用途: 請求書のGoogleドライブ保存",
    "",
    "このアカウントのGmail連携は有効ですが、Googleドライブへの",
    "保存権限 (drive.file) が付与されていません。このままだと",
    "請求書PDFがGoogleドライブに控え保存されません",
    "(アプリ内では閲覧できます)。",
    "",
    "下記URLから再認可すると、同意画面にドライブ権限が追加で表示されます。",
    "「許可」をタップしてください。",
    "",
    "▼ 再認可URL",
    reauthUrl,
  ].join("\n");
}

function buildRecoveryMessage(email, context) {
  return [
    "✅ Gmail OAuth 連携が復旧しました",
    "",
    `アカウント: ${email}`,
    `用途: ${context === "default" ? "税理士資料" : "メール照合 / サンクスメール送信"}`,
    "",
    "リフレッシュトークンが正常に動作することを確認しました。",
  ].join("\n");
}

// 単一 token に対して refreshAccessToken を叩く
async function probeToken_(oauth2Client, refreshToken) {
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  await oauth2Client.refreshAccessToken();
}

async function processCollection_(db, collectionPath, context, oauth2Client, ns, requireDriveScope = false) {
  const tokensSnap = await db.collection("settings").doc(collectionPath).collection("tokens").get();
  if (tokensSnap.empty) return { ok: 0, failed: 0, recovered: 0, alerted: 0 };

  let ok = 0, failed = 0, recovered = 0, alerted = 0;

  for (const tokenDoc of tokensSnap.docs) {
    const tokenData = tokenDoc.data();
    const refreshToken = tokenData.refreshToken || tokenData.refresh_token;
    const email = tokenData.email || tokenDoc.id;
    const accountKey = String(email).replace(/[@.]/g, "_");
    const flagRef = db.collection("settings").doc("oauthAlerts").collection("byAccount").doc(`${context}_${accountKey}`);
    const flag = await flagRef.get();
    const wasFailing = flag.exists && flag.data().lastFailure === true;

    if (!refreshToken) {
      failed++;
      console.warn(`[oauthReminder] ${email} (${context}): refreshToken なし → 連携切れ扱い`);
      // フラグは毎回書く (常駐の差分検知が Discord の発報点なので、失効を取りこぼさない)。
      // 24h 抑制はメール通知にだけ効かせる。
      const suppressed = Date.now() - (flag.exists ? (flag.data().lastFailureAlertAt?.toMillis?.() || 0) : 0)
        < 24 * 60 * 60 * 1000;
      await flagRef.set({
        lastFailure: true,
        lastFailureMessage: "refreshToken が保存されていない",
        accountEmail: email,
        ...(suppressed ? {} : { lastFailureAlertAt: admin.firestore.FieldValue.serverTimestamp() }),
      }, { merge: true });
      if (suppressed) continue;
      await sendAlert_(ns, email, context, "refreshToken が保存されていない", null);
      alerted++;
      continue;
    }

    // savedAt から日数計算
    const savedAt = tokenData.savedAt;
    let savedMs = null;
    if (savedAt && typeof savedAt.toMillis === "function") savedMs = savedAt.toMillis();
    else if (savedAt && savedAt._seconds) savedMs = savedAt._seconds * 1000;
    else if (savedAt instanceof Date) savedMs = savedAt.getTime();
    const daysSince = savedMs ? (Date.now() - savedMs) / (24 * 60 * 60 * 1000) : null;

    // 実際に refresh を試みる
    try {
      await probeToken_(oauth2Client, refreshToken);
      ok++;
      console.log(`[oauthReminder] ${email} (${context}): ✓ OK`);

      // ドライブ権限 (drive.file) の有無を確認 (請求書Drive保存用トークンのみ)
      if (requireDriveScope) {
        const scope = String(tokenData.scope || "");
        const hasDriveScope = scope.includes("drive.file") || scope.includes("auth/drive");
        const scopeFlagRef = db.collection("settings").doc("oauthAlerts").collection("byAccount").doc(`scope_${context}_${accountKey}`);
        const scopeFlag = await scopeFlagRef.get();
        if (!hasDriveScope) {
          const lastMs = scopeFlag.exists ? (scopeFlag.data().lastAlertAt?.toMillis?.() || 0) : 0;
          if (Date.now() - lastMs >= 24 * 60 * 60 * 1000) {
            await sendScopeAlert_(ns, email, context);
            await scopeFlagRef.set({
              scopeMissing: true,
              lastAlertAt: admin.firestore.FieldValue.serverTimestamp(),
              accountEmail: email,
            }, { merge: true });
            alerted++;
            console.warn(`[oauthReminder] ${email} (${context}): drive.file scope 欠落 → 通知`);
          }
        } else if (scopeFlag.exists && scopeFlag.data().scopeMissing === true) {
          await scopeFlagRef.set({ scopeMissing: false, lastOkAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        }
      }

      // 直前まで失敗していたなら復旧通知
      if (wasFailing) {
        await sendRecovery_(ns, email, context);
        recovered++;
        await flagRef.set({
          lastFailure: false,
          lastSuccessAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      } else if (flag.exists) {
        // 既に OK 状態でもタイムスタンプ更新
        await flagRef.set({
          lastFailure: false,
          lastSuccessAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    } catch (e) {
      failed++;
      const errMsg = e?.message || String(e);
      console.warn(`[oauthReminder] ${email} (${context}): ✗ ${errMsg}`);
      // フラグは毎回書く (常駐の差分検知が Discord の発報点)。24h 抑制はメール通知にだけ効かせる。
      // 旧実装は抑制時に continue していたため、24h以内に「復旧→再失効」した場合に
      // lastFailure=true を書き直せず、常駐にも失効が伝わらない穴があった。
      const suppressed = Date.now() - (flag.exists ? (flag.data().lastFailureAlertAt?.toMillis?.() || 0) : 0)
        < 24 * 60 * 60 * 1000;
      await flagRef.set({
        lastFailure: true,
        lastFailureMessage: errMsg,
        accountEmail: email,
        ...(suppressed ? {} : { lastFailureAlertAt: admin.firestore.FieldValue.serverTimestamp() }),
      }, { merge: true });
      if (suppressed) continue;
      await sendAlert_(ns, email, context, errMsg, daysSince);
      alerted++;
    }
  }

  return { ok, failed, recovered, alerted };
}

// 通知送信ヘルパ (メールのみ)。
// 2026-07-29 やますけ決定: OAuth切れ通知の宛先を LINE → Discord に変更(LINE送信は廃止・メールは継続)。
// 2026-08-17: Discord 送信もここから外した。同じ失効1件に対して
//   ①この関数 ②emailVerification の直送 ③常駐(discord-secretary-resident)の差分検知
// の3通が飛んでいたため、Discordの発報点は常駐1本に統一し、Functions側はフラグ書き込みに徹する
// (フラグ = settings/oauthAlerts/byAccount/{context}_{key}.lastFailure。常駐が30分毎に読む)。
// メールは常駐がカバーしない別チャネルなので残す。
async function deliverOAuthNotice_(ns, subject, text) {
  const notifyEmails = Array.isArray(ns.notifyEmails) ? ns.notifyEmails : [];
  for (const to of notifyEmails) {
    try {
      const { sendNotificationEmail_ } = require("../utils/lineNotify");
      await sendNotificationEmail_(to, subject, text);
    } catch (e) { console.error(`[oauthReminder] メール失敗 (${to}):`, e.message); }
  }
}

async function sendAlert_(ns, email, context, errorMsg, daysSince) {
  await deliverOAuthNotice_(ns, "Gmail OAuth 連携切れ アラート", buildFailureMessage(email, context, errorMsg, daysSince));
}

async function sendScopeAlert_(ns, email, context) {
  await deliverOAuthNotice_(ns, "Gmail連携にドライブ権限がありません", buildScopeMissingMessage(email, context));
}

async function sendRecovery_(ns, email, context) {
  await deliverOAuthNotice_(ns, "Gmail OAuth 連携復旧", buildRecoveryMessage(email, context));
}

async function oauthReminderCore(db) {
  // OAuth クライアント設定 (clientId/secret 共通)
  const cfg = await db.doc("settings/gmailOAuth").get();
  if (!cfg.exists) {
    console.warn("[oauthReminder] settings/gmailOAuth 未設定 → スキップ");
    return { ok: 0, failed: 0, recovered: 0, alerted: 0 };
  }
  const { clientId, clientSecret, redirectUri } = cfg.data();
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  // 通知設定
  const nsDoc = await db.collection("settings").doc("notifications").get();
  const ns = nsDoc.exists ? nsDoc.data() : {};

  // メール照合用 (物件Gmail = 請求書Drive保存にも使用) + 税理士資料用 を順に検査
  // 第6引数 requireDriveScope=true: drive.file scope 欠落も検知して通知
  const a = await processCollection_(db, "gmailOAuthEmailVerification", "emailVerification", oauth2Client, ns, true);
  const b = await processCollection_(db, "gmailOAuth", "default", oauth2Client, ns, false);

  const total = {
    ok: a.ok + b.ok,
    failed: a.failed + b.failed,
    recovered: a.recovered + b.recovered,
    alerted: a.alerted + b.alerted,
  };
  console.log(`[oauthReminder] 完了 ok=${total.ok} failed=${total.failed} alerted=${total.alerted} recovered=${total.recovered}`);
  return total;
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
