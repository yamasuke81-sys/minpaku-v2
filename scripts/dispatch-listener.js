/**
 * Dispatch Listener — 常時起動 PC で動かす Firestore queue 監視デーモン
 *
 * 動作:
 *   1. dispatchQueue.where("status","==","pending") を onSnapshot で監視
 *   2. 新規 pending を検知 → status="processing" にロック (ジョブは直列処理)
 *   3. command の種別 (kind) に応じて処理を実行
 *      - timee_post:     Playwright でタイミー求人フォームを自動入力 → 投稿
 *      - session_check:  タイミーのログイン状態を点検 (キープアライブ兼、8時間毎に自己投入)
 *   4. 完了したら status="done" (or "failed") + completedAt 記録
 *   5. settings/dispatchListener を 60 秒毎に heartbeat 更新
 *   6. セッション失効はDiscordへ通知 (初回即時＋3日毎リマインド、復旧時は✅通知)
 *
 * 前提:
 *   - Firebase Admin SDK で認証
 *     → 環境変数 GOOGLE_APPLICATION_CREDENTIALS にサービスアカウント JSON のパスをセット
 *       例 (PowerShell): $env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\serviceAccount.json"
 *     または Firebase CLI ログイン状態 (firebase login:ci で取得した認証情報) でも可
 *   - 初回起動時、Playwright で開く Chromium 上でタイミーに手動ログインしておく
 *     (Cookie が user-data-dir に保存され以降は維持される)
 *
 * 起動:
 *   cd C:\Users\yamas\AI_Workspace\minpaku-v2
 *   node scripts/dispatch-listener.js
 *   (バックグラウンド化: pm2 start scripts/dispatch-listener.js --name dispatch-listener)
 *   再ログイン: scripts\dispatch-relogin.cmd (pm2停止→ --login でログイン→ pm2再開)
 */

const admin = require("firebase-admin");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const { chromium } = require("playwright");

// ================== 定数 ==================
const VERSION = "0.2.0"; // 0.2.0: 未ログイン偽成功修正+Discord通知+session_check状態機械+heartbeat+--login
const LOG_PREFIX = "[listener]";

if (!admin.apps.length) {
  admin.initializeApp({ projectId: "minpaku-v2" });
}
const db = admin.firestore();

// Playwright 用専用 user-data-dir (タイミーログインセッション保持用)
// 初回はこのプロファイルで Chromium 起動してタイミー手動ログイン → 以降は自動継続
const PLAYWRIGHT_USER_DATA_DIR = path.join(process.env.USERPROFILE || process.env.HOME || ".", ".dispatch-playwright-chrome");
// ヘッドフル (画面表示) を強制 (デバッグ + ユーザー視認用)
const PLAYWRIGHT_HEADLESS = process.env.PLAYWRIGHT_HEADLESS === "1";

// セッション失効アラートの状態ファイル (ログイン確認/失効/通知履歴を永続化)
const SESSION_STATE_FILE = path.join(PLAYWRIGHT_USER_DATA_DIR, "session-state.json");
const HEARTBEAT_INTERVAL_MS = 60_000;
// 未ログインによるジョブ失敗の連続 Discord 通知は 6 時間抑制
const JOB_FAIL_NOTIFY_SUPPRESS_H = 6;
// 失効継続中のリマインドは最低20時間間隔・3日毎程度 (タイミーは月次サイクルがないため定期リマインドのみ)
const EXPIRE_REMIND_MIN_INTERVAL_H = 20;
const EXPIRE_REMIND_EVERY_H = 72;
// 状態ファイル内のサイトキー (yadozei-listener と同形式のサイト別マップ)
const TIMEE_SITE = "タイミー";
// timeeAutofill.baseUrl が1件も見つからない場合のフォールバック判定URL (要ログインのアカウントページ)
const TIMEE_ACCOUNT_URL = "https://app-new.taimee.co.jp/account";

try {
  fs.mkdirSync(PLAYWRIGHT_USER_DATA_DIR, { recursive: true });
} catch (_) {
  /* ignore */
}

// クラッシュ痕跡を残す (プロセスは落とさず継続 — 常駐ワーカーとして生存優先)
const CRASH_LOG = path.join(PLAYWRIGHT_USER_DATA_DIR, "listener-crash.log");
function logCrash(kind, err) {
  const msg = `[${new Date().toISOString()}] ${kind}: ${err?.stack || err}\n`;
  console.error(`${LOG_PREFIX} ${kind}:`, err);
  try {
    fs.appendFileSync(CRASH_LOG, msg);
  } catch (_) {
    /* ignore */
  }
}
process.on("uncaughtException", (e) => logCrash("uncaughtException", e));
process.on("unhandledRejection", (e) => logCrash("unhandledRejection", e));

