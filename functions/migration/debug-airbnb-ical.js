/**
 * Airbnb iCal デバッグスクリプト (readonly)
 *
 * the Terrace 長浜 (propertyId=tsZybhDMcPrxqgcRy7wp) の Airbnb iCal URL を
 * syncSettings から取得し、直接フェッチして 2026-05 のイベント生データを出力する。
 *
 * 目的:
 *   syncIcal.js が 2026-05-04〜2026-05-06 の Airbnb 予約を "Reserved" ブロック扱いで
 *   キャンセルにしている原因が
 *   (A) Airbnb iCal 側の Reservation URL 付与遅延 か
 *   (B) syncIcal.js の判定ロジックのバグ か
 *   を特定する。
 *
 * 実行: node functions/migration/debug-airbnb-ical.js
 *
 * 書き込みは一切しない。
 */
const admin = require("firebase-admin");
const ical = require("node-ical");

admin.initializeApp({
  projectId: "minpaku-v2",
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();

const TARGET_PROPERTY_ID = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜
const TARGET_MONTH = "2026-05"; // 対象月 (YYYY-MM)
const MAX_DESC_LEN = 500; // DESCRIPTION 出力の最大文字数

function header(tag) {
  console.log(`\n==== ${tag} ====`);
}

// Date または node-ical の DateWithTimeZone から YYYY-MM-DD を取り出す
function toDateStr(v) {
  if (!v) return null;
  try {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === "string") return v.slice(0, 10);
  } catch (_) {}
  return String(v);
}

(async () => {
  header("1. syncSettings 取得");
  const snap = await db
    .collection("syncSettings")
    .where("propertyId", "==", TARGET_PROPERTY_ID)
    .where("platform", "==", "Booking.com")
    .get();

  console.log(`Airbnb syncSettings 件数: ${snap.size}`);
  if (snap.empty) {
    console.log("該当する syncSettings が見つかりません。終了します。");
    return;
  }

  const settings = [];
  snap.forEach((doc) => {
    const data = doc.data();
    console.log(`- docId: ${doc.id}`);
    console.log(`  icalUrl: ${data.icalUrl}`);
    console.log(`  active: ${data.active}`);
    console.log(`  lastSync: ${data.lastSync ? data.lastSync.toDate().toISOString() : "(none)"}`);
    console.log(`  lastSyncResult: ${data.lastSyncResult || "(none)"}`);
    settings.push({ docId: doc.id, url: data.icalUrl });
  });

  // URL ごとに処理
  for (const { docId, url } of settings) {
    header(`2. iCal フェッチ [${docId}]`);
    console.log(`URL: ${url}`);

    let events;
    try {
      events = await ical.async.fromURL(url);
    } catch (e) {
      console.log(`ERROR: iCal 取得失敗: ${e.message}`);
      continue;
    }

    // VEVENT のみ抽出
    const vevents = Object.values(events).filter((e) => e && e.type === "VEVENT");
    console.log(`VEVENT 総数: ${vevents.length}`);

    // 対象月のイベント抽出
    const targetEvents = vevents.filter((e) => {
      const d = toDateStr(e.start);
      return d && d.startsWith(TARGET_MONTH);
    });

    console.log(`\n${TARGET_MONTH} のイベント数: ${targetEvents.length}`);

    let withResUrl = 0;
    let withoutResUrl = 0;

    for (const ev of targetEvents) {
      const uid = ev.uid || "(no-uid)";
      const summary = ev.summary || "";
      const startStr = toDateStr(ev.start);
      const endStr = toDateStr(ev.end);
      const dateOnly = !!(ev.start && ev.start.dateOnly);
      const desc = ev.description || "";
      const hasResUrl = /reservation url:/i.test(desc);

      if (hasResUrl) withResUrl++;
      else withoutResUrl++;

      let descOut = desc.replace(/\\n/g, "\n");
      if (descOut.length > MAX_DESC_LEN) {
        descOut = descOut.slice(0, MAX_DESC_LEN) + " ...";
      }

      console.log(`\n---- [${uid}] ----`);
      console.log(`SUMMARY: ${summary}`);
      console.log(`DTSTART: ${startStr} (dateOnly: ${dateOnly})`);
      console.log(`DTEND: ${endStr}`);
      console.log(`DESCRIPTION:`);
      console.log(descOut);
      console.log(`HAS_RESERVATION_URL: ${hasResUrl}`);
    }

    header(`3. サマリ [${docId}]`);
    console.log(`${TARGET_MONTH} のイベント総数: ${targetEvents.length}`);
    console.log(`HAS_RESERVATION_URL=true : ${withResUrl}`);
    console.log(`HAS_RESERVATION_URL=false: ${withoutResUrl}`);
  }

  console.log("\n==== 完了 ====");
  process.exit(0);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
