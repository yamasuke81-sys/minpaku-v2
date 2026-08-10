#!/usr/bin/env node
// 楽天でんきの電気代を「月次で1回だけ」PnLへ自動計上する(宿小町ほか)。
//
//   背景(2026-07-16 実測で確定):
//     - 楽天でんきはステップアップ認証(login.account.rakuten.com/session/upgrade)のセッションが短命
//       (ログイン後1時間以内に失効を再現)。いつ読むにしても毎回やますけの手動再ログインが必要。
//       → だから日次で読まず「翌月1〜7日に前月分が確定したら1回だけ」取得し、手動ログインを月1回に最小化する。
//     - 月別料金APIは {usages:[{month,total_usage,amount,amount_status_id,period:{start_date,end_date}}]} を返す
//       (配列直ではなくオブジェクト包み)。amount!=null で確定。宿小町の検針日は毎月11〜14日、確定はその数日後、
//       翌月1日には確実に載っている(データで確認)。
//
//     - 検針日は契約ごとに違う(宿小町=11〜14日 / 呉市清水=月末 / 音戸・西川原石=月初)。月末検針だと翌月1〜7日の窓に
//       確定が間に合わないことがあるため、対象は「前月」単月ではなく **startYm 以降の未取得月すべて**(遡り上限12ヶ月)。
//       取り逃した月は state に残るので、翌月の窓で自動的に拾い直す。
//
//   使い方:
//     node rakuten-denki-monthly.mjs            本番(ルーチン): 翌月1〜7日ゲート。未取得月があれば、ログイン済みなら取得/未ログインなら再ログイン依頼。
//     node rakuten-denki-monthly.mjs --capture  ユーザー起動(「楽天取り込み」返信時): 日付ゲート無視で、ログイン済みなら未取得月を今すぐ取得。
//     node rakuten-denki-monthly.mjs --check     疎通・セッション・対象月の確定状況だけ表示(取得も通知もしない)。--force 併用で開業前契約も表示。
//     node rakuten-denki-monthly.mjs --dry       APIをdryRunで叩き、state を書かない(検証用)。
//     node rakuten-denki-monthly.mjs --force     日付ゲート/取得済みスキップ/開業前ゲートを無視(検証用)。
//     node rakuten-denki-monthly.mjs --month 2026-06   対象使用月を明示。
//
//   通知: stdout の「NOTIFY: 」行だけ常駐bun(command型)が #経理 へ送る(無音=正常)。非0終了はエラー通知。
//   前提: debug Chrome(CDP:9222)。計上先=v2 API import-external-utility(冪等キー=sourceId=rakuten:{cn}:{ym})。
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- 設定 ----
//   startYm = このルーチンが計上を担当する最初の「使用月」。
//     - 宿小町の 2026-06 以前は PDF/MF 経由で計上済みなので担当外(二重計上防止)。
//     - null = 開業前。電気は通っていても pnl には載せない(開業準備費は別管理)。開業月が決まったらその月を入れる。
const CONTRACTS = [
  { cn: "8070379292", pid: "RZV9IwtQgMAsvrdM3j8J", label: "宿小町", startYm: "2026-07" },
  // 若草: 2026-08-14 に楽天でんき開通(申込 2026-07-14)。開業前のため計上はまだしない。
  // 民泊の開業月が決まったら startYm を "YYYY-MM" にする(あわせて物件の pnlBatchEnabled も要確認)。
  { cn: "8089375892", pid: "ZXW6wdpnBFk1azQ87KXQ", label: "若草", startYm: null },
];
const WINDOW_DAYS = 7; // 翌月1〜7日だけ動く(それ以外は静か)
const BACKFILL_MONTHS = 12; // 未取得月をさかのぼって拾う上限(検針日が遅い契約で7日窓を跨いでも落とさない)
const API = "https://api-5qrfx7ujcq-an.a.run.app";
const CDP = "http://127.0.0.1:9222";
const SECRET_PATH = "C:/Users/yamas/.claude/channels/discord/v2-gas-secret.txt";
const STATE_PATH = join(homedir(), ".claude", "channels", "discord", "rakuten-denki-state.json");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILE = "C:\\Users\\yamas\\.claude\\chrome-debug-profile";

// ---- 引数 ----
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const DRY = has("--dry");
const FORCE = has("--force");
const CAPTURE = has("--capture");
const CHECK = has("--check");
const mi = argv.indexOf("--month");
const MONTH_OVERRIDE = mi >= 0 && /^\d{4}-\d{2}$/.test(argv[mi + 1] || "") ? argv[mi + 1] : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, l) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(l + " timeout")), ms))]);

