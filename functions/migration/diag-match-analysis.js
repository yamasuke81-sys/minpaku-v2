#!/usr/bin/env node
/**
 * emailVerifications と bookings を突き合わせて、なぜ突合が 0 件なのかを分析
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

async function main() {
  console.log("========== emailVerifications (最新 20 件) ==========");
  const ev = await db.collection("emailVerifications").orderBy("createdAt", "desc").limit(20).get();
  for (const d of ev.docs) {
    const data = d.data();
    const info = data.extractedInfo || {};
    console.log(`[${data.matchStatus}] ${data.platform} / ${info.kind} / code=${info.reservationCode || "-"} / CI=${(info.checkIn && info.checkIn.date) || "-"}`);
    console.log(`  件名: ${(data.subject || "").slice(0, 60)}`);
    console.log(`  guestName: ${info.guestName || info.guestFirstName || "-"}`);
  }

  console.log("\n========== bookings の icalUid パターン (最新 15 件) ==========");
  const bookings = await db.collection("bookings")
    .where("propertyId", "==", "tsZybhDMcPrxqgcRy7wp")
    .orderBy("checkIn", "desc")
    .limit(15)
    .get();
  for (const d of bookings.docs) {
    const data = d.data();
    console.log(`${d.id}`);
    console.log(`  source=${data.source} status=${data.status} checkIn=${data.checkIn}`);
    console.log(`  icalUid=${data.icalUid}`);
    console.log(`  icalUrl=${(data.icalUrl || "").slice(0, 80)}`);
    if (data.notes) console.log(`  notes=${String(data.notes).slice(0, 100)}`);
    if (data._icalOriginalName) console.log(`  _icalOriginalName=${data._icalOriginalName}`);
    if (data.guestName) console.log(`  guestName=${data.guestName}`);
  }

  console.log("\n========== 特定 reservationCode (HMJENWXRMS) で bookings 検索 ==========");
  const hmCode = "HMJENWXRMS";
  const allBookings = await db.collection("bookings").where("propertyId", "==", "tsZybhDMcPrxqgcRy7wp").get();
  const matches = allBookings.docs.filter((d) => {
    const data = d.data();
    const uid = String(data.icalUid || "").toLowerCase();
    const notes = String(data.notes || "").toLowerCase();
    return uid.includes(hmCode.toLowerCase()) || notes.includes(hmCode.toLowerCase());
  });
  console.log(`HMJENWXRMS を icalUid or notes に含む bookings: ${matches.length} 件`);
  matches.forEach((d) => {
    const data = d.data();
    console.log(`- ${d.id}: icalUid=${data.icalUid} notes=${(data.notes || "").slice(0, 80)}`);
  });

  console.log("\n========== Booking.com の予約 ID (5750794035) で bookings 検索 ==========");
  const bookingId = "5750794035";
  const matches2 = allBookings.docs.filter((d) => {
    const data = d.data();
    return String(data.icalUid || "").includes(bookingId) ||
           String(data.notes || "").includes(bookingId);
  });
  console.log(`5750794035 を含む bookings: ${matches2.length} 件`);
  matches2.forEach((d) => {
    const data = d.data();
    console.log(`- ${d.id}: source=${data.source} icalUid=${data.icalUid}`);
  });
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
