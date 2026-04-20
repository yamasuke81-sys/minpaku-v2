/**
 * メール照合機能: OTA 予約確認メールを巡回し、生データを emailVerifications/{messageId} に保存する
 *
 * 実行方式 (3 経路で同じ core ロジックを呼ぶ):
 *   1. 定期実行:  onSchedule("every 10 minutes") → `scheduled`
 *   2. 予約作成即時: triggers/onBookingEmailCheck.js から呼出
 *   3. 手動トリガー: api/email-verification.js の POST /run から呼出
 *
 * 本ステップでは生データ保存までで止める。本文パース (Step 3) と iCal 突合 (Step 4) は別ステップ。
 */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { google } = require("googleapis");

const PROCESSED_LABEL_NAME = "minpaku-v2-email-verified";
const KNOWN_OTA_SENDERS = [
  "automated@airbnb.com",
  "no-reply@airbnb.jp",
  "no-reply@airbnb.com",
  "noreply@airbnb.com",
  "express@airbnb.com",
  "customer.service@booking.com",
  "customer.service@mail.booking.com",
  "noreply@booking.com",
];

// ======================================================
// 純粋関数 (テスト対象、Firestore / Gmail API に依存しない)
// ======================================================

// Gmail 検索クエリ組み立て (to: OR 連結 + from: OTA 連結 + -label:処理済)
function buildGmailQuery(verificationEmails, labelId, senders = KNOWN_OTA_SENDERS) {
  if (!Array.isArray(verificationEmails) || verificationEmails.length === 0) return "";
  const toClause = verificationEmails.map((e) => `to:${e}`).join(" OR ");
  const fromClause = senders.map((s) => `from:${s}`).join(" OR ");
  const labelExclude = labelId ? `-label:${labelId}` : "";
  return `(${toClause}) (${fromClause}) ${labelExclude}`.trim();
}

// Gmail payload.headers から大小文字無視で値を取得
function getHeader(headers, name) {
  if (!Array.isArray(headers)) return null;
  const lower = String(name).toLowerCase();
  const h = headers.find((x) => String(x.name || "").toLowerCase() === lower);
  return h ? h.value : null;
}

// multipart から text/plain or text/html 本文を抽出
function extractBody(payload, preferText = true) {
  if (!payload) return "";
  let found = "";
  function walk(part) {
    if (!part) return;
    const mime = part.mimeType || "";
    if (preferText && mime === "text/plain" && part.body && part.body.data) {
      found = Buffer.from(part.body.data, "base64url").toString("utf-8");
      return;
    }
    if (!preferText && mime === "text/html" && part.body && part.body.data) {
      found = Buffer.from(part.body.data, "base64url").toString("utf-8");
      return;
    }
    if (Array.isArray(part.parts)) part.parts.forEach(walk);
  }
  walk(payload);
  return found;
}

// 送信元ヘッダから OTA プラットフォーム名を推定
function guessPlatform(fromHeader) {
  const s = String(fromHeader || "").toLowerCase();
  if (s.includes("airbnb")) return "Airbnb";
  if (s.includes("booking.com")) return "Booking.com";
  return "Unknown";
}

// To ヘッダ文字列内に含まれる verificationTargets の該当を返す (plus-addressing 許容)
function matchVerificationTarget(toHeader, verificationTargets) {
  if (!Array.isArray(verificationTargets)) return null;
  const s = String(toHeader || "").toLowerCase();
  return verificationTargets.find((t) => t && s.includes(String(t.email || "").toLowerCase())) || null;
}

// ======================================================
// Gmail ラベル管理
// ======================================================

async function ensureProcessedLabel(gmail, labelName = PROCESSED_LABEL_NAME) {
  const list = await gmail.users.labels.list({ userId: "me" });
  const existing = (list.data.labels || []).find((l) => l.name === labelName);
  if (existing) return existing.id;
  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name: labelName,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  });
  return created.data.id;
}

// ======================================================
// 本体ロジック (Firestore 書込あり、注入された db を使用)
// ======================================================