// ---- 時刻/対象月(JST) ----
function nowJST() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  return { y, m, day, ymd: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
}
function prevMonthOf(y, m) { let yy = y, mm = m - 1; if (mm === 0) { mm = 12; yy--; } return { y: yy, m: mm, ym: `${yy}-${String(mm).padStart(2, "0")}` }; }
function addMonths(ym, delta) {
  let y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) + delta;
  while (m <= 0) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return `${y}-${String(m).padStart(2, "0")}`;
}
// 契約ごとの「まだ計上していない使用月」を古い順に返す。
// 検針日は契約ごとに違い(宿小町=11〜14日/月末/月初)、翌月1〜7日の窓に確定が間に合わない契約もあるため、
// 単月ではなく startYm 以降の未取得月をさかのぼって拾う(1ヶ月遅れても落とさない)。
function targetMonths(c, state, latestYm) {
  const wanted = [];
  if (MONTH_OVERRIDE) {
    if (FORCE || c.startYm) wanted.push(MONTH_OVERRIDE);
  } else if (c.startYm) {
    let ym = latestYm;
    for (let i = 0; i < BACKFILL_MONTHS && ym >= c.startYm; i++) { wanted.push(ym); ym = addMonths(ym, -1); }
    wanted.reverse();
  }
  return FORCE ? wanted : wanted.filter((ym) => !state.imported[`${c.cn}:${ym}`]);
}

// ---- state ----
function loadState() { try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return { imported: {}, promptedYmd: {} }; } }
function saveState(s) { try { writeFileSync(STATE_PATH, JSON.stringify({ ...s, at: new Date().toISOString() }, null, 1)); } catch {} }

// ---- CDP(生HTTP + ページ直結WebSocket。Playwright不使用でハング回避) ----
async function cdpAlive() { try { const r = await withTimeout(fetch(CDP + "/json/version"), 3000, "ver"); return r.ok; } catch { return false; } }
function launchDebugChrome() {
  try { const p = spawn(CHROME, ["--remote-debugging-port=9222", `--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble", "--enable-unsafe-extension-debugging"], { detached: true, stdio: "ignore" }); p.on("error", () => {}); p.unref(); } catch {}
}
async function getTabs() { const r = await withTimeout(fetch(CDP + "/json"), 5000, "tabs"); return r.json(); }
async function cdpPut(path) { return withTimeout(fetch(CDP + path, { method: "PUT" }), 8000, "put"); }
async function activate(id) { try { await withTimeout(fetch(CDP + "/json/activate/" + id), 5000, "act"); } catch {} }

// energy.rakutenのタブを確保(無ければ /contracts を新規に開く)。{id, url, ws} を返す。
async function ensureEnergyTab() {
  let tabs = await getTabs();
  let t = tabs.find((x) => x.type === "page" && /mypage\.energy\.rakuten\.co\.jp/.test(x.url || ""))
       || tabs.find((x) => x.type === "page" && /rakuten/.test(x.url || ""));
  if (!t) {
    await cdpPut("/json/new?https://mypage.energy.rakuten.co.jp/contracts");
    await sleep(4000);
    tabs = await getTabs();
    t = tabs.find((x) => x.type === "page" && /rakuten/.test(x.url || ""));
  }
  if (!t) throw new Error("楽天タブを用意できません");
  return { id: t.id, url: t.url, ws: t.webSocketDebuggerUrl };
}

// 生WebSocketの最小CDPクライアント
function connectWs(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map(); const waiters = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) { for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].method === m.method) { waiters[i].resolve(m); waiters.splice(i, 1); } }
  });
  const ready = new Promise((res, rej) => { ws.addEventListener("open", () => res(), { once: true }); ws.addEventListener("error", () => rej(new Error("ws接続失敗")), { once: true }); });
  function send(method, params = {}, timeoutMs = 15000) {
    const myId = ++id;
    return new Promise((res, rej) => { const to = setTimeout(() => { pending.delete(myId); rej(new Error(method + " timeout")); }, timeoutMs); pending.set(myId, (m) => { clearTimeout(to); res(m); }); ws.send(JSON.stringify({ id: myId, method, params })); });
  }
  function waitEvent(method, timeoutMs = 12000) { return new Promise((res) => { const w = { method, resolve: res }; waiters.push(w); setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); res(null); }, timeoutMs); }); }
  return { ready, send, waitEvent, close: () => { try { ws.close(); } catch {} } };
}

async function evalJson(cli, expr) {
  await cli.send("Runtime.enable");
  const r = await cli.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
}
async function navigateContracts(cli) {
  await cli.send("Page.enable");
  const load = cli.waitEvent("Page.loadEventFired", 15000);
  await cli.send("Page.navigate", { url: "https://mypage.energy.rakuten.co.jp/contracts" });
  await load;
  await sleep(2500); // SPA初期化 + APIトークン交換待ち
}
// 月別APIを読む(ページ文脈でcredential付きfetch)。{status, usages:[]} を返す。
async function readMonthly(cli, cn, year) {
  const expr = `(async()=>{try{const r=await fetch("https://api.energy.rakuten.co.jp/mypage/v1/usages/denki/${cn}/monthly?target_year=${year}",{credentials:"include",headers:{Accept:"application/json"}});let j=null;try{j=await r.json();}catch{}return {status:r.status, href:location.href, usages:(j&&Array.isArray(j.usages))?j.usages:(Array.isArray(j)?j:[])};}catch(e){return {status:0,err:String(e),href:location.href,usages:[]};}})()`;
  return (await evalJson(cli, expr)) || { status: 0, usages: [] };
}

async function postImport(pid, ym, items) {
  const secret = readFileSync(SECRET_PATH, "utf8").trim();
  const r = await withTimeout(fetch(`${API}/pnl/${pid}/${ym}/import-external-utility`, {
    method: "POST", headers: { authorization: `Bearer gas-${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ items, source: "楽天でんき(月次)", dryRun: DRY }),
  }), 30000, "import");
  if (!r.ok) { const t = await r.text().catch(() => ""); console.error("import API", r.status, t.slice(0, 200)); return false; }
  return true;
}

