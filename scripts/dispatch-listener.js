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
const VERSION = "0.4.0"; // 0.4.0: 一般公開への自動切替オフ+マッチング時メッセージ送信を機械検証 (userscript v0.4.0 と対) / 0.3.2: group_limited×groupIds空を投稿前に弾く+確認画面へ進めない時に画面のエラー文言を拾う / 0.3.1: snapshot error を指数バックオフ再購読(2/8/32秒×3回)化+launchCtx を実Chrome→bundled Chromium フォールバック化 / 0.3.0: userscript注入統一+偽posted根絶+snapshot error 自己再起動
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
// タイミー未ログインを Discord 秘書(常駐bun)に伝えるフラグ。秘書がこれを見て
// 「🔑 ログイン画面を開く / 📱 リモートデスクトップ / 🆗 あとで」のボタンを投稿する。
// (webhook経由の通知にはボタンを付けられないため。2026-07-28 やますけ要望のワンタップ化)
const TIMEE_PENDING_FILE = path.join(os.homedir(), ".claude", "channels", "discord", "timee-relogin-pending.json");
function writeTimeePending_(pending, reason) {
  try {
    fs.writeFileSync(TIMEE_PENDING_FILE, JSON.stringify(
      pending ? { pending: true, ts: new Date().toISOString(), reason: reason || "" }
              : { pending: false, clearedAt: new Date().toISOString() }, null, 2));
  } catch (e) { console.warn(`${LOG_PREFIX} timee pending 書込失敗: ${e.message}`); }
}
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
// 自動入力ロジックは Tampermonkey ユーザースクリプト (手動フローで実績あり) を実物のまま注入して使う。
// ここに別実装を持つとタイミー UI 変更のたびに二重メンテになるため、入力ロジックはこの1ファイルが SSOT。
const AUTOFILL_USERSCRIPT_PATH = path.join(__dirname, "..", "public", "userscripts", "timee-autofill.user.js");

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
  const baseOpts = {
    headless: PLAYWRIGHT_HEADLESS,
    viewport: null, // フルウィンドウ
    args: ["--start-maximized"],
    bypassCSP: true, // ユーザースクリプト注入 (addScriptTag) をページ CSP に阻まれないため
  };
  // Playwright の bundled Chromium 実体が無い環境 (パッケージ更新後の playwright install 忘れ、
  // 2026-08-03 に chromium-1223 不在で4件失敗の実績) でも止まらないよう、
  // まずインストール済みの実 Chrome (channel: "chrome") で起動を試し、
  // 失敗したら channel を外して bundled Chromium で再試行する (yadozei-listener.mjs と同型のフォールバック)。
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PLAYWRIGHT_USER_DATA_DIR, { ...baseOpts, channel: "chrome" });
    console.log(`${LOG_PREFIX} 実 Chrome (channel=chrome) で起動しました`);
  } catch (e) {
    console.warn(`${LOG_PREFIX} 実 Chrome での起動失敗 (${String(e.message).split("\n")[0]}) — bundled Chromium で再試行します`);
    ctx = await chromium.launchPersistentContext(PLAYWRIGHT_USER_DATA_DIR, baseOpts);
    console.log(`${LOG_PREFIX} bundled Chromium で起動しました`);
  }
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
    `再ログイン: 直後に届く**ボタン**（🔑 ログイン画面を開く）を押すだけでOK。テキストで「タイミー再ログイン」でも同じ。PCから直接なら \`scripts\\dispatch-relogin.cmd\` でも可`,
  ].join("\n"));
  writeTimeePending_(true, "job_failed_logged_out"); // 秘書がボタン付きメッセージを出す
}

