// ugc-past-guest-mailer — 過去ゲストへのUGCキャンペーン案内を送る(週15通ローリング配信)
//
// 設計SSOT: setouchi-stay-sites/marketing/UGC_CASHBACK_CAMPAIGN.md §5-D
// 文面は functions/utils/ugcFollowMail-logic.js の buildUgcPastGuestMail(純粋関数・テスト済み)。
// 送信経路は v2 の通知メールと同じ(物件の senderGmail の Gmail API)。BCC一斉ではなく1通ずつ送る。
//
// 実行:
//   node scripts/ugc-past-guest-mailer.mjs                    # ドライラン: 今回送る15名と文面サンプルを表示(送らない)
//   node scripts/ugc-past-guest-mailer.mjs --send             # ★実際に送信する(週1回・15通)
//   node scripts/ugc-past-guest-mailer.mjs --limit 5 --send   # 件数を変える
//   node scripts/ugc-past-guest-mailer.mjs --test a@b.com     # そのアドレスにテラス文面のテストメールを1通送る
//
// 安全装置:
//   ・送信済みは Firestore marketingSends/{emailKey} に記録し、二度と送らない(再実行しても安全)
//   ・送信直前にも配信停止(marketingSuppressions)を照合する
//   ・チェックアウト後フォローメール(ugcFollowMail)が送った相手もスキップ(二重案内防止)
//   ・対象は「滞在が終わった人」だけ(未宿泊者に「先日はご宿泊…」を送らない)
import admin from "firebase-admin";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildOptoutToken, normalizeEmail, emailKey } = require("../functions/api/marketing-optout-logic.js");
const { buildUgcPastGuestMail, UGC_PROPERTIES } = require("../functions/utils/ugcFollowMail-logic.js");

if (!admin.apps.length) admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const SEND = argv.includes("--send");
const LIMIT = Number(argOf("--limit", "15"));
const TEST_TO = argOf("--test");

const CAMPAIGN = "ugc-cashback-2026-08"; // marketingSends の記録キー(キャンペーンを変えたらここも変える)
const OPTOUT_BASE = "https://setouchi-stay.com/ugc-optout";

// 過去名簿の対象物件。propertyId 未設定の古い名簿は the Terrace 扱い(v2 の集計慣例)
const LIST_PROPERTIES = {
  tsZybhDMcPrxqgcRy7wp: "the Terrace 長浜",
  RZV9IwtQgMAsvrdM3j8J: "YADO KOMACHI Hiroshima",
};
const DEFAULT_PID = "tsZybhDMcPrxqgcRy7wp";

const looksLikeEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const toMillis = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : 0);
const TODAY_JST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const ymd = (v) => String(v || "").slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSecret() {
  const snap = await db.collection("settings").doc("marketing").get();
  const secret = snap.exists ? snap.data().optoutSecret : null;
  if (!secret) throw new Error("settings/marketing.optoutSecret がありません(先に配信停止APIを一度叩いて生成してください)");
  return secret;
}

// 物件の senderGmail を引く(1回だけ読んでキャッシュ)
const senderCache = new Map();
async function senderGmailOf(pid) {
  if (!senderCache.has(pid)) {
    const p = await db.collection("properties").doc(pid).get();
    senderCache.set(pid, (p.exists && p.data().senderGmail) || null);
  }
  return senderCache.get(pid);
}

const secret = await getSecret();

// ---- テスト送信 (--test a@b.com) ----
if (TEST_TO) {
  const to = normalizeEmail(TEST_TO);
  if (!looksLikeEmail(to)) { console.error("メールアドレスが不正です:", TEST_TO); process.exit(1); }
  const pid = DEFAULT_PID;
  const { subject, body } = buildUgcPastGuestMail({
    guestName: "テスト",
    propertyId: pid,
    propertyName: LIST_PROPERTIES[pid],
    optoutUrl: `${OPTOUT_BASE}?t=${buildOptoutToken(to, secret)}`,
  });
  if (!SEND) {
    console.log("=== テスト文面(--send を付けると実送信) ===");
    console.log("宛先:", to);
    console.log("件名:", subject);
    console.log("");
    console.log(body);
    process.exit(0);
  }
  const { sendNotificationEmail_, resolveSenderGmail_ } = require("../functions/utils/lineNotify.js");
  const from = await resolveSenderGmail_(db, pid);
  const r = await sendNotificationEmail_(to, subject, body, from || null);
  console.log(`テスト送信しました: ${to} (from=${from} messageId=${r.messageId})`);
  console.log("※ marketingSends には記録していません(テストのため)");
  process.exit(0);
}

// ---- 配信リストを組む(marketing-mailing-list.mjs と同じ判定) ----
const supSnap = await db.collection("marketingSuppressions").where("optedOut", "==", true).get();
const suppressed = new Set(supSnap.docs.map((d) => normalizeEmail(d.data().email)).filter(Boolean));

