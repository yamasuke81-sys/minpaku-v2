/**
 * メール照合機能: OTA 予約確認メールを巡回し、emailVerifications/{messageId} に保存 +
 * bookings と突合して bookings を更新する。
 *
 * 実行方式 (3 経路で同じ core ロジックを呼ぶ):
 *   1. 定期実行:  onSchedule("every 10 minutes") → `scheduled`
 *   2. 予約作成即時: triggers/onBookingEmailCheck.js から呼出
 *   3. 手動トリガー: api/email-verification.js の POST /run から呼出
 *
 * Step 4 で以下を追加:
 *   - parseEmail() で構造化情報を抽出し extractedInfo に保存
 *   - emailMatcher.findBookingMatch() で対応 booking を特定
 *   - decideBookingUpdate() で bookings の更新オブジェクトを決定 (emailVerifiedAt,
 *     emailMessageId, guestName, guestCount, status=cancelled 等を保守的に)
 *   - matchStatus (matched / unmatched / cancelled / changed 等) を emailVerifications に記録
 */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { google } = require("googleapis");
const { parseEmail } = require("../utils/emailParser");
const {
  findBookingMatch,
  decideBookingUpdate,
  decideVerificationStatus,
  isPendingRequest,
} = require("../utils/emailMatcher");

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
  const result = {
    processedCount: 0,
    newlySaved: 0,
    matchedCount: 0,
    skipped: 0,
    errors: [],
  };

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

      // ラベル機能は gmail.modify スコープが必要なため使用しない。
      // 重複処理は emailVerifications/{messageId} のドキュメント存在チェックで防ぐ。
      const query = buildGmailQuery(uniqueEmails, null);
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
          const propertyId = matched ? matched.propertyId : null;
          // platform は from ヘッダから判定する (verificationTargets に同じメアドを
          // 複数 platform で登録した場合でも正しく識別するため)
          const platformFromSender = guessPlatform(fromHeader);
          const platform = platformFromSender !== "Unknown"
            ? platformFromSender
            : (matched && matched.platform) || "Unknown";
          const receivedAt = detail.data.internalDate
            ? admin.firestore.Timestamp.fromMillis(parseInt(detail.data.internalDate, 10))
            : null;

          // ===== Step 4: 本文パース + bookings 突合 =====
          let extractedInfo = null;
          let bookingMatch = null;
          let bookingUpdates = null;
          try {
            extractedInfo = parseEmail({
              subject,
              body: bodyText || bodyHtml,
              fromHeader,
              platform,
              receivedAt: receivedAt ? receivedAt.toDate() : new Date(),
            });
          } catch (pe) {
            result.errors.push(`parse ${msg.id}: ${pe.message}`);
          }

          if (extractedInfo && extractedInfo.reservationCode) {
            // 関連する bookings を取得 (propertyId でスコープできればそれで絞る)
            try {
              let bookingsQuery = db.collection("bookings");
              if (propertyId) {
                bookingsQuery = bookingsQuery.where("propertyId", "==", propertyId);
              }
              const bookingsSnap = await bookingsQuery.limit(500).get();
              const bookingsArr = bookingsSnap.docs.map((d) => ({ id: d.id, data: d.data() }));
              bookingMatch = findBookingMatch(bookingsArr, extractedInfo, propertyId);

              if (bookingMatch && bookingMatch.id) {
                const emailReceivedMs = receivedAt ? receivedAt.toMillis() : null;
                const threadId = detail.data.threadId || null;
                const decision = decideBookingUpdate(bookingMatch.data, extractedInfo, msg.id, emailReceivedMs, threadId, subject);
                if (decision && decision.updates) {
                  // placeholder を実 FieldValue に置換
                  const bookingPatch = {};
                  for (const k of Object.keys(decision.updates)) {
                    const v = decision.updates[k];
                    if (v && typeof v === "object" && v.__placeholder === "serverTimestamp") {
                      bookingPatch[k] = admin.firestore.FieldValue.serverTimestamp();
                    } else if (v && typeof v === "object" && v.__placeholder === "timestampFromMs") {
                      bookingPatch[k] = admin.firestore.Timestamp.fromMillis(v.ms);
                    } else if (v !== undefined) {
                      bookingPatch[k] = v;
                    }
                  }
                  bookingPatch.emailMatchedBy = "auto"; // 自動マッチマーク
                  await db.collection("bookings").doc(bookingMatch.id).update(bookingPatch);
                  bookingUpdates = Object.keys(bookingPatch);
                } else if (decision && decision.skippedReason) {
                  console.log(`[bookingUpdate skipped] msg=${msg.id} booking=${bookingMatch.id}: ${decision.skippedReason}`);
                }
              } else if (bookingMatch && bookingMatch.matchReason === "ambiguous-dateAndPlatform") {
                console.log(`[bookingUpdate skipped] msg=${msg.id} ambiguous candidates: ${(bookingMatch.candidateIds || []).join(", ")}`);
              }
            } catch (me) {
              result.errors.push(`match ${msg.id}: ${me.message}`);
            }
          }

          // extractedInfo に subject を補完して判定関数に渡す (案A/B の判定に使用)
          const parsedInfoWithSubject = extractedInfo
            ? { ...extractedInfo, subject }
            : null;
          const matchStatus = decideVerificationStatus(parsedInfoWithSubject, bookingMatch);

          await evRef.set({
            messageId: msg.id,
            threadId: detail.data.threadId || null,
            gmailAccount: tokenData.email || null,
            propertyId,
            platform,
            subject,
            fromHeader,
            toHeader,
            dateHeader,
            receivedAt,
            rawBodyText: bodyText.slice(0, 50000),   // 50KB 上限
            rawBodyHtml: bodyHtml.slice(0, 100000),  // 100KB 上限
            extractedInfo,
            matchStatus,
            matchedBookingId: bookingMatch ? bookingMatch.id : null,
            bookingUpdates, // デバッグ用: 上書きしたフィールド名配列
            triggeredBy: scopedBookingId
              ? { kind: "booking", bookingId: scopedBookingId }
              : { kind: "schedule" },
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          // 処理済マークは emailVerifications/{messageId} ドキュメント存在で判定するため
          // Gmail ラベル付与 (gmail.modify スコープ要) は行わない

          // ===== 案B: チェーン追跡 =====
          // 新しい confirmed メールが保存された場合、同じ物件+チェックイン日の
          // pending_request エントリを resolved_to_confirmed に更新
          const kindForChain = extractedInfo && extractedInfo.kind;
          const checkInDateForChain = extractedInfo && extractedInfo.checkIn && extractedInfo.checkIn.date;
          if (kindForChain === "confirmed" && propertyId && checkInDateForChain) {
            try {
              const pendingSnap = await db.collection("emailVerifications")
                .where("propertyId", "==", propertyId)
                .where("matchStatus", "==", "pending_request")
                .get();
              for (const pendingDoc of pendingSnap.docs) {
                const pendingData = pendingDoc.data();
                const pendingCheckIn = pendingData.extractedInfo && pendingData.extractedInfo.checkIn && pendingData.extractedInfo.checkIn.date;
                if (pendingCheckIn === checkInDateForChain) {
                  await db.collection("emailVerifications").doc(pendingDoc.id).update({
                    matchStatus: "resolved_to_confirmed",
                    resolvedByMessageId: msg.id,
                    resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
                  });
                  console.log(`[chainTrack] pending_request → resolved_to_confirmed: ${pendingDoc.id}`);
                }
              }
            } catch (chainErr) {
              console.error(`[chainTrack] エラー: ${chainErr.message}`);
            }
          }

          result.newlySaved++;
          result.processedCount++;
          if (bookingMatch) result.matchedCount = (result.matchedCount || 0) + 1;
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