// ================== ブラウザコンテキスト管理 ==================
// 永続コンテキスト (Chromium) は同時に1つだけ。ジョブ/セッションチェックで共有プロファイルを使うため、
// 並行起動するとプロファイルロック競合で "context has been closed" になる (直列処理+毎回作り直しで防ぐ)。
let _persistentCtx = null;
async function launchCtx() {
  const ctx = await chromium.launchPersistentContext(PLAYWRIGHT_USER_DATA_DIR, {
    headless: PLAYWRIGHT_HEADLESS,
    viewport: null, // フルウィンドウ
    args: ["--start-maximized"],
  });
  // コンテキストが閉じたら参照をクリア (次ジョブで作り直す)
  ctx.on("close", () => {
    if (_persistentCtx === ctx) _persistentCtx = null;
  });
  // session_check が自ページを閉じてもブラウザごと終了しないよう、キープアライブページを1枚残す
  try {
    await ctx.newPage(); // about:blank を1枚残す (閉じない)
  } catch (_) {
    /* ignore */
  }
  return ctx;
}

async function getContext() {
  // 共有せず毎回新規起動する。前回のコンテキストが残っていれば必ず閉じてから起動
  // (死んだ context の再利用や、複数コンテキストによるプロファイルロック競合を防ぐ)。
  // ※ 前ジョブの結果表示ウィンドウは次のジョブ開始時に閉じられる。
  if (_persistentCtx) {
    try {
      await _persistentCtx.close();
    } catch (_) {
      /* ignore */
    }
    _persistentCtx = null;
  }
  console.log(`${LOG_PREFIX} ブラウザを起動します (headless=${PLAYWRIGHT_HEADLESS})`);
  // プロファイルロック競合等でたまに失敗するのでリトライ (待ってからやり直す)
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      _persistentCtx = await launchCtx();
      return _persistentCtx;
    } catch (e) {
      lastErr = e;
      console.warn(`${LOG_PREFIX} コンテキスト起動失敗 (試行${attempt + 1}/3): ${e.message}`);
      await new Promise((r) => setTimeout(r, 4000)); // プロファイルロック解放待ち
    }
  }
  throw lastErr;
}

// ================== heartbeat ==================
async function updateHeartbeat() {
  try {
    await db.collection("settings").doc("dispatchListener").set(
      {
        lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
        hostName: os.hostname(),
        version: VERSION,
      },
      { merge: true }
    );
  } catch (e) {
    console.warn(`${LOG_PREFIX} heartbeat 更新失敗: ${e.message}`);
  }
}

