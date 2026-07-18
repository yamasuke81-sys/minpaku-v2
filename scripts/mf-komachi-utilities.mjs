#!/usr/bin/env node
// 宿小町の光熱・通信費(ガス/固定電話/水道)を MF から自動計上する(毎日実行・冪等)。
//   ※電気(楽天でんき)は別ルーチン rakuten-denki-monthly.mjs へ分離済(月次・下記2026-07-16の分離理由参照)。
//
//   使い方: node scripts/mf-komachi-utilities.mjs [--dry]
//
//   対象(2026-07 使用分以降のみ。過去月はPDF経由で計上済みのため触らない):
//     1. ガス(ニシモトヤ):      MF 楽天ハープの引落「SMBC(ニシモトヤ」→ 使用月=引落月の前月 → 水道光熱費
//     3. 固定電話(NTTファイナンス): MF 楽天第三の引落 → 使用月=引落月 → 固定電話
//        ※楽天フーガ側で NTTファイナンス を見つけた場合は計上せず NOTIFY のみ(支払方法の揺れ検知)
//     4. 水道(広島市水道):      MF ゆうちょ高陽の引落「水道 ヒロシマシ」(隔月) → 引落月と前月に÷2月割 → 水道光熱費
//        (端数は引落月側。例 6/29¥3,267 → 5月1,633+6月1,634。2026-07-14やますけ決定=MF月割方式)
//
//   計上先: v2 API /pnl/{小町}/{ym}/import-external-utility (冪等キー=sourceId、overridden保護はサーバ側)
//   通知: 計上発生時とエラー時のみ NOTIFY 行(常駐bun command型が #経理 へ)
//   前提: debug Chrome(CDP:9222) に MF のログインセッション(MFは持続=毎日読んでOK)。
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
const requireScripts = createRequire("C:/Users/yamas/.claude/scripts/node_modules/");
const { chromium } = requireScripts("playwright-core");

const KOMACHI = "RZV9IwtQgMAsvrdM3j8J";
const API = "https://api-5qrfx7ujcq-an.a.run.app";
const CDP = "http://127.0.0.1:9222";
const HARP_HASH = "tXfU3weteHfPaOksh_Kf_g";   // MF ㉂楽天ハープ(個人事業主)
const R3_HASH = "64SwijL8nXXCHReKyZpAbA";     // MF ㊇楽天第3(八朔)
const YUCHO_HASH = "k5ed6gnMzjChkCsMJ9WJXQ";  // MF 恭ゆうちょ高陽(川原石ラベル) — 広島市水道=小町の引落元
const FUGA_NAME = /フーガ|ﾌｰｶﾞ/;
const BANK_SERVICE = "1331";
const START_YM = "2026-07";                   // これより前の使用月は計上しない(PDF計上済み)

const DRY = process.argv.includes("--dry");
const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
const curYm = `${nowJst.getUTCFullYear()}-${String(nowJst.getUTCMonth() + 1).padStart(2, "0")}`;
const prevOf = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };
const SCAN = [prevOf(curYm), curYm];

