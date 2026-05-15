/**
 * unmatched な emailVerifications を再評価して bookings と突合する
 *
 * トリガー:
 *   (a) onBookingEmailCheck (新規 booking 作成時)
 *   (b) syncIcal (新規 confirmed 作成 or pendingApproval=true→false 降下時)
 *
 * 競合 (Race) 対策:
 *   - Firestore トランザクションで「matchStatus が unmatched のままか」を再確認
 *   - bookings 側の更新も同一トランザクション内で実施
 *   - 既存の最新勝ちガード (decideBookingUpdate) を継承
 *
 * 冪等性:
 *   - matchStatus !== "unmatched" のドキュメントはスキップ
 *   - 同一 messageId が複数回再評価されても結果は変わらない
 *
 * 無限ループ防止:
 *   - 再評価で matched 化したものは次回以降スキップされる (matchStatus が変わるため)
 *   - 呼出側 (onBookingEmailCheck) で booking.emailMatchedBy が既設定ならスキップ
 */
const { findBookingMatch, decideBookingUpdate } = require("./emailMatcher");

const SCAN_LIMIT = 50; // 1 回の再評価で見る unmatched 上限

/**
 * 再評価のメイン
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {Object} opts
 * @param {string} [opts.propertyId] - 物件スコープ
 * @param {string} [opts.bookingId]  - 特定 booking 起点 (ヒント、propertyId と併用可)
 * @param {boolean} [opts.scanGlobalUnmatched] - propertyId=null の未マッチを全 active 物件横断で再評価
 * @param {Console} [opts.log]
 * @returns {Promise<{ rematched: number, scanned: number, errors: string[] }>}
 */
async function reevaluateUnmatched(db, opts = {}) {
  const log = opts.log || console;
  const result = { rematched: 0, scanned: 0, errors: [] };

  // global モード: propertyId=null の未マッチ emailVerifications を全 active 物件横断で再評価
  if (opts.scanGlobalUnmatched) {
    return await reevaluateGlobalUnmatched_(db, log);
  }

  // スコープが何も無ければ何もしない (全件再評価は P2 の突合バッチで)
  if (!opts.propertyId && !opts.bookingId) {
    return result;
  }

  // propertyId が無く bookingId のみ指定された場合は、その booking から propertyId を解決
  let propertyId = opts.propertyId;
  if (!propertyId && opts.bookingId) {
    try {
      const bs = await db.collection("bookings").doc(opts.bookingId).get();
      if (bs.exists) propertyId = bs.data().propertyId || null;
    } catch (e) {
      result.errors.push(`booking lookup: ${e.message}`);
    }
  }
  if (!propertyId) return result;

  // 1. unmatched な emailVerifications を取得
  let unmatchedDocs = [];
  try {
    const snap = await db.collection("emailVerifications")
      .where("propertyId", "==", propertyId)
      .where("matchStatus", "==", "unmatched")
      .limit(SCAN_LIMIT)
      .get();
    unmatchedDocs = snap.docs;
  } catch (e) {
    result.errors.push(`unmatched query: ${e.message}`);
    return result;
  }
  result.scanned = unmatchedDocs.length;
  if (unmatchedDocs.length === 0) return result;

  // 2. propertyId スコープの bookings を一括取得 (再評価対象が複数あっても 1 クエリで済む)
  let bookingsArr = [];
  try {
    const bsnap = await db.collection("bookings")
      .where("propertyId", "==", propertyId)
      .limit(500)
      .get();
    bookingsArr = bsnap.docs.map((d) => ({ id: d.id, data: d.data() }));
  } catch (e) {
    result.errors.push(`bookings query: ${e.message}`);
    return result;
  }

  // 3. 各 unmatched について再突合 → トランザクションで matched 化
  for (const evDoc of unmatchedDocs) {
    try {
      const ev = evDoc.data();
      const extractedInfo = ev.extractedInfo;
      if (!extractedInfo) continue;

      const match = findBookingMatch(bookingsArr, extractedInfo, propertyId);
      if (!match || !match.id) continue;

      const ok = await applyRematchTransaction_(db, evDoc.ref, match.id, ev, extractedInfo);
      if (ok) {
        result.rematched++;
        log.log && log.log(`[reevaluateUnmatched] rematched: ev=${evDoc.id} → booking=${match.id}`);
      }
    } catch (e) {
      result.errors.push(`reevaluate ${evDoc.id}: ${e.message}`);
    }
  }

  return result;
}

