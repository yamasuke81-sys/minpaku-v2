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
function detectSubjectKind(subject) {
  const s = String(subject || "");
  if (/予約確定/.test(s)) return "confirmed";
  if (/予約変更が承認|予約.*変更.*承認/.test(s)) return "changed";
  if (/予約.*キャンセル|キャンセルされました/.test(s)) return "cancelled";
  if (/保留中.*予約リクエスト|予約リクエスト.*保留/.test(s)) return "request";
  if (/予約リクエスト/.test(s)) return "request";
  return "unknown";
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
 * @param {{subject:string, body:string, receivedAt?:Date|string|number}} input
 * @returns {{
 *   platform: "Airbnb",
 *   kind: "confirmed"|"changed"|"cancelled"|"request"|"unknown",
 *   reservationCode: string|null,
 *   guestName: string|null,
 *   guestFirstName: string|null,
 *   checkIn: {date:string, time:string}|null,
 *   checkOut: {date:string, time:string}|null,
 *   guestCount: {adults:number, children:number, infants:number, total:number}|null,
 *   totalAmount: number|null,
 * }}
 */
function parseAirbnbEmail(input) {
  const subject = (input && input.subject) || "";
  const body = (input && input.body) || "";
  const receivedAt = input && input.receivedAt ? new Date(input.receivedAt) : new Date();

  const kind = detectSubjectKind(subject);
  const reservationCode = extractReservationCode(body);
  const guestName = extractGuestNameFromSubject(subject);
  const guestFirstName = extractGuestFirstNameFromBody(body);
  const checkInRaw = extractCheckIn(body);
  const checkOutRaw = extractCheckOut(body);
  const guestCount = extractGuestCount(body);
  const totalAmount = extractTotalAmount(body);

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
      // checkIn と同じ年、または月跨ぎ (checkIn 12月 → checkOut 1月) なら翌年
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
  };
}

module.exports = {
  parseAirbnbEmail,
  _pure: {
    extractReservationCode,
    extractGuestNameFromSubject,
    extractGuestFirstNameFromBody,
    extractCheckIn,
    extractCheckOut,
    extractGuestCount,
    extractTotalAmount,
    detectSubjectKind,
    inferYear,
  },
};
