/**
 * Airbnb 新件名書式で壊れた guestName の一括是正（単発スクリプト）
 *
 * Airbnb が 2026-06 下旬から件名を
 *   旧: 「予約確定 - {名前}さんが{M}月{D}日ご到着です」
 *   新: 「予約確定 - {M}月{D}日に{名前}さんが到着予定」
 * の2書式併用に変えたが、パーサーが旧書式しか見ていなかったため、
 * 新書式の予約は guestName が「8月22日に宮 瀬Takumi」のように日付ごと保存されていた。
 * (監査 民泊業務監査4番 で判明。パーサー本体は utils/emailParser/airbnb.js で修正済み)
 *
 * 名簿提出済みの予約は onGuestFormSubmit が名簿の氏名で上書きするので既に正常。
 * 残っているのは名簿未提出の予約だけ。
 *
 * 使い方:
 *   node scripts/fix-airbnb-subject-guestname.mjs          # dry-run
 *   node scripts/fix-airbnb-subject-guestname.mjs --apply
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
const { _pure } = require("../functions/utils/emailParser/airbnb.js");

const APPLY = process.argv.includes("--apply");

admin.initializeApp({
  credential: admin.credential.cert(
    require("../.credentials/minpaku-v2-firebase-adminsdk-fbsvc-dd291cd17e.json")
  ),
});
const db = admin.firestore();

// guestName 先頭の「{M}月{D}日に」を剥がす。件名が残っていれば修正後パーサーで引き直す
function repair(d) {
  const cur = String(d.guestName || "");
  if (!/^\s*\d{1,2}月\d{1,2}日に/.test(cur)) return null;
  const fromSubject = _pure.extractGuestNameFromSubject(d.emailSubject || "");
  const fixed = (fromSubject || cur.replace(/^\s*\d{1,2}月\d{1,2}日に\s*/, "")).trim();
  return fixed && fixed !== cur ? fixed : null;
}

async function main() {
  console.log(`=== ${APPLY ? "APPLY(実書き込み)" : "DRY-RUN(確認のみ)"} ===\n`);
  // checkIn が今日以降 = これから接客する予約だけを対象にする(過去の記録は触らない)
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const snap = await db.collection("bookings").where("checkIn", ">=", today).get();

  let n = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.status !== "confirmed") continue;
    const fixed = repair(d);
    if (!fixed) continue;
    n++;
    console.log(`${d.checkIn} ${doc.id}`);
    console.log(`   件名 : ${d.emailSubject || "(なし)"}`);
    console.log(`   氏名 : "${d.guestName}" → "${fixed}"`);
    if (APPLY) {
      // bookings.updatedAt は Timestamp 型。ISO文字列を書くと型が崩れるので serverTimestamp を使う
      await doc.ref.update({
        guestName: fixed,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log("   → 更新しました");
    }
  }
  console.log(`\n対象 ${n} 件${APPLY ? " を更新しました" : "(--apply で実行)"}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
