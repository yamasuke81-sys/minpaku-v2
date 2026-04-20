/**
 * OTA 予約メールパーサー ディスパッチャ
 *
 * emailVerifications/{id} に保存された rawBodyText / subject / fromHeader から、
 * プラットフォーム判定 → 各 parser に委譲 → 構造化結果 (extractedInfo) を返す
 */
const { parseAirbnbEmail } = require("./airbnb");
const { parseBookingEmail } = require("./booking");

// 送信元ヘッダからプラットフォームを判定
function detectPlatform(fromHeader) {
  const s = String(fromHeader || "").toLowerCase();
  if (s.includes("airbnb")) return "Airbnb";
  if (s.includes("booking.com")) return "Booking.com";
  return null;
}

/**
 * メールをパースして構造化情報を返す
 * @param {{
 *   subject?: string,
 *   body?: string,               // text/plain 推奨
 *   fromHeader?: string,
 *   platform?: string,           // 明示指定があればそれを優先
 *   receivedAt?: Date|string|number,
 * }} input
 * @returns 各 parser の出力形式 (platform / kind / reservationCode / ...)
 */
function parseEmail(input) {
  const platform = (input && input.platform) || detectPlatform(input && input.fromHeader);
  switch (platform) {
    case "Airbnb":
      return parseAirbnbEmail(input);
    case "Booking.com":
      return parseBookingEmail(input);
    default:
      return {
        platform: "Unknown",
        kind: "unknown",
        reservationCode: null,
        guestName: null,
        guestFirstName: null,
        checkIn: null,
        checkOut: null,
        guestCount: null,
        totalAmount: null,
      };
  }
}

module.exports = {
  parseEmail,
  detectPlatform,
  // 個別 parser も公開 (テスト / 明示呼出用)
  parseAirbnbEmail,
  parseBookingEmail,
};
