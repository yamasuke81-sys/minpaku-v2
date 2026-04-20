/**
 * Airbnb 予約確認メールパーサー (automated@airbnb.com からの日本語版メール)
 *
 * 対応メール種別:
 *   - 予約確定 (confirmed)     : subject 「予約確定 - {名前}さんが{月}月{日}日ご到着です」
 *   - 予約変更承認 (changed)  : subject 「予約変更が承認されました」(詳細情報なし、kind のみ)
 *   - 予約キャンセル (cancelled)
 *   - 予約リクエスト (request) : 承認待ち状態
 *
 * NOTE: Airbnb はホスト側アカウントの言語設定に従って送信する。やますけのアカウントが
 * 日本語設定のため、海外ゲスト予約も本文は日本語。英語版パーサーは現状不要。
 */

// ======================================================
// 純粋関数群 (単体テスト可能、Firestore 非依存)
// ======================================================

// 確認コード抽出: Airbnb は "HM" 接頭の英数 8 文字
function extractReservationCode(body) {
  const m = /HM[A-Z0-9]{8}/.exec(String(body || ""));
  return m ? m[0] : null;
}

// 件名からゲスト名 (full name) を抽出: 「予約確定 - {名前}さんが」
function extractGuestNameFromSubject(subject) {
  const m = /予約確定\s*[-\-ー−]\s*(.+?)\s*さんが/.exec(String(subject || ""));
  return m ? m[1].trim() : null;
}

// 件名から「M月D日ご到着」のチェックイン月日を抽出
// 例: 「予約確定 - Mike Dierkxさんが8月3日ご到着です」
function extractCheckInFromSubject(subject) {
  const m = /(\d{1,2})月(\d{1,2})日ご到着/.exec(String(subject || ""));
  if (!m) return null;
  return { month: +m[1], day: +m[2] };
}

// 本文冒頭からゲストのファーストネームを抽出: 「新規予約確定です! {FirstName}さんが{M}月{D}日到着。」
function extractGuestFirstNameFromBody(body) {
  const m = /新規予約確定です[!！]\s*(.+?)さんが\s*\d+月\d+日到着/.exec(String(body || ""));
  return m ? m[1].trim() : null;
}

// チェックイン情報抽出: 「チェックイン{M}月{D}日({曜})...{HH}:{MM}」
function extractCheckIn(body) {
  const m = /チェックイン\s*(\d+)月(\d+)日[^0-9]*?(\d{1,2}):(\d{2})/.exec(String(body || ""));
  if (!m) return null;
  return { month: +m[1], day: +m[2], hour: +m[3], minute: +m[4] };
}

// チェックアウト情報抽出
function extractCheckOut(body) {
  const m = /チェックアウト\s*(\d+)月(\d+)日[^0-9]*?(\d{1,2}):(\d{2})/.exec(String(body || ""));
  if (!m) return null;
  return { month: +m[1], day: +m[2], hour: +m[3], minute: +m[4] };
}

// ゲスト人数抽出: 「ゲスト人数大人{N}人(, 子ども{N}人)?(, 乳幼児{N}人)?」
function extractGuestCount(body) {
  const s = String(body || "");
  const adultsM = /ゲスト人数\s*大人\s*(\d+)人/.exec(s);
  if (!adultsM) return null;
  const childrenM = /子ども\s*(\d+)人/.exec(s);
  const infantsM = /乳幼児\s*(\d+)人/.exec(s);
  const adults = +adultsM[1];
  const children = childrenM ? +childrenM[1] : 0;
  const infants = infantsM ? +infantsM[1] : 0;
  return { adults, children, infants, total: adults + children + infants };
}

// 合計金額抽出: 「合計（JPY）¥ 51,988」
function extractTotalAmount(body) {
  const m = /合計[（(]JPY[)）]\s*¥\s*([\d,]+)/.exec(String(body || ""));
  if (!m) return null;
  return parseInt(m[1].replace(/,/g, ""), 10);
}

