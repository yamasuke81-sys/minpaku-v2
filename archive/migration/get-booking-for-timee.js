#!/usr/bin/env node
// bookingId + visibility から、タイミー自動入力に必要な URL とフォーム値を JSON 出力する。
// /timee-post slash command (Dispatch 自動投稿フロー) から呼ばれる。
//
// 使い方:
//   node functions/migration/get-booking-for-timee.js <bookingId> <visibility>
//
//   visibility: "group_limited" | "new_worker_for_client_limited"
//
// 出力例 (stdout 1行 JSON):
//   {"ok":true,"url":"https://...#date=...","propertyName":"YADO KOMACHI Hiroshima","propertyId":"...","checkOut":"2026-05-29","timeeAutofill":{...},"guestName":"...","source":"Airbnb"}

const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

function buildTimeeAutofillUrl(tf, checkOut, visibility) {
  if (!tf || !tf.baseUrl || !checkOut) return null;
  const url = new URL(tf.baseUrl);
  url.searchParams.set("openExternalBrowser", "1");
  const params = new URLSearchParams();
  params.set("date", checkOut);
  if (tf.start) params.set("start", tf.start);
  if (tf.end) params.set("end", tf.end);
  if (tf.restMin != null) params.set("restMin", String(tf.restMin));
  if (tf.workers) params.set("workers", String(tf.workers));
  params.set("visibility", visibility);
  if (visibility === "group_limited" && tf.groupIds) params.set("groupIds", tf.groupIds);
  if (tf.wage) params.set("wage", String(tf.wage));
  if (tf.transport != null) params.set("transport", String(tf.transport));
  if (tf.autoMsg != null) params.set("autoMsg", tf.autoMsg ? "true" : "false");
  if (tf.autoMsgTarget) params.set("autoMsgTarget", tf.autoMsgTarget);
  return `${url.toString()}#${params.toString()}`;
}

(async () => {
  const bookingId = process.argv[2];
  const visibility = process.argv[3] || "group_limited";
  if (!bookingId) {
    console.log(JSON.stringify({ ok: false, error: "bookingId is required" }));
    process.exit(1);
  }
  if (!["group_limited", "new_worker_for_client_limited"].includes(visibility)) {
    console.log(JSON.stringify({ ok: false, error: `invalid visibility: ${visibility}` }));
    process.exit(1);
  }

  const bookingDoc = await db.collection("bookings").doc(bookingId).get();
  if (!bookingDoc.exists) {
    console.log(JSON.stringify({ ok: false, error: `booking ${bookingId} not found` }));
    process.exit(1);
  }
  const booking = bookingDoc.data();
  if (!booking.propertyId) {
    console.log(JSON.stringify({ ok: false, error: "booking has no propertyId" }));
    process.exit(1);
  }
  const propDoc = await db.collection("properties").doc(booking.propertyId).get();
  if (!propDoc.exists) {
    console.log(JSON.stringify({ ok: false, error: `property ${booking.propertyId} not found` }));
    process.exit(1);
  }
  const property = propDoc.data();
  if (!property.timeeAutofill) {
    console.log(JSON.stringify({ ok: false, error: "property has no timeeAutofill config" }));
    process.exit(1);
  }
  const url = buildTimeeAutofillUrl(property.timeeAutofill, booking.checkOut, visibility);
  if (!url) {
    console.log(JSON.stringify({ ok: false, error: "failed to build URL" }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    url,
    bookingId,
    propertyId: booking.propertyId,
    propertyName: property.name || "",
    checkOut: booking.checkOut,
    checkIn: booking.checkIn || "",
    guestName: booking.guestName || "",
    source: booking.source || "",
    visibility,
    timeeAutofill: property.timeeAutofill,
  }));
  process.exit(0);
})().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String(e) }));
  process.exit(1);
});