const withTimeout = (p, ms, l) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(l + " timeout")), ms))]);
function killDebugChrome() {
  try {
    const { spawnSync } = require("node:child_process");
    spawnSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoProfile", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*9222*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"],
      { stdio: "ignore", timeout: 15000 });
  } catch {}
}
function launchDebugChrome() {
  const cp = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ["--remote-debugging-port=9222", "--user-data-dir=C:\\Users\\yamas\\.claude\\chrome-debug-profile", "--no-first-run", "--no-default-browser-check"],
    { detached: true, stdio: "ignore" });
  cp.on("error", () => {}); cp.unref();
}
// HTTPエンドポイントの生死確認。生きている間は chrome.exe を絶対に起動しない
// (既存インスタンスがあると Chrome のシングルトン機構で「新しいウィンドウ」が開くだけ=ウィンドウ増殖の原因)
async function cdpHttpAlive() {
  try {
    const r = await withTimeout(fetch(CDP + "/json/version"), 3000, "http");
    return r.ok;
  } catch { return false; }
}
async function connectCdp() {
  for (let i = 0; i < 8; i++) {
    try { return await withTimeout(chromium.connectOverCDP(CDP), 15000, "cdp"); } catch {}
    const alive = await cdpHttpAlive();
    if (!alive) {
      launchDebugChrome(); // 完全に死んでいる時だけ起動(新ウィンドウ増殖防止)
    } else if (i === 3) {
      // HTTPは生きているのにCDPが繋がらない = stale endpoint → 掃除してから起動
      killDebugChrome();
      await new Promise((r) => setTimeout(r, 3000));
      launchDebugChrome();
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("CDP接続不可(debug Chrome起動失敗)");
}
function parseCsv(text) {
  const rows = []; let cur = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else { if (c === '"') q = true; else if (c === ",") { cur.push(f); f = ""; } else if (c === "\n") { cur.push(f); rows.push(cur); cur = []; f = ""; } else if (c !== "\r") f += c; }
  }
  if (f.length || cur.length) { cur.push(f); rows.push(cur); }
  return rows;
}
async function fetchMfCsv(page, hash, ym) {
  const [Y, M] = ym.split("-").map(Number);
  const url = `https://moneyforward.com/cf/csv?account_id_hash=${hash}&from=${Y}%2F${String(M).padStart(2, "0")}%2F01&month=${M}&service_id=${BANK_SERVICE}&year=${Y}`;
  const buf = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: "include" });
    if (!r.ok) throw new Error("csv fetch " + r.status);
    return Array.from(new Uint8Array(await r.arrayBuffer()));
  }, url);
  const rows = parseCsv(new TextDecoder("shift_jis").decode(new Uint8Array(buf)));
  const head = rows[0] || [];
  const h = {}; head.forEach((c, i) => { h[c] = i; });
  return rows.slice(1).map((r) => ({
    date: String(r[h["日付"]] || "").replace(/\//g, "-"),
    desc: r[h["内容"]] || "",
    amount: Number(String(r[h["金額（円）"]] || "").replace(/,/g, "")) || 0,
    mfId: r[h["ID"]] || "",
  }));
}
const ymOfDate = (d) => (String(d).match(/^(\d{4})-(\d{1,2})/) ? `${RegExp.$1}-${String(Number(RegExp.$2)).padStart(2, "0")}` : null);

