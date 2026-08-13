/**
 * Booking.com エクストラネットで予約1件の内容(人数など)を確認する（読み取り専用）
 *
 * 前提: デバッグ Chrome (CDP:9222) が起動していて、admin.booking.com にログイン済みであること。
 *       未ログインならログイン画面を前面に出して終了する（パスワード入力は自動化しない）。
 *
 * 使い方:
 *   node scripts/booking-reservation-check.mjs --res 5167790262
 *   node scripts/booking-reservation-check.mjs --res 5167790262 --dump   # 本文全文を出す
 */
const CDP = "http://127.0.0.1:9222";
const HOTEL_ID = "14868587"; // the Terrace 長浜

const argv = process.argv.slice(2);
const RES_ID = (() => {
  const i = argv.indexOf("--res");
  return i >= 0 ? argv[i + 1] : null;
})();
const DUMP = argv.includes("--dump");
if (!RES_ID) {
  console.error("--res <予約番号> が必要です");
  process.exit(1);
}

const URL_RES = `https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/booking.html?res_id=${RES_ID}&hotel_id=${HOTEL_ID}&lang=ja`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + " timeout")), ms))]);
}

async function cdpAlive() {
  try { const r = await withTimeout(fetch(CDP + "/json/version"), 3000, "ver"); return r.ok; } catch { return false; }
}
async function getTabs() { const r = await withTimeout(fetch(CDP + "/json"), 5000, "tabs"); return r.json(); }
async function cdpPut(path) { return withTimeout(fetch(CDP + path, { method: "PUT" }), 8000, "put"); }
async function activate(id) { try { await withTimeout(fetch(CDP + "/json/activate/" + id), 5000, "act"); } catch {} }

// 生WebSocketの最小CDPクライアント（Playwrightのハングを回避）
function connectWs(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map(); const waiters = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) { for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].method === m.method) { waiters[i].resolve(m); waiters.splice(i, 1); } }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", () => rej(new Error("ws接続失敗")), { once: true });
  });
  function send(method, params = {}, timeoutMs = 20000) {
    const myId = ++id;
    return new Promise((res, rej) => {
      const to = setTimeout(() => { pending.delete(myId); rej(new Error(method + " timeout")); }, timeoutMs);
      pending.set(myId, (m) => { clearTimeout(to); res(m); });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  }
  function waitEvent(method, timeoutMs = 15000) {
    return new Promise((res) => {
      const w = { method, resolve: res }; waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); res(null); }, timeoutMs);
    });
  }
  return { ready, send, waitEvent, close: () => { try { ws.close(); } catch {} } };
}

async function evalJson(cli, expr) {
  await cli.send("Runtime.enable");
  const r = await cli.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
}

async function main() {
  if (!(await cdpAlive())) {
    console.log("🚨 デバッグChrome(CDP:9222)に接続できません。Chromeを起動してください。");
    process.exitCode = 1;
    return;
  }

  // admin.booking.com のタブを確保（既存があれば再利用。無ければ新規）
  let tabs = await getTabs();
  let t = tabs.find((x) => x.type === "page" && /admin\.booking\.com/.test(x.url || ""));
  if (!t) {
    await cdpPut("/json/new?" + encodeURI(URL_RES));
    await sleep(5000);
    tabs = await getTabs();
    t = tabs.find((x) => x.type === "page" && /booking\.com/.test(x.url || ""));
  }
  if (!t) throw new Error("Booking.com のタブを用意できません");

  const cli = connectWs(t.webSocketDebuggerUrl);
  await cli.ready;
  await cli.send("Page.enable");

  // 目的の予約ページへ遷移
  const load = cli.waitEvent("Page.loadEventFired", 25000);
  await cli.send("Page.navigate", { url: URL_RES });
  await load;
  await sleep(4000);

  const info = await evalJson(cli, `(() => {
    const url = location.href;
    const title = document.title || "";
    const text = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n");
    return { url, title, text };
  })()`);

  if (!info) throw new Error("ページ内容を取得できません");

  const loggedOut = /sign[- ]?in|ログイン|account\.booking\.com/i.test(info.url)
    || /ログイン|パスワード/.test(info.title);

  console.log("URL  :", info.url);
  console.log("TITLE:", info.title);

  if (loggedOut) {
    await activate(t.id);
    console.log("\n🔑 未ログインです。Chrome を前面に出しました。ログイン後にもう一度このコマンドを実行してください。");
    cli.close();
    return;
  }

  const text = info.text || "";
  console.log("\n===== ページ本文 =====");
  console.log(DUMP ? text : text.slice(0, 4000));

  // 人数らしき記述を抽出
  console.log("\n===== 人数候補の行 =====");
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (/大人|子供|子ども|ゲスト|人数|名|adults?|children|guests?/i.test(lines[i])) {
      console.log(`  ${lines[i]}${lines[i + 1] ? "  ⏎ " + lines[i + 1] : ""}`);
    }
  }

  cli.close();
}

main()
  .then(() => console.log("\n完了"))
  .catch((e) => { console.error("エラー:", e.message); process.exitCode = 1; });
