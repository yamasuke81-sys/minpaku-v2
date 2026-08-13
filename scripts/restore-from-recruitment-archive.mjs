/**
 * recruitmentArchives から募集・シフトを復旧する汎用スクリプト
 *
 * キャンセル連動削除などで消えた募集(responses=スタッフの回答)・シフト(staffIds)は
 * onBookingChange が削除前に `recruitmentArchives/{kind}__{docId}` へ退避している。
 * ここから中身を確認し、必要なら現在の募集/シフトへ書き戻す。
 *
 * 通知について:
 *   募集の responses を増やすと onRecruitmentChange が notifyByKey("recruit_response") を呼ぶ。
 *   物件の channelOverrides.recruit_response.enabled=false なら送信されない(lineNotify.js:508)。
 *   有効な物件で通知を出したくない場合は --check で先に確認すること。
 *
 * 使い方:
 *   # 予約に紐づく退避を一覧
 *   node scripts/restore-from-recruitment-archive.mjs --booking <bookingId>
 *   # 退避の中身を表示
 *   node scripts/restore-from-recruitment-archive.mjs --show recruitment__<docId>
 *   # 回答だけを現在の募集へ書き戻す (--apply で実書き込み)
 *   node scripts/restore-from-recruitment-archive.mjs --responses-to <現在の募集ID> --from recruitment__<docId> [--apply]
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin");

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const APPLY = argv.includes("--apply");

admin.initializeApp({
  credential: admin.credential.cert(
    require("../.credentials/minpaku-v2-firebase-adminsdk-fbsvc-dd291cd17e.json")
  ),
});
const db = admin.firestore();

const fmt = (v) => {
  if (v == null) return "";
  if (typeof v.toDate === "function") return v.toDate().toISOString().replace("T", " ").slice(0, 16);
  return String(v);
};

function printResponses(responses) {
  for (const r of responses || []) {
    console.log(`    - ${r.staffName || r.staffId}: ${r.response}` +
      `${r.reason ? ` (理由: ${r.reason})` : ""}` +
      `${r.respondedAt ? ` @${fmt(r.respondedAt)}` : ""}`);
  }
}

async function listByBooking(bookingId) {
  const snap = await db.collection("recruitmentArchives").where("bookingId", "==", bookingId).get();
  if (snap.empty) { console.log(`退避なし (bookingId=${bookingId})`); return; }
  console.log(`退避 ${snap.size} 件 (bookingId=${bookingId})\n`);
  for (const d of snap.docs) {
    const a = d.data();
    console.log(`[${d.id}]`);
    console.log(`  kind=${a.kind} workType=${a.workType} date=${a.checkoutDate || ""} reason=${a.reason}`);
    console.log(`  status=${a.status || ""} 確定=${a.selectedStaff || "(なし)"} 回答=${a.responseCount}件 削除=${fmt(a.deletedAt)}`);
    printResponses((a.data || {}).responses);
    console.log("");
  }
}

async function show(archiveId) {
  const d = await db.collection("recruitmentArchives").doc(archiveId).get();
  if (!d.exists) throw new Error(`退避が見つかりません: ${archiveId}`);
  console.log(JSON.stringify(d.data(), null, 1));
}

async function restoreResponses(archiveId, targetRecId) {
  const a = await db.collection("recruitmentArchives").doc(archiveId).get();
  if (!a.exists) throw new Error(`退避が見つかりません: ${archiveId}`);
  const src = a.data();
  if (src.kind !== "recruitment") throw new Error(`kind が recruitment ではありません: ${src.kind}`);
  const responses = ((src.data || {}).responses) || [];
  if (responses.length === 0) { console.log("退避側に回答がありません。処理不要。"); return; }

  const ref = db.collection("recruitments").doc(targetRecId);
  const cur = await ref.get();
  if (!cur.exists) throw new Error(`復元先の募集がありません: ${targetRecId}`);
  const curResp = cur.data().responses || [];

  console.log(`復元元: ${archiveId} (回答${responses.length}件)`);
  printResponses(responses);
  console.log(`復元先: ${targetRecId} (現在の回答${curResp.length}件, status=${cur.data().status})`);

  if (curResp.length > 0) {
    console.log("⚠️ 復元先に既に回答があります。上書きせず中止します(手動確認が必要)。");
    return;
  }
  if (!APPLY) { console.log("\n(dry) --apply を付けると書き戻します"); return; }

  await ref.update({
    responses,
    responsesRestoredAt: admin.firestore.FieldValue.serverTimestamp(),
    responsesRestoredFrom: archiveId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`\n✅ 回答 ${responses.length}件 を ${targetRecId} へ復元しました`);
}

async function main() {
  const booking = arg("--booking");
  const showId = arg("--show");
  const to = arg("--responses-to");
  const from = arg("--from");

  if (booking) return listByBooking(booking);
  if (showId) return show(showId);
  if (to && from) return restoreResponses(from, to);

  console.log("使い方:");
  console.log("  --booking <bookingId>                       予約に紐づく退避を一覧");
  console.log("  --show <archiveId>                          退避の中身をJSONで表示");
  console.log("  --responses-to <募集ID> --from <archiveId> [--apply]   回答を書き戻す");
}

main()
  .then(() => console.log("\n完了"))
  .catch((e) => { console.error("エラー:", e.message); process.exitCode = 1; });
