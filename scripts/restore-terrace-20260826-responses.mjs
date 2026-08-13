/**
 * the Terrace 長浜 8/26(直前点検)・8/27(清掃) のスタッフ回答(◎△×)を
 * Firestore バックアップから復元する（単発スクリプト）
 *
 * 背景:
 *   2026-08-12 14:54 のキャンセル連動削除で募集ドキュメントごと消えたため、
 *   responses(回答) が失われた。確定状況は Cloud Logging から復元済みだが、
 *   回答は痕跡が無い(recruit_response 通知はテラスで enabled=false のため
 *   LINE/Discord/メールのどこにも控えが残らない)。
 *   → キャンセル前(2026-08-11T22:29:50Z)の自動バックアップを一時DB
 *     `recover-0813` へ復元し、そこから responses を読み出して本番へ書き戻す。
 *
 * 通知は出ない:
 *   onRecruitmentChange は responses が増えたときだけ notifyByKey("recruit_response") を呼ぶが、
 *   テラスの channelOverrides.recruit_response.enabled=false のため lineNotify.js:508 で
 *   全チャネル OFF になり送信されない。念のため実行後にログで確認すること。
 *
 * 使い方:
 *   node scripts/restore-terrace-20260826-responses.mjs          # dry-run(バックアップ側を読むだけ)
 *   node scripts/restore-terrace-20260826-responses.mjs --apply  # 本番へ書き戻し
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");
const BACKUP_DB = "recover-0813";
const BOOKING_ID = "ical_7253811f3931278394cb928226739462@booking.com";

// 復元対象: [バックアップ側の募集ID, 本番側の募集ID, ラベル]
const TARGETS = [
  { label: "直前点検 8/26", from: "1d6yGC6g2RAG9Un5Lkqb", to: "49OfiCD8mEomgR1P8LKl" },
  {
    label: "清掃 8/27",
    from: `auto_${BOOKING_ID}_cleaning_2026-08-27`,
    to: `auto_${BOOKING_ID}_cleaning_2026-08-27`,
  },
];

const cred = admin.credential.cert(
  require("../.credentials/minpaku-v2-firebase-adminsdk-fbsvc-dd291cd17e.json")
);
// 本番DBとバックアップ復元DBの2つを別アプリとして初期化
const prodApp = admin.initializeApp({ credential: cred }, "prod");
const bkApp = admin.initializeApp({ credential: cred }, "backup");
const prod = prodApp.firestore();
const bk = bkApp.firestore();
bk.settings({ databaseId: BACKUP_DB });

const fmt = (v) => {
  if (v == null) return "";
  if (typeof v.toDate === "function") return v.toDate().toISOString().replace("T", " ").slice(0, 16);
  return String(v);
};

async function main() {
  console.log(`=== ${APPLY ? "APPLY(本番へ書き戻し)" : "DRY-RUN(バックアップの中身を確認)"} ===`);
  console.log(`バックアップDB: ${BACKUP_DB} (snapshot 2026-08-11T22:29:50Z)\n`);

  const plans = [];
  const mismatched = [];

  for (const t of TARGETS) {
    const snap = await bk.collection("recruitments").doc(t.from).get();
    if (!snap.exists) {
      console.log(`❌ [${t.label}] バックアップに募集 ${t.from} が見つかりません\n`);
      continue;
    }
    const d = snap.data();
    const responses = Array.isArray(d.responses) ? d.responses : [];

    console.log(`=== [${t.label}] バックアップ側 (${t.from}) ===`);
    console.log(`  status        : ${d.status}`);
    console.log(`  selectedStaff : ${d.selectedStaff || "(なし)"}`);
    console.log(`  checkoutDate  : ${d.checkoutDate}`);
    console.log(`  responses     : ${responses.length}件`);
    for (const r of responses) {
      console.log(`    - ${r.staffName || r.staffId}: ${r.response}` +
        `${r.reason ? ` (理由: ${r.reason})` : ""}` +
        `${r.respondedAt ? ` @${fmt(r.respondedAt)}` : ""}`);
    }

    // 本番側の現状
    const cur = await prod.collection("recruitments").doc(t.to).get();
    if (!cur.exists) {
      console.log(`  ❌ 本番に募集 ${t.to} がありません\n`);
      continue;
    }
    const curData = cur.data();
    const curResp = Array.isArray(curData.responses) ? curData.responses : [];
    const curSel = Array.isArray(curData.selectedStaffIds) ? curData.selectedStaffIds : [];
    console.log(`  本番の現状: status=${curData.status} 確定=${curData.selectedStaff || "(なし)"} responses=${curResp.length}件`);

    if (curResp.length > 0) {
      console.log(`  ⚠️ 既に回答があるため上書きしません(手動確認が必要)\n`);
      continue;
    }
    if (responses.length === 0) {
      console.log(`  → バックアップ側も0件。復元不要\n`);
      continue;
    }

    // ===== 齟齬チェック: 復元済みの確定内容とバックアップの整合を検証 =====
    const bkSel = Array.isArray(d.selectedStaffIds) ? d.selectedStaffIds : [];
    const issues = [];

    // 1) 確定スタッフの集合が一致するか (Cloud Logging から復元した確定内容の答え合わせ)
    const sameSet = bkSel.length === curSel.length && bkSel.every((id) => curSel.includes(id));
    if (!sameSet) {
      issues.push(`確定スタッフ不一致: バックアップ=[${bkSel.join(",")}] / 本番=[${curSel.join(",")}]`);
    }

    // 2) 確定した人が回答一覧にいて、× でないこと
    for (const sid of curSel) {
      const r = responses.find((x) => x.staffId === sid);
      if (!r) { issues.push(`確定者 ${sid} の回答がバックアップに無い`); continue; }
      if (r.response === "×") issues.push(`確定者 ${r.staffName || sid} の回答が × になっている`);
    }

    // 3) 日付が同じ募集か (取り違え防止)
    if (d.checkoutDate !== curData.checkoutDate) {
      issues.push(`日付不一致: バックアップ=${d.checkoutDate} / 本番=${curData.checkoutDate}`);
    }

    if (issues.length > 0) {
      console.log(`  ❌ 齟齬あり — この募集は復元しません:`);
      for (const i of issues) console.log(`     ・${i}`);
      console.log("");
      mismatched.push({ label: t.label, issues });
      continue;
    }

    console.log(`  ✅ 齟齬なし (確定スタッフ一致・確定者は全員◎/△・日付一致)`);
    plans.push({ ...t, responses });
    console.log("");
  }

  if (mismatched.length > 0) {
    console.log("⚠️ 齟齬のあった募集があるため、そこは自動復元していません。上の内容を確認してください。\n");
  }

  if (plans.length === 0) { console.log("復元対象なし。"); return; }

  if (!APPLY) {
    console.log(`(dry) ${plans.length}件の募集へ回答を書き戻す予定`);
    return;
  }

  for (const p of plans) {
    await prod.collection("recruitments").doc(p.to).update({
      responses: p.responses,
      responsesRestoredAt: admin.firestore.FieldValue.serverTimestamp(),
      responsesRestoredFrom: `backup ${BACKUP_DB} / ${p.from}`,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`✅ [${p.label}] 回答 ${p.responses.length}件 を復元`);
  }

  console.log("\n=== 検証 ===");
  for (const p of plans) {
    const a = (await prod.collection("recruitments").doc(p.to).get()).data();
    const rs = a.responses || [];
    console.log(`[${p.label}] status=${a.status} selectedStaff="${a.selectedStaff}" responses=${rs.length}件`);
    for (const r of rs) console.log(`   - ${r.staffName || r.staffId}: ${r.response}`);
  }
}

main()
  .then(() => console.log("\n完了"))
  .catch((e) => { console.error("エラー:", e.message); process.exitCode = 1; });