(async () => {
  console.log(`宿小町 光熱・通信 MF取込: 走査=${SCAN.join(", ")} 対象使用月>=${START_YM} ${DRY ? "[dry]" : ""}`);
  const browser = await connectCdp();
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  const perYm = {}; // usageYm → items[]
  const notices = [];
  try {
    await page.goto("https://moneyforward.com/accounts", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    if (/sign_in|login/.test(page.url())) throw new Error("MF未ログイン(debug ChromeでMFに再ログインが必要)");

    // ---- 1. ガス(ニシモトヤ) 楽天ハープ ----
    for (const ym of SCAN) {
      for (const r of await fetchMfCsv(page, HARP_HASH, ym)) {
        if (!/ニシモトヤ|ﾆｼﾓﾄﾔ/.test(r.desc) || r.amount >= 0) continue;
        const usage = prevOf(ymOfDate(r.date));
        if (!usage || usage < START_YM) continue;
        (perYm[usage] = perYm[usage] || []).push({
          sourceId: `mfbank:${r.mfId}`, description: `ガス(ニシモトヤ) 引落${r.date} ${r.desc}`.slice(0, 90),
          amount: Math.abs(r.amount), date: r.date, category: "水道光熱費", vendor: "ニシモトヤ",
        });
      }
    }

    // ---- 3. 固定電話(NTTファイナンス) 楽天第三 ----
    for (const ym of SCAN) {
      for (const r of await fetchMfCsv(page, R3_HASH, ym)) {
        if (!/NTTファイナンス|NTTﾌｧｲﾅﾝｽ/.test(r.desc) || r.amount >= 0) continue;
        const usage = ymOfDate(r.date);
        if (!usage || usage < START_YM) continue;
        (perYm[usage] = perYm[usage] || []).push({
          sourceId: `mfbank:${r.mfId}`, description: `固定電話(NTTファイナンス) 引落${r.date}`.slice(0, 90),
          amount: Math.abs(r.amount), date: r.date, category: "固定電話", vendor: "NTTファイナンス",
        });
      }
    }
    // ---- 4. 水道(広島市水道) ゆうちょ高陽・隔月引落を前月+当月に÷2月割 ----
    for (const ym of SCAN) {
      for (const r of await fetchMfCsv(page, YUCHO_HASH, ym)) {
        if (!/水道 ヒロシマシ|ｽｲﾄﾞｳ ﾋﾛｼﾏｼ/.test(r.desc) || r.amount >= 0) continue;
        const debitYm = ymOfDate(r.date);
        if (!debitYm) continue;
        const total = Math.abs(r.amount);
        const firstHalf = Math.floor(total / 2);         // 前月分
        const secondHalf = total - firstHalf;            // 引落月分(端数はこちら)
        const parts = [
          { usage: prevOf(debitYm), amount: firstHalf },
          { usage: debitYm, amount: secondHalf },
        ];
        for (const p of parts) {
          if (p.usage < START_YM) continue;
          (perYm[p.usage] = perYm[p.usage] || []).push({
            sourceId: `mfbank:${r.mfId}:${p.usage}`,
            description: `水道(広島市) 引落${r.date} ¥${total.toLocaleString()}の月割(${p.usage}分)`.slice(0, 90),
            amount: p.amount, date: r.date, category: "水道光熱費", vendor: "広島市水道局",
          });
        }
      }
    }

    // フーガ側の NTTファイナンス(支払方法の揺れ) → 計上せず通知のみ
    try {
      const accountsPage = await page.evaluate(() =>
        Array.from(document.querySelectorAll("a")).filter((a) => /accounts\/show/.test(a.href))
          .map((a) => ({ t: a.textContent || "", h: a.href })));
      const fuga = accountsPage.find((l) => FUGA_NAME.test(l.t));
      if (fuga) {
        const fugaHash = (fuga.h.match(/show\/([^/?]+)/) || [])[1];
        for (const ym of SCAN) {
          for (const r of await fetchMfCsv(page, fugaHash, ym)) {
            if (/NTTファイナンス|NTTﾌｧｲﾅﾝｽ/.test(r.desc) && r.amount < 0 && ymOfDate(r.date) >= START_YM) {
              notices.push(`⚠️ 楽天フーガ側で NTTファイナンス 支払 ¥${Math.abs(r.amount).toLocaleString()}(${r.date}) を検出。固定電話の支払方法が揺れている可能性(自動計上はしない・要確認)`);
            }
          }
        }
      }
    } catch {}

    // ---- 電気(楽天でんき)は月次ルーチン rakuten-denki-monthly.mjs へ分離(2026-07-16) ----
    //   理由: 楽天でんきはステップアップ認証(session/upgrade)のセッションが短命(実測: ログイン後1時間以内に失効)で、
    //   いつ読むにしても毎回手動再ログインが要る。よって日次で読まず「翌月1〜7日に前月分が確定したら1回だけ」取得する
    //   方式へ移行(手動ログインの手間を月1回に最小化)。このルーチンではガス/固定電話/水道(MF・持続セッション)のみ扱う。
  } finally {
    await page.close();
    await browser.close();
  }

  // ---- API へ POST ----
  const yms = Object.keys(perYm).sort();
  if (!yms.length && !notices.length) { console.log("計上候補なし。終了。"); process.exitCode = 0; return; }
  const secret = readFileSync("C:/Users/yamas/.claude/channels/discord/v2-gas-secret.txt", "utf8").trim();
  let hadError = false;
  for (const ym of yms) {
    const r = await fetch(`${API}/pnl/${KOMACHI}/${ym}/import-external-utility`, {
      method: "POST",
      headers: { "authorization": `Bearer gas-${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ items: perYm[ym], source: "MF/楽天でんき", dryRun: DRY }),
    });
    const j = await r.json().catch(() => ({}));
    console.log(`\n[${ym}] status=${r.status} 候補${perYm[ym].length}件`);
    if (!r.ok) { hadError = true; console.log("error:", j.error); continue; }
    const adopted = j.adopted || [];
    console.log(`採用${adopted.length}件 / skip ${(j.skipped || []).length}件`);
    for (const s of (j.skipped || [])) console.log(`  skip: ${s.description || s.sourceId} (${s.reason})`);
    if (!DRY && adopted.length) {
      const detail = adopted.map((a) => `${a.description} ¥${Number(a.amount).toLocaleString()}`).join(" / ");
      console.log(`NOTIFY: 🏠 宿小町 ${ym} の光熱・通信費を MF/楽天でんき から自動計上しました: ${detail}`);
    }
  }
  for (const n of notices) console.log(`NOTIFY: ${n}`);
  process.exitCode = hadError ? 1 : 0;
})().catch((e) => { console.error("ERROR:", e.message); process.exitCode = 1; });