// ============================================================
(async () => {
  const now = nowJST();
  const latestYm = MONTH_OVERRIDE || prevMonthOf(now.y, now.m).ym; // 翌月1日に走らせる前提=前月が最新の対象

  // 日付ゲート(本番のみ。--capture / --check / --force は無視)
  const windowOk = FORCE || CAPTURE || CHECK || (now.day >= 1 && now.day <= WINDOW_DAYS);
  if (!windowOk) { console.log(`窓外(翌月1〜${WINDOW_DAYS}日のみ稼働)。今日=${now.day}日。終了。`); return; }

  const state = loadState();
  const targets = CONTRACTS.map((c) => ({ c, months: targetMonths(c, state, latestYm) })).filter((t) => t.months.length);
  if (!targets.length && !CHECK) {
    const preOpen = CONTRACTS.filter((c) => !c.startYm).map((c) => c.label);
    console.log(`${latestYm}分まで全契約取得済み。終了。` + (preOpen.length ? ` (開業前で対象外: ${preOpen.join("/")})` : ""));
    return;
  }

  // CDP疎通(完全に死んでいる時だけ起動。生きている場合はkillしない=ログインを壊さない)
  if (!(await cdpAlive())) {
    launchDebugChrome();
    let ok = false;
    for (let i = 0; i < 30; i++) { await sleep(1000); if (await cdpAlive()) { ok = true; break; } }
    if (!ok) { console.log("NOTIFY: 🚨 楽天でんき: デバッグChrome(CDP:9222)に接続できません。Chromeの起動/更新保留を確認してください。"); process.exitCode = 1; return; }
  }

  let tab, cli;
  try {
    tab = await ensureEnergyTab();
    cli = connectWs(tab.ws);
    await withTimeout(cli.ready, 15000, "ws-ready");
    await navigateContracts(cli);

    // 使用量APIは年単位で全月返るので、契約×年でキャッシュして同じ年の複数月を1リクエストで賄う
    const usagesCache = new Map();
    const usagesFor = async (cn, year) => {
      const key = `${cn}:${year}`;
      if (!usagesCache.has(key)) usagesCache.set(key, await readMonthly(cli, cn, year));
      return usagesCache.get(key);
    };

    // セッション判定(先頭の対象契約×対象年で月別APIを叩く)
    const probe = CHECK ? CONTRACTS[0] : targets[0].c;
    const probeYear = Number((CHECK ? latestYm : targets[0].months[0]).slice(0, 4));
    let sess = await readMonthly(cli, probe.cn, probeYear);
    if (sess.status !== 200 && !/login\.account\.rakuten|sign_in/.test(sess.href || "")) {
      // mypage上なのに401=トークン未確立の競合の可能性 → 3秒待って1回だけ再読
      await sleep(3000);
      sess = await readMonthly(cli, probe.cn, probeYear);
    }
    const loggedIn = sess.status === 200;
    if (loggedIn) usagesCache.set(`${probe.cn}:${probeYear}`, sess);

    if (CHECK) {
      console.log(`[check] url=${sess.href} status=${sess.status} loggedIn=${loggedIn} 最新対象月=${latestYm}`);
      for (const c of CONTRACTS) {
        // 開業前(startYm未設定)は通常は対象外。--force を付けると契約の実在・検針状況だけ覗ける。
        if (!c.startYm && !FORCE) { console.log(`  ${c.label}(${c.cn}): 開業前のため計上対象外(startYm未設定)`); continue; }
        const months = targetMonths(c, state, latestYm);
        if (!months.length) { console.log(`  ${c.label}(${c.cn}): ${latestYm}分まで取得済み`); continue; }
        for (const ym of months) {
          const res = loggedIn ? await usagesFor(c.cn, Number(ym.slice(0, 4))) : { status: 0, usages: [] };
          const m = (res.usages || []).find((x) => Number(x.month) === Number(ym.slice(5, 7)));
          const detail = m ? (m.amount == null ? "未確定" : `¥${m.amount} ${m.total_usage}kWh 検針${m.period?.end_date || "?"}`)
            : (loggedIn ? `該当月データ無し(API status=${res.status} 同年の実績${(res.usages || []).length}件)` : "(未ログインのため不明)");
          console.log(`  ${c.label}(${c.cn}) ${ym}: ${detail}`);
        }
      }
      return;
    }

    if (!loggedIn) {
      // ログインページを前面待機
      try { await activate(tab.id); } catch {}
      if (CAPTURE) {
        console.log("NOTIFY: ⚠️ 楽天でんきにまだログインされていません。デバッグChromeで楽天でんきにログイン後、もう一度**下のボタン**を押してください（テキストで「楽天取り込み」でも同じ）。");
        console.log("BUTTONS: rakuten_denki");
      } else if (state.promptedYmd?.[latestYm] !== now.ymd) {
        state.promptedYmd = state.promptedYmd || {};
        state.promptedYmd[latestYm] = now.ymd; saveState(state);
        console.log(`NOTIFY: 🔴 楽天でんき ${latestYm}分 の取り込み時期です。デバッグChromeで楽天でんきにログイン(ログイン画面を前面に用意済み)→ 済んだら**下のボタン**を押してください（テキストで「楽天取り込み」でも同じ）。`);
        console.log("BUTTONS: rakuten_denki");
      }
      return;
    }

    // ログイン済み → 各契約の未取得月を計上(古い月から)
    let anyErr = false, didSomething = false;
    for (const { c, months } of targets) {
      for (const ym of months) {
        const list = (await usagesFor(c.cn, Number(ym.slice(0, 4)))).usages || [];
        const m = list.find((x) => Number(x.month) === Number(ym.slice(5, 7)));
        if (!m || m.amount == null) {
          // 検針待ちは毎日は騒がない(窓の最終日か手動起動のときだけ通知)。未取得のまま残るので翌月以降に自動で拾い直す。
          const msg = `楽天でんき ${c.label} ${ym}分 はまだ確定していません(検針待ち)`;
          if (CAPTURE || now.day >= WINDOW_DAYS) console.log(`NOTIFY: ⏳ ${msg}。確定後に自動で拾い直します。`);
          else console.log(msg);
          continue;
        }
        didSomething = true;
        if (!(m.amount > 0)) {
          if (!DRY) { state.imported[`${c.cn}:${ym}`] = true; saveState(state); }
          console.log(`NOTIFY: 🏠 楽天でんき ${c.label} ${ym}分 = ¥0(0kWh)。計上なし・確定として記録しました。`);
          continue;
        }
        const per = m.period ? ` ${m.period.start_date}〜${m.period.end_date}` : "";
        const item = {
          sourceId: `rakuten:${c.cn}:${ym}`,
          description: `電気(楽天でんき ${c.label}) ${ym}分 ${m.total_usage}kWh${per}`.slice(0, 90),
          amount: Math.round(m.amount), date: m.period?.end_date || ym, category: "水道光熱費", vendor: "楽天でんき",
        };
        const ok = await postImport(c.pid, ym, [item]);
        if (ok) {
          if (!DRY) { state.imported[`${c.cn}:${ym}`] = true; saveState(state); }
          console.log(`NOTIFY: 🏠 楽天でんき ${c.label} ${ym}分を計上しました: ¥${Math.round(m.amount).toLocaleString()} (${m.total_usage}kWh)${DRY ? " [dry]" : ""}`);
        } else {
          anyErr = true;
          console.log(`NOTIFY: 🚨 楽天でんき ${c.label} ${ym}分の計上に失敗しました(API)。手動確認してください。`);
        }
      }
    }
    if (!didSomething && CAPTURE) console.log(`NOTIFY: ℹ️ 楽天でんき ${latestYm}分までは取り込み済みか、まだ確定していません。`);
    process.exitCode = anyErr ? 1 : 0;
  } catch (e) {
    console.log(`NOTIFY: 🚨 楽天でんき月次取り込みエラー: ${e.message}`);
    process.exitCode = 1;
  } finally {
    try { cli?.close(); } catch {}
  }
})().catch((e) => { console.error("FATAL:", e.message); process.exitCode = 1; });
