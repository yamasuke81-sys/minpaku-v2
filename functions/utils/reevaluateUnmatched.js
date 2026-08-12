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

// buildRematchPatch へ渡す FieldValue/Timestamp ラッパ (テストでは差し替え可能にするため注入する)
const FV_ = (admin) => ({
  serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
  timestampFromMillis: (ms) => admin.firestore.Timestamp.fromMillis(ms),
});

const SCAN_LIMIT = 50; // 1 回の再評価で見る unmatched 上限 (物件スコープ)
const GLOBAL_SCAN_LIMIT = 300; // global 再評価の上限。ノイズを ignored 化した上で本物の未照合を取りこぼさないよう広めに設定

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
    // decision.updates が null でも打ち切らない (buildRematchPatch のコメント参照)
    const bookingPatch = buildRematchPatch(booking, decision, parsedInfo, "reevaluate", FV_(admin));

    if (Object.keys(bookingPatch).length > 0) tx.update(bookingRef, bookingPatch);
    // booking 側に変更が無くても ev は matched にして未照合プールから外す
    // (でないと同じメールを毎サイクル拾い続け、本物の未照合が枠を食われる)
    tx.update(evRef, {
      matchStatus: "matched",
      matchedBookingId: bookingId,
      matchedAt: admin.firestore.FieldValue.serverTimestamp(),
      rematched: true,
      ...(decision && decision.skippedReason ? { rematchNote: decision.skippedReason } : {}),
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

  // 1. active 物件の bookings を chunk クエリで全取得 + 物件名→propertyId マップを構築
  let bookingsArr = [];
  const propertyNameMap = []; // [{ name, propertyId }] - subject から物件名を逆引きする用
  try {
    const propsSnap = await db.collection("properties").where("active", "==", true).get();
    const propIds = propsSnap.docs.map((d) => d.id);
    for (const p of propsSnap.docs) {
      const name = p.data()?.name || "";
      if (name) propertyNameMap.push({ name, propertyId: p.id });
    }
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

  // 2. 未照合(matchStatus=unmatched)の emailVerifications を直接取得する。
  // 以前は propertyId=null のみで limit 50 だったが、照合不能ノイズ(現 ignored)が
  // 大量に滞留すると 50 枠を食い潰し、本物の確定メールが永遠に再評価されない
  // (starvation)。matchStatus=unmatched に絞り、上限も広げて取りこぼしを防ぐ。
  // ノイズは decideVerificationStatus 側で ignored に終端化済みなので未照合プールに入らない。
  let evDocs = [];
  try {
    const evSnap = await db.collection("emailVerifications")
      .where("matchStatus", "==", "unmatched")
      .limit(GLOBAL_SCAN_LIMIT)
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

      // subject から物件名を逆引きして propertyId を推定 (新規取込ルートと同じ補完を再評価でも適用)
      // 例: subject="瀬戸内海ビュー大テラス｜...のご予約" → "the Terrace 長浜" を抽出して propertyId 復元
      // ※ Airbnb 等の subject は物件 listing 名なので properties.name と完全一致しない可能性あり。
      //   従って完全一致 + 部分一致 (4文字以上連続一致) で広めに判定
      let propertyIdHint = null;
      // 実フィールド名は rawBodyText / rawBodyHtml。以前 bodyText/bodyHtml を参照しており
      // 本文が常に空 → 物件名逆引きが空振りし propertyIdHint=null のまま横断誤照合の一因になっていた(2026-07-09修正)
      const haystack = `${ev.subject || ""} ${ev.rawBodyText || ev.bodyText || ""} ${ev.rawBodyHtml || ev.bodyHtml || ""}`;
      for (const { name, propertyId } of propertyNameMap) {
        if (!name) continue;
        if (haystack.includes(name)) { propertyIdHint = propertyId; break; }
        // 短い物件名は部分一致のみ。長い名前は 4文字以上の連続部分でも一致判定
        if (name.length >= 4) {
          for (let i = 0; i + 4 <= name.length; i++) {
            const sub = name.slice(i, i + 4);
            if (haystack.includes(sub)) { propertyIdHint = propertyId; break; }
          }
          if (propertyIdHint) break;
        }
      }

      const match = findBookingMatch(bookingsArr, ext, propertyIdHint);
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
    // decision.updates が null でも打ち切らない (buildRematchPatch のコメント参照)
    const bookingPatch = buildRematchPatch(booking, decision, parsedInfo, "auto-rematch-global", FV_(admin));

    if (Object.keys(bookingPatch).length > 0) tx.update(bookingRef, bookingPatch);
    // booking 側に変更が無くても ev は matched にして未照合プールから外す
    tx.update(evRef, {
      matchStatus: "matched",
      matchedBookingId: match.id,
      // 共用メアド由来で null だった propertyId を booking 側に揃える
      propertyId: booking.propertyId || null,
      matchedAt: admin.firestore.FieldValue.serverTimestamp(),
      matchReason: match.matchReason || "rematch-global",
      rematched: true,
      ...(decision && decision.skippedReason ? { rematchNote: decision.skippedReason } : {}),
    });
    return true;
  });
}

/**
 * 再マッチ時に booking へ当てるパッチを組み立てる (純粋関数・テスト対象)
 *
 * ★ decision.updates が null (「古いメール」ガード等でフィールド更新が不要) でも、
 *   confirmed が届いた事実は有効なので pendingApproval / unverified の降下は必ず行う。
 *   ここを decision と一体にすると、後から届いた別メールで booking.emailVerifiedAt が
 *   進んだ予約では確定メールが永久にスキップされ、承認待ちの縞々が残り続ける
 *   (清掃募集も生成されない)。2026-08-12 宿小町 10/27 予約で実際に発生。
 *
 * @param {object} booking     現在の booking データ
 * @param {object|null} decision  decideBookingUpdate の戻り値
 * @param {object} parsedInfo  メールの抽出結果
 * @param {string} matchedBy   emailMatchedBy に入れる値
 * @param {object} fv          { serverTimestamp(), timestampFromMillis(ms) } (admin 依存を注入)
 * @returns {object} booking に当てるパッチ (空オブジェクトなら更新不要)
 */
function buildRematchPatch(booking, decision, parsedInfo, matchedBy, fv) {
  const patch = {};
  const b = booking || {};
  if (decision && decision.updates) {
    for (const k of Object.keys(decision.updates)) {
      const v = decision.updates[k];
      if (v && typeof v === "object" && v.__placeholder === "serverTimestamp") {
        patch[k] = fv.serverTimestamp();
      } else if (v && typeof v === "object" && v.__placeholder === "timestampFromMs") {
        patch[k] = fv.timestampFromMillis(v.ms);
      } else if (v !== undefined) {
        patch[k] = v;
      }
    }
    patch.emailMatchedBy = matchedBy;
  }
  if (parsedInfo && parsedInfo.kind === "confirmed") {
    if (b.pendingApproval === true) {
      patch.pendingApproval = false;
      patch.pendingApprovalResolvedAt = fv.serverTimestamp();
    }
    if (b.unverified === true) {
      patch.unverified = false;
      patch.unverifiedResolvedAt = fv.serverTimestamp();
    }
  }
  return patch;
}

module.exports = {
  reevaluateUnmatched,
  buildRematchPatch,
  SCAN_LIMIT,
};