// 件名から kind を判定
//   confirmed        : 新規予約確定 (予約確定 - ...)
//   cancelled        : キャンセル (キャンセルのお知らせ / 予約がキャンセル)
//   change-approved  : 予約変更が承認された (双方合意済、新 CI/CO 反映)
//   change-request   : 予約変更をご希望 (ゲストから要望、ホスト承認待ち)
//   request          : 予約リクエスト (新規予約の承認待ち)
function detectSubjectKind(subject) {
  const s = String(subject || "");
  if (/予約確定/.test(s)) return "confirmed";
  if (/キャンセルのお知らせ|予約.*キャンセル|キャンセルされました/.test(s)) return "cancelled";
  if (/予約変更が承認|予約変更.*承認/.test(s)) return "change-approved";
  if (/予約変更.*希望|予約変更をご希望/.test(s)) return "change-request";
  if (/保留中.*予約リクエスト|予約リクエスト.*保留/.test(s)) return "request";
  if (/予約リクエスト/.test(s)) return "request";
  return "unknown";
}

// キャンセル通知の件名から reservationCode + 日付範囲を抽出 (年含む)
// 例: 「キャンセルのお知らせ：2026年5月4日～6日のご予約（HMJENWXRMS）」
//     「キャンセルのお知らせ：2026年12月31日～1月2日のご予約（HM...）」 (年またぎ)
function parseCancelSubject(subject) {
  const s = String(subject || "");
  const m = /キャンセルのお知らせ[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日[〜～\-](?:(\d{1,2})月)?(\d{1,2})日.*?[（(]\s*(HM[A-Z0-9]+)\s*[)）]/.exec(s);
  if (!m) return null;
  const year = +m[1];
  const m1 = +m[2];
  const d1 = +m[3];
  const m2 = m[4] ? +m[4] : m1; // 同月なら月を省略する仕様
  const d2 = +m[5];
  // 12月→1月 の年またぎ対応
  const checkOutYear = m1 === 12 && m2 === 1 ? year + 1 : year;
  return {
    reservationCode: m[6],
    checkIn: { year, month: m1, day: d1 },
    checkOut: { year: checkOutYear, month: m2, day: d2 },
  };
}

// 予約変更リクエスト件名からゲスト名を抽出
// 例: 「Muhamad Nurakmalさんが予約変更をご希望です」
function parseChangeRequestSubject(subject) {
  const s = String(subject || "");
  const m = /^(.+?)さんが予約変更をご希望/.exec(s);
  return m ? { guestName: m[1].trim() } : null;
}

// キャンセル本文からゲストのファーストネーム抽出
// 例: 「ゲストの和行さんにより、やむを得ず…がキャンセル」
function extractCancelGuestFirstName(body) {
  const m = /ゲストの(.+?)さんにより/.exec(String(body || ""));
  return m ? m[1].trim() : null;
}

// 本文から Airbnb リスティング ID を抽出
// 例: 「リスティング#1496523336810635360」
function extractListingId(body) {
  const m = /リスティング#(\d+)/.exec(String(body || ""));
  return m ? m[1] : null;
}

// キャンセル本文 「{M}月{D}日〜{D2}日, {N}人」から人数合計を抽出
function extractCancelGuestCount(body) {
  const m = /\d+月\d+日[〜～\-](?:\d+月)?\d+日\s*,\s*(\d+)人/.exec(String(body || ""));
  if (!m) return null;
  const total = +m[1];
  return { adults: total, children: 0, infants: 0, total };
}

// 年推測: メール本文に年が含まれないため、受信日時から推測
// check-in は通常受信日より未来 (or 数日以内の過去) なので、直近の未来の同月日を採用
function inferYear(month, day, receivedAt) {
  const base = receivedAt instanceof Date ? receivedAt : new Date(receivedAt || Date.now());
  const year = base.getFullYear();
  const sameYear = new Date(year, month - 1, day);
  // 同年の候補日が受信日より 30 日以上過去なら、翌年と推測
  const diffDays = (base - sameYear) / (1000 * 60 * 60 * 24);
  return diffDays > 30 ? year + 1 : year;
}

function pad2(n) { return String(n).padStart(2, "0"); }

// ======================================================
// 統合パーサー
// ======================================================

/**
 * Airbnb メールから構造化情報を抽出
 * kind によって抽出経路が異なる:
 *   - confirmed       : 本文から全情報取得、年は受信日時から推論
 *   - cancelled       : 件名から reservationCode/checkIn/checkOut (年含む) + 本文補完
 *   - change-request  : 件名から guestName のみ (本文は詳細なし)
 *   - change-approved : 件名 + 本文で補完可能な範囲
 *   - request / unknown: best-effort
 * @param {{subject:string, body:string, receivedAt?:Date|string|number}} input
 */
function parseAirbnbEmail(input) {
  const subject = (input && input.subject) || "";
  const body = (input && input.body) || "";
  const receivedAt = input && input.receivedAt ? new Date(input.receivedAt) : new Date();

  const kind = detectSubjectKind(subject);

  // ========== kind=cancelled: 件名主導 ==========
  if (kind === "cancelled") {
    const cancelInfo = parseCancelSubject(subject);
    const listingId = extractListingId(body);
    const cancelCount = extractCancelGuestCount(body);
    const firstName = extractCancelGuestFirstName(body);

    let checkIn = null;
    let checkOut = null;
    if (cancelInfo) {
      checkIn = {
        date: `${cancelInfo.checkIn.year}-${pad2(cancelInfo.checkIn.month)}-${pad2(cancelInfo.checkIn.day)}`,
        time: null,
      };
      checkOut = {
        date: `${cancelInfo.checkOut.year}-${pad2(cancelInfo.checkOut.month)}-${pad2(cancelInfo.checkOut.day)}`,
        time: null,
      };
    }

    return {
      platform: "Airbnb",
      kind,
      reservationCode: (cancelInfo && cancelInfo.reservationCode) || extractReservationCode(body),
      guestName: null, // キャンセル件名にフルネーム無し
      guestFirstName: firstName,
      checkIn,
      checkOut,
      guestCount: cancelCount,
      totalAmount: null,
      listingId,
    };
  }

  // ========== kind=change-request: 件名からゲスト名のみ ==========
  if (kind === "change-request") {
    const changeReqInfo = parseChangeRequestSubject(subject);
    return {
      platform: "Airbnb",
      kind,
      reservationCode: extractReservationCode(body),
      guestName: changeReqInfo ? changeReqInfo.guestName : null,
      guestFirstName: null,
      checkIn: null,
      checkOut: null,
      guestCount: null,
      totalAmount: null,
      listingId: extractListingId(body),
    };
  }

  // ========== kind=confirmed / change-approved / request / unknown: 本文主導 ==========
  const reservationCode = extractReservationCode(body);
  const guestName = extractGuestNameFromSubject(subject);
  const guestFirstName = extractGuestFirstNameFromBody(body);
  // checkIn: まず本文から取得を試みて、取れなかったら件名の「M月D日ご到着」から補完
  let checkInRaw = extractCheckIn(body);
  if (!checkInRaw) {
    const subj = extractCheckInFromSubject(subject);
    if (subj) checkInRaw = { month: subj.month, day: subj.day, hour: 0, minute: 0 };
  }
  const checkOutRaw = extractCheckOut(body);
  const guestCount = extractGuestCount(body);
  const totalAmount = extractTotalAmount(body);
  const listingId = extractListingId(body);

  let checkIn = null;
  let checkOut = null;

  if (checkInRaw) {
    const y = inferYear(checkInRaw.month, checkInRaw.day, receivedAt);
    checkIn = {
      date: `${y}-${pad2(checkInRaw.month)}-${pad2(checkInRaw.day)}`,
      time: `${pad2(checkInRaw.hour)}:${pad2(checkInRaw.minute)}`,
    };
  }
  if (checkOutRaw) {
    let y;
    if (checkIn) {
      const ciYear = parseInt(checkIn.date.slice(0, 4), 10);
      y = checkInRaw && checkInRaw.month > checkOutRaw.month ? ciYear + 1 : ciYear;
    } else {
      y = inferYear(checkOutRaw.month, checkOutRaw.day, receivedAt);
    }
    checkOut = {
      date: `${y}-${pad2(checkOutRaw.month)}-${pad2(checkOutRaw.day)}`,
      time: `${pad2(checkOutRaw.hour)}:${pad2(checkOutRaw.minute)}`,
    };
  }

  return {
    platform: "Airbnb",
    kind,
    reservationCode,
    guestName,
    guestFirstName,
    checkIn,
    checkOut,
    guestCount,
    totalAmount,
    listingId,
  };
}

module.exports = {
  parseAirbnbEmail,
  _pure: {
    extractReservationCode,
    extractGuestNameFromSubject,
    extractCheckInFromSubject,
    extractGuestFirstNameFromBody,
    parseCancelSubject,
    parseChangeRequestSubject,
    extractCancelGuestFirstName,
    extractListingId,
    extractCancelGuestCount,
    extractCheckIn,
    extractCheckOut,
    extractGuestCount,
    extractTotalAmount,
    detectSubjectKind,
    inferYear,
  },
};
