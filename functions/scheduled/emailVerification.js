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
  isChangeNotifyKind,
  buildChangeEmailNotification,
} = require("../utils/emailMatcher");
const { recordParseError, checkThresholdsAndNotify } = require("../utils/parseErrors");
const { updateSyncHealth } = require("../utils/syncHealth");

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
//
// 複数物件で同じメアドを共有している場合 (例: 81hassac@gmail.com を the Terrace と YADO KOMACHI 両方で使用) は、
//   1. fromPlatform が指定されていれば platform 一致で絞り込み
//   2. それでも複数残るなら null を返す (呼出側でオーナー全物件横断検索にフォールバック)
//
// これにより「最初の物件に誤って固定する」バグを防ぐ。
function matchVerificationTarget(toHeader, verificationTargets, fromPlatform) {
  if (!Array.isArray(verificationTargets)) return null;
  const s = String(toHeader || "").toLowerCase();
  let matched = verificationTargets.filter((t) => t && s.includes(String(t.email || "").toLowerCase()));
  if (matched.length === 0) return null;
  if (matched.length > 1 && fromPlatform && fromPlatform !== "Unknown") {
    const filteredByPlatform = matched.filter((t) => t.platform === fromPlatform);
    if (filteredByPlatform.length > 0) matched = filteredByPlatform;
  }
  if (matched.length === 1) return matched[0];
  // 複数残った (= 共用メアド + 同 platform 複数物件) → 物件特定不能、null で全物件横断
  return null;
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

  // 1. アクティブ物件の verificationEmails[] を全部集める (ownerId も保持)
  const propsSnap = await db.collection("properties").where("active", "==", true).get();
  const verificationTargets = [];
  // 物件名 → propertyId マップ (本文中の物件名で propertyId を推定するフォールバック用)
  // key: 物件名の正規化文字列 (半角スペース除去・小文字), value: propertyId
  const propertyNameMap = {};
  for (const p of propsSnap.docs) {
    const pData = p.data();
    const veList = Array.isArray(pData.verificationEmails) ? pData.verificationEmails : [];
    for (const ve of veList) {
      if (ve && ve.email) {
        verificationTargets.push({
          propertyId: p.id,
          propertyName: pData.name || "",
          ownerId: pData.ownerId || "",  // サブオーナー対応スコープ用
          platform: ve.platform || "Unknown",
          email: ve.email,
        });
      }
    }
    // 物件名マップ登録 (verificationEmails 未登録物件も含む)
    if (pData.name) {
      propertyNameMap[pData.name] = p.id;
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
  // サブオーナー対応: 各トークンの ownerId に紐づく物件 (verificationTargets) のみを処理対象にする
  // - tokenData.ownerId が無いトークンは「未帰属」として警告ログのみ (照合スキップ)
  // - サブオーナーの Gmail でメインオーナー物件のメールを処理しない / 逆も
  for (const tokenDoc of tokensSnap.docs) {
    const tokenData = tokenDoc.data();
    if (!tokenData.refreshToken) continue;
    const tokenOwnerId = tokenData.ownerId || "";
    if (!tokenOwnerId) {
      log.warn && log.warn(`[emailVerification] token.ownerId 未設定のためスキップ: ${tokenData.email || tokenDoc.id}`);
      result.skipped++;
      continue;
    }
    // 巡回統計 (このトークン分のみ) — 終了時に lastScanResult として書き戻す
    const perToken = { processed: 0, matched: 0, newlySaved: 0, skipped: 0, errors: 0 };

    // このトークンのオーナーが所有する verificationTargets だけに絞る
    const myTargets = verificationTargets.filter((t) => t.ownerId === tokenOwnerId);
    if (myTargets.length === 0) {
      log.info && log.info(`[emailVerification] owner=${tokenOwnerId} に紐づく verificationEmails 無し (${tokenData.email})`);
      continue;
    }
    const myUniqueEmails = [...new Set(myTargets.map((t) => t.email))];

    try {
      const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
      oauth2Client.setCredentials({ refresh_token: tokenData.refreshToken });
      const gmail = google.gmail({ version: "v1", auth: oauth2Client });

      // ラベル機能は gmail.modify スコープが必要なため使用しない。
      // 重複処理は emailVerifications/{messageId} のドキュメント存在チェックで防ぐ。
      const query = buildGmailQuery(myUniqueEmails, null);
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
            perToken.skipped++;
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
          // platform は from ヘッダから判定する (verificationTargets に同じメアドを
          // 複数 platform で登録した場合でも正しく識別するため)
          const platformFromSender = guessPlatform(fromHeader);
          // myTargets のみで照合 (他オーナーの物件メアドにヒットさせない)
          // 同一メアドが複数物件で共用されている場合、platform 一致で絞れなければ null
          //   → 下流の findBookingMatch がオーナー全物件 bookings から reservationCode で特定する
          const matched = matchVerificationTarget(toHeader, myTargets, platformFromSender);
          // propertyId 推定: To ヘッダで特定できない場合は本文・件名に含まれる物件名で補完
          let propertyId = matched ? matched.propertyId : null;
          if (!propertyId) {
            const searchText = (subject + " " + bodyText + " " + bodyHtml).toLowerCase();
            for (const [propName, propId] of Object.entries(propertyNameMap)) {
              // このオーナーの物件のみ対象 (myTargets に含まれる propertyId のみ許可)
              const isMyProp = myTargets.some((t) => t.propertyId === propId);
              if (!isMyProp) continue;
              if (propName && searchText.includes(propName.toLowerCase())) {
                propertyId = propId;
                log.info && log.info(`[emailVerification] 物件名マッチで propertyId 補完: "${propName}" → ${propId} (msg=${msg.id})`);
                break;
              }
            }
          }
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
          // confirmed の pendingApproval/unverified 降下を bookingPatch にまとめたか
          let confirmedResolveMerged = false;
          // 別予約への差し替えを検知した予約 (ループ後にオーナー通知する)
          let replacedBooking = null;
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
            // DLQ 記録 (本処理は止めない)
            await recordParseError(db, {
              messageId: msg.id,
              ota: platform === "Airbnb" ? "airbnb" : (platform === "Booking.com" ? "booking" : "unknown"),
              errorType: "parse_failed",
              subject, from: fromHeader,
              receivedAt,
              rawSnippet: bodyText || bodyHtml,
              reason: pe.message,
            });
          }

          if (extractedInfo && extractedInfo.reservationCode) {
            // 関連する bookings を取得 (propertyId でスコープできればそれで絞る)
            // サブオーナー対応: propertyId 不明時も「このオーナーの物件」に限定して横断
            try {
              let bookingsArr = [];
              if (propertyId) {
                const snap = await db.collection("bookings")
                  .where("propertyId", "==", propertyId).limit(500).get();
                bookingsArr = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
              } else {
                // 共用メアド等 To ヘッダで物件特定できなかった場合: このオーナーの全物件 bookings から探す
                const myPropertyIds = myTargets.map((t) => t.propertyId);
                const uniquePids = [...new Set(myPropertyIds)];
                // Firestore "in" は 30 件まで。それを超える場合は分割クエリ
                const chunks = [];
                for (let i = 0; i < uniquePids.length; i += 30) chunks.push(uniquePids.slice(i, i + 30));
                for (const chunk of chunks) {
                  if (chunk.length === 0) continue;
                  const snap = await db.collection("bookings")
                    .where("propertyId", "in", chunk).limit(500).get();
                  bookingsArr.push(...snap.docs.map((d) => ({ id: d.id, data: d.data() })));
                }
              }
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
                    } else if (v && typeof v === "object" && v.__placeholder === "delete") {
                      bookingPatch[k] = admin.firestore.FieldValue.delete();
                    } else if (v !== undefined) {
                      bookingPatch[k] = v;
                    }
                  }
                  bookingPatch.emailMatchedBy = "auto"; // 自動マッチマーク

                  // confirmed の pendingApproval/unverified 降下を同じ update にまとめる。
                  // (別 update に分けると bookings への書き込みが 1 通のメールで 2 回になり、
                  //  onBookingChange が並列発火して募集が重複生成される。2026-08-12 の事故要因)
                  let mergedResolve = false;
                  if (extractedInfo && extractedInfo.kind === "confirmed") {
                    Object.assign(bookingPatch, buildConfirmedResolvePatch_(bookingMatch.data));
                    mergedResolve = true;
                  }

                  await db.collection("bookings").doc(bookingMatch.id).update(bookingPatch);
                  // ★update が成功してから統合済みフラグを立てる。
                  //   先に立てると、update が失敗したときに後段のフォールバックも
                  //   スキップされ、承認待ちのまま募集が生成されない状態で固定される。
                  confirmedResolveMerged = mergedResolve;
                  bookingUpdates = Object.keys(bookingPatch);
                  if (bookingPatch.guestInfoStale === true) {
                    replacedBooking = { id: bookingMatch.id, data: bookingMatch.data, updates: decision.updates };
                  }
                } else if (decision && decision.skippedReason) {
                  console.log(`[bookingUpdate skipped] msg=${msg.id} booking=${bookingMatch.id}: ${decision.skippedReason}`);
                }
              } else if (bookingMatch && bookingMatch.matchReason === "ambiguous-dateAndPlatform") {
                console.log(`[bookingUpdate skipped] msg=${msg.id} ambiguous candidates: ${(bookingMatch.candidateIds || []).join(", ")}`);
                // 曖昧候補多数 = OTA メール書式変更でスコアリング崩れている可能性 → DLQ に記録
                await recordParseError(db, {
                  messageId: msg.id,
                  ota: platform === "Airbnb" ? "airbnb" : (platform === "Booking.com" ? "booking" : "unknown"),
                  errorType: "schema_changed",
                  subject, from: fromHeader,
                  receivedAt,
                  rawSnippet: bodyText || bodyHtml,
                  reason: `ambiguous candidates: ${(bookingMatch.candidateIds || []).join(", ")}`,
                });
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

          // reservationCode が抽出できないままの unmatched 系 → DLQ に "unmatched" として記録
          // (reservationCode あり + bookings 不在のメール先行ケースは再評価でカバーされるため記録しない)
          if ((matchStatus === "unmatched" || matchStatus === "cancelled-unmatched")
              && (!extractedInfo || !extractedInfo.reservationCode)) {
            await recordParseError(db, {
              messageId: msg.id,
              ota: platform === "Airbnb" ? "airbnb" : (platform === "Booking.com" ? "booking" : "unknown"),
              errorType: "unmatched",
              subject, from: fromHeader,
              receivedAt,
              rawSnippet: bodyText || bodyHtml,
              reason: `matchStatus=${matchStatus}, reservationCode=null (パース成功だがコード未抽出)`,
            });
          }

          // propertyId 補正: bookingMatch で booking が確定した場合は、
          // 共用メアド由来で propertyId=null になっていても booking の propertyId に揃える
          const finalPropertyId = (bookingMatch && bookingMatch.id && bookingMatch.data && bookingMatch.data.propertyId)
            || propertyId;

          await evRef.set({
            messageId: msg.id,
            threadId: detail.data.threadId || null,
            gmailAccount: tokenData.email || null,
            propertyId: finalPropertyId,
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

          // ===== 保留中→確定 連動: bookings.pendingApproval / unverified を false に降ろす =====
          // confirmed メール受信で対応 booking が見つかれば、pendingApproval=false + unverified=false に更新
          // → onBookingChange が更新イベントで再発火し、募集生成が走る
          // → unverified=false で UI 上の「未照合」表示が消える
          if (extractedInfo && extractedInfo.kind === "confirmed" && bookingMatch && bookingMatch.id
              && !confirmedResolveMerged) {
            try {
              const resolvePatch = buildConfirmedResolvePatch_(bookingMatch.data);
              if (Object.keys(resolvePatch).length > 0) {
                await db.collection("bookings").doc(bookingMatch.id).update(resolvePatch);
                console.log(`[emailVerification] pendingApproval/unverified=false に降下 (confirmed): booking=${bookingMatch.id}`);
              }
            } catch (e) {
              console.error(`[emailVerification] pendingApproval/unverified 降下エラー:`, e.message);
            }
          }

          // ===== 別予約への差し替え検知 → オーナー通知 =====
          // キャンセル→同日程で別予約番号の再予約が同一 booking に着地したケース。
          // Booking.com の確定メールには人数・氏名が載らないため機械的に直せない。
          // 気づけないまま古い人数で清掃準備が進むのを防ぐため必ず知らせる。
          if (replacedBooking) {
            await notifyBookingReplaced_(db, replacedBooking, extractedInfo, evRef, msg.id);
          }

          // ===== 保留中メール検出時: bookings.pendingApproval=true をセット =====
          // pending_request メールが届いて対応 booking がある場合、フラグを立てて募集生成をブロック
          if (matchStatus === "pending_request" && bookingMatch && bookingMatch.id) {
            try {
              await db.collection("bookings").doc(bookingMatch.id).update({
                pendingApproval: true,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
              console.log(`[emailVerification] pendingApproval=true をセット: booking=${bookingMatch.id}`);
            } catch (e) {
              console.error(`[emailVerification] pendingApproval セットエラー:`, e.message);
            }
          }

          // ===== Airbnb 変更メール検知時の即時通知 =====
          // change-approved (予約変更が承認された) / change-request (ゲストから変更希望)
          // を検知したら、オーナー宛てに通知1発。名簿との人数食い違いがあれば本文に併記。
          // 冪等: emailVerifications/{messageId}.notifiedAt が set 直後に付いたら再送しない
          if (extractedInfo && isChangeNotifyKind(extractedInfo.kind)) {
            try {
              await notifyBookingChangeEmail_(db, {
                messageId: msg.id,
                evRef,
                parsedInfo: extractedInfo,
                bookingMatch,
                propertyId: finalPropertyId,
                log,
              });
            } catch (nerr) {
              console.error(`[emailVerification] booking_change_email 通知エラー: ${nerr.message}`);
            }
          }

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
          perToken.processed++;
          perToken.newlySaved++;
          if (bookingMatch) {
            result.matchedCount = (result.matchedCount || 0) + 1;
            perToken.matched++;
          }
        } catch (e) {
          result.errors.push(`message ${msg.id}: ${e.message}`);
          perToken.errors++;
        }
      }
    } catch (e) {
      result.errors.push(`account ${tokenData.email || "unknown"}: ${e.message}`);
      perToken.errors++;
      // OAuth トークン失効 (invalid_grant) を検知 → 失効フラグを立てる (通知は常駐の差分検知が出す)
      // メール照合機能の停止に気付かず数日経過すると、キャンセル/確定メールが取り込まれず
      // カレンダー/通知が壊れる事故になるため、10分毎のこの巡回で即座にフラグを立てる
      if (/invalid_grant/i.test(String(e.message || ""))) {
        try {
          await flagOAuthFailure_(db, tokenData.email || tokenDoc.id, e.message);
        } catch (nerr) {
          console.error("[emailVerification] flagOAuthFailure_ error:", nerr.message);
        }
      }
    }

    // 巡回結果をトークンドキュメントに記録 (UI 表示用 lastScannedAt / lastScanResult)
    try {
      const summary = `${perToken.processed}件処理 / ${perToken.matched}件マッチ / ${perToken.skipped}件既存`
        + (perToken.errors ? ` / ${perToken.errors}件エラー` : "");
      await tokenDoc.ref.update({
        lastScannedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastScanResult: summary,
        lastScanCounts: perToken,
      });
    } catch (we) {
      console.error("[emailVerification] lastScannedAt 書込失敗:", we.message);
    }
  }
  // ===== 巡回終了処理: 閾値判定 + syncHealth =====
  try {
    await checkThresholdsAndNotify(db);
  } catch (e) {
    console.error("[emailVerification] checkThresholdsAndNotify エラー (握り潰し):", e.message);
  }

  const allOk = result.errors.length === 0;
  await updateSyncHealth(db, "emailVerification", {
    ok: allOk,
    error: allOk ? undefined : result.errors.slice(0, 3).join(" | "),
  });

  return result;
}

/**
 * confirmed メール受信時に降ろすフラグのパッチを組み立てる
 * (bookingPatch へマージして 1 回の update で済ませ、onBookingChange の多重発火を減らす)
 */
function buildConfirmedResolvePatch_(bookingData) {
  const admin = require("firebase-admin");
  const b = bookingData || {};
  const patch = {};
  if (b.pendingApproval === true) {
    patch.pendingApproval = false;
    patch.pendingApprovalResolvedAt = admin.firestore.FieldValue.serverTimestamp();
  }
  if (b.unverified === true) {
    patch.unverified = false;
    patch.unverifiedResolvedAt = admin.firestore.FieldValue.serverTimestamp();
  }
  if (Object.keys(patch).length > 0) {
    patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  }
  return patch;
}

/**
 * 予約が別予約に差し替わったことをオーナーへ通知
 * (キャンセル → 同日程で別予約番号の再予約が同一 booking ドキュメントに着地したケース)
 *
 * 冪等・再試行:
 *   - emailVerifications/{messageId}.replacedNotifiedAt があれば送らない (並列実行時の二重通知を防ぐ)
 *   - 送信に失敗したら error_logs に残す (onErrorLogCreated がオーナーへ知らせる)。
 *     処理済みガードで次回スキップされるため、握り潰すと「必ず知らせる」が破れる
 */
async function notifyBookingReplaced_(db, replaced, parsedInfo, evRef, messageId) {
  const admin = require("firebase-admin");
  const { notifyByKey } = require("../utils/lineNotify");
  const b = replaced.data || {};

  // ★冪等ガードは create() の原子性で取る。
  //   evRef を read→write する方式だと (a) 並列実行が両方とも「未通知」と読んで二重送信し、
  //   (b) 後続の evRef.set() (マージ無し) がマークを上書きしてしまう。
  //   専用の claim ドキュメントなら create() が ALREADY_EXISTS で確実に1回に絞れる。
  //   claim の status は結果の記録用 ("sending" → "sent"/"failed")。
  //   claim 作成後・送信前にプロセスが落ちると、この通知は送られないまま終わる。
  //   ただし差し替えの事実は booking の guestInfoStale / guestInfoStaleReason として
  //   永続化されており、通知はあくまで気づきを早めるための二次的な手段である。
  //   (メールは emailVerifications の存在で処理済み判定されるため、そもそも
  //    通知だけを後から再送する経路は存在しない。無理に再送機構を足すより
  //    失敗を error_logs で人に上げるほうが確実)
  const claimRef = db.collection("notifyClaims").doc(`booking_replaced__${messageId || replaced.id}`);
  try {
    await claimRef.create({
      kind: "booking_replaced",
      status: "sending",
      messageId: messageId || null,
      bookingId: replaced.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(String(e.message || "")))) {
      console.log(`[emailVerification] 差し替え通知は送信済/送信中 msg=${messageId}`);
      return;
    }
    // claim を作れない = Firestore 異常。通知を止めるより送る側に倒す(重複のほうが軽い)
    console.error(`[emailVerification] 差し替え通知の claim 作成失敗 (続行):`, e.message);
  }

  const propertyName = b.propertyName || "";
  const newCode = (parsedInfo && parsedInfo.reservationCode) || "";
  const reason = (replaced.updates && replaced.updates.guestInfoStaleReason) || "";

  const body = [
    "🔁 予約が別予約に差し替わりました",
    "",
    `物件: ${propertyName || "(不明)"}`,
    `日程: ${b.checkIn || "?"} 〜 ${b.checkOut || "?"}`,
    `新しい予約番号: ${newCode || "(不明)"}`,
    `表示中のゲスト名: ${b.guestName || "(不明)"}`,
    `表示中の人数: ${b.guestCount != null ? `${b.guestCount}人` : "(未設定)"}`,
    "",
    `理由: ${reason}`,
    "",
    "⚠️ ゲスト名・人数は前の予約のものが残っている可能性があります。",
    "→ OTAの管理画面で実際の人数を確認し、予約詳細から修正してください。",
  ].join("\n");

  // ★notifyByKey はチャネル送信失敗を throw せず { sent, errors } で返すため、
  //   戻り値の errors を見ないと「失敗したのに成功扱い」になる。
  // ★リトライはしない。notifyByKey はチャネル単位の部分失敗でも全体を再送するため、
  //   再試行すると成功済みチャネルへ二重送信になる。失敗は error_logs で人に上げる。
  let lastErr = null;
  let sentSummary = "";
  try {
    const res = await notifyByKey(db, "booking_change", {
      title: `🔁 予約差し替え: ${propertyName || b.checkIn || ""}`,
      body,
      vars: {
        property: propertyName,
        checkin: b.checkIn || "",
        date: b.checkOut || "",
        guest: b.guestName || "",
        code: newCode,
      },
      propertyId: b.propertyId || null,
    });
    const errs = (res && Array.isArray(res.errors)) ? res.errors : [];
    const sent = (res && res.sent) || {};
    sentSummary = JSON.stringify(sent);
    if (errs.length > 0) {
      lastErr = new Error(errs.map((x) => (x && (x.error || x.message)) || String(x)).join(" / "));
      console.error(`[emailVerification] 差し替え通知が一部/全部失敗:`, lastErr.message);
    } else {
      // errors が空でも「どのチャネルにも出ていない」ことがある
      // (通知キーが無効 / 宛先0件)。無効設定なら正常なので警告に留める。
      if (!res || !res.queued) {
        const anySent = Object.values(sent).some((v) => v === true || (typeof v === "number" && v > 0));
        if (!anySent) {
          console.warn(`[emailVerification] 差し替え通知はどのチャネルにも送られませんでした ` +
            `(booking_change が無効か宛先0件の可能性) booking=${replaced.id} sent=${sentSummary}`);
        }
      }
      console.log(`[emailVerification] 予約差し替えを通知: booking=${replaced.id} newCode=${newCode} sent=${sentSummary}`);
      try { await claimRef.update({ status: "sent", sentAt: admin.firestore.FieldValue.serverTimestamp() }); } catch (_e) { /* noop */ }
      if (evRef) {
        try {
          await evRef.update({ replacedNotifiedAt: admin.firestore.FieldValue.serverTimestamp() });
        } catch (_e) { /* マーク失敗は通知済みの事実を変えない */ }
      }
      return;
    }
  } catch (e) {
    lastErr = e;
    console.error(`[emailVerification] 差し替え通知エラー:`, e.message);
  }

  // 送れなかった → 握り潰すと処理済みガードで二度と通知されないので error_logs に残す。
  // ★フィールド名は onErrorLogCreated が読む functionName / errorMessage に合わせる
  //   (source/message だと通知本文が「関数: 不明 / 原因: 不明なエラー」になる)
  try { await claimRef.update({ status: "failed", failedAt: admin.firestore.FieldValue.serverTimestamp() }); } catch (_e) { /* noop */ }
  try {
    await db.collection("error_logs").add({
      functionName: "emailVerification.notifyBookingReplaced_",
      errorMessage: `予約差し替え通知の送信に失敗: booking=${replaced.id} newCode=${newCode} — ${lastErr && lastErr.message}`,
      severity: "error",
      stack: body,
      propertyId: b.propertyId || null,
      messageId: messageId || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error(`[emailVerification] error_logs 記録も失敗:`, e.message);
  }
}

/**
 * Airbnb 変更メール検知時にオーナー宛て通知を発火
 *   - 冪等: emailVerifications/{messageId}.notifiedAt が既に set されていたらスキップ
 *   - 本文: bookings 現況 + 名簿(guestRegistrations) 現況 + 食い違い警告
 *   - 通知キー: "booking_change_email"
 */
async function notifyBookingChangeEmail_(db, opts) {
  const admin = require("firebase-admin");
  const { notifyByKey } = require("../utils/lineNotify");
  const { messageId, evRef, parsedInfo, bookingMatch, propertyId, log } = opts;

  // 冪等ガード: 保存直後の同じドキュメントを読み、notifiedAt があれば既に通知済み
  try {
    const cur = await evRef.get();
    if (cur.exists && cur.data().notifiedAt) {
      log && log.info && log.info(`[booking_change_email] 既に通知済 msg=${messageId}`);
      return;
    }
  } catch (_e) { /* 読み取り失敗は続行 */ }

  // 現況取得: booking と 名簿
  let bookingData = null;
  let bookingId = null;
  let propertyName = "";
  const rosterDocs = [];

  if (bookingMatch && bookingMatch.id && bookingMatch.data) {
    bookingId = bookingMatch.id;
    bookingData = bookingMatch.data;
    propertyName = bookingData.propertyName || "";
  }

  // 物件名の補完
  if (!propertyName && propertyId) {
    try {
      const pDoc = await db.collection("properties").doc(propertyId).get();
      if (pDoc.exists) propertyName = pDoc.data().name || "";
    } catch (_e) { /* 握り潰し */ }
  }

  // 名簿取得: booking にリンクされた guestRegistrations を集める
  if (bookingId) {
    try {
      const grSnap = await db.collection("guestRegistrations")
        .where("bookingId", "==", bookingId).get();
      for (const g of grSnap.docs) rosterDocs.push(g.data());
    } catch (_e) { /* 握り潰し */ }
  }

  const notif = buildChangeEmailNotification(parsedInfo, bookingData, rosterDocs, {
    propertyName,
  });

  await notifyByKey(db, "booking_change_email", {
    title: notif.title,
    body: notif.body,
    vars: notif.vars,
    propertyId: propertyId || null,
  });

  // 冪等マーク
  try {
    await evRef.update({
      notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      notifiedKind: parsedInfo.kind || null,
      notifiedMismatch: notif.hasMismatch === true,
    });
  } catch (e) {
    console.error(`[booking_change_email] notifiedAt update 失敗: msg=${messageId}: ${e.message}`);
  }
  console.log(`[booking_change_email] 通知送信: msg=${messageId} kind=${parsedInfo.kind} booking=${bookingId || "unmatched"} mismatch=${notif.hasMismatch}`);
}

/**
 * OAuth トークン失効を Firestore のフラグに記録する (Discordへは送らない)。
 *
 * 発報点は常駐の差分検知 (discord-secretary-resident.mjs が
 * settings/oauthAlerts/byAccount を30分毎に読み、新規失敗/復旧を1回だけ通知する) に一本化してある。
 * ここから直接 Discord に送っていた頃は、同じ失効1件に対して
 * 「メール照合 Gmail OAuth 失効」(この関数) + oauthReminder + 常駐 の3通が飛んでいた (2026-08-06)。
 *
 * ドキュメントIDは oauthReminder.js / gmail-auth.js と同じ `{context}_{accountKey}` 形式にする。
 * 旧実装は context 抜きの `{accountKey}` に書いていたため、誰も読まない孤児ドキュメントになっていて
 * 10分毎に失効を検知していながら常駐の通知には一切繋がっていなかった。
 */
async function flagOAuthFailure_(db, accountEmail, errorMessage) {
  const admin = require("firebase-admin");

  const accountKey = (accountEmail || "unknown").replace(/[@.]/g, "_");
  const flagRef = db.collection("settings").doc("oauthAlerts").collection("byAccount")
    .doc(`emailVerification_${accountKey}`);

  await flagRef.set({
    lastFailure: true,
    lastFailureMessage: errorMessage,
    lastErrorAt: admin.firestore.FieldValue.serverTimestamp(),
    accountEmail,
  }, { merge: true });
  console.log(`[flagOAuthFailure_] OAuth失効フラグを記録 (通知は常駐が担当): ${accountEmail}`);
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
    memory: "512MiB", // Gmail 本文バッファ + bookings 横断クエリで OOM リスク (2026-05-28)
  },
  async (_event) => {
    const admin = require("firebase-admin");
    const db = admin.firestore();
    const res = await emailVerificationCore(db, { log: console });
    console.log("[scheduledEmailVerification]", JSON.stringify(res));

    // 共用 Gmail 経由で propertyId=null のまま保存された未マッチを毎サイクル再評価
    try {
      const { reevaluateUnmatched } = require("../utils/reevaluateUnmatched");
      const gres = await reevaluateUnmatched(db, { scanGlobalUnmatched: true, log: console });
      console.log("[scheduledEmailVerification:global-rematch]", JSON.stringify(gres));
    } catch (e) {
      console.error("[scheduledEmailVerification:global-rematch] エラー (握り潰し):", e.message);
    }
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