const sentSnap = await db.collection("marketingSends").where("campaign", "==", CAMPAIGN).get();
const alreadySent = new Set(sentSnap.docs.map((d) => normalizeEmail(d.data().email)).filter(Boolean));

// チェックアウト後フォローメールが届いた予約のアドレスは二重案内になるので除外
const followSnap = await db.collection("bookings").orderBy("ugcFollowMailSentAt").get().catch(() => ({ docs: [] }));
const followMailed = new Set(followSnap.docs.map((d) => normalizeEmail(d.data().email)).filter(Boolean));

const regs = await db.collection("guestRegistrations").get();

const byEmail = new Map();
let noEmail = 0, badEmail = 0, otherProperty = 0, notFinished = 0;
for (const doc of regs.docs) {
  const d = doc.data();
  const pid = d.propertyId || DEFAULT_PID;
  if (!LIST_PROPERTIES[pid]) { otherProperty++; continue; }
  const raw = String(d.email || "").trim();
  if (!raw) { noEmail++; continue; }
  const email = normalizeEmail(raw);
  if (!looksLikeEmail(email)) { badEmail++; continue; }
  const out = ymd(d.checkOut) || ymd(d.checkIn);
  if (!out || out >= TODAY_JST) { notFinished++; continue; }
  const stayedAt = toMillis(d.submittedAt) || toMillis(d.createdAt) || 0;
  const prev = byEmail.get(email);
  if (!prev || stayedAt > prev.stayedAt) {
    byEmail.set(email, {
      email,
      name: String(d.guestName || "").trim(),
      propertyId: pid,
      property: LIST_PROPERTIES[pid],
      checkIn: ymd(d.checkIn),
      stayedAt,
    });
  }
}

const all = [...byEmail.values()].sort((a, b) => b.stayedAt - a.stayedAt);
const sendable = all.filter((r) => !suppressed.has(r.email) && !alreadySent.has(r.email) && !followMailed.has(r.email));
const batch = LIMIT > 0 ? sendable.slice(0, LIMIT) : sendable;

console.log("=== 過去ゲスト UGC案内 ローリング配信 ===");
console.log(`基準日(JST): ${TODAY_JST} / キャンペーン: ${CAMPAIGN}`);
console.log(`名簿 ${regs.size} 件 → 宿泊済みユニーク ${all.length} 件`);
console.log(`  除外: 配信停止 ${all.filter((r) => suppressed.has(r.email)).length} / 送信済み ${all.filter((r) => alreadySent.has(r.email)).length} / フォローメール済み ${all.filter((r) => followMailed.has(r.email)).length}`);
console.log(`  (参考: メール無し ${noEmail} / 形式不正 ${badEmail} / 対象外物件 ${otherProperty} / 未宿泊 ${notFinished})`);
console.log(`残り ${sendable.length} 件 → 今回のバッチ ${batch.length} 件 (--limit ${LIMIT})`);
console.log("");
batch.forEach((r, i) => console.log(` ${String(i + 1).padStart(2)}. ${r.name || "(名前なし)"} <${r.email}> / ${r.property} / CI=${r.checkIn}`));

if (!SEND) {
  if (batch[0]) {
    const s = buildUgcPastGuestMail({
      guestName: batch[0].name,
      propertyId: batch[0].propertyId,
      propertyName: batch[0].property,
      optoutUrl: `${OPTOUT_BASE}?t=${buildOptoutToken(batch[0].email, secret)}`,
    });
    console.log("\n=== 文面サンプル(1件目) ===");
    console.log("件名:", s.subject);
    console.log("");
    console.log(s.body);
  }
  console.log("\n※ ドライランです。実際に送るには --send を付けてください");
  process.exit(0);
}

// ---- 実送信 ----
const { sendNotificationEmail_, resolveSenderGmail_ } = require("../functions/utils/lineNotify.js");
let sent = 0, failed = 0;
for (const r of batch) {
  try {
    const { subject, body } = buildUgcPastGuestMail({
      guestName: r.name,
      propertyId: r.propertyId,
      propertyName: r.property,
      optoutUrl: `${OPTOUT_BASE}?t=${buildOptoutToken(r.email, secret)}`,
    });
    const from = await senderGmailOf(r.propertyId);
    const res = await sendNotificationEmail_(r.email, subject, body, from || null);
    await db.collection("marketingSends").doc(emailKey(r.email)).set({
      email: r.email,
      campaign: CAMPAIGN,
      property: r.property,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      messageId: res.messageId || null,
    });
    sent++;
    console.log(`送信 ${sent}/${batch.length}: ${r.email} (from=${from})`);
    await sleep(1500); // Gmail への連続送信をならす
  } catch (e) {
    failed++;
    console.error(`失敗: ${r.email} — ${e.message}`);
  }
}
console.log(`\n完了: ${sent}件送信 / ${failed}件失敗 / 残り ${sendable.length - sent} 件(来週の実行で続きから)`);
process.exitCode = 0;
