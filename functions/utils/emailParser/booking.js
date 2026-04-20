/**
 * Booking.com ホスト側予約通知メール パーサー
 *
 * 対象メール (From: noreply@booking.com):
 *   - 新しい予約 (confirmed): 「Booking.com - 新しい予約がありました！ ({id}, {YYYY}年{M}月{D}日{曜})」
 *   - キャンセル (cancelled): 「Booking.com - 予約のキャンセルがありました ({id}, {YYYY}年{M}月{D}日{曜})」
 *   - 予約変更 (changed)   : 「Booking.com - 予約の変更がありました！ ({id}, {YYYY}年{M}月{D}日{曜})」
 *
 * 本文内の抽出可能情報:
 *   - propertyName (施設名、本文冒頭の「{name} Booking confirmation — {id}」など)
 *   - hotel_id (Extranet URL res_id=&hotel_id= から)
 *   - guestName (キャンセルメールの「{name}様のご予約」パターン、新規メールには含まれない)
 *
 * 本文に含まれない情報 (Booking.com は Extranet ログインを前提とするため):
 *   - checkOut date
 *   - ゲスト人数
 *   - 合計金額
 */

// ======================================================
// 純粋関数群
// ======================================================

// 件名から reservationId と チェックイン日 (年月日) を抽出
// 「Booking.com - {...} ({id}, {YYYY}年{M}月{D}日{曜})」形式
function parseSubject(subject) {
  const s = String(subject || "");
  // 括弧内: (数字8-12桁, YYYY年M月D日...) 半角/全角カッコ両対応
  const m = /[（(]\s*(\d{8,12})\s*,\s*(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(s);
  if (!m) return null;
  return {
    reservationId: m[1],
    checkIn: {
      year: +m[2],
      month: +m[3],
      day: +m[4],
    },
  };
}

// 件名から種別判定
function detectSubjectKind(subject) {
  const s = String(subject || "");
  if (!/Booking\.com/i.test(s)) return "unknown";
  if (/新しい予約|new reservation/i.test(s)) return "confirmed";
  if (/キャンセル|cancellation/i.test(s)) return "cancelled";
  if (/変更|modification/i.test(s)) return "changed";
  return "unknown";
}

// 本文から reservationId を抽出 (件名と冗長だが fallback)
// 「Booking confirmation — {id}」「Cancellation — {id}」等の行
function extractReservationIdFromBody(body) {
  const s = String(body || "");
  // Booking confirmation — 5750794035 / Cancellation — 5750794035
  const m = /(?:Booking confirmation|Cancellation|Modification)\s*[—\-–]\s*(\d{8,12})/.exec(s);
  if (m) return m[1];
  // URL から: res_id=5750794035
  const u = /res_id=(\d{8,12})/.exec(s);
  return u ? u[1] : null;
}

// 本文から施設名を抽出 (「{propertyName} Booking confirmation — {id}」の先頭部分)
function extractPropertyName(body) {
  const s = String(body || "");
  const m = /([^\n]+?)\s+(?:Booking confirmation|Cancellation|Modification)\s*[—\-–]\s*\d{8,12}/.exec(s);
  if (!m) return null;
  // 「セキュリティ対策のため...」等の Booking.com のヘッダ文言を誤検出しないよう、
  // 短すぎる名前は除外 (施設名は 2 文字以上の想定)
  const name = m[1].trim();
  // Booking.com の共通ヘッダ文言を除去
  return name.length >= 2 ? name : null;
}

// 本文から hotel_id を抽出 (Extranet URL パラメータ)
function extractHotelId(body) {
  const m = /hotel_id=(\d+)/.exec(String(body || ""));
  return m ? m[1] : null;
}

// 本文からゲスト名を抽出 (キャンセルメールの「{name}様のご予約」パターン)
function extractGuestName(body) {
  const m = /(.+?)様のご予約\s*[（(]\s*予約番号/.exec(String(body || ""));
  if (!m) return null;
  const name = m[1].trim();
  // 改行後の文字列を拾った場合に末尾空白・行頭の接続詞を除去
  const cleaned = name.split(/[\n\r]/).pop().trim();
  return cleaned.length >= 1 ? cleaned : null;
}

function pad2(n) { return String(n).padStart(2, "0"); }

// ======================================================
// 統合パーサー
// ======================================================

function parseBookingEmail(input) {
  const subject = (input && input.subject) || "";
  const body = (input && input.body) || "";

  const kind = detectSubjectKind(subject);
  const subjectInfo = parseSubject(subject);
  const reservationCode = (subjectInfo && subjectInfo.reservationId) || extractReservationIdFromBody(body);
  const guestName = extractGuestName(body);
  const propertyName = extractPropertyName(body);
  const hotelId = extractHotelId(body);

  let checkIn = null;
  if (subjectInfo) {
    checkIn = {
      date: `${subjectInfo.checkIn.year}-${pad2(subjectInfo.checkIn.month)}-${pad2(subjectInfo.checkIn.day)}`,
      time: null, // Booking.com メールに時刻は含まれない
    };
  }

  return {
    platform: "Booking.com",
    kind,
    reservationCode,
    guestName,          // cancelled のみ通常取得可、confirmed は null
    guestFirstName: null, // Booking.com メールには first/last 分離情報なし
    checkIn,
    checkOut: null,     // Booking.com メールに含まれない (Extranet 参照要)
    guestCount: null,   // 同上
    totalAmount: null,  // 同上
    // Booking.com 固有メタ情報
    propertyName,
    hotelId,
  };
}

module.exports = {
  parseBookingEmail,
  _pure: {
    parseSubject,
    detectSubjectKind,
    extractReservationIdFromBody,
    extractPropertyName,
    extractHotelId,
    extractGuestName,
  },
};