// 自動投稿が (未ログイン以外の理由で) 失敗し、既定ブラウザにフォールバックしたときの Discord 通知
async function notifyTimeeAutoPostFailure_(docId, err) {
  const c = err.jobContext || {};
  await notifyDiscord_([
    `⚠️ **タイミー自動投稿失敗 → 手動投稿が必要**`,
    `対象: ${c.propertyName || "物件不明"} / チェックアウト ${c.checkoutDate || "?"}`,
    `理由: ${String(err.message || err).slice(0, 200)}`,
    `PCの既定ブラウザに自動入力フォームを開きました。内容を確認して「求人を作成」を押してください。`,
    `※求人はまだ作成されていません (予約への「募集中」書き込みもしていません)。投稿前に求人一覧で重複がないか確認: ${c.offeringsUrl || "https://app-new.taimee.co.jp/"}`,
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
    } else if (e && e.timeeFallbackOpened) {
      // 自動投稿失敗 → 既定ブラウザ fallback は必ず通知 (無通知だと「見かけは動いた・実は未投稿」になる)
      await notifyTimeeAutoPostFailure_(docId, e).catch((e2) => console.warn(`${LOG_PREFIX} 投稿失敗通知失敗: ${e2.message}`));
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
    // グループ限定は groupIds が無いと成立しない。userscript はグループ限定ラジオだけ選び、
    // タイミーは確認ボタンを押した後に「限定公開グループを入力してください」で遷移を止めるため、
    // 事前に弾かないと「求人を公開ボタンが出ない」タイムアウトという読めない失敗になる (2026-08-11 実例)。
    // ここで throw すると下の catch が拾い、既定ブラウザで開く+Discord 通知まで乗る (人手ならグループを選べる)。
    if (visibility === "group_limited" && !String(tf.groupIds || "").trim()) {
      throw new Error(
        "timeeAutofill.groupIds が未設定のため「グループ限定」では投稿できません " +
        "(物件マスタにグループIDを設定するか、初回ワーカー限定で投稿してください)"
      );
    }
    createdUrl = await autoSubmitTimeeJob(url);
    console.log(`${LOG_PREFIX} timee 求人作成完了: ${createdUrl}`);
  } catch (e) {
    // 通知用の予約/物件情報を添えて上へ投げる → handleJob が failed + Discord 通知。
    // 以降の bookings への「posted」書き込みには絶対到達しない (偽成功の根絶)。
    e.jobContext = {
      bookingId,
      propertyName: pDoc.data().name || params?.propertyName || propertyId,
      checkoutDate,
      visibility,
      formUrl: url,
      offeringsUrl: url.replace(/\/offers\/.*$/, "/offerings"), // 手動確認用の求人一覧 URL
    };
    if (!e.timeeNotLoggedIn) {
      // 未ログイン以外の失敗は、自動入力フォームを既定ブラウザで開いて手動続行できるようにする。
      // 旧実装はここで done + timeeStatus="posted" にしていたが、実投稿が確認できていないのに
      // 「投稿済み」記録になる無通知の偽成功だったため、v0.3.0 から failed + Discord 通知に変更。
      console.error(`${LOG_PREFIX} Playwright 自動投稿失敗 (${e.message}) → 既定ブラウザで開いてフォールバック (要手動投稿)`);
      openInBrowser(url);
      e.timeeFallbackOpened = true;
    }
    throw e;
  }

  // bookings に「タイミー募集中」状態 + 投稿後の URL を保存 (UI のバッジから再アクセス用)
  // ※ ここに来るのは自動投稿の成立を検証できたときだけ
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
 * Playwright で Chromium を起動し、Tampermonkey ユーザースクリプト (実物) を注入して自動入力
 * → 入力結果を検証 → 「求人を作成」ボタン押下 → 求人一覧への出現で投稿成立を検証する。
 * 戻り値: 投稿成立を確認した後のページ URL
 * 注意:
 *   - 初回は専用 user-data-dir にタイミー手動ログインが必要
 *   - 未ログイン検出時は throw する (偽成功防止。ブラウザはログイン画面のまま残る)
 *   - 入力検証 NG / 投稿未成立も throw → 呼び出し元が既定ブラウザ fallback + Discord 通知
 */
async function autoSubmitTimeeJob(url) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

  // React SPA は domcontentloaded 後も描画が続く。ログインリダイレクト or フォーム描画 (#hourlyWage)
  // のどちらかが確定するまで待つ (旧実装は固定2秒待ちで描画前に諦めて常にフォールバックしていた)
  await Promise.race([
    page.waitForURL(/sign_in|login/i, { timeout: 45000 }).catch(() => {}),
    page.waitForFunction(() => !!document.getElementById("hourlyWage"), null, { timeout: 45000 }).catch(() => {}),
  ]);
  if (/sign_in|login/i.test(page.url())) {
    const err = new Error("タイミー未ログイン (再ログイン要: scripts\\dispatch-relogin.cmd)");
    err.timeeNotLoggedIn = true;
    throw err;
  }
  if (!(await page.evaluate(() => !!document.getElementById("hourlyWage")))) {
    throw new Error("投稿フォームが45秒以内に描画されない (タイミー UI 変更の可能性)");
  }

  // 自動入力: Tampermonkey スクリプトを注入 (完了合図 = スクリプトが出す画面バナー .__minpaku-timee-banner)
  const userscript = fs.readFileSync(AUTOFILL_USERSCRIPT_PATH, "utf8");
  await page.addScriptTag({ content: userscript });
  await page.waitForSelector(".__minpaku-timee-banner", { timeout: 25000 });

  // 入力結果の検証 (setNative の silent fail 対策): 日付/時給/開始/終了/公開設定が期待値どおりか
  const expected = parseHashParams_(url);
  const applied = await page.evaluate(() => {
    const v = (id) => document.getElementById(id)?.value ?? null;
    // タイミーの投稿フォームは複数日選択カレンダーで、選択済みセルは --highlighted が付く (--selected も念のため許容)
    const sel = document.querySelector(
      ".react-datepicker__day--highlighted:not(.react-datepicker__day--outside-month), .react-datepicker__day--selected:not(.react-datepicker__day--outside-month)"
    );
    const mSel = document.querySelector(".react-datepicker__month-select");
    const ySel = document.querySelector(".react-datepicker__year-select");
    return {
      wage: v("hourlyWage"),
      start: v("workTimeStart"),
      end: v("workTimeEnd"),
      selectedDate: sel && mSel && ySel
        ? `${ySel.value}-${String(Number(mSel.value) + 1).padStart(2, "0")}-${String(Number(sel.textContent.trim())).padStart(2, "0")}`
        : null,
    };
  });
  const visibilityOk = expected.visibility
    ? await page.evaluate((vis) =>
        !!(document.querySelector(`input[type="radio"][name="publishScopeKind"][value="${vis}"]`)?.checked
          || document.getElementById(vis)?.checked), expected.visibility)
    : true;
  // 一般公開への自動切り替えは行わない方針 (2026-08-11 やますけ決定)。タイミーは限定公開を選ぶと
  // 「おまかせタイミングで切り替える」を初期選択するため、userscript が消せたかを必ず確認する。
  // マッチング時メッセージは送信する設定であることも併せて確認 (どちらも黙って既定に戻ると気づけない)。
  const policy = await page.evaluate(() => {
    const dummy = document.getElementById("autoPublishEnabledSelect");
    const control = dummy ? (dummy.closest("[class*=control]") || dummy.parentElement) : null;
    return {
      autoPublish: control ? (control.innerText || "").replace(/\s+/g, " ").trim() : null, // null=コンボ自体が無い(一般公開時)
      autoMsg: document.querySelector('input[type="radio"][name="matchingAutoChatMessage.enabled"][value="true"]')?.checked ?? null,
    };
  });
  const t5 = (s) => String(s ?? "").slice(0, 5); // "10:00:00" 等の表記ゆれ吸収
  const mismatch = [];
  if (expected.date && applied.selectedDate !== expected.date) mismatch.push(`日付 ${applied.selectedDate || "未選択"}≠${expected.date}`);
  if (expected.wage && Number(applied.wage) !== Number(expected.wage)) mismatch.push(`時給 ${applied.wage}≠${expected.wage}`);
  if (expected.start && t5(applied.start) !== t5(expected.start)) mismatch.push(`開始 ${applied.start}≠${expected.start}`);
  if (expected.end && t5(applied.end) !== t5(expected.end)) mismatch.push(`終了 ${applied.end}≠${expected.end}`);
  if (!visibilityOk) mismatch.push(`公開設定 ${expected.visibility} が未選択`);
  if (policy.autoPublish !== null && !/自動切り替えをしない/.test(policy.autoPublish)) {
    mismatch.push(`一般公開への自動切替が「${policy.autoPublish}」のまま (「自動切り替えをしない」が必要)`);
  }
  if (policy.autoMsg === false) mismatch.push("マッチング時メッセージが「送信しない」になっている");
  if (mismatch.length) throw new Error(`自動入力の検証NG: ${mismatch.join(" / ")}`);

  // ---- 2026-08 の現行 UI は2段階: 「入力した求人内容を確認」→ 確認画面で「求人を公開」 ----
  // 1) 確認ボタン (旧「求人を作成」系にもフォールバック)。未入力/矛盾があると disabled のまま
  const submitBtn = page.locator(
    'button:has-text("入力した求人内容を確認"), button:has-text("求人を作成"), button:has-text("作成する"), button[type="submit"]'
  ).first();
  if (!(await submitBtn.count())) {
    throw new Error("確認ボタンが見つからない (タイミー UI 変更の可能性)");
  }
  try {
    await page.waitForFunction(() => {
      const b = Array.from(document.querySelectorAll("button")).find((x) => /入力した求人内容を確認|求人を作成/.test(x.textContent || ""));
      return b && !b.disabled;
    }, null, { timeout: 15000 });
  } catch (_) {
    const errText = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[class*=error], [class*=Error]'))
        .map((e) => (e.textContent || "").trim()).filter(Boolean).slice(0, 3).join(" / "));
    throw new Error(`確認ボタンが有効にならない (未入力/矛盾の可能性${errText ? ": " + errText : ""})`);
  }
  await submitBtn.click();

  // 2) 確認画面: 「休業手当に関する事項を確認しました。」チェック (必須) → 「求人を公開」
  //    遷移しないときは画面のエラー文言を拾う。素の Timeout メッセージだけだと原因が読めず、
  //    Discord 通知を見ても何が悪いのか分からない (2026-08-11 のグループ未選択が実例)。
  try {
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll("button")).some((b) => /求人を公開/.test(b.textContent || "")),
      null, { timeout: 20000 }
    );
  } catch (_) {
    const errText = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[class*=error], [class*=Error], [role=alert]'))
        .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim())
        .filter((t) => t && !/^https?:|^\//.test(t)) // URL だけの要素は原因ではないので除く
        // 先頭語は Material Symbols のアイコン名 (error/info)。実エラーを先に並べ、通知の 200 字制限で
        // 肝心の1行が押し出されないようにする (info の注意書きが長く先に来る画面がある)
        .sort((a, b) => (/^error\b/.test(b) ? 1 : 0) - (/^error\b/.test(a) ? 1 : 0))
        .map((t) => t.replace(/^(error|info|warning)\s+/, ""))
        .slice(0, 3).join(" / ")).catch(() => "");
    throw new Error(`確認画面へ進めない (入力内容の不備/タイミー UI 変更の可能性${errText ? ": " + errText : ""})`);
  }
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const cb = Array.from(document.querySelectorAll('input[type=checkbox]'))
      .find((c) => /休業手当/.test(c.closest("label")?.textContent || c.parentElement?.textContent || ""));
    if (cb && !cb.checked) cb.click();
  });
  try {
    await page.waitForFunction(() => {
      const b = Array.from(document.querySelectorAll("button")).find((x) => /求人を公開/.test(x.textContent || ""));
      return b && !b.disabled;
    }, null, { timeout: 10000 });
  } catch (_) {
    throw new Error("「求人を公開」が有効にならない (確認画面の必須チェック漏れ/タイミー UI 変更の可能性)");
  }
  await page.locator('button:has-text("求人を公開")').first().click();
  await page.waitForTimeout(3000);

  // 投稿成立の最終検証: 求人一覧に対象日の求人が実在するか (これが真の成立確認)
  const [yy, mo, dd] = (expected.date || "").split("-").map(Number);
  if (yy) {
    const dateLabel = `${yy}年${mo}月${dd}日`; // 一覧の表記は「2026年8月6日（木）」のようにゼロ埋めなし
    const listUrl = url.replace(/\/offers\/.*$/, "/offerings");
    await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    let found = false;
    for (let i = 0; i < 10 && !found; i++) {
      await page.waitForTimeout(1500);
      found = await page.evaluate((label) => document.body.innerText.includes(label), dateLabel);
    }
    if (!found) throw new Error(`投稿後の求人一覧に ${dateLabel} の求人が見つからない (投稿未成立の可能性)`);
  }
  return page.url();
}

