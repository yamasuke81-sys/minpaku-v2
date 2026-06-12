#!/usr/bin/env node
/**
 * GAS版回答取込のローカルテスト (dryRun)
 * 使い方: node functions/migration/test-gas-import.js 2026-04-26 2026-04-26 [--write]
 *   --write を付けると本番 Firestore に書き込み、無ければ dryRun
 */
const admin = require("firebase-admin");
const { google } = require("googleapis");

admin.initializeApp({ projectId: "minpaku-v2" });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const SHEET_ID = "1Kk8VZrMQoJwmNk4OZKVQ9riufiCEcVPi_xmYHHnHgCs";
const PROPERTY_ID = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜

const args = process.argv.slice(2);
const from = args[0];
const to = args[1];
const doWrite = args.includes("--write");

if (!from || !to) {
  console.error("使い方: node test-gas-import.js <from YYYY-MM-DD> <to YYYY-MM-DD> [--write]");
  process.exit(1);
}

function normalizeDate(v) {
  if (!v) return "";
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return "";
}

function idxOf(headers, ...names) {
  for (const n of names) {
    const i = headers.findIndex((h) => String(h || "").trim() === n);
    if (i >= 0) return i;
  }
  return -1;
}

(async () => {
  console.log(`期間: ${from} 〜 ${to}, write=${doWrite}`);

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const [r1, r2] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "募集" }),
    sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "募集_立候補" }),
  ]);
  const recruitRows = r1.data.values || [];
  const candidateRows = r2.data.values || [];

  console.log(`\n[募集シート] ${recruitRows.length}行 (ヘッダ含む)`);
  console.log(`ヘッダ: ${JSON.stringify(recruitRows[0])}`);
  console.log(`\n[募集_立候補] ${candidateRows.length}行 (ヘッダ含む)`);
  console.log(`ヘッダ: ${JSON.stringify(candidateRows[0])}`);

  const recHeaders = recruitRows[0].map((h) => String(h || "").trim());
  const candHeaders = candidateRows[0].map((h) => String(h || "").trim());

  const recDateIdx = idxOf(recHeaders, "日付", "CO日", "チェックアウト日");
  const recIdIdx = idxOf(recHeaders, "募集ID", "ID", "行番号");
  const candRecIdIdx = idxOf(candHeaders, "募集ID", "ID");
  const candNameIdx = idxOf(candHeaders, "スタッフ名", "氏名", "名前");
  const candStatusIdx = idxOf(candHeaders, "ステータス", "回答", "状況");
  const candMemoIdx = idxOf(candHeaders, "メモ", "保留理由", "理由", "備考");

  console.log(`\n列インデックス: recDate=${recDateIdx} recId=${recIdIdx} candRecId=${candRecIdIdx} candName=${candNameIdx} candStatus=${candStatusIdx} candMemo=${candMemoIdx}`);

  if (recDateIdx < 0 || candRecIdIdx < 0 || candNameIdx < 0 || candStatusIdx < 0) {
    console.error("必須列が見つかりません");
    process.exit(2);
  }

  // 募集ID → 日付 マップ
  const recIdToDate = new Map();
  for (let i = 1; i < recruitRows.length; i++) {
    const row = recruitRows[i];
    const date = normalizeDate(row[recDateIdx]);
    if (!date) continue;
    const id = recIdIdx >= 0 ? String(row[recIdIdx] || "").trim() : String(i + 1);
    if (id) recIdToDate.set(id, date);
  }
  // 範囲内の募集をプレビュー
  console.log(`\n[募集シート] 範囲内の日付:`);
  for (const [id, d] of recIdToDate.entries()) {
    if (d >= from && d <= to) console.log(`  募集ID=${id} 日付=${d}`);
  }

  // v2 staff
  const staffSnap = await db.collection("staff").get();
  const lastNameMap = new Map();
  staffSnap.forEach((d) => {
    const data = d.data();
    if (data.active === false) return;
    const name = String(data.name || "").trim();
    if (!name) return;
    const lastName = name.split(/[ 　]/)[0];
    if (!lastName) return;
    const entry = { id: d.id, name, lastName };
    if (!lastNameMap.has(lastName)) lastNameMap.set(lastName, []);
    lastNameMap.get(lastName).push(entry);
  });

  // v2 recruitments
  const recSnap = await db.collection("recruitments")
    .where("propertyId", "==", PROPERTY_ID)
    .where("checkoutDate", ">=", from)
    .where("checkoutDate", "<=", to)
    .get();
  const recByDate = new Map();
  recSnap.forEach((d) => {
    const data = { id: d.id, ...d.data() };
    if (!data.checkoutDate) return;
    if (!recByDate.has(data.checkoutDate)) recByDate.set(data.checkoutDate, []);
    recByDate.get(data.checkoutDate).push(data);
  });
  console.log(`\n[v2 recruitments] 該当: ${recSnap.size}件`);
  for (const [d, list] of recByDate.entries()) {
    list.forEach((r) => console.log(`  ${d} id=${r.id} status=${r.status} selectedStaff=${r.selectedStaff}`));
  }

  const symbolMap = { "○": "◎", "◎": "◎", "△": "△", "×": "×", "✕": "×", "X": "×", "x": "×" };
  const warnings = [];
  const preview = [];
  let matched = 0, imported = 0, skipped = 0;

  for (let i = 1; i < candidateRows.length; i++) {
    const row = candidateRows[i];
    const recId = String(row[candRecIdIdx] || "").trim();
    const gasName = String(row[candNameIdx] || "").trim();
    const rawStatus = String(row[candStatusIdx] || "").trim();
    const memo = candMemoIdx >= 0 ? String(row[candMemoIdx] || "").trim() : "";

    if (!recId || !gasName || !rawStatus) { skipped++; continue; }
    const date = recIdToDate.get(recId);
    if (!date) { skipped++; continue; }
    if (date < from || date > to) { skipped++; continue; }

    const list = recByDate.get(date) || [];
    if (list.length === 0) {
      warnings.push({ type: "no_recruitment", date, gasStaffName: gasName });
      skipped++; continue;
    }
    const recruitment = list[0];

    const lastName = gasName.split(/[ 　]/)[0];
    const cands = lastNameMap.get(lastName) || [];
    if (cands.length === 0) {
      warnings.push({ type: "no_match", gasStaffName: gasName, lastName });
      skipped++; continue;
    }
    if (cands.length > 1) {
      warnings.push({ type: "duplicate_lastname", gasStaffName: gasName, lastName, candidates: cands.map((c) => c.name) });
      skipped++; continue;
    }
    const staff = cands[0];
    const response = symbolMap[rawStatus] || null;
    if (!response) { skipped++; continue; }

    const existing = await db.collection("recruitments").doc(recruitment.id)
      .collection("responses").doc(staff.id).get();
    if (existing.exists) {
      warnings.push({ type: "v2_existing", staffId: staff.id, staffName: staff.name, date });
      skipped++; continue;
    }
    matched++;
    const responseDoc = {
      staffId: staff.id,
      staffName: staff.name,
      response,
      memo: response === "△" ? memo : "",
      respondedAt: FieldValue.serverTimestamp(),
      source: "gas-import",
    };
    preview.push({ date, recruitmentId: recruitment.id, staffName: staff.name, response, memo: responseDoc.memo, gasStaffName: gasName });
    if (doWrite) {
      await db.collection("recruitments").doc(recruitment.id)
        .collection("responses").doc(staff.id).set(responseDoc, { merge: true });
      imported++;
    }
  }

  console.log(`\n========== 集計 ==========`);
  console.log(`該当: ${matched}件, 取込: ${imported}件, スキップ: ${skipped}件`);
  console.log(`\n[取込予定/実績]`);
  preview.forEach((p) => console.log(`  ${p.date} ${p.staffName} ← ${p.gasStaffName} 回答=${p.response} メモ=${p.memo}`));
  console.log(`\n[警告]`);
  warnings.forEach((w) => console.log(`  ${JSON.stringify(w)}`));

  process.exit(0);
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