/**
 * トランザクション本体: emailVerifications と bookings を原子的に更新
 *
 * @returns {Promise<boolean>} - 実際に更新したら true、ガードで弾かれたら false
 */
async function applyRematchTransaction_(db, evRef, bookingId, evDataAtScan, parsedInfo) {
  const admin = require("firebase-admin");
  const bookingRef = db.collection("bookings").doc(bookingId);

  return await db.runTransaction(async (tx) => {
    // ★ 競合再確認 1: emailVerifications の matchStatus が unmatched のままか
    const evSnap = await tx.get(evRef);
    if (!evSnap.exists) return false;
    const evNow = evSnap.data();
    if (evNow.matchStatus !== "unmatched") return false;

    // ★ 競合再確認 2: booking が存在するか
    const bookingSnap = await tx.get(bookingRef);
    if (!bookingSnap.exists) return false;
    const booking = bookingSnap.data();

    // ★ 既存の最新勝ちガード + manualOverride 保護を継承
    const emailReceivedMs = evDataAtScan.receivedAt && evDataAtScan.receivedAt.toMillis
      ? evDataAtScan.receivedAt.toMillis()
      : null;
    const decision = decideBookingUpdate(
      booking,
      parsedInfo,
      evDataAtScan.messageId || evRef.id,
      emailReceivedMs,
      evDataAtScan.threadId || null,
      evDataAtScan.subject || null
    );
    if (!decision || !decision.updates) return false;

    // placeholder を実 FieldValue に置換 (emailVerification.js と同じロジック)
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
    bookingPatch.emailMatchedBy = "reevaluate";

    // emailVerification.js と同等: confirmed 受信で pendingApproval / unverified を降下
    if (parsedInfo && parsedInfo.kind === "confirmed") {
      if (booking.pendingApproval === true) {
        bookingPatch.pendingApproval = false;
        bookingPatch.pendingApprovalResolvedAt = admin.firestore.FieldValue.serverTimestamp();
      }
      if (booking.unverified === true) {
        bookingPatch.unverified = false;
        bookingPatch.unverifiedResolvedAt = admin.firestore.FieldValue.serverTimestamp();
      }
    }

    tx.update(bookingRef, bookingPatch);
    tx.update(evRef, {
      matchStatus: "matched",
      matchedBookingId: bookingId,
      matchedAt: admin.firestore.FieldValue.serverTimestamp(),
      rematched: true,
    });
    return true;
  });
}

/**
 * global モード: propertyId=null の未マッチ emailVerifications を全 active 物件横断で再評価
 *
 * 用途: 共用 Gmail (例: 81hassac@gmail.com) で受信し、To ヘッダから物件特定できず
 *      propertyId=null で保存された emailVerifications を、
 *      active 物件全 bookings に対して再突合する。
 *
 * 冪等性: 既存トランザクション (matchStatus 再確認 + bookings 更新) を流用。
 * 互換: emailVerifications.matchStatus フィールドが無いドキュメントも、
 *       matchedBookingId が未設定なら再評価対象とする。
 */
