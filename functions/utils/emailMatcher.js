/**
 * メール照合 (email ↔ bookings マッチング) ロジック
 *
 * 責務:
 *   - parsedInfo (Airbnb / Booking.com メールの構造化結果) と bookings コレクションから
 *     対応する予約を特定する
 *   - 突合成功時に bookings へ書き込む更新オブジェクトを決定する (保守的に)
 *   - emailVerifications に記録する matchStatus を決定する
 *
 * 純粋関数のみで構成し、Firestore アクセスは呼び出し側 (emailVerification.js) で行う。
 */

// ======================================================
// マッチングロジック
// ======================================================

/**
 * bookings 配列から parsedInfo に対応する予約を検索
 * 優先順位:
 *   1. reservationCode (HM... or Booking ID) が icalUid に部分一致
 *   2. reservationCode が beds24BookingId に一致
 *   3. source + propertyId + checkIn 日付の完全一致 (フォールバック)
 *
 * @param {Array<{id:string, data:object}>} bookings
 * @param {object} parsedInfo
 * @param {string} [propertyIdHint] - emailVerifications.propertyId から渡される推定物件
 * @returns {{id:string, data:object, matchReason:string} | null}
 */
function findBookingMatch(bookings, parsedInfo, propertyIdHint) {
  if (!Array.isArray(bookings) || bookings.length === 0) return null;
  if (!parsedInfo) return null;

  const code = parsedInfo.reservationCode
    ? String(parsedInfo.reservationCode).toLowerCase()
    : null;

  // 1. icalUid / icalUrl / notes / description に reservationCode を含む部分一致
  //    Airbnb iCal UID は {hash}-{hash}@airbnb.com で HM コードを含まないが、
  //    description や URL に HM コードが含まれる場合があるため広範に検索
  if (code) {
    for (const b of bookings) {
      const d = b.data || {};
      const haystack = [
        String(d.icalUid || ""),
        String(d.icalUrl || ""),
        String(d.notes || ""),
        String(d.description || ""),
      ].join(" ").toLowerCase();
      if (haystack.includes(code)) {
        return { id: b.id, data: d, matchReason: "codeInHaystack" };
      }
    }
    // 2. beds24BookingId 完全一致
    for (const b of bookings) {
      const bid = String((b.data && b.data.beds24BookingId) || "").toLowerCase();
      if (bid && bid === code) {
        return { id: b.id, data: b.data, matchReason: "beds24BookingId" };
      }
    }
  }

  // 3. source + propertyId + checkIn 日付 フォールバック
  //    ※候補が複数ある場合は null (曖昧マッチによる誤更新を防ぐ)
  if (parsedInfo.platform && parsedInfo.checkIn && parsedInfo.checkIn.date) {
    const ciDate = parsedInfo.checkIn.date; // "YYYY-MM-DD"
    const candidates = [];
    for (const b of bookings) {
      const d = b.data || {};
      if (d.source !== parsedInfo.platform) continue;
      if (propertyIdHint && d.propertyId && d.propertyId !== propertyIdHint) continue;
      const bCheckIn = normalizeCheckInDate_(d.checkIn);
      if (bCheckIn === ciDate) {
        candidates.push({ id: b.id, data: d, matchReason: "dateAndPlatform" });
      }
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      return {
        id: null,
        data: null,
        matchReason: "ambiguous-dateAndPlatform",
        candidateIds: candidates.map((c) => c.id),
      };
    }
  }

  return null;
}

// checkIn フィールドを YYYY-MM-DD 形式に正規化
// Firestore Timestamp / Date / string / {toDate()} をサポート
function normalizeCheckInDate_(v) {
  if (!v) return null;
  try {
    let d = null;
    if (typeof v === "string") {
      // "YYYY-MM-DD" or ISO 形式
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
      d = new Date(v);
    } else if (v instanceof Date) {
      d = v;
    } else if (typeof v.toDate === "function") {
      d = v.toDate();
    } else if (typeof v._seconds === "number") {
      d = new Date(v._seconds * 1000);
    }
    if (!d || isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  } catch (_e) {
    return null;
  }
}

// ======================================================
// bookings 更新決定 (保守的なマージロジック)
// ======================================================

// 任意形式の時刻値を ms に変換
function toMs_(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v._seconds === "number") return v._seconds * 1000 + (v._nanoseconds ? Math.floor(v._nanoseconds / 1e6) : 0);
  if (typeof v === "string") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  return null;
}

