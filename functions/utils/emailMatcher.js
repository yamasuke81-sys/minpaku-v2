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
    // 0. otaReservationCode 完全一致 (最も確実)
    //    Booking.com の iCal は同一日程なら予約が差し替わっても同じ UID の CLOSED を返すため、
    //    UID では新旧の予約を区別できない。照合時に保存した予約番号で厳密に突合する。
    for (const b of bookings) {
      const rc = String((b.data && b.data.otaReservationCode) || "").toLowerCase();
      if (rc && rc === code) {
        return { id: b.id, data: b.data, matchReason: "otaReservationCode" };
      }
    }
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
  //    ※propertyIdHint が無い(物件を特定できない)場合は日付フォールバックを行わない(2026-07-09)。
  //      共用メアド由来で propertyId=null のまま source+日付だけでマッチすると、別物件の
  //      同日予約に吸い込まれる事故が起きたため(テラス長浜の確定メールがおのみちホテルへ誤照合)。
  //      物件を特定できないメールは unmatched のまま残し、メール照合UIの手動リンクに委ねる。
  if (propertyIdHint && parsedInfo.platform && parsedInfo.checkIn && parsedInfo.checkIn.date) {
    const ciDate = parsedInfo.checkIn.date; // "YYYY-MM-DD"
    const candidates = [];
    for (const b of bookings) {
      const d = b.data || {};
      if (d.source !== parsedInfo.platform) continue;
      if (propertyIdHint && d.propertyId && d.propertyId !== propertyIdHint) continue;
      // ★予約番号が食い違う候補の扱い (誤照合ガード)
      //   - キャンセルメール: 番号違いには絶対に当てない。
      //     これがないと、差し替え後の新予約(NEW)に旧予約(OLD)のキャンセルメールが
      //     日付一致で吸い込まれ、生きている予約をキャンセルしてしまう
      //     (最新勝ちガードはメール受信日時しか見ないので防げない)。
      //   - 確定メール: 相手が「キャンセル済み」なら番号違いこそが差し替えのサインなので
      //     候補に残す。ここで除外すると復活・guestInfoStale・差し替え通知が全部動かなくなる。
      //     相手が生きている場合は別の実在予約なので除外する。
      const bCode = d.otaReservationCode ? String(d.otaReservationCode).toLowerCase() : null;
      if (code && bCode && bCode !== code) {
        const candCancelled = isCancelledStatus_(d.status) || !!d.cancelledAt;
        if (parsedInfo.kind === "cancelled" || !candCancelled) continue;
      }
      const bCheckIn = normalizeCheckInDate_(d.checkIn);
      if (bCheckIn === ciDate) {
        candidates.push({ id: b.id, data: d, matchReason: "dateAndPlatform" });
      }
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      // キャンセル済みが混ざっている場合は active を優先する。
      // (キャンセル→同日程で再予約 のとき、旧キャンセル doc と新 doc が併存して
      //  ambiguous になり確定メールが取りこぼされるのを防ぐ)
      // ★ただしキャンセルメールには適用しない。旧予約のキャンセルメールが
      //   新しい active 予約を選んでしまい、生きている予約を消すため。
      //   (キャンセルメールは既に cancelled の doc に当たっても実害がない)
      const active = parsedInfo.kind === "cancelled"
        ? []
        : candidates.filter((c) => !isCancelledStatus_(c.data && c.data.status));
      if (active.length === 1) {
        return { ...active[0], matchReason: "dateAndPlatform-activePreferred" };
      }
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

// status がキャンセル系かどうか (表記ゆれ: cancelled / キャンセル / キャンセル済み)
function isCancelledStatus_(status) {
  const s = String(status || "").toLowerCase();
  return s.includes("cancel") || s === "キャンセル" || s === "キャンセル済み";
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
function decideBookingUpdate(booking, parsedInfo, messageId, emailReceivedAt, threadId, subject) {
  if (!booking || !parsedInfo) {
    return { updates: null, skippedReason: "booking または parsedInfo が空" };
  }

  // ---- 除外 kind: 予約ステータスに影響しないメールは bookings に書込まない ----
  // (emailVerifications への記録は引き続き行う = 蓄積して将来ルール見直しに使う)
  const EXCLUDED_KINDS = new Set(["payout"]);
  if (EXCLUDED_KINDS.has(parsedInfo.kind)) {
    return { updates: null, skippedReason: `kind=${parsedInfo.kind} は bookings 更新対象外` };
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
    emailThreadId: threadId || null,
    // subject は UI (予約詳細モーダル) で「📧 {subject} / {日付}」表示に使う
    emailSubject: subject || null,
  };
  if (newMs != null) {
    // 呼出側で Timestamp.fromMillis に置換
    updates.emailVerifiedAt = { __placeholder: "timestampFromMs", ms: newMs };
  }

  // ---- 予約番号の保存 ----
  // 次回以降このコードで厳密に突合できるようにする (日付フォールバック依存からの脱却)。
  // 併せて「予約が別番号に差し替わった」ことの検知にも使う。
  const newCode = parsedInfo.reservationCode ? String(parsedInfo.reservationCode) : null;
  const prevCode = booking.otaReservationCode ? String(booking.otaReservationCode) : null;
  if (newCode && newCode !== prevCode) {
    updates.otaReservationCode = newCode;
  }

  // ---- キャンセル済み予約の復活 / 別予約への差し替え ----
  // Booking.com の iCal は同一日程なら予約が差し替わっても同じ UID の CLOSED を返すため、
  // 「キャンセル → 同日程で別予約番号の再予約」が同一 booking ドキュメントに着地する。
  // このとき status だけ confirmed に戻ってキャンセル痕跡と旧予約のゲスト情報が残っていた
  // (2026-08-12 the Terrace 8/26 の事故)。痕跡を消し、差し替えを検知できるようにする。
  const wasCancelled = isCancelledStatus_(booking.status) || !!booking.cancelledAt;
  if (parsedInfo.kind === "confirmed" && wasCancelled) {
    updates.status = "confirmed";
    updates.cancelledAt = { __placeholder: "delete" };
    updates.cancelReason = { __placeholder: "delete" };
    updates.cancelSource = { __placeholder: "delete" };
    updates.revivedAt = { __placeholder: "serverTimestamp" };
  }
  // 差し替え判定: キャンセル済みが確定メールで復活した / 予約番号が別物に変わった
  const isReplacement =
    parsedInfo.kind === "confirmed" &&
    (wasCancelled || !!(newCode && prevCode && newCode !== prevCode));
  if (isReplacement) {
    // 人数・氏名は旧予約由来の可能性がある。値は壊さずフラグだけ立て、呼出側が通知する。
    // (Booking.com の確定メールには人数・氏名が載らないため機械的に更新できない)
    updates.guestInfoStale = true;
    updates.guestInfoStaleReason = wasCancelled
      ? "キャンセル済み予約が確定メールで復活 (別予約への差し替えの可能性)"
      : "予約番号が変わりました (別予約への差し替え)";
    updates.replacedAt = { __placeholder: "serverTimestamp" };
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
      // キャンセル予約一覧でソート/表示するために必須
      updates.cancelledAt = { __placeholder: "serverTimestamp" };
      updates.cancelReason = "メール照合: キャンセル通知メール検知";
    }
  }

  // ---- change-approved / changed 処理 (予約日変更) ----
  // Airbnb の change-approved (予約変更承認) や Booking.com の changed (予約変更) で
  // 新しい checkIn / checkOut / guestCount がメール本文から取得できた場合は bookings 反映。
  // 本文に新日付が含まれず取得できない場合は素通り (記録のみ)。
  // CI/CO の変化は onBookingChange トリガーが booking_change 通知を発火するので自動連動。
  if (parsedInfo.kind === "change-approved" || parsedInfo.kind === "changed") {
    if (booking.manualOverride !== true) {
      const newCi = parsedInfo.checkIn && parsedInfo.checkIn.date;
      const newCo = parsedInfo.checkOut && parsedInfo.checkOut.date;
      if (newCi && booking.checkIn !== newCi) {
        updates.checkIn = newCi;
      }
      if (newCo && booking.checkOut !== newCo) {
        updates.checkOut = newCo;
      }
      // 人数も新値が取得できたら上書き (キャンセル/確定と異なり「既存が0のみ」ガードを外す)
      if (parsedInfo.guestCount && parsedInfo.guestCount.total > 0
          && booking.guestCount !== parsedInfo.guestCount.total) {
        updates.guestCount = parsedInfo.guestCount.total;
      }
      if (updates.checkIn || updates.checkOut || updates.guestCount) {
        updates.changeSource = "email";
      }
    } else {
      updates._emailVerificationNote = "manualOverride=true のため変更反映スキップ";
    }
  }

  return { updates, skippedReason: null };
}

// ======================================================
// emailVerifications の matchStatus 決定
// ======================================================

/**
 * 件名から「保留中/予約リクエスト」メールかどうかを判定する
 * 案A: pending_request ステータスの付与判断に使用
 */
function isPendingRequest(subject, kind) {
  // kind が "request" なら件名チェック不要で保留中とみなす
  if (kind === "request") return true;
  const s = String(subject || "").toLowerCase();
  return /保留中|予約リクエスト|reservation request|^request\s|^pending\s/.test(s);
}

/**
 * emailVerifications ドキュメントに書き込む matchStatus を返す
 * - matched              : confirmed メールが予約と突合
 * - cancelled            : cancelled メールが予約と突合 (bookings も更新)
 * - changed              : change-approved / change-request メール
 * - unmatched            : 予約が見つからない (メール先行のケース — 定期巡回で後追い可能)
 * - pending              : 不明 kind
 * - pending_request      : 予約リクエスト/保留中メール (案A)
 * - resolved_to_confirmed: 保留中→確定済チェーン (案B、呼び出し側が上書き)
 * - archived             : iCal同期後に自動アーカイブ (案C、呼び出し側が上書き)
 */
function decideVerificationStatus(parsedInfo, matchedBooking) {
  if (!parsedInfo) return "pending";
  const kind = parsedInfo.kind;
  // payout (送金) は予約ステータスへの影響なし
  if (kind === "payout") return "payout";

  // 案A: 保留中/リクエストメールを pending_request に分類
  if (isPendingRequest(parsedInfo.subject || "", kind)) {
    // 対応する確定予約が見つかっていれば resolved_to_confirmed (案B 相当)
    if (matchedBooking && matchedBooking.data && matchedBooking.data.status === "confirmed") {
      return "resolved_to_confirmed";
    }
    return "pending_request";
  }

  if (!matchedBooking) {
    if (kind === "cancelled") return "cancelled-unmatched";
    // 突合の手がかり(予約番号 or チェックイン日)が両方無いメールは永久に照合不能
    // (Airbnbメッセージスレッド/レビュー/汎用通知等)。未照合プール(再評価対象)に入れず
    // ignored で終端化する。これがないと findBookingMatch で拾えないノイズが溜まり、
    // 救済バッチの枠を食い潰して本物の確定メールが埋もれる(starvation)。
    const hasCode = !!parsedInfo.reservationCode;
    const hasCI = !!(parsedInfo.checkIn && parsedInfo.checkIn.date);
    return (hasCode || hasCI) ? "unmatched" : "ignored";
  }
  if (kind === "confirmed") return "matched";
  if (kind === "cancelled") return "cancelled";
  if (kind === "change-approved" || kind === "change-request") return "changed";
  return "matched";
}

// ======================================================
// 変更メール通知の判定 (Airbnb change-approved / change-request)
// ======================================================

// 通知対象の kind
function isChangeNotifyKind(kind) {
  return kind === "change-approved" || kind === "change-request";
}

/**
 * 名簿(guestRegistrations)の合計人数を計算
 *   - numAdults + numChildren を採用 (乳幼児は宿泊税/人数集計で通常除外)
 *   - 複数レコードあれば合算
 * @param {Array<object>} rosterDocs - guestRegistrations の data 配列
 * @returns {{total:number, adults:number, children:number, infants:number, count:number}}
 */
function computeRosterTotals(rosterDocs) {
  const out = { total: 0, adults: 0, children: 0, infants: 0, count: 0 };
  if (!Array.isArray(rosterDocs)) return out;
  for (const g of rosterDocs) {
    if (!g) continue;
    const a = Number(g.numAdults || 0);
    const c = Number(g.numChildren || 0);
    const i = Number(g.numInfants || 0);
    out.adults += a;
    out.children += c;
    out.infants += i;
    out.total += a + c;
    out.count++;
  }
  return out;
}

/**
 * Airbnb変更メール通知の本文/変数を組み立てる純粋関数
 *   - kind=change-approved: 「予約変更が承認されました」
 *   - kind=change-request : 「ゲストから変更希望」
 *   - bookingData と roster から現況を並記
 *   - roster.total>0 かつ booking.guestCount と食い違いあれば ⚠️ を追加
 *
 * @param {object} parsedInfo
 * @param {object|null} bookingData - matched booking の data (無ければ null)
 * @param {Array<object>} rosterDocs - guestRegistrations data 配列 (無ければ [])
 * @param {object} opts - { propertyName?, appUrl? }
 * @returns {{title:string, body:string, vars:object, hasMismatch:boolean}}
 */
function buildChangeEmailNotification(parsedInfo, bookingData, rosterDocs, opts) {
  const kind = parsedInfo && parsedInfo.kind;
  const opt = opts || {};
  const isRequest = kind === "change-request";

  const code = (parsedInfo && parsedInfo.reservationCode) || "";
  const emailGuestName =
    (parsedInfo && (parsedInfo.guestName || parsedInfo.guestFirstName)) || "";
  const propertyName =
    opt.propertyName || (bookingData && bookingData.propertyName) || "";

  const bookingGuestName = (bookingData && bookingData.guestName) || "";
  const ci = (bookingData && bookingData.checkIn) || "";
  const co = (bookingData && bookingData.checkOut) || "";
  const bookingCount =
    bookingData && bookingData.guestCount != null ? Number(bookingData.guestCount) : null;

  const roster = computeRosterTotals(rosterDocs);
  const hasMismatch =
    roster.total > 0 && bookingCount != null && roster.total !== bookingCount;

  const guestForDisplay =
    bookingGuestName || emailGuestName || "(不明)";

  const emoji = isRequest ? "🙋" : "🔄";
  const kindLabel = isRequest
    ? "予約変更希望が届きました"
    : "予約変更が承認されました";

  const bodyLines = [
    `${emoji} Airbnb: ${kindLabel}`,
    "",
    `物件: ${propertyName || "(不明)"}`,
    `ゲスト: ${guestForDisplay}`,
  ];
  if (code) bodyLines.push(`予約コード: ${code}`);
  if (ci || co) {
    bodyLines.push(`現在の予約: ${ci || "?"} 〜 ${co || "?"}`);
  }
  if (bookingCount != null) {
    bodyLines.push(`予約の登録人数: ${bookingCount}人`);
  }
  if (roster.count > 0) {
    bodyLines.push(
      `名簿の申告人数: 合計${roster.total}人 (大人${roster.adults}/子ども${roster.children}/乳幼児${roster.infants}) ${roster.count}件`,
    );
  } else {
    bodyLines.push("名簿の申告人数: 未入力");
  }
  if (hasMismatch) {
    bodyLines.push("");
    bodyLines.push(
      `⚠️ 名簿との食い違いあり (予約=${bookingCount}人 / 名簿=${roster.total}人)`,
    );
  }
  bodyLines.push("");
  bodyLines.push(
    isRequest
      ? "→ Airbnb で変更希望の内容を確認して承認/拒否してください。承認後、必要なら人数を手動で更新してください。"
      : "→ Airbnb で変更後の内容を確認し、必要なら人数を手動で更新してください。",
  );

  return {
    title: `${emoji} Airbnb ${isRequest ? "予約変更希望" : "予約変更承認"}: ${
      propertyName || guestForDisplay
    }`,
    body: bodyLines.join("\n"),
    vars: {
      property: propertyName || "",
      guest: guestForDisplay,
      code,
      checkin: ci,
      date: co,
      kind: kind || "",
      booking_count: bookingCount != null ? String(bookingCount) : "",
      roster_total: String(roster.total),
      roster_adults: String(roster.adults),
      roster_children: String(roster.children),
      roster_infants: String(roster.infants),
      roster_count: String(roster.count),
      mismatch: hasMismatch ? "1" : "",
    },
    hasMismatch,
  };
}

module.exports = {
  findBookingMatch,
  decideBookingUpdate,
  decideVerificationStatus,
  isPendingRequest,
  isChangeNotifyKind,
  computeRosterTotals,
  buildChangeEmailNotification,
  // テスト用 internal
  _normalizeCheckInDate: normalizeCheckInDate_,
};
