#!/usr/bin/env node
// 既存予約の timee_posting 通知を手動で再発火するテスト用スクリプト
// onBookingChange と同じ URL ビルダ + notifyByKey を使う
//
// 使い方:
//   node functions/migration/test-fire-timee-notify.js              # dry-run (対象予約を表示のみ)
//   node functions/migration/test-fire-timee-notify.js --execute    # 実送信

const admin = require("firebase-admin");
admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const isExecute = process.argv.includes("--execute");
const PROPERTY_NAME_HINT = "YADO KOMACHI"; // 対象物件

// onBookingChange.js から流用したロジック (関数 export されていないため再実装)
function buildTimeeAutofillUrl_(tf, checkOut, visibility) {
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
  console.log(`mode: ${isExecute ? "EXECUTE" : "DRY-RUN (実行は --execute)"}`);

  // 対象物件 (YADO KOMACHI Hiroshima) を取得
  const propsSnap = await db.collection("properties").where("active", "==", true).get();
  const property = propsSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .find((p) => (p.name || "").includes(PROPERTY_NAME_HINT));
  if (!property) {
    console.error(`物件 "${PROPERTY_NAME_HINT}" が見つかりません`);
    process.exit(1);
  }
  console.log(`対象物件: ${property.id} : ${property.name}`);
  if (!property.timeeAutofill) {
    console.error("この物件には timeeAutofill 設定がありません");
    process.exit(1);
  }

  // 直近の未来予約を1件選ぶ (複合インデックス回避のため client side filter/sort)
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const bookSnap = await db
    .collection("bookings")
    .where("propertyId", "==", property.id)
    .get();

  const candidates = bookSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((b) => {
      const s = String(b.status || "").toLowerCase();
      if (s.includes("cancel") || b.status === "キャンセル") return false;
      if (!b.checkOut || b.checkOut < today) return false;
      return true;
    })
    .sort((a, b) => String(a.checkOut).localeCompare(String(b.checkOut)));

  if (candidates.length === 0) {
    console.error("対象予約が見つかりません (今日以降の active 予約なし)");
    process.exit(1);
  }

  const booking = candidates[0];
  console.log(`対象予約: ${booking.id} (CO: ${booking.checkOut}, ゲスト: ${booking.guestName || "?"}, ソース: ${booking.source || "?"})`);

  // URL ビルド
  const tf = property.timeeAutofill;
  const urlGroup = buildTimeeAutofillUrl_(tf, booking.checkOut, "group_limited");
  const urlNewWorker = buildTimeeAutofillUrl_(tf, booking.checkOut, "new_worker_for_client_limited");

  // 通知本文 (onBookingChange.js と完全同期)
  const lines = [
    `🕐 タイミー募集依頼【テスト再送】`,
    ``,
    `チェックアウト: ${booking.checkOut}`,
    `物件: ${property.name}`,
  ];
  if (booking.guestName) lines.push(`ゲスト: ${booking.guestName}${booking.source ? `（${booking.source}）` : ""}`);
  lines.push(``, `▼ PC Chrome でタップ → 自動入力 → 「求人を作成」`);
  if (urlGroup) lines.push(``, `▶ グループ限定で募集を作成`, urlGroup);
  if (urlNewWorker) lines.push(``, `▶ 初回ワーカー限定で募集を作成`, urlNewWorker);
  lines.push(``, `▼ スマホ完結 (Dispatch コピペ用)`,
    `/timee-post ${booking.id} group_limited`,
    `/timee-post ${booking.id} new_worker_for_client_limited`);
  const bodyText = lines.join("\n");

  console.log("\n--- 送信予定本文 ---");
  console.log(bodyText);
  console.log("--- ここまで ---\n");

  if (!isExecute) {
    console.log("dry-run のためここで終了。--execute で実送信。");
    process.exit(0);
  }

  // 通知送信
  const { notifyByKey } = require("../utils/lineNotify");
  await notifyByKey(db, "timee_posting", {
    title: `タイミー募集依頼【テスト】: ${booking.checkOut} ${property.name}`,
    body: bodyText,
    vars: {
      date: booking.checkOut,
      checkin: booking.checkIn || "",
      property: property.name || "",
      guest: booking.guestName || "",
      site: booking.source || "",
      url: urlGroup || urlNewWorker || "https://app-new.taimee.co.jp/account",
      urlGroup: urlGroup || "",
      urlNewWorker: urlNewWorker || "",
    },
    propertyId: property.id,
  });

  console.log("✅ 送信完了");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
