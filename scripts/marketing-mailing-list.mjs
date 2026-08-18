// marketing-mailing-list — 過去ゲストへの案内メール用の配信リストを作る
//
// UGCキャッシュバックの案内を「週15通ずつローリング配信」するための宛先リストを出力する。
// 各行に**その人専用の配信停止リンク**を付ける（受信者にアドレスを入力させないため）。
//
// 除外するもの:
//   ・marketingSuppressions で optedOut=true のアドレス（配信停止済み）
//   ・★滞在がまだ終わっていない人（これから泊まる/滞在中）。
//     案内文が「先日はご宿泊いただきありがとうございました」なので、未宿泊者に送ると事故になる
//   ・メールアドレスが無い/壊れている名簿
//   ・同一アドレスの重複（最新の滞在を代表として1通だけ）
//
// 実行:
//   node scripts/marketing-mailing-list.mjs                 # 先頭15件を表示（送らない・ファイルも書かない）
//   node scripts/marketing-mailing-list.mjs --limit 15 --out batch1.csv
//   node scripts/marketing-mailing-list.mjs --all           # 全件
//   node scripts/marketing-mailing-list.mjs --email a@b.com # 1件だけリンクを確認
//
// ※このスクリプトはメールを送らない。CSVを出すだけ。送信は人の手で行う（BCC厳禁・1通ずつ）。
//
import admin from "firebase-admin";
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildOptoutToken, normalizeEmail, emailKey } = require("../functions/api/marketing-optout-logic.js");

if (!admin.apps.length) admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const ALL = argv.includes("--all");
const LIMIT = Number(argOf("--limit", ALL ? "0" : "15"));
const OUT = argOf("--out");
const ONE = argOf("--email");

const OPTOUT_BASE = "https://setouchi-stay.com/ugc-optout";

// 案内対象の物件（UGCキャンペーンは the Terrace と 小町 が対象）
const PROPERTIES = {
  tsZybhDMcPrxqgcRy7wp: "the Terrace 長浜",
  RZV9IwtQgMAsvrdM3j8J: "YADO KOMACHI Hiroshima",
};
// propertyId 未設定の古い名簿は the Terrace 扱い（v2 の集計慣例に合わせる）
const DEFAULT_PID = "tsZybhDMcPrxqgcRy7wp";

// 配信停止リンクの署名鍵。API と同じものを使う。無ければここで作って保存する
async function getSecret() {
  const ref = db.collection("settings").doc("marketing");
  const snap = await ref.get();
  const existing = snap.exists ? snap.data().optoutSecret : null;
  if (existing) return existing;
  const secret = crypto.randomBytes(32).toString("hex");
  await ref.set({ optoutSecret: secret }, { merge: true });
  console.log("※ 署名鍵が無かったので新規作成しました (settings/marketing.optoutSecret)");
  return secret;
}

const looksLikeEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
const toMillis = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : 0);

// 日付は文字列のまま比較する（タイムゾーン混在で1日ずれるのを避ける）
const TODAY_JST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const ymd = (v) => String(v || "").slice(0, 10);

// 滞在が終わっているか。チェックアウト日が無い名簿はチェックイン日で代用する
function stayFinished(d) {
  const out = ymd(d.checkOut) || ymd(d.checkIn);
  if (!out) return false; // 日付が無い名簿は判断できないので送らない
  return out < TODAY_JST;
}

const secret = await getSecret();

// --email 指定時はリンクを1本出して終わり（動作確認用）
if (ONE) {
  const e = normalizeEmail(ONE);
  if (!looksLikeEmail(e)) { console.error("メールアドレスが不正です:", ONE); process.exit(1); }
  console.log(`${OPTOUT_BASE}?t=${buildOptoutToken(e, secret)}`);
  process.exit(0);
}

// 配信停止済みを先に集める
const supSnap = await db.collection("marketingSuppressions").where("optedOut", "==", true).get();
const suppressed = new Set(supSnap.docs.map((d) => normalizeEmail(d.data().email)).filter(Boolean));

