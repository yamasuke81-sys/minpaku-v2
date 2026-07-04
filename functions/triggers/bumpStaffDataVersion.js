/**
 * スタッフ向けデータ更新通知トリガー
 *
 * staff は bookings/guestRegistrations を onSnapshot 監視できない (rules で遮断) ため、
 * PII を含まない軽量カウンタ meta/staffDataVersion をこのトリガーが bump する。
 * スタッフ端末はこのカウンタ1件だけを onSnapshot 監視し、変化時に staff-data API を再取得する。
 *
 * onBookingChange (重関数・OOM歴あり) には相乗りせず独立トリガーにする。
 * onDocumentWritten で create/update/delete を1本で網羅。
 *
 * 更新は「スタッフ表示に関わるフィールドが変わった時のみ」bump する。
 * → syncIcal が5分毎に全予約 doc の updatedAt を洗い替えても発火せず、
 *   スタッフ端末が5分毎に無駄な再取得をするのを防ぐ。
 */
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");

// スタッフのスケジュール表示に影響する booking フィールド (これらが変わった時だけ bump)
const STAFF_BOOKING_FIELDS = [
  "propertyId", "propertyName", "checkIn", "checkOut", "checkInTime", "checkOutTime",
  "guestCount", "source", "bookingSite", "status", "pendingApproval",
  "timeeStatus", "timeePostedUrl",
];

// スタッフ表示に影響する guestRegistration フィールド
const STAFF_GUEST_FIELDS = [
  "bookingId", "propertyId", "checkIn", "checkOut", "checkInTime", "checkOutTime",
  "guestCount", "guestCountInfants", "bbq", "carCount", "paidParking", "bedChoice",
  "nationality", "parking", "transport", "vehicleTypes", "bookingSite", "source",
];

// 比較用に正規化 (Timestamp はミリ秒、配列/オブジェクトは JSON 文字列化)
function norm_(v) {
  if (v == null) return "";
  if (typeof v === "object") {
    if (v.toMillis) { try { return "T" + v.toMillis(); } catch (_) { /* fallthrough */ } }
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  }
  return String(v);
}

function changedFields_(before, after, fields) {
  for (const f of fields) {
    if (norm_(before ? before[f] : undefined) !== norm_(after ? after[f] : undefined)) return true;
  }
  return false;
}

async function bump_(field) {
  await admin.firestore().doc("meta/staffDataVersion").set(
    { [field]: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
}

async function onBookingWritten(event) {
  try {
    const b = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    const a = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    // 作成/削除は無条件、更新は関連フィールド差分時のみ
    if (!b || !a || changedFields_(b, a, STAFF_BOOKING_FIELDS)) {
      await bump_("bookingsV");
    }
  } catch (e) {
    console.error("[bumpStaffDataVersion/booking]", e);
  }
}

async function onGuestRegistrationWritten(event) {
  try {
    const b = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    const a = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    if (!b || !a || changedFields_(b, a, STAFF_GUEST_FIELDS)) {
      await bump_("guestsV");
    }
  } catch (e) {
    console.error("[bumpStaffDataVersion/guestReg]", e);
  }
}

module.exports = { onBookingWritten, onGuestRegistrationWritten };
