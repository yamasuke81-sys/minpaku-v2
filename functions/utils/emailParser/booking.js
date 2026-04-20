/**
 * Booking.com 予約確認メール パーサー (stub 実装)
 *
 * STATUS: 未完成 — 2026-04 時点でやますけの Gmail にホスト側通知は届いていない
 * (Booking.com は Extranet ダッシュボード + BEDS24 経由で通知するため)。
 *
 * 将来ホスト側メールが届くようになったら、以下フィールドを抽出する本実装を追加:
 *   - 予約 ID (10 桁数字、例: 5622417501)
 *   - ゲスト名
 *   - チェックイン / チェックアウト
 *   - 宿泊人数 (大人 / 子供 / 幼児)
 *   - 合計金額
 *
 * 現状は emailVerifications/ に生データを保存し、手動で照合する運用を想定。
 */

// Booking.com ゲスト側メールに含まれる「予約番号」(10 桁数字) の抽出
// ホスト側メールが届くようになったら、共通ヘルパとして利用可能
function extractReservationIdLike(body) {
  const m = /予約\s*(?:ID|番号|No\.?)[\s:：]*(\d{8,12})/i.exec(String(body || ""));
  return m ? m[1] : null;
}

function parseBookingEmail(input) {
  const subject = (input && input.subject) || "";
  const body = (input && input.body) || "";

  // 現状は reservationCode (予約 ID) だけ best-effort で拾う
  const reservationCode = extractReservationIdLike(body);

  return {
    platform: "Booking.com",
    kind: /予約.*確定|confirmed/i.test(subject) ? "confirmed" : "unknown",
    reservationCode,
    guestName: null,
    guestFirstName: null,
    checkIn: null,
    checkOut: null,
    guestCount: null,
    totalAmount: null,
    _note: "Booking.com parser is a stub (no host-side samples yet)",
  };
}

module.exports = {
  parseBookingEmail,
  _pure: { extractReservationIdLike },
};
