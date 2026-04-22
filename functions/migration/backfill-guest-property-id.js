/**
 * 宿泊者名簿 propertyId 既存データ補完スクリプト
 * 実行: cd functions && node migration/backfill-guest-property-id.js
 *
 * 処理:
 *   1. guestRegistrations 全件取得
 *   2. propertyId 未設定のものを対象
 *   3. triggers/onGuestRegistrationCreate.js の inferPropertyId を使って推論
 *   4. 推論できたものだけ update
 *   5. 総数 / 補完成功 / 補完失敗 (曖昧 or ゼロ候補) をログ出力
 */
const admin = require("firebase-admin");
const { inferPropertyId } = require("../triggers/onGuestRegistrationCreate");

// サービスアカウント: GOOGLE_APPLICATION_CREDENTIALS 環境変数を利用
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

async function main() {
  console.log("[backfill] guestRegistrations 全件取得中...");
  const guestsSnap = await db.collection("guestRegistrations").get();
  const guests = guestsSnap.docs;
  console.log(`[backfill] 総数: ${guests.length}`);

  const targets = guests.filter((d) => !d.data().propertyId);
  console.log(`[backfill] propertyId 未設定: ${targets.length} 件`);
  if (targets.length === 0) {
    console.log("[backfill] 補完対象なし。終了。");
    return;
  }

  console.log("[backfill] bookings 全件取得中...");
  const bookingsSnap = await db.collection("bookings").get();
  const bookings = bookingsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  console.log(`[backfill] bookings 総数: ${bookings.length}`);

  let success = 0;
  const failures = [];
  for (const doc of targets) {
    const guest = doc.data();
    const result = inferPropertyId(guest, bookings);
    if (!result) {
      failures.push({
        id: doc.id,
        guestName: guest.guestName || "",
        checkIn: guest.checkIn || "",
        checkOut: guest.checkOut || "",
        bookingSite: guest.bookingSite || guest.source || "",
      });
      continue;
    }
    try {
      await doc.ref.update({
        propertyId: result.propertyId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      success++;
      console.log(
        `  OK id=${doc.id} guest=${guest.guestName || "?"} ci=${guest.checkIn || "?"} ` +
        `→ propertyId=${result.propertyId} (level=${result.level}, from=${result.bookingId})`
      );
    } catch (e) {
      failures.push({ id: doc.id, error: e.message });
      console.error(`  NG id=${doc.id}: ${e.message}`);
    }
  }

  console.log("\n====== 結果サマリ ======");
  console.log(`総数           : ${guests.length}`);
  console.log(`未設定対象     : ${targets.length}`);
  console.log(`補完成功       : ${success}`);
  console.log(`補完失敗       : ${failures.length}`);
  if (failures.length > 0) {
    console.log("\n[失敗詳細]");
    failures.forEach((f) => {
      console.log(`  - ${JSON.stringify(f)}`);
    });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[backfill] fatal:", e);
    process.exit(1);
  });