/**
 * 突合成功時に bookings ドキュメントへ書き込む更新オブジェクトを決定
 *
 * 保守方針:
 *   - **最新勝ちルール**: booking.emailVerifiedAt より古いメールは全て skip (古いメールで
 *     新しい状態を上書きしない)。同時刻または新規メールのみ反映
 *   - emailVerifiedAt には **メールの受信日時** (処理時刻ではない) を保存 → 真実の
 *     source of truth として時系列比較に使える
 *   - emailMessageId も常に上書き
 *   - guestName: 既存が空 or iCal の generic name (Not available / Reserved / Airbnb / Booking.com) の場合のみ上書き
 *   - guestCount: 既存が 0 or 未設定の場合のみ上書き
 *   - status=cancelled: manualOverride=true の予約は保護 (ガード)、それ以外は cancelled に設定
 *   - change-approved / change-request / request: 現状 bookings の変更なし (email 記録のみ)
 *
 * @param {object} booking - bookings ドキュメントの data
 * @param {object} parsedInfo
 * @param {string} messageId - Gmail message.id
 * @param {Date|Timestamp|number|string|null} emailReceivedAt - メールの受信日時
 * @returns {{ updates: object, skippedReason: string|null }}
 */
function decideBookingUpdate(booking, parsedInfo, messageId, emailReceivedAt, threadId) {
  if (!booking || !parsedInfo) {
    return { updates: null, skippedReason: "booking または parsedInfo が空" };
  }

  // ---- 最新勝ちガード: 古いメールは scope しない ----
  const newMs = toMs_(emailReceivedAt);
  const existingMs = toMs_(booking.emailVerifiedAt);
  if (newMs != null && existingMs != null && newMs < existingMs) {
    return {
      updates: null,
      skippedReason: `古いメール (${new Date(newMs).toISOString()}) を検出。booking は既により新しいメール (${new Date(existingMs).toISOString()}) で更新済みのためスキップ`,
    };
  }

  const updates = {
    emailMessageId: messageId || null,
    // threadId は Gmail の会話スレッド ID。UI の URL 生成で `#all/{threadId}` 形式で使うと
    // 確実に該当メールを開ける (messageId 単体だと "Temporary Error 404" が出るケースあり)
    emailThreadId: threadId || null,
  };
  if (newMs != null) {
    // 呼出側で Timestamp.fromMillis に置換
    updates.emailVerifiedAt = { __placeholder: "timestampFromMs", ms: newMs };
  }

  // ---- ゲスト名の慎重マージ ----
  const existingName = String(booking.guestName || "");
  const icalOriginal = String(booking._icalOriginalName || "");
  const isGenericExisting =
    !existingName.trim() ||
    /not available|closed|reserved|airbnb|booking\.com/i.test(existingName) ||
    existingName === icalOriginal; // 手動編集なし (= iCal 元と同一)

  if (isGenericExisting) {
    const newName = parsedInfo.guestName || parsedInfo.guestFirstName || null;
    if (newName) updates.guestName = newName;
  }

  // ---- 人数の慎重マージ ----
  const existingCount = booking.guestCount;
  const hasNoCount = existingCount == null || existingCount === 0;
  if (hasNoCount && parsedInfo.guestCount && parsedInfo.guestCount.total > 0) {
    updates.guestCount = parsedInfo.guestCount.total;
  }

  // ---- cancelled 処理 ----
  if (parsedInfo.kind === "cancelled") {
    if (booking.manualOverride === true) {
      // 手動確定済みの予約は保護 (syncIcal と同じガード)
      updates._emailVerificationNote = "manualOverride=true のためキャンセル反映スキップ";
    } else if (booking.status !== "cancelled") {
      updates.status = "cancelled";
      updates.cancelSource = "email";
    }
  }

  return { updates, skippedReason: null };
}

// ======================================================
// emailVerifications の matchStatus 決定
// ======================================================

/**
 * emailVerifications ドキュメントに書き込む matchStatus を返す
 * - matched   : confirmed メールが予約と突合
 * - cancelled : cancelled メールが予約と突合 (bookings も更新)
 * - changed   : change-approved / change-request メール
 * - unmatched : 予約が見つからない (メール先行のケース — 定期巡回で後追い可能)
 * - pending   : 不明 kind
 */
function decideVerificationStatus(parsedInfo, matchedBooking) {
  if (!parsedInfo) return "pending";
  const kind = parsedInfo.kind;
  if (!matchedBooking) {
    return kind === "cancelled" ? "cancelled-unmatched" : "unmatched";
  }
  if (kind === "confirmed") return "matched";
  if (kind === "cancelled") return "cancelled";
  if (kind === "change-approved" || kind === "change-request") return "changed";
  if (kind === "request") return "matched"; // リクエスト段階も予約あれば matched 扱い
  return "matched";
}

module.exports = {
  findBookingMatch,
  decideBookingUpdate,
  decideVerificationStatus,
  // テスト用 internal
  _normalizeCheckInDate: normalizeCheckInDate_,
};
