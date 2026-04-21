#!/usr/bin/env node
/**
 * 既存 emailVerifications/{id} を再パース + 再突合して update する
 * (プラットフォーム判定バグ等の修正後、既存データを正しい状態に更新するため)
 */
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const { parseEmail, detectPlatform } = require("../utils/emailParser");
const {
  findBookingMatch,
  decideBookingUpdate,
  decideVerificationStatus,
} = require("../utils/emailMatcher");

function guessPlatform(fromHeader) {
  const s = String(fromHeader || "").toLowerCase();
  if (s.includes("airbnb")) return "Airbnb";
  if (s.includes("booking.com")) return "Booking.com";
  return "Unknown";
}

async function main() {
  const snap = await db.collection("emailVerifications").orderBy("createdAt", "desc").limit(50).get();
  console.log(`対象: ${snap.size} 件`);

  for (const doc of snap.docs) {
    const data = doc.data();
    // 正しい platform を再判定
    const correctPlatform = guessPlatform(data.fromHeader);

    const extractedInfo = parseEmail({
      subject: data.subject,
      body: data.rawBodyText || data.rawBodyHtml || "",
      fromHeader: data.fromHeader,
      platform: correctPlatform,
      receivedAt: data.receivedAt && data.receivedAt.toDate ? data.receivedAt.toDate() : new Date(),
    });

    // 突合
    let bookingMatch = null;
    let bookingUpdates = null;
    if (extractedInfo && extractedInfo.reservationCode) {
      try {
        let bookingsQuery = db.collection("bookings");
        if (data.propertyId) {
          bookingsQuery = bookingsQuery.where("propertyId", "==", data.propertyId);
        }
        const bookingsSnap = await bookingsQuery.limit(500).get();
        const bookingsArr = bookingsSnap.docs.map((d) => ({ id: d.id, data: d.data() }));
        bookingMatch = findBookingMatch(bookingsArr, extractedInfo, data.propertyId);

        if (bookingMatch) {
          const emailReceivedMs = data.receivedAt && data.receivedAt.toMillis ? data.receivedAt.toMillis() : null;
          const decision = decideBookingUpdate(bookingMatch.data, extractedInfo, data.messageId, emailReceivedMs);
          if (decision && decision.updates) {
            const bookingPatch = {};
            for (const k of Object.keys(decision.updates)) {
              const v = decision.updates[k];
              if (v && typeof v === "object" && v.__placeholder === "serverTimestamp") {
                bookingPatch[k] = admin.firestore.FieldValue.serverTimestamp();
              } else if (v && typeof v === "object" && v.__placeholder === "timestampFromMs") {
                bookingPatch[k] = admin.firestore.Timestamp.fromMillis(v.ms);
              } else if (v !== undefined) {
                bookingPatch[k] = v;
              }
            }
            await db.collection("bookings").doc(bookingMatch.id).update(bookingPatch);
            bookingUpdates = Object.keys(bookingPatch);
          }
        }
      } catch (e) {
        console.error(`match エラー ${doc.id}: ${e.message}`);
      }
    }

    const matchStatus = decideVerificationStatus(extractedInfo, bookingMatch);

    await doc.ref.update({
      platform: correctPlatform,
      extractedInfo,
      matchStatus,
      matchedBookingId: bookingMatch ? bookingMatch.id : null,
      bookingUpdates,
      reparsedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const shortSubject = (data.subject || "").slice(0, 50);
    const code = (extractedInfo && extractedInfo.reservationCode) || "-";
    const ci = (extractedInfo && extractedInfo.checkIn && extractedInfo.checkIn.date) || "-";
    const marker = bookingMatch ? `→ MATCHED(${bookingMatch.id.slice(0, 30)}...) reason=${bookingMatch.matchReason}` : "";
    console.log(`[${matchStatus}] ${correctPlatform} ${extractedInfo.kind} code=${code} CI=${ci} ${marker}`);
    console.log(`  ${shortSubject}`);
  }

  // 最終カウント
  console.log("\n===== 最終ステータス集計 =====");
  const all = await db.collection("emailVerifications").get();
  const counts = {};
  all.docs.forEach((d) => {
    const s = d.data().matchStatus || "pending";
    counts[s] = (counts[s] || 0) + 1;
  });
  Object.entries(counts).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
