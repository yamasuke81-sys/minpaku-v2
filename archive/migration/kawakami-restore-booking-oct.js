/**
 * 10/11・10/25 Booking.com 予約の応急復元スクリプト (WRITE)
 *
 * 背景:
 *   Booking.com iCal は実予約でも "CLOSED - Not available" としてしか出さず
 *   (プライバシー保護)、syncIcal.js の line 179 で全スキップされる。
 *   syncIcal の cancel 検出ロジックで「iCal に無い」判定になり、先行 ingest
 *   されていた 2 件が cancelled 化されてしまった。
 *
 *   ユーザー確認済の実予約 2 件:
 *     - ical_e3c235c6dc4289a7ed7834d1ee5c0fc3@booking.com (10/11 CI)
 *     - ical_c0c2c596859932432b90dd3071ec5e30@booking.com (10/25 CI)
 *
 * このスクリプトの動作:
 *   1. 上記 2 件を status=confirmed に戻す
 *   2. manualOverride=true フラグを付与
 *   3. syncIcal.js 側で manualOverride=true の予約は cancel 検出の対象外にする
 *      ガード処理と組み合わせて、次回同期で再度 cancelled 化されないようにする
 *
 * 注意: 書き込みを行う。実行前にユーザー確認必須。
 *   dry run モード: 環境変数 DRY_RUN=1 で実行すると書き込みせず対象だけ表示
 */
const admin = require("firebase-admin");

admin.initializeApp({
  projectId: "minpaku-v2",
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();

const TARGET_IDS = [
  "ical_e3c235c6dc4289a7ed7834d1ee5c0fc3@booking.com",
  "ical_c0c2c596859932432b90dd3071ec5e30@booking.com",
];

const DRY_RUN = process.env.DRY_RUN === "1";

(async () => {
  console.log(`==== 10/11・10/25 Booking 予約 応急復元 ${DRY_RUN ? "(DRY RUN)" : ""} ====\n`);

  for (const id of TARGET_IDS) {
    const ref = db.collection("bookings").doc(id);
    const snap = await ref.get();
    if (!snap.exists) {
      console.log(`[SKIP] ${id}: ドキュメント存在せず`);
      continue;
    }
    const data = snap.data();
    console.log(`[TARGET] ${id}`);
    console.log(`  checkIn: ${data.checkIn}, checkOut: ${data.checkOut}`);
    console.log(`  current status: ${data.status}`);
    console.log(`  source: ${data.source}`);
    console.log(`  guestName: "${data.guestName || ""}"`);

    if (DRY_RUN) {
      console.log(`  [DRY RUN] status → "confirmed", manualOverride=true を付与予定`);
      continue;
    }

    await ref.update({
      status: "confirmed",
      manualOverride: true,
      manualOverrideReason: "Booking.com iCal は CLOSED しか出さないため syncIcal で cancelled 化されたが、実予約として手動復元",
      manualOverrideAt: admin.firestore.FieldValue.serverTimestamp(),
      cancelledAt: admin.firestore.FieldValue.delete(),
      cancelReason: admin.firestore.FieldValue.delete(),
    });
    console.log(`  [OK] status="confirmed" + manualOverride=true に更新`);
  }

  console.log("\n==== 完了 ====");
  process.exit(0);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
