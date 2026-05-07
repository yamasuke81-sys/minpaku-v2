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
 * @param {Console} [opts.log]
 * @returns {Promise<{ rematched: number, scanned: number, errors: string[] }>}
 */
async function reevaluateUnmatched(db, opts = {}) {
  const log = opts.log || console;
  const result = { rematched: 0, scanned: 0, errors: [] };

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

module.exports = {
  reevaluateUnmatched,
  SCAN_LIMIT,
};