// ================== Discord 通知 ==================
// Discord Webhook へ単純POST (minpaku-v2 settings/notifications の discordOwnerWebhookUrl を流用)
function postDiscord_(webhookUrl, content) {
  return new Promise((resolve) => {
    try {
      const u = new URL(webhookUrl);
      const body = JSON.stringify({ content: String(content || "").slice(0, 1900) });
      const req = https.request(
        {
          hostname: u.hostname, path: u.pathname + u.search, method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "User-Agent": "dispatch-listener" },
        },
        (res) => { res.on("data", () => {}); res.on("end", () => resolve({ ok: res.statusCode < 300, status: res.statusCode })); },
      );
      req.on("error", (e) => resolve({ ok: false, error: e.message }));
      req.write(body); req.end();
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

async function notifyDiscord_(content) {
  try {
    const doc = await db.collection("settings").doc("notifications").get();
    const url = doc.exists ? (doc.data()?.settings?.discordOwnerWebhookUrl || doc.data()?.discordOwnerWebhookUrl) : null;
    if (!url) { console.warn(`${LOG_PREFIX} Discord webhook 未設定 (settings/notifications.settings.discordOwnerWebhookUrl)`); return; }
    const r = await postDiscord_(url, content);
    console.log(`${LOG_PREFIX} Discord通知 ${r.ok ? "送信OK" : "失敗:" + (r.error || r.status)}`);
  } catch (e) { console.warn(`${LOG_PREFIX} Discord通知失敗: ${e.message}`); }
}

// ---- セッション状態の永続化 (sessionStartAt / lastOkAt / expiredSince / lastExpiredNotifyAt / lastJobFailNotifyAt) ----
function loadSessionState_() {
  try { return JSON.parse(fs.readFileSync(SESSION_STATE_FILE, "utf8")); } catch (_) { return {}; }
}
function saveSessionState_(state) {
  try { fs.writeFileSync(SESSION_STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.warn(`${LOG_PREFIX} session-state 保存失敗: ${e.message}`); }
}
function fmtJst_(iso) {
  if (!iso) return "不明";
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

// 未ログインでジョブが失敗したときの Discord 即時通知 (同一原因の連続通知は6時間抑制)
async function notifyTimeeLoginFailure_(docId, err) {
  const state = loadSessionState_();
  const st = state[TIMEE_SITE] || (state[TIMEE_SITE] = {});
  const nowIso = new Date().toISOString();
  // 失効フラグを立てる (boot recovery / 復旧✅通知の起点になる)
  if (!st.expiredSince) {
    st.expiredSince = nowIso;
    st.lastExpiredNotifyAt = nowIso;
  }
  const hoursSince = (Date.now() - new Date(st.lastJobFailNotifyAt || 0).getTime()) / 3600000;
  if (hoursSince < JOB_FAIL_NOTIFY_SUPPRESS_H) {
    saveSessionState_(state);
    console.log(`${LOG_PREFIX} 未ログイン失敗通知は${JOB_FAIL_NOTIFY_SUPPRESS_H}時間抑制中 (前回 ${fmtJst_(st.lastJobFailNotifyAt)})`);
    return;
  }
  st.lastJobFailNotifyAt = nowIso;
  saveSessionState_(state);
  const c = err.jobContext || {};
  await notifyDiscord_([
    `⚠️ **タイミー自動投稿失敗: 未ログイン**`,
    `対象: ${c.propertyName || "物件不明"} / チェックアウト ${c.checkoutDate || "?"} / 予約 ${c.bookingId || "?"}`,
    `ジョブ ${docId} は failed にしました (予約への「募集中」書き込みは行っていません)。`,
    `再ログイン: このチャンネルに **「タイミー再ログイン」** と送信（PC側の準備は全自動）→ 開いたブラウザでログイン → 閉じるだけ。PCから直接なら \`scripts\\dispatch-relogin.cmd\` でも可`,
  ].join("\n"));
}

// ================== タイミー URL 構築 (Cloud Functions の buildTimeeAutofillUrl_ と同等) ==================
function buildTimeeAutofillUrl(tf, checkOut, visibility) {
  if (!tf || !tf.baseUrl || !checkOut) return null;
  const url = new URL(tf.baseUrl);
  url.searchParams.set("openExternalBrowser", "1");
  const params = new URLSearchParams();
  params.set("date", checkOut);
  if (tf.start) params.set("start", tf.start);
  if (tf.end) params.set("end", tf.end);
  if (tf.restMin != null) params.set("restMin", String(tf.restMin));
  if (tf.workers) params.set("workers", String(tf.workers));
  params.set("visibility", visibility);
  if (visibility === "group_limited" && tf.groupIds) params.set("groupIds", tf.groupIds);
  if (tf.wage) params.set("wage", String(tf.wage));
  if (tf.transport != null) params.set("transport", String(tf.transport));
  if (tf.autoMsg != null) params.set("autoMsg", tf.autoMsg ? "true" : "false");
  if (tf.autoMsgTarget) params.set("autoMsgTarget", tf.autoMsgTarget);
  return `${url.toString()}#${params.toString()}`;
}

// ================== 既定ブラウザで URL を開く ==================
function openInBrowser(url) {
  // shell:true で OS デフォルトシェル経由 (Windows: cmd.exe, *nix: sh)
  // URL を直接シェルに渡すので簡単。引用符のエスケープは Windows の "" + 二重引用符で対応
  let cmdline;
  if (process.platform === "win32") {
    // start の第1引数 "" はタイトル指定 (省略不可)。URL は引用符で囲む
    cmdline = `start "" "${url}"`;
  } else if (process.platform === "darwin") {
    cmdline = `open "${url}"`;
  } else {
    cmdline = `xdg-open "${url}"`;
  }
  const child = spawn(cmdline, [], { detached: true, stdio: "ignore", shell: true });
  child.unref();
}

// ================== ジョブ処理 ==================
async function handleJob(docId, data) {
  const ref = db.collection("dispatchQueue").doc(docId);
  console.log(`${LOG_PREFIX} processing ${docId} kind=${data.kind} command=${data.command || "-"}`);

  // ロック (already-locked なら何もせず終了)
  try {
    await db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (!cur.exists) throw new Error("doc disappeared");
      if (cur.data().status !== "pending") throw new Error("not pending");
      tx.update(ref, {
        status: "processing",
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    console.log(`${LOG_PREFIX} skip ${docId}: ${e.message}`);
    return;
  }

  try {
    let result = null;
    if (data.kind === "timee_post") {
      await handleTimeePost(data);
    } else if (data.kind === "session_check") {
      result = await handleSessionCheck(docId);
    } else {
      throw new Error(`unknown kind: ${data.kind}`);
    }
    await ref.update({
      status: "done",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(result ? { result } : {}),
    });
    console.log(`${LOG_PREFIX} done ${docId}`);
  } catch (e) {
    console.error(`${LOG_PREFIX} failed ${docId}:`, e.message);
    await ref.update({
      status: "failed",
      error: String(e.message || e).slice(0, 500),
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch((e2) => console.warn(`${LOG_PREFIX} failed 書き込み失敗 ${docId}: ${e2.message}`));
    // タイミー未ログインによる失敗は Discord へ即時通知 (6時間抑制付き)
    if (e && e.timeeNotLoggedIn) {
      await notifyTimeeLoginFailure_(docId, e).catch((e2) => console.warn(`${LOG_PREFIX} 未ログイン通知失敗: ${e2.message}`));
    }
  }
}

async function handleTimeePost(data) {
  const { bookingId, params } = data;
  const visibility = params?.visibility;
  const checkoutDate = params?.checkoutDate;
  if (!bookingId || !visibility || !checkoutDate) {
    throw new Error("missing required params (bookingId/visibility/checkoutDate)");
  }
  // 物件マスタから timeeAutofill 設定を取得
  const bDoc = await db.collection("bookings").doc(bookingId).get();
  if (!bDoc.exists) throw new Error(`booking not found: ${bookingId}`);
  const propertyId = bDoc.data().propertyId;
  if (!propertyId) throw new Error("booking has no propertyId");
  const pDoc = await db.collection("properties").doc(propertyId).get();
  if (!pDoc.exists) throw new Error(`property not found: ${propertyId}`);
  const tf = pDoc.data().timeeAutofill;
  if (!tf || !tf.baseUrl) {
    throw new Error("property.timeeAutofill 未設定 (タイミー求人テンプレ URL がない)");
  }

  const url = buildTimeeAutofillUrl(tf, checkoutDate, visibility);
  if (!url) throw new Error("buildTimeeAutofillUrl が null を返した");
  console.log(`${LOG_PREFIX} opening with Playwright: ${url.slice(0, 80)}...`);

  // Playwright で Chromium 起動 + 求人作成ボタンまで自動押下
  // 失敗時は openInBrowser にフォールバック (手動操作で続行できる)
  // ※ 未ログインだけはフォールバックしない — job を failed にして Discord 通知する
  //   (以前は console.warn + ログインURLの正常 return で timeeStatus="posted" になる偽成功だった)
  let createdUrl;
  try {
    createdUrl = await autoSubmitTimeeJob(url);
    console.log(`${LOG_PREFIX} timee 求人作成完了: ${createdUrl}`);
  } catch (e) {
    if (e && e.timeeNotLoggedIn) {
      // 通知用の予約/物件情報を添えて上へ投げる → handleJob が failed + Discord 通知。
      // 以降の bookings への「posted」書き込みには絶対到達しない (偽成功の根絶)。
      e.jobContext = {
        bookingId,
        propertyName: pDoc.data().name || params?.propertyName || propertyId,
        checkoutDate,
        visibility,
      };
      throw e;
    }
    console.error(`${LOG_PREFIX} Playwright 自動投稿失敗 (${e.message}) → 既定ブラウザで開いてフォールバック`);
    openInBrowser(url);
    createdUrl = url;
  }

  // bookings に「タイミー募集中」状態 + 開いた URL を保存 (UI のバッジから再アクセス用)
  // ※ ここに来るのは 自動投稿成功 or 既定ブラウザフォールバック (手動続行) のときだけ
  try {
    await db.collection("bookings").doc(bookingId).update({
      timeeStatus: "posted",
      timeePostedAt: admin.firestore.FieldValue.serverTimestamp(),
      timeePostedVisibility: visibility,
      timeePostedUrl: createdUrl,
    });
  } catch (e) {
    console.warn(`${LOG_PREFIX} timeeStatus 更新失敗 (${bookingId}):`, e.message);
  }
}

/**
 * Playwright で Chromium を起動し、Tampermonkey 相当の自動入力 + 「求人を作成」ボタン押下まで自動化
 * 戻り値: 求人作成後のページ URL (公開された求人ページの URL になる想定)
 * 注意:
 *   - 初回は専用 user-data-dir にタイミー手動ログインが必要
 *   - 未ログイン検出時は throw する (偽成功防止。ブラウザはログイン画面のまま残る)
 *   - タイミー側 UI が変わると DOM セレクタが壊れるため、その場合は手動で開く方が安全
 */
async function autoSubmitTimeeJob(url) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // タイミー未ログインなら "/sign_in" 等にリダイレクトされる想定
    await page.waitForTimeout(2000); // 自動入力スクリプト相当の値反映を待つ猶予
    if (/sign_in|login/i.test(page.url())) {
      // 偽成功の根絶: ログインURLを正常 return せず必ず throw → job は failed になる。
      // ブラウザはログイン画面のまま残すので、その場で手動ログインしてもよい
      // (正規の再ログイン手順は scripts\dispatch-relogin.cmd)
      const err = new Error("タイミー未ログイン (再ログイン要: scripts\\dispatch-relogin.cmd)");
      err.timeeNotLoggedIn = true;
      throw err;
    }

    // hash params から値を読み取り、フォームに入力 (Tampermonkey と同等処理)
    await applyTimeeHashParams(page, url);

    // 「求人を作成」ボタンを探してクリック
    // セレクタ候補 (タイミー側 UI 変更で要メンテ):
    //   1. テキストが「求人を作成」「保存」「投稿」「公開」を含むボタン
    //   2. type=submit
    const submitBtn = await page.locator(
      'button:has-text("求人を作成"), button:has-text("作成する"), button:has-text("保存"), button[type="submit"]'
    ).first();
    if (!(await submitBtn.count())) {
      throw new Error("「求人を作成」ボタンが見つからない (タイミー UI 変更の可能性)");
    }
    await submitBtn.waitFor({ state: "visible", timeout: 10000 });
    await submitBtn.click();

    // 確認ダイアログ or 公開完了画面への遷移を待つ
    // 確認モーダルが出る場合は「OK」「公開」ボタンを再度押す
    await page.waitForTimeout(2000);
    const confirmBtn = page.locator(
      'button:has-text("公開"), button:has-text("確定"), button:has-text("OK"), [role="dialog"] button:has-text("はい")'
    ).first();
    if (await confirmBtn.count()) {
      try { await confirmBtn.click({ timeout: 3000 }); } catch (_) {}
    }

    // 求人作成完了後の URL を取得
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    const finalUrl = page.url();
    // ウィンドウは閉じずに残す (yamasuke が結果を確認できるよう)
    return finalUrl;
  } finally {
    // ctx.close() は呼ばない — yamasuke が画面確認できるよう放置 (次ジョブ開始時に getContext が閉じる)
  }
}

/** Tampermonkey ユーザースクリプトと同等の hash params → フォーム入力ロジック */
async function applyTimeeHashParams(page, fullUrl) {
  // hash 部分を取り出して page.evaluate に渡す
  const hashIdx = fullUrl.indexOf("#");
  if (hashIdx < 0) return;
  const hashStr = fullUrl.slice(hashIdx + 1);
  await page.evaluate((hs) => {
    const params = new URLSearchParams(hs);
    const set = (sel, value) => {
      if (value == null || value === "") return;
      const el = document.querySelector(sel);
      if (!el) return false;
      el.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      if (nativeSetter) nativeSetter.call(el, String(value));
      else el.value = String(value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.blur();
      return true;
    };
    // 主な候補セレクタ (Tampermonkey と同じ箇所、UI 変更で要メンテ)
    set('input[name="date"], input[type="date"]', params.get("date"));
    set('input[name="start_at"], input[name="start"]', params.get("start"));
    set('input[name="end_at"], input[name="end"]', params.get("end"));
    set('input[name="rest_minute"], input[name="restMin"]', params.get("restMin"));
    set('input[name="workers"], input[name="recruit_count"]', params.get("workers"));
    set('input[name="hourly_wage"], input[name="wage"]', params.get("wage"));
  }, hashStr);
}

// ================== セッション健全性チェック (キープアライブ兼) ==================
// 判定URLの解決: ジョブと同じ画面 (timeeAutofill.baseUrl) で判定する (handleTimeePost と同条件)。
// baseUrl を持つ物件が無ければ要ログインのアカウントページで代替。
async function resolveTimeeCheckUrl_() {
  try {
    const snap = await db.collection("properties").get();
    for (const d of snap.docs) {
      const tf = d.data()?.timeeAutofill;
      if (tf?.baseUrl) return tf.baseUrl;
    }
  } catch (e) {
    console.warn(`${LOG_PREFIX} [session_check] properties 読取失敗 (フォールバックURLで判定): ${e.message}`);
  }
  return TIMEE_ACCOUNT_URL;
}

// タイミーのログイン状態を点検。アクセス自体がキープアライブ(セッション延命)。
//   失効の初回検知: 即通知 (セッション持続日数の実測付き)
//   失効継続中:     20時間以上間隔を空けて3日毎程度にリマインド (タイミーは月次サイクルがないため)
//   復旧(再ログイン): 即「✅ タイミー再ログイン確認」を通知し、持続日数の計測を再スタート
async function handleSessionCheck(jobId) {
  const checkUrl = await resolveTimeeCheckUrl_();
  const ctx = await getContext();
  const page = await ctx.newPage();
  let status = "error"; // 判定不能の既定値 (誤通知を避け、未ログインには含めない)
  let landedUrl = "";
  try {
    await page.goto(checkUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(3500); // リダイレクト確定待ち
    landedUrl = page.url();
    if (landedUrl && landedUrl !== "about:blank") {
      // handleTimeePost 内の未ログイン判定ロジックと同一 (/sign_in 等へのリダイレクト検出)
      status = /sign_in|login/i.test(landedUrl) ? "logged_out" : "ok";
      if (status === "logged_out") {
        // 誤検知対策(yadozei側で2026-07-14実測: リダイレクト途中URLを掴んで失効誤報)。
        // 5秒置いて再訪問し、2回連続で未ログインのときだけ失効と判定する。
        await page.waitForTimeout(5000);
        await page.goto(checkUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
        await page.waitForTimeout(3500);
        landedUrl = page.url();
        status = /sign_in|login/i.test(landedUrl) ? "logged_out" : "ok";
        if (status === "ok") console.log(`${LOG_PREFIX} [session_check] 初回の未ログイン判定は一過性(再訪問でOK)`);
      }
    }
    console.log(`${LOG_PREFIX} [session_check] タイミー: ${status === "ok" ? "✓ OK" : status === "logged_out" ? "✗ 未ログイン" : "? 判定不能"} (${landedUrl.slice(0, 70)})`);
  } catch (e) {
    console.warn(`${LOG_PREFIX} [session_check] 点検失敗: ${e.message}`);
  } finally {
    await page.close().catch(() => {});
  }

  // 状態を必ず記録 (webhook未設定でも失効を検知・可視化できる)。heartbeat と同じ doc。
  try {
    await db.collection("settings").doc("dispatchListener").set(
      { sessionCheck: { at: admin.firestore.FieldValue.serverTimestamp(), status, url: landedUrl.slice(0, 200) } },
      { merge: true });
  } catch (_) { /* ignore */ }

  // ---- 通知ポリシー (鳴りっぱなし防止) ----
  const state = loadSessionState_();
  const st = state[TIMEE_SITE] || (state[TIMEE_SITE] = {});
  const nowIso = new Date().toISOString();
  let notice = null;
  if (status === "ok") {
    if (st.expiredSince) {
      // 復旧検知 → 即✅通知 + 計測再スタート
      notice = `✅ **タイミー再ログイン確認** — 自動投稿・キープアライブを再開しました。セッション持続日数はここから自動計測します。`;
      st.sessionStartAt = nowIso;
      st.expiredSince = null;
      st.lastExpiredNotifyAt = null;
      st.lastJobFailNotifyAt = null; // 次に失効した時のジョブ失敗通知を即時に戻す
    } else if (!st.sessionStartAt) {
      st.sessionStartAt = nowIso; // 初回観測 (実ログインより遅い可能性あり=下限値)
    }
    st.lastOkAt = nowIso;
  } else if (status === "logged_out") {
    if (!st.expiredSince) {
      // 失効の初回検知 → 即通知 (持続日数の実測付き)
      st.expiredSince = nowIso;
      st.lastExpiredNotifyAt = nowIso;
      const lines = [`⚠️ **タイミー自動投稿: セッション失効**`];
      if (st.sessionStartAt && st.lastOkAt) {
        const days = ((new Date(st.lastOkAt) - new Date(st.sessionStartAt)) / 86400000).toFixed(1);
        lines.push(`📏 持続実測: ${fmtJst_(st.sessionStartAt)} ログイン確認 〜 ${fmtJst_(st.lastOkAt)} 正常 (約${days}日)`);
      }
      lines.push(`失効中はタイミー求人の自動投稿が失敗します。リマインドは3日毎程度に送ります。`);
      lines.push(`再ログイン: このチャンネルに **「タイミー再ログイン」** と送信（PC側の準備は全自動）→ 開いたブラウザでログイン → 閉じるだけ。PCから直接なら \`scripts\\dispatch-relogin.cmd\` でも可`);
      notice = lines.join("\n");
    } else {
      // 失効継続中 → 最低20時間間隔・3日毎程度にリマインド
      const hoursSince = (Date.now() - new Date(st.lastExpiredNotifyAt || 0).getTime()) / 3600000;
      if (hoursSince >= Math.max(EXPIRE_REMIND_EVERY_H, EXPIRE_REMIND_MIN_INTERVAL_H)) {
        st.lastExpiredNotifyAt = nowIso;
        const days = ((Date.now() - new Date(st.expiredSince).getTime()) / 86400000).toFixed(1);
        notice =
          `⏰ **リマインド: タイミーが未ログインのままです** (失効から約${days}日)\n` +
          `再ログイン: このチャンネルに **「タイミー再ログイン」** と送信（PC側の準備は全自動）→ 開いたブラウザでログイン → 閉じるだけ。PCから直接なら \`scripts\\dispatch-relogin.cmd\` でも可`;
      } else {
        console.log(`${LOG_PREFIX} [session_check] 失効継続中 — 再通知条件外のため抑制`);
      }
    }
  }
  // status === "error" は判定不能のため状態を変更しない

  saveSessionState_(state);
  if (notice) await notifyDiscord_(notice);
  if (status === "ok") console.log(`${LOG_PREFIX} [session_check] タイミーOK (キープアライブ完了)`);
  return { status, url: landedUrl.slice(0, 120) };
}

// ================== 起動 ==================
const LOGIN_MODE = process.argv.includes("--login");
console.log(`${LOG_PREFIX} 起動 v${VERSION} host=${os.hostname()} cwd=${process.cwd()}${LOGIN_MODE ? " [ログインモード]" : ""}`);
console.log(`${LOG_PREFIX} USER_DATA_DIR=${PLAYWRIGHT_USER_DATA_DIR}`);

let heartbeatTimer = null;
let unsubscribe = null;

if (LOGIN_MODE) {
  // ログインモード: Chromium を即起動し、タイミーのログインページ(要ログインのアカウントページ)を開いて待つ。
  // ここでログインすると Cookie が USER_DATA_DIR に保存され、以降の通常起動で自動継続する。
  (async () => {
    const ctx = await getContext();
    // ブラウザ(全ウィンドウ)が閉じられたら自動終了 → dispatch-relogin.cmd が pm2 再開に進める
    ctx.on("close", () => {
      console.log(`${LOG_PREFIX} ブラウザが閉じられました。ログインモードを終了します。`);
      process.exit(0);
    });
    const p = await ctx.newPage();
    await p.goto(TIMEE_ACCOUNT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => {
      console.warn(`${LOG_PREFIX} タイミーを開けませんでした: ${e.message}`);
    });
    console.log(`${LOG_PREFIX} ================================================`);
    console.log(`${LOG_PREFIX} タイミーのタブを開きました。ログインしてください。`);
    console.log(`${LOG_PREFIX} ログイン完了後、ブラウザを閉じれば自動で終了します (Ctrl+C でも可)`);
    console.log(`${LOG_PREFIX} ================================================`);
    // プロセスを生かし続ける (Chromium を開いたまま)
    setInterval(() => {}, 1 << 30);
  })().catch((e) => {
    console.error(`${LOG_PREFIX} ログインモード起動失敗: ${e.message}`);
    process.exit(1);
  });
} else {
  // 通常モード: heartbeat (起動時 + 60秒毎) + dispatchQueue 監視
  updateHeartbeat();
  heartbeatTimer = setInterval(updateHeartbeat, HEARTBEAT_INTERVAL_MS);

  // セッション健全性チェック(キープアライブ兼)を定期 enqueue。docId を JST の 8時間バケット固定で冪等化
  // (同一バケット内は create() が失敗しスキップ → 実質1日3回、日付/バケット跨ぎで新規)。実処理は handleSessionCheck。
  // ジョブ処理と同じブラウザプロファイルを使うため、dispatchQueue 経由で既存の直列化に乗せる
  // (並行起動によるプロファイルロック競合を防ぐ)。
  async function enqueueSessionCheck() {
    try {
      const j = new Date(Date.now() + 9 * 3600 * 1000); // JST
      const ymd = `${j.getUTCFullYear()}${String(j.getUTCMonth() + 1).padStart(2, "0")}${String(j.getUTCDate()).padStart(2, "0")}`;
      const bucket = Math.floor(j.getUTCHours() / 8); // 0/1/2 (8時間毎)
      const id = `session_check_${ymd}_${bucket}`;
      await db.collection("dispatchQueue").doc(id).create({
        kind: "session_check", status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: "listener_periodic",
      });
      console.log(`${LOG_PREFIX} session_check enqueued: ${id}`);
    } catch (e) {
      if (!/already exists/i.test(e.message)) console.warn(`${LOG_PREFIX} session_check enqueue: ${e.message}`);
    }
  }
  setTimeout(enqueueSessionCheck, 20_000); // 起動20秒後に初回
  setInterval(enqueueSessionCheck, 60 * 60 * 1000); // 毎時トライ(8hバケットで冪等 → 実質1日3回)

  // 失効検知中のまま再起動された場合 (=再ログイン直後の可能性が高い) は、8hバケットを
  // 待たずユニークIDで即チェックを投入し、「✅ タイミー再ログイン確認」を早く返す (boot recovery)。
  try {
    const st = loadSessionState_();
    if (Object.values(st).some((v) => v && v.expiredSince)) {
      setTimeout(async () => {
        try {
          await db.collection("dispatchQueue").doc(`session_check_boot_${Date.now()}`).create({
            kind: "session_check", status: "pending",
            createdAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: "listener_boot_recovery",
          });
          console.log(`${LOG_PREFIX} 再ログイン確認用 session_check を投入 (boot)`);
        } catch (e) {
          console.warn(`${LOG_PREFIX} boot session_check 投入失敗: ${e.message}`);
        }
      }, 30_000);
    }
  } catch (_) { /* ignore */ }

  // ジョブは必ず直列処理する。並行して同じ Chrome プロファイルを起動すると
  // ロック競合で "context has been closed" になるため。docId 単位で重複投入も防ぐ。
  const _queue = [];
  const _seen = new Set();
  let _draining = false;
  async function drainQueue() {
    if (_draining) return;
    _draining = true;
    while (_queue.length) {
      const { id, data } = _queue.shift();
      try {
        await handleJob(id, data);
      } catch (e) {
        console.error(`${LOG_PREFIX} ジョブ処理で未捕捉例外: ${e.message}`);
      } finally {
        _seen.delete(id);
      }
    }
    // キューが空になったらブラウザを閉じる(headed窓を画面に残さない+pm2再起動時の孤児化防止)。
    // 投稿結果の確認は Discord/LINE 通知とスクリーンショットで担保(窓の放置はやめる 2026-07-14)。
    if (_persistentCtx) {
      try { await _persistentCtx.close(); } catch (_) { /* ignore */ }
      _persistentCtx = null;
      console.log(`${LOG_PREFIX} キュー空 — ブラウザを閉じました`);
    }
    _draining = false;
    if (_queue.length) drainQueue(); // close 中に到着したジョブを取りこぼさない
  }

  console.log(`${LOG_PREFIX} starting — watching dispatchQueue (status=pending)`);
  unsubscribe = db
    .collection("dispatchQueue")
    .where("status", "==", "pending")
    .onSnapshot(
      (snap) => {
        for (const change of snap.docChanges()) {
          if (change.type !== "added") continue;
          const id = change.doc.id;
          if (_seen.has(id)) continue; // 同じジョブの二重投入を防ぐ
          _seen.add(id);
          _queue.push({ id, data: change.doc.data() });
        }
        drainQueue();
      },
      (err) => {
        console.error(`${LOG_PREFIX} snapshot error:`, err.message);
      }
    );
}

// ================== graceful shutdown ==================
async function shutdown(signal) {
  console.log(`${LOG_PREFIX} ${signal} — shutting down`);
  try {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  } catch (_) {
    /* ignore */
  }
  try {
    if (unsubscribe) unsubscribe();
  } catch (_) {
    /* ignore */
  }
  try {
    if (_persistentCtx) {
      await _persistentCtx.close();
      _persistentCtx = null;
    }
  } catch (e) {
    console.warn(`${LOG_PREFIX} Chromium close 失敗: ${e.message}`);
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