async function reevaluateGlobalUnmatched_(db, log) {
  const result = { rematched: 0, scanned: 0, errors: [] };

  // 1. active 物件の bookings を chunk クエリで全取得
  let bookingsArr = [];
  try {
    const propsSnap = await db.collection("properties").where("active", "==", true).get();
    const propIds = propsSnap.docs.map((d) => d.id);
    for (let i = 0; i < propIds.length; i += 30) {
      const chunk = propIds.slice(i, i + 30);
      if (chunk.length === 0) continue;
      const bs = await db.collection("bookings").where("propertyId", "in", chunk).get();
      bookingsArr.push(...bs.docs.map((d) => ({ id: d.id, data: d.data() })));
    }
  } catch (e) {
    result.errors.push(`global bookings query: ${e.message}`);
    return result;
  }

  // 2. propertyId=null の emailVerifications を取得
  // matchStatus フィールドの有無に依らず matchedBookingId 単独でも判定するため、
  // ここでは propertyId=null のみで絞り込み、ループ内で「未マッチ」を再判定する
  let evDocs = [];
  try {
    const evSnap = await db.collection("emailVerifications")
      .where("propertyId", "==", null)
      .limit(SCAN_LIMIT)
      .get();
    evDocs = evSnap.docs;
  } catch (e) {
    result.errors.push(`global unmatched query: ${e.message}`);
    return result;
  }

  // 3. 各候補について再突合
  for (const evDoc of evDocs) {
    try {
      const ev = evDoc.data();
      // 既にマッチ済はスキップ (matchStatus / matchedBookingId 両対応)
      if (ev.matchedBookingId) continue;
      if (ev.matchStatus && ev.matchStatus !== "unmatched") continue;
      const ext = ev.extractedInfo;
      if (!ext) continue;
      result.scanned++;

      const match = findBookingMatch(bookingsArr, ext, null);
      if (!match || !match.id) continue;

      const ok = await applyGlobalRematchTransaction_(db, evDoc.ref, match, ev, ext);
      if (ok) {
        result.rematched++;
        log.log && log.log(`[reevaluateUnmatched-global] rematched: ev=${evDoc.id} → booking=${match.id} (${match.matchReason || "rematch"})`);
      }
    } catch (e) {
      result.errors.push(`global reevaluate ${evDoc.id}: ${e.message}`);
    }
  }

  log.log && log.log(`[reevaluateUnmatched-global] scanned=${result.scanned} rematched=${result.rematched}`);
  return result;
}

/**
 * global モード用トランザクション
 * - emailVerifications.matchStatus が無い場合も unmatched 扱いで進める
 * - emailVerifications.matchedBookingId が既設定なら競合とみなしスキップ
 * - booking 側の propertyId に揃えて emailVerifications.propertyId も補正する
 */
async function applyGlobalRematchTransaction_(db, evRef, match, evDataAtScan, parsedInfo) {
  const admin = require("firebase-admin");
  const bookingRef = db.collection("bookings").doc(match.id);

  return await db.runTransaction(async (tx) => {
    const evSnap = await tx.get(evRef);
    if (!evSnap.exists) return false;
    const evNow = evSnap.data();
    // 競合再確認: 既にマッチ済なら抜ける
    if (evNow.matchedBookingId) return false;
    if (evNow.matchStatus && evNow.matchStatus !== "unmatched") return false;

    const bookingSnap = await tx.get(bookingRef);
    if (!bookingSnap.exists) return false;
    const booking = bookingSnap.data();

    const emailReceivedMs = evDataAtScan.receivedAt && evDataAtScan.receivedAt.toMillis
      ? evDataAtScan.receivedAt.toMillis()
      : null;
    const decision = decideBookingUpdate(
      booking,
      parsedInfo,
      evDataAtScan.messageId || evRef.id,
      emailReceivedMs,
      evDataAtScan.threadId || null,
      evDataAtScan.subject || null
    );
    if (!decision || !decision.updates) return false;

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
    bookingPatch.emailMatchedBy = "auto-rematch-global";

    // emailVerification.js と同等: confirmed 受信で pendingApproval / unverified を降下
    // (これがないと縞々/未照合点線枠が残ったままになる)
    if (parsedInfo && parsedInfo.kind === "confirmed") {
      if (booking.pendingApproval === true) {
        bookingPatch.pendingApproval = false;
        bookingPatch.pendingApprovalResolvedAt = admin.firestore.FieldValue.serverTimestamp();
      }
      if (booking.unverified === true) {
        bookingPatch.unverified = false;
        bookingPatch.unverifiedResolvedAt = admin.firestore.FieldValue.serverTimestamp();
      }
    }

    tx.update(bookingRef, bookingPatch);
    tx.update(evRef, {
      matchStatus: "matched",
      matchedBookingId: match.id,
      // 共用メアド由来で null だった propertyId を booking 側に揃える
      propertyId: booking.propertyId || null,
      matchedAt: admin.firestore.FieldValue.serverTimestamp(),
      matchReason: match.matchReason || "rematch-global",
      rematched: true,
    });
    return true;
  });
}

module.exports = {
  reevaluateUnmatched,
  SCAN_LIMIT,
};