/** フォーム URL の hash 部分 → パラメータ object */
function parseHashParams_(fullUrl) {
  const i = fullUrl.indexOf("#");
  if (i < 0) return {};
  return Object.fromEntries(new URLSearchParams(fullUrl.slice(i + 1)));
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
      writeTimeePending_(false); // 復旧したのでボタン催促を畳む
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
      lines.push(`再ログイン: 直後に届く**ボタン**（🔑 ログイン画面を開く）を押すだけでOK。テキストで「タイミー再ログイン」でも同じ。PCから直接なら \`scripts\\dispatch-relogin.cmd\` でも可`);
      notice = lines.join("\n");
      writeTimeePending_(true, "session_expired"); // 秘書がボタン付きメッセージを出す
    } else {
      // 失効継続中 → 最低20時間間隔・3日毎程度にリマインド
      const hoursSince = (Date.now() - new Date(st.lastExpiredNotifyAt || 0).getTime()) / 3600000;
      if (hoursSince >= Math.max(EXPIRE_REMIND_EVERY_H, EXPIRE_REMIND_MIN_INTERVAL_H)) {
        st.lastExpiredNotifyAt = nowIso;
        const days = ((Date.now() - new Date(st.expiredSince).getTime()) / 86400000).toFixed(1);
        notice =
          `⏰ **リマインド: タイミーが未ログインのままです** (失効から約${days}日)\n` +
          `再ログイン: 直後に届く**ボタン**（🔑 ログイン画面を開く）を押すだけでOK。テキストで「タイミー再ログイン」でも同じ。PCから直接なら \`scripts\\dispatch-relogin.cmd\` でも可`;
        writeTimeePending_(true, "expired_remind"); // 秘書がボタン付きメッセージを出す
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
  // onSnapshot の error は終端 (SDK 内のリトライ上限超過後は再購読しない限り復帰しない)。
  // heartbeat だけ生きて監視が死ぬ「静かな停止」(2026-08-03 に snapshot error 710行の実績) を防ぐため再購読する。
  // ただし即 process.exit すると Firestore が数分不通のとき「起動→即エラー→終了」を最速で繰り返し、
  // PM2 の max_restarts(既定15) に達して errored で恒久停止するため、プロセス内で指数バックオフ
  // (2秒/8秒/32秒・最大3回) の再購読を先に試み、全滅したときのみ終了して PM2 の再起動に任せる。
  // pending ジョブは再購読の初回スナップショットで拾い直される。
  const WATCH_RETRY_DELAYS_MS = [2_000, 8_000, 32_000];
  let watchRetryCount = 0;
  function startWatch() {
    unsubscribe = db
      .collection("dispatchQueue")
      .where("status", "==", "pending")
      .onSnapshot(
        (snap) => {
          watchRetryCount = 0; // 再購読が成功した (スナップショットが届いた) ので失敗カウンタをリセット
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
          try {
            if (unsubscribe) unsubscribe();
          } catch (_) {
            /* ignore */
          }
          unsubscribe = null;
          if (watchRetryCount >= WATCH_RETRY_DELAYS_MS.length) {
            console.error(
              `${LOG_PREFIX} snapshot error: ${err.message} — 再購読${WATCH_RETRY_DELAYS_MS.length}回全て失敗のため終了します (PM2 が再起動)`
            );
            setTimeout(() => process.exit(1), 1500);
            return;
          }
          const delayMs = WATCH_RETRY_DELAYS_MS[watchRetryCount];
          watchRetryCount++;
          console.error(
            `${LOG_PREFIX} snapshot error: ${err.message} — ${delayMs / 1000}秒後に再購読します (試行${watchRetryCount}/${WATCH_RETRY_DELAYS_MS.length})`
          );
          setTimeout(startWatch, delayMs);
        }
      );
  }
  startWatch();
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
