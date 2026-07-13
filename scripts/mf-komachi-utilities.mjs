#!/usr/bin/env node
// 宿小町の光熱・通信費を MF / 楽天でんきマイページから自動計上する(毎日実行・冪等)。
//
//   使い方: node scripts/mf-komachi-utilities.mjs [--dry]
//
//   対象(2026-07 使用分以降のみ。過去月はPDF経由で計上済みのため触らない):
//     1. ガス(ニシモトヤ):      MF 楽天ハープの引落「SMBC(ニシモトヤ」→ 使用月=引落月の前月 → 水道光熱費
//     2. 電気(楽天でんき):      マイページAPI /usages/denki/8070379292/monthly → 月ラベル=使用月 → 水道光熱費
//     3. 固定電話(NTTファイナンス): MF 楽天第三の引落 → 使用月=引落月 → 固定電話
//        ※楽天フーガ側で NTTファイナンス を見つけた場合は計上せず NOTIFY のみ(支払方法の揺れ検知)
//
//   計上先: v2 API /pnl/{小町}/{ym}/import-external-utility (冪等キー=sourceId、overridden保護はサーバ側)
//   通知: 計上発生時とエラー時のみ NOTIFY 行(常駐bun command型が #経理 へ)
//   前提: debug Chrome(CDP:9222) に MF・楽天でんきのログインセッション。楽天でんき切れは NOTIFY で再ログイン依頼。
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
const FUGA_NAME = /フーガ|ﾌｰｶﾞ/;
const BANK_SERVICE = "1331";
const DENKI_KOMACHI = "8070379292";           // 楽天でんき エクセリア小町704
const START_YM = "2026-07";                   // これより前の使用月は計上しない(PDF計上済み)

const DRY = process.argv.includes("--dry");
const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
const curYm = `${nowJst.getUTCFullYear()}-${String(nowJst.getUTCMonth() + 1).padStart(2, "0")}`;
const prevOf = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };
const SCAN = [prevOf(curYm), curYm];

const withTimeout = (p, ms, l) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(l + " timeout")), ms))]);
function launchDebugChrome() {
  const cp = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ["--remote-debugging-port=9222", "--user-data-dir=C:\\Users\\yamas\\.claude\\chrome-debug-profile", "--no-first-run", "--no-default-browser-check"],
    { detached: true, stdio: "ignore" });
  cp.on("error", () => {}); cp.unref();
}
async function connectCdp() {
  for (let i = 0; i < 12; i++) {
    try { return await withTimeout(chromium.connectOverCDP(CDP), 6000, "cdp"); } catch {}
    if (i === 1) launchDebugChrome();
    await new Promise((r) => setTimeout(r, 4000));
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

    // ---- 2. 電気(楽天でんきマイページAPI) ----
    try {
      await page.goto("https://mypage.energy.rakuten.co.jp/contracts", { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2500);
      if (/login\.account\.rakuten|sign_in/.test(page.url())) {
        notices.push("⚠️ 楽天でんきマイページのセッション切れ。debug Chrome で再ログインしてください(宿小町の電気自動計上が止まっています)");
      } else {
        const years = [...new Set(SCAN.map((ym) => ym.split("-")[0]))];
        for (const y of years) {
          const j = await page.evaluate(async ([cn, yy]) => {
            const r = await fetch(`https://api.energy.rakuten.co.jp/mypage/v1/usages/denki/${cn}/monthly?target_year=${yy}`, { credentials: "include" });
            if (!r.ok) throw new Error("denki api " + r.status);
            return r.json();
          }, [DENKI_KOMACHI, y]);
          for (const m of (Array.isArray(j) ? j : [])) {
            if (m.amount == null || !(m.amount > 0)) continue;
            const usage = `${y}-${String(m.month).padStart(2, "0")}`;
            if (usage < START_YM || !SCAN.includes(usage)) continue;
            (perYm[usage] = perYm[usage] || []).push({
              sourceId: `rakuten:${DENKI_KOMACHI}:${usage}`,
              description: `電気(楽天でんき小町) ${usage}分 ${m.total_usage}kWh${m.period ? ` ${m.period.start_date}〜${m.period.end_date}` : ""}`.slice(0, 90),
              amount: Math.round(m.amount), date: m.period?.end_date || usage, category: "水道光熱費", vendor: "楽天でんき",
            });
          }
        }
      }
    } catch (e) {
      notices.push(`⚠️ 楽天でんきマイページ読取エラー: ${e.message}`);
    }
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
