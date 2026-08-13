/**
 * the Terrace 長浜 2026-08-26 予約のキャンセル痕跡を除去（単発スクリプト）
 *
 * status="confirmed" なのに cancelledAt / cancelReason / cancelSource が残っている。
 * 原因: syncIcal が同一UIDのCLOSEDイベント再出現で status だけ confirmed に戻し、
 *       cancel 3点セットを消していないため（syncIcal.js の bookingData に delete が無い）。
 *
 * 日程(checkIn/checkOut)は変更しないため onBookingChange の booking_change 通知は発火しない。
 *
 * 使い方:
 *   node scripts/clean-cancel-residue-20260826.mjs          # dry-run
 *   node scripts/clean-cancel-residue-20260826.mjs --apply
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");
const BOOKING_ID = "ical_7253811f3931278394cb928226739462@booking.com";

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

  console.log(`status       : ${d.status}`);
  console.log(`cancelledAt  : ${d.cancelledAt ? d.cancelledAt.toDate().toISOString() : "(なし)"}`);
  console.log(`cancelReason : ${d.cancelReason || "(なし)"}`);
  console.log(`cancelSource : ${d.cancelSource || "(なし)"}`);

  // 安全ガード: confirmed 以外なら触らない（本当にキャンセル中の予約を壊さない）
  if (d.status !== "confirmed") {
    throw new Error(`status が confirmed ではないため中止: ${d.status}`);
  }
  if (!d.cancelledAt && !d.cancelReason && !d.cancelSource) {
    console.log("\n痕跡なし。処理不要。");
    return;
  }

  if (!APPLY) {
    console.log("\n(dry) cancelledAt / cancelReason / cancelSource を削除予定");
    return;
  }

  const del = admin.firestore.FieldValue.delete();
  await ref.update({
    cancelledAt: del,
    cancelReason: del,
    cancelSource: del,
    // 経緯は残す（キャンセル→同名で別予約番号の再予約が同一docへ照合された）
    revivedAt: admin.firestore.FieldValue.serverTimestamp(),
    revivedNote:
      "2026-08-12: 予約5990618442がキャンセル→同ゲストが5167790262で再予約。Booking.comのiCalは同日程で同一UIDのCLOSEDを返すため同一docが再利用され、statusのみconfirmedに復帰しキャンセル痕跡が残っていたものを除去",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log("\n✅ キャンセル痕跡を削除しました");

  const after = (await ref.get()).data();
  console.log("\n=== 検証 ===");
  console.log(`status       : ${after.status}`);
  console.log(`cancelledAt  : ${after.cancelledAt ? "残存!" : "削除済み"}`);
  console.log(`cancelReason : ${after.cancelReason ? "残存!" : "削除済み"}`);
  console.log(`cancelSource : ${after.cancelSource ? "残存!" : "削除済み"}`);
}

main()
  .then(() => console.log("\n完了"))
  .catch((e) => {
    console.error("エラー:", e.message);
    process.exitCode = 1;
  });