const snap = await db.collection("guestRegistrations").get();

const byEmail = new Map();
const upcomingOnly = new Map(); // 未宿泊のみのアドレス（件数把握用）
let noEmail = 0, badEmail = 0, otherProperty = 0;

for (const doc of snap.docs) {
  const d = doc.data();
  const pid = d.propertyId || DEFAULT_PID;
  if (!PROPERTIES[pid]) { otherProperty++; continue; }

  const raw = String(d.email || "").trim();
  if (!raw) { noEmail++; continue; }
  const email = normalizeEmail(raw);
  if (!looksLikeEmail(email)) { badEmail++; continue; }

  // まだ泊まっていない/滞在中の人には「先日はご宿泊…」を送らない
  if (!stayFinished(d)) { upcomingOnly.set(email, true); continue; }

  const stayedAt = toMillis(d.submittedAt) || toMillis(d.createdAt) || 0;
  const prev = byEmail.get(email);
  // 同一アドレスは「最後に泊まった滞在」を代表にする
  if (!prev || stayedAt > prev.stayedAt) {
    byEmail.set(email, {
      email,
      name: String(d.guestName || "").trim(),
      property: PROPERTIES[pid],
      checkIn: ymd(d.checkIn),
      checkOut: ymd(d.checkOut),
      stayedAt,
      consent: d.marketingConsent === true,
    });
  }
}
// 過去に泊まっていれば、先の予約があっても対象にしてよい
for (const e of byEmail.keys()) upcomingOnly.delete(e);

const all = [...byEmail.values()].sort((a, b) => b.stayedAt - a.stayedAt);
const sendable = all.filter((r) => !suppressed.has(r.email));
const rows = (LIMIT > 0 ? sendable.slice(0, LIMIT) : sendable).map((r) => ({
  ...r,
  optoutUrl: `${OPTOUT_BASE}?t=${buildOptoutToken(r.email, secret)}`,
}));

console.log("=== 配信リスト ===");
console.log(`基準日(JST): ${TODAY_JST} — この日より前に滞在が終わった人だけを対象にする`);
console.log(`名簿 ${snap.size} 件 → 宿泊済みのユニークアドレス ${all.length} 件`);
console.log(`  ★未宿泊/滞在中のため除外: ${upcomingOnly.size} 件`);
console.log(`  配信停止済みで除外: ${all.length - sendable.length} 件`);
console.log(`  メール無し ${noEmail} / 形式不正 ${badEmail} / 対象外物件 ${otherProperty} 件は除外`);
console.log(`  うち配信同意(marketingConsent)あり: ${sendable.filter((r) => r.consent).length} 件`);
console.log(`→ 今回の出力: ${rows.length} 件${LIMIT > 0 ? `（--limit ${LIMIT}）` : "（全件）"}`);

if (OUT) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [
    ["氏名", "メールアドレス", "宿", "チェックイン日", "チェックアウト日", "配信同意", "配信停止リンク"].join(","),
    ...rows.map((r) => [r.name, r.email, r.property, r.checkIn, r.checkOut, r.consent ? "あり" : "なし", r.optoutUrl].map(esc).join(",")),
  ].join("\r\n");
  fs.writeFileSync(OUT, "﻿" + csv, "utf8"); // Excelで開けるよう BOM 付き
  console.log(`\n${OUT} に書き出しました（BOM付きUTF-8）`);
} else {
  console.log("\n--- 先頭数件 ---");
  rows.slice(0, 3).forEach((r) => {
    console.log(`${r.name || "(名前なし)"} <${r.email}> / ${r.property} / ${r.checkIn}〜${r.checkOut}`);
    console.log(`  停止リンク: ${r.optoutUrl}`);
  });
  console.log("\n※ CSVで書き出すには --out ファイル名 を付けてください");
}

process.exitCode = 0;
