#!/usr/bin/env node
// 宿泊税 申告・納付リマインド (2026-07-29 新設)
//
// 背景: やどぜい自動化は「申告書PDF生成→Drive保存」で終わっており、その先の
// 「県税事務所への提出・納入」を追いかける仕組みが無かった(2026-06分で期限2日前まで無通知)。
// このスクリプトが毎日、期限(対象月の翌月末日)を逆算して未完了ならボタン付きで通知する。
//
// 実行: 常駐bun(discord-secretary-resident.mjs)の routines.json から command型 で毎日起動。
//   stdout の NOTIFY_BEGIN〜NOTIFY_END を #民泊管理 へ投稿(BUTTONS: yadozei_tax でボタン添付)。
//   通知不要日は無音(exit 0)。
//
// 通知条件: 残り7日 or 残り3日以内(毎日) or 期限徒過(毎日🚨)。同一日1回。
// 完了記録: Discord「✅ 申告・納付済み」ボタン → yadozei-tax-status.json の done=true → 以後無音。
//
// ★点検スクリプトの掟: process.exit() 禁止(NOTIFYが捨てられる)。app.delete()で自然終了させる。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import admin from "firebase-admin";

const STATUS_JSON = path.join(os.homedir(), ".claude", "channels", "discord", "yadozei-tax-status.json");
const YADOZEI_REPORTS_URL = "https://app.yadozei.com/reports";

function loadStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_JSON, "utf8")); } catch { return {}; }
}
function saveStatus(s) {
  fs.mkdirSync(path.dirname(STATUS_JSON), { recursive: true });
  fs.writeFileSync(STATUS_JSON, JSON.stringify(s, null, 1));
}

// JST の今日 (UTC+9)
const jstNow = new Date(Date.now() + 9 * 3600 * 1000);
const todayYmd = jstNow.toISOString().slice(0, 10);

// 対象月 ym の申告期限 = 翌月末日 (広島県宿泊税: 例月申告)
function deadlineOf(ym) {
  const [y, m] = ym.split("-").map(Number);
  // 翌々月1日の前日 = 翌月末日
  const d = new Date(Date.UTC(y, m + 1, 0)); // month は 0-index なので m+1 の day0 = 翌月末日
  return d.toISOString().slice(0, 10);
}
function daysUntil(ymd) {
  return Math.round((new Date(ymd + "T00:00:00Z") - new Date(todayYmd + "T00:00:00Z")) / 86400000);
}
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
function fmtDate(ymd) {
  const d = new Date(ymd + "T00:00:00Z");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAYS[d.getUTCDay()]})`;
}

async function main() {
  if (!admin.apps.length) admin.initializeApp({ projectId: "minpaku-v2" });
  const db = admin.firestore();
  const status = loadStatus();

  // 直近4ヶ月を点検対象にする (徒過月も拾い続ける)
  const months = [];
  for (let back = 4; back >= 1; back--) {
    const d = new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth() - back, 1));
    months.push(d.toISOString().slice(0, 7));
  }

  // やどぜい申告対象 = yadozeiUpload.enabled の物件 (現状 the Terrace / YADO KOMACHI)
  const propsSnap = await db.collection("properties").get();
  const targets = [];
  propsSnap.forEach((doc) => {
    const p = doc.data();
    if (p?.yadozei?.yadozeiUpload?.enabled === true) targets.push({ id: doc.id, name: p.name, yadozei: p.yadozei });
  });

  const notices = [];
  for (const ym of months) {
    const st = status[ym] || {};
    if (st.done) continue;
    const deadline = deadlineOf(ym);
    const left = daysUntil(deadline);
    if (left > 7) continue; // まだ早い
    const shouldNotify = left === 7 || left <= 3; // 7日前に1回 → 3日前から毎日
    if (!shouldNotify) continue;
    if (st.lastNotify === todayYmd) continue; // 同一日1回

    const m = ym.split("-")[1];
    const lines = [];
    const head = left < 0
      ? `🚨 **宿泊税 申告・納付が期限を過ぎています（${Number(m)}月分・${-left}日超過）**`
      : `🏛️ **宿泊税 申告・納付リマインド（${Number(m)}月分）**`;
    lines.push(head);
    lines.push(`期限: **${fmtDate(deadline)}**${left >= 0 ? ` — 残り${left}日` : ""}。期限徒過は延滞金＋不申告加算金の対象です。`);
    lines.push("");

    // 物件ごとの月計表+申告書PDF (lastRun.yadozeiPdf が対象月のものか fileName で確認)
    for (const t of targets) {
      const pdf = t.yadozei?.lastRun?.yadozeiPdf;
      const isThisMonth = pdf?.fileName?.includes(`_${ym}_`);
      if (isThisMonth && Array.isArray(pdf.files) && pdf.files.length) {
        lines.push(`・${t.name}: ` + pdf.files.map((f) => `[${f.type}PDF](${f.webViewLink})`).join(" / "));
      } else if (isThisMonth && pdf.driveLink) {
        lines.push(`・${t.name}: [申告書PDF](${pdf.driveLink})`); // 旧形式(filesなし)フォールバック
      } else {
        lines.push(`・${t.name}: ⚠️ ${Number(m)}月分の申告書PDFが未生成です（やどぜい自動化の異常。要確認）`);
      }
    }
    lines.push(`📊 税額・月計表の確認: ${YADOZEI_REPORTS_URL} （月計表の添付が必須）`);
    lines.push("");
    lines.push(`▶ 下の **「🏛️ eLTAXで納入を進める」** でPCに必要ページを開き手順を案内します。`);
    lines.push(`▶ 提出・納入が済んだら **「✅ 申告・納付済み」** を押すとこの月の通知が止まります。`);
    lines.push(`BUTTONS: yadozei_tax`);
    notices.push(lines.join("\n"));

    status[ym] = { ...st, done: false, deadline, lastNotify: todayYmd };
  }

  if (notices.length) {
    saveStatus(status);
    for (const n of notices) {
      console.log("NOTIFY_BEGIN");
      console.log(n);
      console.log("NOTIFY_END");
    }
  }

  // firebase-admin の gRPC ハンドルを閉じて自然終了 (process.exit 禁止)
  await Promise.all(admin.apps.map((a) => a.delete().catch(() => {})));
}

main().catch((e) => {
  console.error(`yadozei-tax-reminder ERROR: ${e.message}`);
  process.exitCode = 1;
});
