/**
 * the Terrace 長浜 2026-08-26 予約の人数を新予約の実値に是正（単発スクリプト）
 *
 * 旧予約 5990618442 (キャンセル済) の手入力値 4名 が残っていた。
 * Booking.com エクストラネットで新予約 5167790262 を確認 → 大人3名。
 * あわせて予約番号を保存し、次回以降は番号で厳密に突合できるようにする。
 *
 * 日程は変えないので onBookingChange の booking_change 通知は発火しない。
 *
 * 使い方:
 *   node scripts/fix-terrace-20260826-guestcount.mjs          # dry-run
 *   node scripts/fix-terrace-20260826-guestcount.mjs --apply
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");
const BOOKING_ID = "ical_7253811f3931278394cb928226739462@booking.com";
const NEW_COUNT = 3;                    // Booking.com 実画面: 予約人数 大人3名
const NEW_CODE = "5167790262";          // 新予約番号 (旧= 5990618442)

admin.initializeApp({
  credential: admin.credential.cert(
    require("../.credentials/minpaku-v2-firebase-adminsdk-fbsvc-dd291cd17e.json")
  ),
});
const db = admin.firestore();

async function main() {
  console.log(`=== ${APPLY ? "APPLY(実書き込み)" : "DRY-RUN(確認のみ)"} ===\n`);
  const ref = db.collection("bookings").doc(BOOKING_ID);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("予約が存在しません");
  const d = snap.data();

  console.log(`status            : ${d.status}`);
  console.log(`guestName         : ${d.guestName}`);
  console.log(`guestCount        : ${d.guestCount} → ${NEW_COUNT}`);
  console.log(`otaReservationCode: ${d.otaReservationCode || "(未設定)"} → ${NEW_CODE}`);

  if (d.status !== "confirmed") throw new Error(`status が confirmed ではないため中止: ${d.status}`);

  if (!APPLY) { console.log("\n(dry) 上記を書き込み予定"); return; }

  await ref.update({
    guestCount: NEW_COUNT,
    otaReservationCode: NEW_CODE,
    guestCountSource: "booking_extranet_5167790262",
    lastManualEditAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log("\n✅ 反映しました");

  const a = (await ref.get()).data();
  console.log(`検証: guestCount=${a.guestCount} / otaReservationCode=${a.otaReservationCode}`);
}

main()
  .then(() => console.log("\n完了"))
  .catch((e) => { console.error("エラー:", e.message); process.exitCode = 1; });