async function emailVerificationCore(db, opts = {}) {
  const { scopedBookingId = null, log = console, maxResultsPerAccount = 20 } = opts;
  const admin = require("firebase-admin");
  const result = { processedCount: 0, newlySaved: 0, skipped: 0, errors: [] };

  // 1. アクティブ物件の verificationEmails[] を全部集める
  const propsSnap = await db.collection("properties").where("active", "==", true).get();
  const verificationTargets = [];
  for (const p of propsSnap.docs) {
    const veList = Array.isArray(p.data().verificationEmails) ? p.data().verificationEmails : [];
    for (const ve of veList) {
      if (ve && ve.email) {
        verificationTargets.push({
          propertyId: p.id,
          platform: ve.platform || "Unknown",
          email: ve.email,
        });
      }
    }
  }
  if (verificationTargets.length === 0) {
    log.info && log.info("[emailVerification] 巡回対象メアド 0 件 (物件に verificationEmails 未登録)");
    return result;
  }

  // 2. OAuth クライアント設定 (clientId/secret は既存税理士資料と共用)
  const oauthDoc = await db.collection("settings").doc("gmailOAuth").get();
  if (!oauthDoc.exists) {
    result.errors.push("OAuth client config not found (settings/gmailOAuth)");
    return result;
  }
  const { clientId, clientSecret } = oauthDoc.data();
  if (!clientId || !clientSecret) {
    result.errors.push("OAuth clientId/clientSecret missing in settings/gmailOAuth");
    return result;
  }

  // 3. context=emailVerification のトークンを取得
  const tokensSnap = await db.collection("settings")
    .doc("gmailOAuthEmailVerification").collection("tokens").get();
  if (tokensSnap.empty) {
    log.info && log.info("[emailVerification] 認証済 Gmail なし (context=emailVerification)");
    return result;
  }

  // 4. アカウントごとに巡回
  const uniqueEmails = [...new Set(verificationTargets.map((t) => t.email))];
  for (const tokenDoc of tokensSnap.docs) {
    const tokenData = tokenDoc.data();
    if (!tokenData.refreshToken) continue;
    try {
      const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
      oauth2Client.setCredentials({ refresh_token: tokenData.refreshToken });
      const gmail = google.gmail({ version: "v1", auth: oauth2Client });

      const labelId = await ensureProcessedLabel(gmail);
      const query = buildGmailQuery(uniqueEmails, labelId);
      if (!query) continue;

      const listRes = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: maxResultsPerAccount,
      });
      const messages = listRes.data.messages || [];

      for (const msg of messages) {
        try {
          // 重複ガード: emailVerifications/{messageId} が既にあればスキップ
          const evRef = db.collection("emailVerifications").doc(msg.id);
          const existing = await evRef.get();
          if (existing.exists) {
            result.skipped++;
            continue;
          }

          // 詳細取得
          const detail = await gmail.users.messages.get({
            userId: "me",
            id: msg.id,
            format: "full",
          });

          const headers = (detail.data.payload && detail.data.payload.headers) || [];
          const subject = getHeader(headers, "Subject") || "";
          const fromHeader = getHeader(headers, "From") || "";
          const toHeader = getHeader(headers, "To") || getHeader(headers, "Delivered-To") || "";
          const dateHeader = getHeader(headers, "Date") || "";
          const bodyText = extractBody(detail.data.payload, true);
          const bodyHtml = extractBody(detail.data.payload, false);
          const matched = matchVerificationTarget(toHeader, verificationTargets);

          await evRef.set({
            messageId: msg.id,
            threadId: detail.data.threadId || null,
            gmailAccount: tokenData.email || null,
            propertyId: matched ? matched.propertyId : null,
            platform: matched ? matched.platform : guessPlatform(fromHeader),
            subject,
            fromHeader,
            toHeader,
            dateHeader,
            receivedAt: detail.data.internalDate
              ? admin.firestore.Timestamp.fromMillis(parseInt(detail.data.internalDate, 10))
              : null,
            rawBodyText: bodyText.slice(0, 50000),   // 50KB 上限
            rawBodyHtml: bodyHtml.slice(0, 100000),  // 100KB 上限
            // Step 3 以降で埋める
            extractedInfo: null,
            matchStatus: "pending",    // pending | matched | unmatched | cancelled | changed
            matchedBookingId: null,
            // 起動元情報 (デバッグ用)
            triggeredBy: scopedBookingId
              ? { kind: "booking", bookingId: scopedBookingId }
              : { kind: "schedule" },
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          // 処理済ラベル付与
          await gmail.users.messages.modify({
            userId: "me",
            id: msg.id,
            requestBody: { addLabelIds: [labelId] },
          });

          result.newlySaved++;
          result.processedCount++;
        } catch (e) {
          result.errors.push(`message ${msg.id}: ${e.message}`);
        }
      }
    } catch (e) {
      result.errors.push(`account ${tokenData.email || "unknown"}: ${e.message}`);
    }
  }
  return result;
}

// ======================================================
// Scheduled Export (10 分おき)
// ======================================================

const scheduled = onSchedule(
  {
    schedule: "every 10 minutes",
    region: "asia-northeast1",
    timeZone: "Asia/Tokyo",
    concurrency: 1, // 重複実行防止
  },
  async (_event) => {
    const admin = require("firebase-admin");
    const res = await emailVerificationCore(admin.firestore(), { log: console });
    console.log("[scheduledEmailVerification]", JSON.stringify(res));
  }
);

module.exports = {
  scheduled,
  emailVerificationCore,
  // テスト用: 純粋関数群
  _pure: {
    buildGmailQuery,
    getHeader,
    extractBody,
    guessPlatform,
    matchVerificationTarget,
  },
  _constants: {
    PROCESSED_LABEL_NAME,
    KNOWN_OTA_SENDERS,
  },
};
