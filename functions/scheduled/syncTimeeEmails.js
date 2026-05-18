/**
 * Timee メール巡回 (supporter@timee.co.jp)
 *
 * 81hassac@gmail.com に届く Timee 通知メールを巡回し、
 * timeeMatches/{messageId} に保存 + 対応する recruitment に紐付け。
 *
 * 紐付けキー: 物件名 (Subject の【タイミー XXX】) + 清掃日 (本文の YYYY年MM月DD日)
 *           → recruitments where propertyId == X && checkoutDate == YYYY-MM-DD
 */
const { google } = require("googleapis");
const { parseTimeeEmail } = require("../utils/timeeParser");

// 対象 Gmail アカウント
const TARGET_EMAIL = "81hassac@gmail.com";
// 巡回対象期間
const SCAN_NEWER_THAN = "90d";
// 1 回の巡回で処理する最大件数
const MAX_RESULTS = 50;

function getHeader(headers, name) {
  if (!Array.isArray(headers)) return null;
  const lower = String(name).toLowerCase();
  const h = headers.find((x) => String(x.name || "").toLowerCase() === lower);
  return h ? h.value : null;
}

function extractBody(payload) {
  let found = "";
  function walk(part) {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body && part.body.data) {
      found = Buffer.from(part.body.data, "base64url").toString("utf-8");
      return;
    }
    if (Array.isArray(part.parts)) part.parts.forEach(walk);
  }
  walk(payload);
  return found;
}

/**
 * 物件名 (フリーテキスト) から propertyId を解決する。
 * 大小文字無視 + 全角半角差を許容して properties.name と部分一致で照合。
 */
function resolvePropertyId(propertiesArr, nameFromMail) {
  if (!nameFromMail) return null;
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");
  const target = norm(nameFromMail);
  // 完全一致優先
  let hit = propertiesArr.find((p) => norm(p.name) === target);
  if (hit) return hit.id;
  // 部分一致 (Timee 側の表記揺れを考慮)
  hit = propertiesArr.find((p) => norm(p.name).includes(target) || target.includes(norm(p.name)));
  return hit ? hit.id : null;
}

async function syncTimeeEmailsCore(db, opts = {}) {
  const { log = console } = opts;
  const admin = require("firebase-admin");

  const result = { processedCount: 0, newlySaved: 0, linkedCount: 0, skipped: 0, errors: [] };

  // 1) OAuth client
  const oauthDoc = await db.collection("settings").doc("gmailOAuth").get();
  if (!oauthDoc.exists) { result.errors.push("settings/gmailOAuth 未設定"); return result; }
  const { clientId, clientSecret } = oauthDoc.data() || {};
  if (!clientId || !clientSecret) { result.errors.push("OAuth clientId/secret 未設定"); return result; }

  // 2) 81hassac@gmail.com のトークン取得
  const tokensSnap = await db.collection("settings").doc("gmailOAuthEmailVerification").collection("tokens").get();
  let targetToken = null;
  tokensSnap.forEach((d) => {
    const x = d.data();
    if ((x.email || "").toLowerCase() === TARGET_EMAIL) targetToken = x;
  });
  if (!targetToken || !targetToken.refreshToken) {
    log.info && log.info(`[syncTimeeEmails] ${TARGET_EMAIL} のトークン未登録、スキップ`);
    return result;
  }

  // 3) 物件一覧 (propertyName → propertyId 解決用)
  const propsSnap = await db.collection("properties").get();
  const propertiesArr = propsSnap.docs.map((d) => ({ id: d.id, name: d.data().name || "" }));

  // 4) Gmail 接続
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: targetToken.refreshToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });

  // 5) Timee メール一覧取得
  const q = `from:supporter@timee.co.jp newer_than:${SCAN_NEWER_THAN}`;
  let pageToken = undefined;
  let processed = 0;
  do {
    const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 100, pageToken });
    const msgs = list.data.messages || [];
    for (const ref of msgs) {
      if (processed >= MAX_RESULTS) break;

      // 冪等性: 既に保存済みならスキップ
      const existing = await db.collection("timeeMatches").doc(ref.id).get();
      if (existing.exists) { result.skipped++; continue; }

      try {
        const detail = await gmail.users.messages.get({ userId: "me", id: ref.id, format: "full" });
        const headers = detail.data.payload.headers || [];
        const subject = getHeader(headers, "Subject") || "";
        const fromHeader = getHeader(headers, "From") || "";
        const dateHeader = getHeader(headers, "Date") || "";
        const internalMs = Number(detail.data.internalDate);
        const receivedAt = isNaN(internalMs)
          ? admin.firestore.Timestamp.now()
          : admin.firestore.Timestamp.fromMillis(internalMs);

        const body = extractBody(detail.data.payload);
        const parsed = parseTimeeEmail({ subject, body });

        // propertyId 解決
        const propertyId = resolvePropertyId(propertiesArr, parsed.propertyName);

        // recruitment 紐付け候補を引く (propertyId + workDate)
        let linkedRecruitmentId = null;
        if (propertyId && parsed.workDate) {
          const rSnap = await db.collection("recruitments")
            .where("propertyId", "==", propertyId)
            .where("checkoutDate", "==", parsed.workDate)
            .limit(2).get();
          if (rSnap.size === 1) {
            linkedRecruitmentId = rSnap.docs[0].id;
            result.linkedCount++;
          } else if (rSnap.size > 1) {
            // 複数候補 → workType=cleaning を優先
            const cleaning = rSnap.docs.find((d) => (d.data().workType || "cleaning") !== "pre_inspection");
            if (cleaning) {
              linkedRecruitmentId = cleaning.id;
              result.linkedCount++;
            }
          }
        }

        // 保存
        await db.collection("timeeMatches").doc(ref.id).set({
          messageId: ref.id,
          threadId: detail.data.threadId || null,
          subject,
          from: fromHeader,
          dateHeader,
          receivedAt,
          bodySnippet: (body || "").slice(0, 2000),
          eventType: parsed.eventType,
          propertyName: parsed.propertyName,
          propertyId: propertyId || null,
          workDate: parsed.workDate || null,
          workStartTime: parsed.workStartTime || null,
          workEndTime: parsed.workEndTime || null,
          jobTitle: parsed.jobTitle || null,
          workers: parsed.workers || [],
          offeringId: parsed.offeringId || null,
          capacity: parsed.capacity || null,
          linkedRecruitmentId,
          linkedAt: linkedRecruitmentId ? admin.firestore.FieldValue.serverTimestamp() : null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        result.newlySaved++;
        processed++;
        result.processedCount++;
      } catch (e) {
        result.errors.push(`${ref.id}: ${e.message}`);
        log.warn && log.warn(`[syncTimeeEmails] ${ref.id} 処理失敗: ${e.message}`);
      }
    }
    if (processed >= MAX_RESULTS) break;
    pageToken = list.data.nextPageToken;
  } while (pageToken);

  log.info && log.info(`[syncTimeeEmails] processed=${result.processedCount} saved=${result.newlySaved} linked=${result.linkedCount} skipped=${result.skipped}`);
  return result;
}

module.exports = syncTimeeEmailsCore;
