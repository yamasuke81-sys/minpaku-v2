/**
 * Yadozei Listener — PC 常駐 Playwright デーモン (ESM)
 *
 * 動作:
 *   1. yadozeiQueue.where("status","==","pending") を onSnapshot で監視
 *   2. 新規 pending を検知 → status="processing" にロック
 *   3. kind に応じて処理を実行
 *      - airbnb_csv_fetch   : Airbnb ホスト管理画面で CSV DL → Drive 保存
 *      - booking_csv_fetch  : Booking extranet で xlsx DL → CSV 変換 → Drive 保存
 *      - yadozei_csv_upload : (F3 で実装) — 現状は未対応エラー
 *      - yadozei_pdf_fetch  : (F3 で実装) — 現状は未対応エラー
 *      - session_check      : Airbnb/Booking/やどぜい のログイン状態点検 (8時間毎・キープアライブ兼)
 *      - calendar_audit     : 夜間カレンダー監査 (毎日2:30 JST、今後30日のOTA実予約→otaCalendarSnapshots)
 *   4. 完了/失敗を Firestore に書き戻し
 *   5. settings/yadozeiListener を 60 秒毎に heartbeat 更新
 *
 * 前提:
 *   - 環境変数 GOOGLE_APPLICATION_CREDENTIALS にサービスアカウント JSON のパス
 *     例 (PowerShell): $env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\serviceAccount.json"
 *   - 初回起動時、Playwright で開く Chromium 上で Airbnb / Booking.com に
 *     手動ログインしておく (Cookie が user-data-dir に保存され以降は維持される)
 *
 * 起動:
 *   cd C:\Users\yamas\AI_Workspace\minpaku-v2
 *   node scripts/yadozei-listener.mjs
 *   (バックグラウンド化: pm2 start scripts/yadozei-listener.mjs --name yadozei-listener)
 */

import admin from "firebase-admin";
import { chromium } from "playwright";
import { google } from "googleapis";
import XLSX from "xlsx";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import https from "node:https";
import { spawn } from "node:child_process";
// OTA自動返信(名簿確認メッセージ)の隔離ハンドラ。CSV系コードには触れず、直列ドレインに相乗りする。
import { handleOtaMessage } from "./ota-message.mjs";

// ================== 定数 ==================
const VERSION = "0.4.0"; // 0.4.0: 印刷を白黒強制+印刷完了をボタン付きで通知(秘書経由) / 0.3.9: PDF自動印刷+両リンク記録 / 0.3.8: pdf_fetch厳格化 / 0.3.7: 失敗即時通知+audit自動リトライ
// 0.3.5: 失効検知はどのタイミングでも「はい」ワンタップ再ログイン促し(pending書込+CRD URL)を出す
// 0.3.4: Booking ログイン判定を session_check と取得で共通化(OAuthバウンス誤検出根絶)+DL段リトライ/途中失効検知
// 0.3.3: 「復元しますか?」バブル抑止 + ログインモードは3サイトのタブのみ (about:blank を閉じる)
const LOG_PREFIX = "[yadozei-listener]";

const USER_DATA_DIR = path.join(os.homedir(), ".yadozei-playwright-chrome");
const FAILURE_DIR = path.join(USER_DATA_DIR, "failures");
// セッション失効アラートの状態ファイル (サイト別のログイン確認/失効/通知履歴を永続化)
const SESSION_STATE_FILE = path.join(USER_DATA_DIR, "session-state.json");
// 失効中の再通知は「次の月次取得 N 日前」から、最低 H 時間間隔でのみ行う
const EXPIRE_REMIND_BEFORE_DAYS = 3;
const EXPIRE_REMIND_MIN_INTERVAL_H = 20;
// OTA失効を検知したら「どのタイミングでも」秘書(#民泊管理)経由でワンタップ再ログインを促すための連携先。
// ota-login-check.mjs(朝4時)と同じ pending ファイル/チャンネルを使い、handleOne の「はい」が拾って runRelogin する。
const MINPAKU_CHANNEL_ID = "1518754802572722306"; // #民泊管理 (channels.json minpaku。notifyDiscord_ の webhook も同チャンネル)
const OTA_RELOGIN_PENDING_FILE = path.join(os.homedir(), ".claude", "channels", "discord", "ota-relogin-pending.json");
// ※リモートデスクトップの導線は秘書のボタン(📱 リモートデスクトップ)が持つので、ここでURLは持たない
const TMP_DIR = path.join(os.tmpdir(), "yadozei-listener");
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_RETRIES = 2;
const APP_PARENT_FOLDER_NAME = "民泊宿泊税CSV";
const YADOZEI_BASE = "https://app.yadozei.com";
// minpaku-v2 の ota キー → やどぜいインポートウィザードの OTA ラベル
const OTA_YADOZEI_LABEL = { airbnb: "Airbnb", booking: "Booking.com" };

const PLAYWRIGHT_HEADLESS = process.env.PLAYWRIGHT_HEADLESS === "1";

// ================== 初期化 ==================
if (!admin.apps.length) {
  admin.initializeApp({ projectId: "minpaku-v2" });
}
const db = admin.firestore();

for (const dir of [USER_DATA_DIR, FAILURE_DIR, TMP_DIR]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* ignore */
  }
}

// クラッシュ痕跡を残す (プロセスは落とさず継続 — 常駐ワーカーとして生存優先)
const CRASH_LOG = path.join(USER_DATA_DIR, "listener-crash.log");
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

// 永続コンテキスト (Chromium) は1度だけ起動し、複数ジョブで共有
let _persistentCtx = null;
async function launchCtx() {
  // 自動化検出の回避:
  //  - Google/Airbnb 等は Playwright の bundled Chromium を「安全でないブラウザ」として
  //    ログインブロックすることがある。実 Chrome (channel: "chrome") + AutomationControlled 無効化
  //    + navigator.webdriver 消去 で通常ブラウザに近づける。
  const baseOpts = {
    headless: PLAYWRIGHT_HEADLESS,
    viewport: null,
    // --hide-crash-restore-bubble: pm2 停止等の強制終了後に出る「復元しますか?」バブルを抑止
    // (復元を押すと過去セッションの about:blank タブが積み重なるため)
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled", "--hide-crash-restore-bubble"],
    ignoreDefaultArgs: ["--enable-automation"],
    acceptDownloads: true,
  };
  // bundled Chromium を既定にする (単独検証で安定動作を確認済み。ユーザーのChromeと競合しない)。
  // ログイン Cookie は同じ user-data-dir に保存済みなのでログイン状態で使える。
  // 環境変数 YADOZEI_CHANNEL_CHROME=1 のときだけ実Chromeを使う (ログインやり直し用)。
  let ctx;
  if (process.env.YADOZEI_CHANNEL_CHROME === "1") {
    ctx = await chromium.launchPersistentContext(USER_DATA_DIR, { ...baseOpts, channel: "chrome" });
    console.log(`${LOG_PREFIX} 実 Chrome (channel=chrome) で起動しました`);
  } else {
    ctx = await chromium.launchPersistentContext(USER_DATA_DIR, baseOpts);
    console.log(`${LOG_PREFIX} bundled Chromium で起動しました`);
  }
  try {
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
  } catch (_) {
    /* ignore */
  }
  // コンテキストが閉じたら参照をクリア (次ジョブで作り直す)
  ctx.on("close", () => {
    if (_persistentCtx === ctx) _persistentCtx = null;
  });
  // 実 Chrome (channel=chrome) は「最後のタブが閉じる」とブラウザごと終了してしまう。
  // 各ジョブはページを作って finally で閉じるため、常時開いておくキープアライブページを1枚作り、
  // ジョブ間でも Chrome が生き続けるようにする。
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

// ================== ユーティリティ ==================
function jstYearMonth(d = new Date()) {
  // JST 表記の "YYYY-MM" を返す (Date → JST に補正)
  const offsetMs = 9 * 60 * 60 * 1000;
  const jst = new Date(d.getTime() + offsetMs);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthRange(yearMonth) {
  // "YYYY-MM" から JST の月初/月末 (YYYY-MM-DD) を返す
  const [y, m] = yearMonth.split("-").map((x) => parseInt(x, 10));
  const first = `${y}-${String(m).padStart(2, "0")}-01`;
  // 月末日
  const lastDate = new Date(Date.UTC(y, m, 0)).getUTCDate(); // 翌月0日 = 当月末日
  const last = `${y}-${String(m).padStart(2, "0")}-${String(lastDate).padStart(2, "0")}`;
  return { first, last };
}

function jstTodayStr() {
  // JST の今日 (YYYY-MM-DD)
  const j = new Date(Date.now() + 9 * 3600 * 1000);
  return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, "0")}-${String(j.getUTCDate()).padStart(2, "0")}`;
}

function addDaysStr_(ymd, n) {
  // "YYYY-MM-DD" に n 日を加算した "YYYY-MM-DD"
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

function ymdParts_(ymd) {
  // "YYYY-MM-DD" → {y, m, d}
  const [y, m, d] = ymd.split("-").map(Number);
  return { y, m, d };
}

function normalizeDateStr_(s) {
  // "2026/07/20" "2026-07-20" "2026年7月20日" 等を "YYYY-MM-DD" に正規化 (不明は "")
  const m = String(s || "").trim().match(/^(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (!m) return "";
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

async function saveScreenshot(page, jobId, tag) {
  try {
    const p = path.join(FAILURE_DIR, `${jobId}_${tag}_${Date.now()}.png`);
    await page.screenshot({ path: p, fullPage: true });
    console.log(`${LOG_PREFIX} スクリーンショット保存: ${p}`);
    return p;
  } catch (e) {
    console.warn(`${LOG_PREFIX} スクリーンショット保存失敗: ${e.message}`);
    return null;
  }
}

// デバッグ用: 成功/失敗に関わらず要所でスクショを残す (YADOZEI_DEBUG=0 で無効化)
const DEBUG_SHOTS = process.env.YADOZEI_DEBUG !== "0";
async function debugShot(page, jobId, tag) {
  if (!DEBUG_SHOTS) return;
  try {
    // ビューポートのみ (fullPage=false) — フィルター等のUIが読めるサイズで残す
    const p = path.join(FAILURE_DIR, `debug_${jobId}_${tag}_${Date.now()}.png`);
    await page.screenshot({ path: p, fullPage: false });
    console.log(`${LOG_PREFIX} debugShot: ${p}`);
  } catch (_) {
    /* ignore */
  }
}

// カレンダーの構造 (月見出し・日セルの aria-label 等) を crash ログに残す (診断用)
async function dumpCalendar(page, tag) {
  try {
    const info = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      if (!dlg) return { err: "no-dialog" };
      const heads = [...dlg.querySelectorAll("*")]
        .filter((e) => e.children.length === 0 && /^\d{4}年\d{1,2}月$/.test(e.textContent.trim()))
        .map((h) => h.textContent.trim());
      const cells = [...dlg.querySelectorAll('td[role="button"]')];
      const sample = cells.slice(0, 4).concat(cells.slice(-2)).map((td) => ({
        text: td.textContent.trim(),
        aria: (td.getAttribute("aria-label") || "").slice(0, 45),
        tid: td.getAttribute("data-testid") || td.getAttribute("data-state") || "",
      }));
      return { heads, cellCount: cells.length, sample };
    });
    fs.appendFileSync(CRASH_LOG, `[${new Date().toISOString()}] ${tag} calendar: ${JSON.stringify(info)}\n`);
  } catch (_) {
    /* ignore */
  }
}

// ダイアログ内の input の placeholder 一覧を crash ログに残す (診断用)
async function dumpDialogInputs(page, tag) {
  try {
    const info = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]') || document;
      const inputs = [...dlg.querySelectorAll("input, textarea, [role=combobox]")].map((e) => ({
        tag: e.tagName,
        placeholder: e.getAttribute("placeholder") || "",
        type: e.getAttribute("type") || "",
        visible: !!(e.offsetWidth || e.offsetHeight),
      }));
      return inputs;
    });
    fs.appendFileSync(CRASH_LOG, `[${new Date().toISOString()}] ${tag} dialog inputs: ${JSON.stringify(info)}\n`);
  } catch (_) {
    /* ignore */
  }
}

function safeUnlink(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) {
    /* ignore */
  }
}

// ================== heartbeat ==================
async function updateHeartbeat() {
  try {
    await db.collection("settings").doc("yadozeiListener").set(
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

// ================== Drive アップロード (invoices.js と同方式: yamasuke81 トークン + 物件フォルダ直書き) ==================
// フォルダ体系の所有者 yamasuke81 のトークンを優先解決。
// drive.file スコープの制約で、フォルダを作成/オープンした本人のトークンでないと
// 新フォルダ体系 (008_民泊運用 配下) に書き込めないため。
async function resolveWriteDrive() {
  const oauthDoc = await db.collection("settings").doc("gmailOAuth").get();
  if (!oauthDoc.exists) throw new Error("Gmail/Drive OAuth 未設定 (settings/gmailOAuth)");
  const { clientId, clientSecret } = oauthDoc.data();
  if (!clientId || !clientSecret) throw new Error("OAuth clientId/clientSecret 未設定");
  const cols = [
    db.collection("settings").doc("gmailOAuth").collection("tokens"),
    db.collection("settings").doc("gmailOAuthEmailVerification").collection("tokens"),
  ];
  async function findByEmail(email) {
    for (const col of cols) {
      const snap = await col.where("email", "==", email).limit(1).get();
      if (!snap.empty) return snap.docs[0].data();
    }
    return null;
  }
  let tok = await findByEmail("yamasuke81@gmail.com");
  if (!tok) {
    for (const col of cols) {
      const snap = await col.limit(1).get();
      if (!snap.empty) { tok = snap.docs[0].data(); break; }
    }
  }
  if (!tok) throw new Error("OAuth tokens 未登録");
  if (!tok.refreshToken) throw new Error("refreshToken なし (yamasuke81 の Drive 再認可が必要)");
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: tok.refreshToken });
  return google.drive({ version: "v3", auth: oauth2Client });
}

// 物件の driveOtaCsvFolderId (新フォルダ体系 008_民泊運用/OTAcsv) を取得
async function getOtaCsvFolderId(propertyId) {
  const propSnap = await db.collection("properties").doc(propertyId).get();
  const folderId = propSnap.exists ? (propSnap.data().driveOtaCsvFolderId || "") : "";
  if (!folderId) {
    throw new Error(
      "OTA CSV保存フォルダID (driveOtaCsvFolderId) 未設定 — 物件編集モーダルで各宿の 008_民泊運用/OTAcsv フォルダIDを登録してください"
    );
  }
  return folderId;
}

// 指定親フォルダ直下にフォルダを確保 (既存があれば再利用、無ければ作成)
async function ensureFolder(drive, name, parentId) {
  const q = `'${parentId}' in parents and name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const search = await drive.files.list({ q, fields: "files(id, name)", pageSize: 1 });
  if (search.data.files && search.data.files.length) return search.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
    fields: "id",
  });
  return created.data.id;
}

// ================== 税理士フォルダへのコピー保存 ==================
// 物件の運営主体 (entities コレクション) を解決し、税理士フォルダの YYYY.MM サブフォルダへコピーする。
// - 運営主体の解決: properties.{pid}.yadozei.taxEntityId (明示指定) > properties.{pid}.entityId (scan-sorter 物件マスタの既存フィールド)
// - コピー先: entities/{entityId}.taxFolderId 直下の「YYYY.MM」フォルダ (scan-sorter の税理士フォルダ運用と同形式)
// - 冪等: 同名ファイルが既に存在すればスキップ
// - files.copy が権限等で失敗した場合はローカルファイルの再アップロードにフォールバック
async function copyToTaxFolder(drive, propertyId, propData, yearMonth, fileName, sourceFileId, mimeType, localPath) {
  const entityId = propData?.yadozei?.taxEntityId || propData?.entityId || null;
  if (!entityId) {
    console.warn(`${LOG_PREFIX} 税理士コピー skip: 物件 ${propertyId} に運営主体 (entityId / yadozei.taxEntityId) 未設定`);
    return { copied: false, skipped: "no_entity" };
  }

  const entSnap = await db.collection("entities").doc(entityId).get();
  const taxFolderId = entSnap.exists ? entSnap.data().taxFolderId || null : null;
  if (!taxFolderId) {
    console.warn(`${LOG_PREFIX} 税理士コピー skip: entities/${entityId} に taxFolderId 未設定`);
    return { copied: false, skipped: "no_tax_folder", entityId };
  }

  // 対象月の「YYYY.MM」サブフォルダを確保 (既存があれば再利用)
  const subFolderName = yearMonth.replace("-", ".");
  const subFolderId = await ensureFolder(drive, subFolderName, taxFolderId);

  // 冪等チェック: 同名ファイルが既にあればスキップ
  const dup = await drive.files.list({
    q: `'${subFolderId}' in parents and name='${fileName.replace(/'/g, "\\'")}' and trashed=false`,
    fields: "files(id)",
    pageSize: 1,
  });
  if (dup.data.files && dup.data.files.length) {
    console.log(`${LOG_PREFIX} 税理士コピー skip (同名ファイル既存): ${subFolderName}/${fileName}`);
    return { copied: false, skipped: "duplicate", entityId, fileId: dup.data.files[0].id };
  }

  try {
    // Drive API の files.copy でサーバーサイドコピー
    const copied = await drive.files.copy({
      fileId: sourceFileId,
      requestBody: { name: fileName, parents: [subFolderId] },
      fields: "id",
    });
    console.log(`${LOG_PREFIX} 税理士コピー完了: ${subFolderName}/${fileName} (entity=${entityId})`);
    return { copied: true, entityId, fileId: copied.data.id, folderId: subFolderId };
  } catch (e) {
    // copy が使えない場合 (権限等) は同バイト再アップロードにフォールバック
    if (localPath && fs.existsSync(localPath)) {
      const re = await drive.files.create({
        requestBody: { name: fileName, parents: [subFolderId] },
        media: { mimeType, body: fs.createReadStream(localPath) },
        fields: "id",
      });
      console.log(`${LOG_PREFIX} 税理士コピー完了 (再アップロード): ${subFolderName}/${fileName} (entity=${entityId})`);
      return { copied: true, entityId, fileId: re.data.id, folderId: subFolderId, via: "reupload" };
    }
    throw e;
  }
}

// 任意ファイルを物件の OTAcsv フォルダへ直接アップロード (CSV/PDF 共通)
// 事前 files.get 検証はしない (drive.file の非対称仕様: 未オープンのフォルダは
// files.get で not found だが files.create の parents 指定は通る — invoices.js と同じ)
async function uploadFileToDrive(propertyId, propertyName, yearMonth, fileName, mimeType, localPath) {
  const folderId = await getOtaCsvFolderId(propertyId);
  const drive = await resolveWriteDrive();
  const created = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType, body: fs.createReadStream(localPath) },
    fields: "id, webViewLink",
  });
  // 同種別×同月の旧版をゴミ箱へ (フォルダに世代が溜まらないように)。
  // fileName = {kind}_{YYYY-MM}_{timestamp}.{ext} なので末尾を除いた prefix で同一系列を特定。
  try {
    const prefix = fileName.replace(/_\d+\.[a-z0-9]+$/i, "_");
    const list = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and name contains '${prefix.replace(/'/g, "")}'`,
      fields: "files(id,name)",
      pageSize: 200,
    });
    for (const f of list.data.files || []) {
      if (f.id !== created.data.id && f.name.startsWith(prefix)) {
        await drive.files.update({ fileId: f.id, requestBody: { trashed: true } }).catch(() => {});
      }
    }
  } catch (e) {
    console.warn(`${LOG_PREFIX} 旧版プルーニング失敗(無視): ${e.message}`);
  }

  // 物件フォルダへの保存成功後、税理士フォルダへもコピー (失敗しても本処理は成功扱いのベストエフォート)
  let taxCopy = null;
  try {
    const propSnap = await db.collection("properties").doc(propertyId).get();
    const propData = propSnap.exists ? propSnap.data() : {};
    taxCopy = await copyToTaxFolder(drive, propertyId, propData, yearMonth, fileName, created.data.id, mimeType, localPath);
  } catch (e) {
    console.warn(`${LOG_PREFIX} 税理士コピー失敗 (${fileName}): ${e.message}`);
    taxCopy = { copied: false, error: String(e.message || e).slice(0, 300) };
  }

  return {
    fileId: created.data.id,
    fileName,
    webViewLink: created.data.webViewLink || `https://drive.google.com/file/d/${created.data.id}/view`,
    taxCopy,
  };
}

// CSV アップロード (ファイル名規則つきの uploadFileToDrive ラッパ)
async function uploadCsvToDrive(propertyId, propertyName, ota, yearMonth, localPath) {
  const fileName = `${ota}_reservations_${yearMonth}_${Date.now()}.csv`;
  return uploadFileToDrive(propertyId, propertyName, yearMonth, fileName, "text/csv", localPath);
}

// Drive のファイル (fileId) を temp にダウンロード (やどぜいアップロード用に CSV を取り戻す)
async function downloadDriveFileToTemp(propertyId, fileId, destPath) {
  const drive = await resolveWriteDrive();
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
  await new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(destPath);
    res.data.on("end", resolve).on("error", reject).pipe(dest);
  });
  return destPath;
}

// CSV の1行をフィールド配列にパース (ダブルクォート対応)。判定用途。出力は元の行をそのまま使う。
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Airbnb 純正CSVを「リスティング」列がいずれかのリスティング名と一致(双方向部分一致)する行だけに絞る
// (形式は無加工=行を減らすだけ)。1宿=複数Airbnbリスティング (宿小町A/B等) は names に複数渡す。
function filterAirbnbCsvByListing(csvText, listingNames) {
  const keys = (Array.isArray(listingNames) ? listingNames : [listingNames])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  if (!keys.length) return { csv: csvText, total: 0, kept: 0, note: "リスティング名未設定=全行" };
  const lines = csvText.split(/\r?\n/);
  if (lines.length < 2) return { csv: csvText, total: 0, kept: 0 };
  const header = lines[0];
  const cols = parseCsvLine(header);
  const idx = cols.findIndex((c) => c.replace(/"/g, "").includes("リスティング"));
  if (idx < 0) return { csv: csvText, total: lines.length - 1, kept: lines.length - 1, note: "リスティング列不明=全行" };
  const out = [header];
  let total = 0, kept = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    total++;
    const listing = (parseCsvLine(lines[i])[idx] || "").trim();
    if (keys.some((k) => listingMatches_(listing, k))) { out.push(lines[i]); kept++; }
  }
  return { csv: out.join("\r\n") + "\r\n", total, kept };
}

// 物件の yadozei.airbnb 設定から対象リスティング名の配列を解決する
// (auditListingNames=1宿複数リスティング用の配列 > listingName 単体)。月次取得と夜間監査で共用。
function resolveAirbnbListingNames_(cfg, fallbackName) {
  const c = cfg || {};
  const names =
    Array.isArray(c.auditListingNames) && c.auditListingNames.filter(Boolean).length
      ? c.auditListingNames
      : [c.listingName || fallbackName || ""];
  return names.map((s) => String(s || "").trim()).filter(Boolean);
}

// ================== Airbnb ハンドラ ==================
// 期間指定で Airbnb 予約CSV (全リスティング) を取得する共通コア。
// 月次取得 (handleAirbnbCsv) と夜間カレンダー監査 (handleCalendarAudit) で共用する。
// fromD/toD は {y, m, d} (同月でも別月でも可)。返り値は生CSVテキスト (リスティング絞込・Drive保存はしない)。
async function fetchAirbnbCsvRange(ctx, jobId, fromD, toD) {
  const fromLabel = `${fromD.y}年${fromD.m}月`;
  const toLabel = `${toD.y}年${toD.m}月`;

  const page = await ctx.newPage();
  let tmpFile = null;
  try {
    // 全予約ビュー (過去含む)
    await page.goto("https://www.airbnb.com/hosting/reservations/all", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2500);
    if (/login|signin|sign_in/i.test(page.url())) {
      await saveScreenshot(page, jobId, "airbnb_not_logged_in");
      throw new Error("Airbnb 未ログイン (初回手動ログインが必要)");
    }

    // 「すべて」タブ (URL /all で既に全予約だが念のため)
    await clickByText(page, ["すべて"], 3000).catch(() => {});
    await page.waitForTimeout(1000);

    // 「フィルター」を開く
    if (!(await clickByText(page, ["フィルター", "絞り込み", "Filters"], 4000))) {
      await saveScreenshot(page, jobId, "airbnb_filter_not_found");
      throw new Error("Airbnb 「フィルター」ボタンが見つからない (UI 変更の可能性)");
    }
    await page.waitForTimeout(1500);
    await debugShot(page, jobId, "airbnb_filter_open");

    // ★ リスティング絞り込みは Airbnb UI では行わない (特殊文字/複数リスティングで不安定なため)。
    // 期間(日付)だけ Airbnb でフィルタして全リスティングを出力し、ダウンロード後に
    // listener 側で CSV の「リスティング」列をリスティング名(複数可)で行フィルタする (形式は無加工)。

    // 期間: From カレンダーを開き、対象月の1日〜末日を範囲選択
    // From 欄の「From」は placeholder ではなくアクセシブル名なので getByRole で拾う
    let fromInput = page.getByRole("textbox", { name: "From", exact: true }).first();
    if (!(await fromInput.count())) {
      // フォールバック: ダイアログ内の2番目のテキスト入力 (1番目=リスティング)
      fromInput = page.locator('[role="dialog"] input[type="text"]').nth(1);
    }
    if (await fromInput.count()) {
      await fromInput.scrollIntoViewIfNeeded().catch(() => {});
      try {
        await fromInput.click({ timeout: 8000 });
      } catch (_) {
        // overlay 等でクリック不可なら force、それでもダメなら JS click
        await fromInput.click({ force: true, timeout: 4000 }).catch(async () => {
          await fromInput.evaluate((el) => el.click()).catch(() => {});
        });
      }
      await page.waitForTimeout(1000);
      await debugShot(page, jobId, "airbnb_calendar_open");
      await dumpCalendar(page, "airbnb_calendar_open");
      // 対象月見出しが DOM に現れるまで prev/next で移動する (月をまたぐ範囲選択でも使う)
      const gotoMonth = async (lbl, y, m) => {
        for (let i = 0; i < 30; i++) {
          const has = await page.evaluate(
            (lbl) => [...document.querySelectorAll('[role="dialog"] *')].some((e) => e.children.length === 0 && e.textContent.trim() === lbl),
            lbl
          );
          if (has) return true;
          const cur = await page.evaluate(() => {
            const h = [...document.querySelectorAll('[role="dialog"] *')].find((e) => e.children.length === 0 && /^\d{4}年\d{1,2}月$/.test(e.textContent.trim()));
            return h ? h.textContent.trim() : "";
          });
          const mm = cur.match(/(\d+)年(\d+)月/);
          const goPrev = mm ? parseInt(mm[1]) * 12 + parseInt(mm[2]) > y * 12 + m : true;
          await page
            .locator(goPrev ? 'button[aria-label="表示する月を前月に戻します。"]' : 'button[aria-label="表示する月を翌月に進めます。"]')
            .first()
            .click()
            .catch(() => {});
          await page.waitForTimeout(500);
        }
        return false;
      };
      await gotoMonth(fromLabel, fromD.y, fromD.m);
      // 対象月の日セルを「文書順」で特定してクリック
      // (カレンダーは3ヶ月分を同時描画するので、対象月見出し〜次の月見出しの間にある td[role=button] を選ぶ)
      const clickDay = (lbl, day) =>
        page.evaluate(
          ({ lbl, day }) => {
            const dlg = document.querySelector('[role="dialog"]');
            if (!dlg) return "no-dialog";
            const all = [...dlg.querySelectorAll("*")];
            const isHead = (e) => e.children.length === 0 && /^\d{4}年\d{1,2}月$/.test(e.textContent.trim());
            const headEls = all.filter(isHead);
            const targetHead = headEls.find((h) => h.textContent.trim() === lbl);
            if (!targetHead) return "no-head";
            const targetIdx = all.indexOf(targetHead);
            const nextHead = headEls.find((h) => all.indexOf(h) > targetIdx);
            const nextIdx = nextHead ? all.indexOf(nextHead) : all.length;
            const cell = all
              .slice(targetIdx, nextIdx)
              .find((e) => e.tagName === "TD" && e.getAttribute("role") === "button" && e.textContent.trim() === String(day));
            if (!cell) return "no-cell";
            cell.click();
            return "ok";
          },
          { lbl, day }
        );
      const r1 = await clickDay(fromLabel, fromD.d);
      await page.waitForTimeout(700);
      // To が別月なら見出しの表示を確認してから選択 (通常は隣月が同時描画済みで移動不要)
      if (toLabel !== fromLabel) await gotoMonth(toLabel, toD.y, toD.m);
      const r2 = await clickDay(toLabel, toD.d);
      await page.waitForTimeout(700);
      await debugShot(page, jobId, "airbnb_dates_selected");
      // 選択された From/To の実値をログに残す (検証用)
      try {
        const vals = await page.evaluate(() => {
          const ins = [...document.querySelectorAll('[role="dialog"] input')].map((i) => i.value || "");
          return ins;
        });
        console.log(`${LOG_PREFIX} 日付選択 r1=${r1} r2=${r2} inputs=${JSON.stringify(vals)}`);
      } catch (_) {}
      if (r1 !== "ok" || r2 !== "ok") {
        console.warn(`${LOG_PREFIX} 日付選択が不完全: from(${fromLabel}${fromD.d}日)=${r1} to(${toLabel}${toD.d}日)=${r2}`);
      }
    } else {
      console.warn(`${LOG_PREFIX} From 日付欄が見つからない — 期間フィルタなしで続行`);
    }

    // 適用
    if (!(await clickByText(page, ["適用", "結果を表示", "Apply"], 4000))) {
      console.warn(`${LOG_PREFIX} 「適用」ボタンが見つからない`);
    }
    await page.waitForTimeout(2500);
    await debugShot(page, jobId, "airbnb_applied");

    // 「エクスポート」 → 「CSV ファイルをダウンロード」
    const exportCandidates = [
      'button:has-text("エクスポート")',
      'button:has-text("Export")',
      'a:has-text("エクスポート")',
    ];
    let exportClicked = false;
    for (const sel of exportCandidates) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count()) {
          await loc.click({ timeout: 3000 });
          await page.waitForTimeout(1000);
          exportClicked = true;
          break;
        }
      } catch (_) {
        /* try next */
      }
    }
    if (!exportClicked) {
      await saveScreenshot(page, jobId, "airbnb_export_not_found");
      throw new Error("Airbnb 「エクスポート」ボタンが見つからない (UI 変更の可能性)");
    }

    // エクスポートメニューの状態を確認 (デバッグ)
    await page.waitForTimeout(1000);
    await debugShot(page, jobId, "airbnb_export_menu");

    // download イベントを先に arm してから CSV 項目 → 確認ダイアログを辿る
    tmpFile = path.join(TMP_DIR, `airbnb_${jobId}_${Date.now()}.csv`);
    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });

    // 1) 「CSVファイルをダウンロード」メニュー項目をクリック
    const csvClicked = await clickByText(
      page,
      ["CSVファイルをダウンロード", "CSVファイル", "CSVをダウンロード", "CSV"],
      4000
    );
    if (!csvClicked) {
      await saveScreenshot(page, jobId, "airbnb_csv_option_not_found");
      throw new Error("Airbnb 「CSV ファイルをダウンロード」が見つからない (UI 変更の可能性)");
    }
    await page.waitForTimeout(1500);
    await debugShot(page, jobId, "airbnb_after_csv_click");

    // 2) 確認ダイアログの「ダウンロード」ボタン (出れば押す。直接DLが始まる UI もあるので任意)
    try {
      const confirmDl = page
        .locator(
          '[role="dialog"] button:has-text("ダウンロード"), [role="dialog"] a:has-text("ダウンロード"), button:has-text("ダウンロードする"), button:has-text("ダウンロード")'
        )
        .last();
      if (await confirmDl.count()) {
        await confirmDl.click({ timeout: 4000 });
        console.log(`${LOG_PREFIX} Airbnb 確認ダイアログの「ダウンロード」をクリック`);
      }
    } catch (_) {
      /* 確認ダイアログ無しでも継続 */
    }

    // 3) download 受信
    let download;
    try {
      download = await downloadPromise;
    } catch (e) {
      await saveScreenshot(page, jobId, "airbnb_download_timeout");
      throw new Error(`Airbnb CSV ダウンロード待機タイムアウト: ${e.message}`);
    }
    await download.saveAs(tmpFile);
    console.log(`${LOG_PREFIX} Airbnb CSV 保存: ${tmpFile}`);

    // 生CSVテキストを返す (リスティング絞込・保存は呼び出し側の責務)
    return fs.readFileSync(tmpFile, "utf8");
  } finally {
    safeUnlink(tmpFile);
    try {
      await page.close();
    } catch (_) {
      /* ignore */
    }
  }
}

// 月次取得: 対象月の1日〜末日を共通コアで取得し、リスティング絞込 → Drive 保存
async function handleAirbnbCsv(job, ctx, jobId) {
  const { propertyId, propertyName, yearMonth, params } = job;
  if (!yearMonth) throw new Error("yearMonth が未指定");
  const [ty, tm] = yearMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();

  // フィルタに使うリスティング名 (auditListingNames=複数リスティング対応 > listingName > params)
  const propSnap = await db.collection("properties").doc(propertyId).get();
  const airbnbCfg = (propSnap.exists && propSnap.data()?.yadozei?.airbnb) || {};
  const listingNames = resolveAirbnbListingNames_(airbnbCfg, params?.listingName);

  const raw = await fetchAirbnbCsvRange(ctx, jobId, { y: ty, m: tm, d: 1 }, { y: ty, m: tm, d: lastDay });

  // リスティング列で行フィルタ (形式は無加工=元の行をそのまま残す)。全リスティング出力から対象宿のみ抽出。
  let csvText = raw;
  if (listingNames.length) {
    try {
      const f = filterAirbnbCsvByListing(raw, listingNames);
      csvText = f.csv;
      console.log(
        `${LOG_PREFIX} リスティング${listingNames.length}名「${listingNames.map((n) => n.slice(0, 14)).join("」「")}…」で ${f.total}→${f.kept}行に絞込`
      );
      if (f.kept === 0) console.warn(`${LOG_PREFIX} 該当行0件 — listingName/auditListingNames が Airbnb の実リスティング名と一致しているか確認`);
    } catch (e) {
      console.warn(`${LOG_PREFIX} CSV行フィルタ失敗 (元CSVのまま続行): ${e.message}`);
    }
  }

  const tmpFile = path.join(TMP_DIR, `airbnb_${jobId}_${Date.now()}.csv`);
  try {
    fs.writeFileSync(tmpFile, csvText, "utf8");
    return await uploadCsvToDrive(propertyId, propertyName, "airbnb", yearMonth, tmpFile);
  } finally {
    safeUnlink(tmpFile);
  }
}

// ================== Booking.com ハンドラ ==================
// クォート対応の最小CSVパーサ(検証用)
function parseCsvSimple(text) {
  const rows = [];
  let row = [], field = "", q = false;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// 取得した Booking CSV のチェックイン日が要求月と一致するか検証する。
// arrival(チェックイン)基準で絞り込んでいるので、非キャンセル予約は全て対象月のはず。
// 別月が混入していたら「ダウンロード行の取り違え(月ズレ)」なので保存せずエラーにする(静かな誤りを根絶)。
function verifyBookingCsvMonth(csv, yearMonth) {
  const rows = parseCsvSimple(csv);
  if (rows.length <= 1) return { count: 0 }; // ヘッダのみ=空月(正当)
  const h = rows[0];
  const ci = h.findIndex((x) => /チェックイン/.test(x));
  const st = h.findIndex((x) => /ステータス/.test(x));
  if (ci < 0) throw new Error("Booking CSV に「チェックイン」列が見つからない (UI/書式変更の可能性)");
  let checked = 0;
  const outMonths = {};
  for (const r of rows.slice(1)) {
    if (!r[ci]) continue;
    if (st >= 0 && /cancel/i.test(r[st] || "")) continue; // キャンセルは対象外
    const m = String(r[ci]).trim().slice(0, 7);
    checked++;
    if (m !== yearMonth) outMonths[m] = (outMonths[m] || 0) + 1;
  }
  const outKeys = Object.keys(outMonths);
  if (outKeys.length) {
    throw new Error(
      `Booking ダウンロード内容が要求月(${yearMonth})と不一致: ` +
      outKeys.map((k) => `${k}×${outMonths[k]}`).join(", ") +
      ` (対象月と別月の予約が混入=DL行の取り違え。月ズレ防止のため保存を中止)`);
  }
  return { count: checked };
}

// ================== Booking.com ログイン状態の共通判定 ==================
// admin.booking.com は有効セッションでも一瞬 account.booking.com/sign-in?op_token=... へ
// OAuthバウンスしてから home.htm へ自動復帰する。単発でURLを見ると復帰前を掴んで誤って
// 「未ログイン」と判定してしまう(これが「点検OKなのに取得は未ログイン」食い違いの正体)。
// session_check と fetchBookingCsvRange の両方でこの共通判定を使い、バウンス完了を待ってから
// 「ログインフォームが残っているか」で確定させることで、両者が食い違わないようにする。
const BOOKING_ADMIN_URL = "https://admin.booking.com/?lang=ja";

// ログイン画面の確実なシグナル(ユーザー名入力欄／ログイン誘導見出し／アカウント作成ボタン)。
async function bookingLoginFormVisible_(page) {
  return (
    (await page
      .locator(
        'input[name="username"], input[name="loginname"], ' +
          ':text("ページ・予約の管理をするには"), :text("パートナー施設様向けアカウント"), ' +
          ':text("パートナーアカウント"), :text("Sign in to manage")'
      )
      .first()
      .count()
      .catch(() => 0)) > 0
  );
}

// ログイン済みの確実なシグナル。
// バウンス直前の一瞬だけ admin が表示される事故を避けるため、「admin かつフォーム無し」では足りず、
// ダッシュボードURL(home.htm/extranet/hoteladmin)か、ログイン後UI(予約ナビ/日付カテゴリ)の実在を要求する。
async function bookingDashboardVisible_(page) {
  const url = page.url();
  if (/\/sign-?in|account\.booking\.com/i.test(url)) return false; // バウンス/サインイン中
  if (!/admin\.booking\.com/i.test(url)) return false;
  // 明確なダッシュボードURLなら確定 (session_check の実測 OK は必ず home.htm)。
  if (/(hoteladmin|extranet|home\.htm|\/hotel\/)/i.test(url)) return true;
  // admin.booking.com/?lang=ja のまま留まる場合は、ログイン後UIの実在で判定。
  return (
    (await page
      .locator('a:has-text("予約"), a:has-text("Reservations"), [data-testid*="reservation"], :text("日付カテゴリ")')
      .first()
      .count()
      .catch(() => 0)) > 0
  );
}

// admin.booking.com へ遷移し、OAuthバウンス(sign-in?op_token)の自動復帰を待ってから
// ログイン状態を確定する。返り値: "ok" | "logged_out"。
// 有効セッションはバウンスが数秒で home.htm へ復帰する。settle待ちの中で
//   - ログインフォームが出れば確定的に "logged_out"(それ以上待たない)
//   - ダッシュボードが出れば確定的に "ok"
// のどちらかが立つまで待つ。判定不能(遷移途中)のまま attempts 回粘っても決まらなければ安全側で "logged_out"。
async function resolveBookingLoginState_(page, jobId, { attempts = 3, tag = "booking" } = {}) {
  for (let a = 0; a < attempts; a++) {
    await page
      .goto(BOOKING_ADMIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 })
      .catch(() => {});
    // バウンス(account.booking.com/sign-in?op_token)からの自動復帰を最大 ~18秒待つ。
    const settleDeadline = Date.now() + 18_000;
    let decided = null;
    while (Date.now() < settleDeadline) {
      await page.waitForTimeout(1500);
      if (await bookingLoginFormVisible_(page)) { decided = "logged_out"; break; }
      if (await bookingDashboardVisible_(page)) { decided = "ok"; break; }
      // まだバウンス途中 → 継続待機。
    }
    if (decided === "ok") return "ok";
    if (decided === "logged_out") {
      await saveScreenshot(page, jobId, `${tag}_not_logged_in`);
      return "logged_out";
    }
    // 判定不能(バウンス継続 or 遷移未完) → もう一度リトライして復帰を待つ。
    console.log(`${LOG_PREFIX} [booking-login] 判定不能(遷移途中) 試行${a + 1}/${attempts} url=${page.url().slice(0, 70)}`);
  }
  // リトライ後もログイン済みシグナルが取れない → 安全側で未ログイン扱い。
  await saveScreenshot(page, jobId, `${tag}_login_indeterminate`);
  return "logged_out";
}

// 期間指定で Booking.com 予約一覧 (xlsx→CSV変換済みテキスト) を取得する共通コア。
// 月次取得 (handleBookingCsv) と夜間カレンダー監査 (handleCalendarAudit) で共用する。
// first/last は "YYYY-MM-DD" (チェックイン日基準の絞込範囲)。返り値は CSVテキスト (検証・Drive保存はしない)。
async function fetchBookingCsvRange(ctx, jobId, first, last) {
  const page = await ctx.newPage();
  let tmpXlsx = null;
  try {
    // ログイン状態は session_check と同じ共通判定を使う (lang=ja へ遷移し OAuthバウンス完了を待つ)。
    // 単発判定だとバウンス途中を掴んで誤って「未ログイン」になり、点検OKでも取得0になる食い違いが起きるため。
    const loginState = await resolveBookingLoginState_(page, jobId, { tag: "booking" });
    if (loginState !== "ok") {
      throw new Error("Booking.com extranet 未ログイン (再ログインが必要: node yadozei-listener.mjs --login でログイン)");
    }

    // 予約ページ検出: admin.booking.com は予約ページへ直接ランディングすることが多い。
    // 既に予約UI (日付カテゴリ / ダウンロード) があればナビクリック不要。無ければ「予約」ナビをクリック。
    const reservationsCandidates = [
      'a:has-text("予約")',
      'button:has-text("予約")',
      'a:has-text("Reservations")',
      '[data-testid*="reservation"]',
    ];
    const isOnReservations = async () =>
      (await page.locator(':text("日付カテゴリ")').first().count().catch(() => 0)) > 0 ||
      (await page.locator(':text("予約一覧を印刷")').first().count().catch(() => 0)) > 0;

    let opened = await isOnReservations();
    if (opened) {
      console.log(`${LOG_PREFIX} 既に予約ページに到達済み (ナビクリック省略)`);
    } else {
      for (const sel of reservationsCandidates) {
        const loc = page.locator(sel).first();
        if (!(await loc.count().catch(() => 0))) continue;
        // ナビリンクのクリックは遷移で例外化することがあるので無視し、遷移結果で判定する
        await loc.click({ timeout: 4000 }).catch(() => {});
        try {
          await page.locator(':text("日付カテゴリ")').first().waitFor({ timeout: 12000 });
        } catch (_) {
          /* まだ描画されていないかもしれない */
        }
        if (await isOnReservations()) {
          opened = true;
          console.log(`${LOG_PREFIX} 「予約」ナビ経由で予約ページに遷移`);
          break;
        }
      }
    }
    if (!opened) {
      await saveScreenshot(page, jobId, "booking_reservations_not_found");
      throw new Error("Booking.com 予約ページに到達できない (UI 変更の可能性)");
    }

    // 予約ページ描画待ち
    await page.waitForTimeout(2500);
    try {
      await page
        .locator(':text("日付カテゴリ"), :text("予約一覧を印刷")')
        .first()
        .waitFor({ timeout: 15000 });
    } catch (_) {
      /* 描画途中でも続行 */
    }

    // 対象月に絞り込む: 予約ページの URL は date_from/date_to/date_type を受け付けるため、
    // 日付ピッカー (input type="Datepicker") を操作せず URL パラメータで確実に絞り込む。
    // date_type=arrival = チェックイン日基準 (Airbnb 取得と同じ月の考え方)。
    try {
      const curUrl = page.url();
      if (/search_reservations\.html/i.test(curUrl)) {
        const u = new URL(curUrl);
        u.searchParams.set("lang", "ja"); // 日本語表示を維持 (ダウンロードパネル等のセレクタ用)
        u.searchParams.set("date_type", "arrival");
        u.searchParams.set("date_from", first); // YYYY-MM-DD (月初)
        u.searchParams.set("date_to", last); // YYYY-MM-DD (月末)
        u.searchParams.delete("upcoming_reservations");
        await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(3500);
        console.log(`${LOG_PREFIX} 予約期間を ${first}〜${last} (チェックイン日基準) に設定`);
      } else {
        console.warn(`${LOG_PREFIX} search_reservations URL でないため URL 絞り込みをスキップ: ${curUrl}`);
      }
    } catch (e) {
      console.warn(`${LOG_PREFIX} 日付絞り込み(URL)失敗: ${e.message}`);
    }

    // 「ダウンロード」 → 「予約一覧をダウンロード」
    const dlMenuCandidates = [
      'button:has-text("ダウンロード")',
      'button:has-text("Download")',
      'a:has-text("ダウンロード")',
    ];
    let dlMenuClicked = false;
    for (const sel of dlMenuCandidates) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count()) {
          await loc.click({ timeout: 3000 });
          await page.waitForTimeout(1500);
          dlMenuClicked = true;
          break;
        }
      } catch (_) {
        /* try next */
      }
    }
    if (!dlMenuClicked) {
      await saveScreenshot(page, jobId, "booking_dl_menu_not_found");
      throw new Error("Booking.com 「ダウンロード」が見つからない (UI 変更の可能性)");
    }

    const reqDlCandidates = [
      'button:has-text("予約一覧をダウンロード")',
      'a:has-text("予約一覧をダウンロード")',
      'button:has-text("Download reservations")',
    ];
    let reqClicked = false;
    for (const sel of reqDlCandidates) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count()) {
          await loc.click({ timeout: 3000 });
          await page.waitForTimeout(1500);
          reqClicked = true;
          break;
        }
      } catch (_) {
        /* try next */
      }
    }
    if (!reqClicked) {
      await saveScreenshot(page, jobId, "booking_request_dl_not_found");
      throw new Error("Booking.com 「予約一覧をダウンロード」が見つからない (UI 変更の可能性)");
    }

    // ダウンロードパネルの生成待ち
    await page.waitForTimeout(3000);

    // 対象月のエクスポートが「ダウンロード可能」になるまでポーリングし、その行のDLをクリック。
    // パネルには過去の別レンジ(例:7/2-7/3の空)も並ぶため、必ず対象月レンジ(月初+月末を含む行)を選ぶ。
    // ※ 区切り文字(～)は環境差があるので month初日+末日の両方を hasText で照合する。
    const deadline = Date.now() + 5 * 60 * 1000;
    let downloadTrigger = null;
    let reopenAt = Date.now() + 20_000;
    // 「ダウンロード可能」リンクの祖先(=その行)のテキストを取得するヘルパ
    const ancestorRowText = (el) => el.evaluate((node) => {
      let n = node;
      for (let k = 0; k < 6 && n && n.parentElement; k++) {
        const cls = (n.getAttribute && n.getAttribute("class")) || "";
        if (n.tagName === "TR" || n.tagName === "LI" || /row|list-item|export/i.test(cls)) break;
        n = n.parentElement;
      }
      return ((n || node).innerText || "").replace(/\s+/g, " ").trim();
    });
    while (Date.now() < deadline) {
      // 旧実装は :is(li,tr,div) のネストで親コンテナに誤マッチし、.last() で別月の行を掴んでいた
      // (月ズレ・取りこぼしの原因)。ここでは各「ダウンロード可能」リンクを個別に見て、その行テキストに
      // 月初+月末(first,last)の両方が含まれる行だけを対象にする(誤爆防止)。
      const dlEls = await page.getByText("ダウンロード可能").all().catch(() => []);
      for (const el of dlEls) {
        const t = await ancestorRowText(el).catch(() => "");
        if (t.includes(first) && t.includes(last)) {
          downloadTrigger = el;
          console.log(`${LOG_PREFIX} 対象月(${first}〜${last})のダウンロード行を特定`);
          break;
        }
      }
      if (downloadTrigger) break;
      await page.waitForTimeout(4000);
      // パネルが閉じる/更新されない場合に備えて時々「ダウンロード」を開き直す
      if (Date.now() > reopenAt) {
        reopenAt = Date.now() + 20_000;
        for (const sel of dlMenuCandidates) {
          try {
            const loc = page.locator(sel).first();
            if (await loc.count()) {
              await loc.click({ timeout: 3000 });
              await page.waitForTimeout(1200);
              break;
            }
          } catch (_) {
            /* ignore */
          }
        }
      }
    }
    if (!downloadTrigger) {
      await saveScreenshot(page, jobId, "booking_dl_ready_timeout");
      throw new Error(`Booking.com 対象月(${first}〜${last})のダウンロードがタイムアウト (5分)`);
    }

    // 対象行の「ダウンロード可能」クリック → xlsx を受信。
    // ダウンロードが発火しないこと(セッション不安定・サーバ側の生成遅延)があるため、対象行を都度
    // 取り直しつつ最大3回リトライする。フロー途中でログイン画面に落ちた場合は「取得中に失効」と明示して
    // エラーにする(誤検知でない本物の失効として分類し、再ログイン導線につなげる)。
    let download = null;
    const DL_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= DL_ATTEMPTS && !download; attempt++) {
      if (await bookingLoginFormVisible_(page)) {
        await saveScreenshot(page, jobId, "booking_session_died_midflow");
        throw new Error("Booking.com extranet セッションが取得中に切れた (再ログインが必要: node yadozei-listener.mjs --login でログイン)");
      }
      try {
        const [dl] = await Promise.all([
          page.waitForEvent("download", { timeout: 45_000 }),
          downloadTrigger.click({ timeout: 8000 }),
        ]);
        download = dl;
      } catch (e) {
        console.warn(`${LOG_PREFIX} Booking ダウンロード発火せず (試行${attempt}/${DL_ATTEMPTS}): ${e.message}`);
        if (attempt < DL_ATTEMPTS) {
          // 「ダウンロード」メニューを開き直して対象月の行を取り直す(古いハンドルはデタッチされている)。
          for (const sel of dlMenuCandidates) {
            try {
              const loc = page.locator(sel).first();
              if (await loc.count()) { await loc.click({ timeout: 3000 }); await page.waitForTimeout(1500); break; }
            } catch (_) { /* ignore */ }
          }
          await page.waitForTimeout(1500);
          const dlEls2 = await page.getByText("ダウンロード可能").all().catch(() => []);
          for (const el of dlEls2) {
            const t = await ancestorRowText(el).catch(() => "");
            if (t.includes(first) && t.includes(last)) { downloadTrigger = el; break; }
          }
        }
      }
    }
    if (!download) {
      await saveScreenshot(page, jobId, "booking_download_no_fire");
      throw new Error(`Booking.com ダウンロードが発火しない (${DL_ATTEMPTS}回試行)`);
    }

    tmpXlsx = path.join(TMP_DIR, `booking_${jobId}_${Date.now()}.xlsx`);
    await download.saveAs(tmpXlsx);
    console.log(`${LOG_PREFIX} Booking.com xlsx 保存: ${tmpXlsx}`);

    // xlsx → csv 変換
    const wb = XLSX.readFile(tmpXlsx);
    const firstSheetName = wb.SheetNames[0];
    if (!firstSheetName) throw new Error("Booking.com xlsx にシートが無い");
    return XLSX.utils.sheet_to_csv(wb.Sheets[firstSheetName]);
  } finally {
    safeUnlink(tmpXlsx);
    try {
      await page.close();
    } catch (_) {
      /* ignore */
    }
  }
}

// 月次取得: 対象月の月初〜月末を共通コアで取得し、月一致検証 → Drive 保存
async function handleBookingCsv(job, ctx, jobId) {
  const { propertyId, propertyName, yearMonth, params } = job;
  const bookingPropertyId = params?.bookingPropertyId;
  if (!bookingPropertyId) throw new Error("params.bookingPropertyId が未指定");
  if (!yearMonth) throw new Error("yearMonth が未指定");
  const { first, last } = monthRange(yearMonth);

  const csv = await fetchBookingCsvRange(ctx, jobId, first, last);

  // 取得内容が要求月と一致するか検証(別月の取り違え=月ズレを保存前に検出してエラー化)
  const vr = verifyBookingCsvMonth(csv, yearMonth);
  console.log(`${LOG_PREFIX} Booking CSV 検証OK: ${yearMonth} の予約 ${vr.count} 件(全て対象月チェックイン)`);

  const tmpCsv = path.join(TMP_DIR, `booking_${jobId}_${Date.now()}.csv`);
  try {
    fs.writeFileSync(tmpCsv, csv, "utf8");
    return await uploadCsvToDrive(propertyId, propertyName, "booking", yearMonth, tmpCsv);
  } finally {
    safeUnlink(tmpCsv);
  }
}

// ================== 夜間カレンダー監査 (calendar_audit) ==================
// OTA の実予約一覧 (今日〜+AUDIT_WINDOW_DAYS日) をブラウザ取得し、Firestore スナップショットへ保存する。
// v2 予約台帳との突合・通知はサーバ側 (Cloud Functions morningOtaAudit, 毎朝7:00 JST) が行う。
const AUDIT_WINDOW_DAYS = 30;

// Airbnb 生CSV → 監査用の正規化行配列 (列名はゆるく照合し、UI/書式変更に耐える)
function parseAirbnbAuditRows_(csvText) {
  const rows = parseCsvSimple(csvText);
  if (rows.length <= 1) return [];
  const h = rows[0].map((x) => String(x || "").replace(/"/g, "").trim());
  const idx = (...keys) => h.findIndex((c) => keys.some((k) => c.includes(k)));
  const iCode = idx("確認コード");
  const iStatus = idx("ステータス");
  const iGuest = idx("ゲスト名", "ゲストの名前");
  const iAdults = idx("大人");
  const iChildren = idx("子ども", "子供");
  const iInfants = idx("乳幼児");
  const iIn = idx("チェックイン", "開始日");
  const iOut = idx("チェックアウト", "終了日");
  const iListing = idx("リスティング");
  const num = (r, i) => {
    if (i < 0) return null;
    const n = parseInt(String(r[i] || "").replace(/[^\d]/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  };
  const out = [];
  for (const r of rows.slice(1)) {
    if (!r.length || r.every((c) => !String(c || "").trim())) continue;
    const status = iStatus >= 0 ? String(r[iStatus] || "").trim() : "";
    const adults = num(r, iAdults);
    const children = num(r, iChildren);
    const infants = num(r, iInfants);
    out.push({
      code: iCode >= 0 ? String(r[iCode] || "").trim() : "",
      status,
      cancelled: /キャンセル|cancel/i.test(status),
      guestName: iGuest >= 0 ? String(r[iGuest] || "").trim() : "",
      checkIn: iIn >= 0 ? normalizeDateStr_(r[iIn]) : "",
      checkOut: iOut >= 0 ? normalizeDateStr_(r[iOut]) : "",
      adults,
      children,
      infants,
      guests: adults != null || children != null ? (adults || 0) + (children || 0) : null,
      listing: iListing >= 0 ? String(r[iListing] || "").trim() : "",
    });
  }
  return out;
}

// Booking 生CSV → 監査用の正規化行配列。子供の年齢列があれば 0-5歳を乳幼児に振り分ける
// (v2 の人数セマンティクス「guests=大人+子ども(乳幼児除外)」に合わせる)
function parseBookingAuditRows_(csvText) {
  const rows = parseCsvSimple(csvText);
  if (rows.length <= 1) return [];
  const h = rows[0].map((x) => String(x || "").trim());
  const iCode = h.findIndex((c) => c.includes("予約番号"));
  const iStatus = h.findIndex((c) => c.includes("ステータス"));
  const iGuest = h.findIndex((c) => c.includes("宿泊者氏名"));
  const iBooker = h.findIndex((c) => c.includes("予約者名"));
  const iIn = h.findIndex((c) => c.includes("チェックイン"));
  const iOut = h.findIndex((c) => c.includes("チェックアウト"));
  const iAdults = h.findIndex((c) => c.includes("大人"));
  const iChildren = h.findIndex((c) => c.includes("子供") && !c.includes("年齢"));
  const iChildAges = h.findIndex((c) => c.includes("子供の年齢"));
  const iNights = h.findIndex((c) => /滞在期間/.test(c));
  const iHotel = h.findIndex((c) => c.includes("施設"));
  const num = (r, i) => {
    if (i < 0) return null;
    const n = parseInt(String(r[i] || "").replace(/[^\d]/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  };
  const out = [];
  for (const r of rows.slice(1)) {
    if (!r.length || r.every((c) => !String(c || "").trim())) continue;
    const status = iStatus >= 0 ? String(r[iStatus] || "").trim() : "";
    const adults = num(r, iAdults);
    let children = num(r, iChildren);
    let infants = null;
    if (iChildAges >= 0) {
      const ages = (String(r[iChildAges] || "").match(/\d+/g) || []).map((a) => parseInt(a, 10));
      if (ages.length) {
        infants = ages.filter((a) => a <= 5).length;
        children = ages.length - infants;
      }
    }
    const checkIn = iIn >= 0 ? normalizeDateStr_(r[iIn]) : "";
    let checkOut = iOut >= 0 ? normalizeDateStr_(r[iOut]) : "";
    if (!checkOut && checkIn) {
      const nights = num(r, iNights);
      if (nights) checkOut = addDaysStr_(checkIn, nights);
    }
    out.push({
      code: iCode >= 0 ? String(r[iCode] || "").trim() : "",
      status,
      cancelled: /cancel|キャンセル/i.test(status),
      guestName: (iGuest >= 0 && String(r[iGuest] || "").trim()) || (iBooker >= 0 ? String(r[iBooker] || "").trim() : ""),
      checkIn,
      checkOut,
      adults,
      children,
      infants,
      guests: adults != null || children != null ? (adults || 0) + (children || 0) : null,
      hotel: iHotel >= 0 ? String(r[iHotel] || "").trim() : "",
    });
  }
  return out;
}

// リスティング名/施設名の照合 (filterAirbnbCsvByListing と同じ双方向部分一致)
function listingMatches_(listing, key) {
  const a = String(listing || "").trim();
  const b = String(key || "").trim();
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

async function handleCalendarAudit(job, ctx, jobId) {
  const fromStr = jstTodayStr();
  const toStr = addDaysStr_(fromStr, AUDIT_WINDOW_DAYS);

  // 対象物件の列挙 (月次 dispatcher と同条件: active × yadozei.airbnb/booking.enabled)
  const propsSnap = await db.collection("properties").where("active", "==", true).get();
  const airbnbProps = [];
  const bookingProps = [];
  propsSnap.forEach((d) => {
    const p = d.data() || {};
    const y = p.yadozei || {};
    if (y.airbnb?.enabled === true) {
      // 監査用リスティング名: auditListingNames (1宿=複数リスティング用の配列) > listingName
      const names = resolveAirbnbListingNames_(y.airbnb);
      if (names.length) airbnbProps.push({ id: d.id, name: p.name || d.id, listingNames: names });
    }
    if (y.booking?.enabled === true) {
      bookingProps.push({ id: d.id, name: p.name || d.id, bookingPropertyName: y.booking.propertyName || "" });
    }
  });

  const errors = [];
  const reservations = [];
  let unassignedCount = 0;
  let attempted = 0;

  // Airbnb: 1回の取得で全リスティング分を取り、リスティング名で物件へ振り分け
  if (airbnbProps.length) {
    attempted++;
    try {
      const raw = await fetchAirbnbCsvRange(ctx, jobId, ymdParts_(fromStr), ymdParts_(toStr));
      const rows = parseAirbnbAuditRows_(raw);
      let assigned = 0;
      for (const row of rows) {
        const prop = airbnbProps.find((p) => p.listingNames.some((k) => listingMatches_(row.listing, k)));
        if (!prop) {
          unassignedCount++;
          continue;
        }
        reservations.push({
          ota: "airbnb", propertyId: prop.id, propertyName: prop.name,
          code: row.code, status: row.status, cancelled: row.cancelled,
          guestName: row.guestName, checkIn: row.checkIn, checkOut: row.checkOut,
          adults: row.adults, children: row.children, infants: row.infants, guests: row.guests,
        });
        assigned++;
      }
      console.log(`${LOG_PREFIX} [calendar_audit] Airbnb ${rows.length}行取得 → ${assigned}行割当 / 未割当${unassignedCount}`);
    } catch (e) {
      errors.push({ ota: "airbnb", message: String(e.message || e).slice(0, 300) });
      console.warn(`${LOG_PREFIX} [calendar_audit] Airbnb 取得失敗: ${e.message}`);
    }
  }

  // Booking: アカウント一括の予約一覧を取得し、施設列があれば物件へ振り分け (単一物件なら全行その物件)
  if (bookingProps.length) {
    attempted++;
    try {
      const csv = await fetchBookingCsvRange(ctx, jobId, fromStr, toStr);
      const rows = parseBookingAuditRows_(csv);
      let assigned = 0;
      for (const row of rows) {
        let prop = null;
        if (bookingProps.length === 1) prop = bookingProps[0];
        else if (row.hotel) {
          prop = bookingProps.find(
            (p) => listingMatches_(row.hotel, p.bookingPropertyName) || listingMatches_(row.hotel, p.name)
          );
        }
        if (!prop) {
          unassignedCount++;
          continue;
        }
        reservations.push({
          ota: "booking", propertyId: prop.id, propertyName: prop.name,
          code: row.code, status: row.status, cancelled: row.cancelled,
          guestName: row.guestName, checkIn: row.checkIn, checkOut: row.checkOut,
          adults: row.adults, children: row.children, infants: row.infants, guests: row.guests,
        });
        assigned++;
      }
      console.log(`${LOG_PREFIX} [calendar_audit] Booking ${rows.length}行取得 → ${assigned}行割当`);
    } catch (e) {
      errors.push({ ota: "booking", message: String(e.message || e).slice(0, 300) });
      console.warn(`${LOG_PREFIX} [calendar_audit] Booking 取得失敗: ${e.message}`);
    }
  }

  const counts = {
    airbnb: reservations.filter((r) => r.ota === "airbnb").length,
    booking: reservations.filter((r) => r.ota === "booking").length,
  };
  const status = errors.length === 0 ? "done" : errors.length < attempted ? "partial" : "failed";

  // 監査対象 (物件×OTA) の一覧。逆方向チェック (v2→OTA) はこのペアに限定する
  // (別アカウント運用の物件=おのみちホテル/Hotel Zen 等を誤って「OTAに無い」と検知しないため)。
  // 取得失敗した OTA のペアは除外する (失敗時の誤検知防止)。
  const failedOtaKeys = errors.map((e) => e.ota);
  const auditedTargets = [
    ...airbnbProps.filter(() => !failedOtaKeys.includes("airbnb")).map((p) => ({ propertyId: p.id, ota: "airbnb" })),
    ...bookingProps.filter(() => !failedOtaKeys.includes("booking")).map((p) => ({ propertyId: p.id, ota: "booking" })),
  ];

  // スナップショット保存 (同日再実行は上書き)。部分失敗でも取れた分は保存し、morningOtaAudit が errors を報告する。
  await db.collection("otaCalendarSnapshots").doc(fromStr).set({
    date: fromStr, from: fromStr, to: toStr,
    fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
    status, errors, counts, unassignedCount, auditedTargets, reservations,
  });
  console.log(
    `${LOG_PREFIX} [calendar_audit] スナップショット保存 ${fromStr} status=${status} airbnb=${counts.airbnb} booking=${counts.booking} 未割当=${unassignedCount}`
  );

  if (status === "failed") {
    throw new Error(`OTAカレンダー取得が全滅: ${errors.map((e) => `${e.ota}: ${e.message}`).join(" / ")}`);
  }
  return { date: fromStr, from: fromStr, to: toStr, status, counts, errors, unassignedCount };
}

// ================== やどぜい操作ヘルパー (F3) ==================
// やどぜいへ遷移しログイン状態を確認
async function gotoYadozei(page, route, jobId, tag) {
  await page.goto(`${YADOZEI_BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2500);
  if (/\/login/i.test(page.url())) {
    await saveScreenshot(page, jobId, `${tag}_not_logged_in`);
    throw new Error("やどぜい 未ログイン (初回手動ログインが必要)");
  }
}

// 複数テキスト候補のいずれかのボタン/タブをクリック
async function clickByText(page, texts, timeout = 4000) {
  for (const t of texts) {
    const loc = page
      .locator(`button:has-text("${t}"), a:has-text("${t}"), [role="tab"]:has-text("${t}")`)
      .first();
    try {
      if (await loc.count()) {
        await loc.click({ timeout });
        return true;
      }
    } catch (_) {
      /* try next */
    }
  }
  return false;
}

// やどぜいの施設(物件)セレクタを目的の物件に切り替える
// やどぜい登録物件は 物件名 が minpaku-v2 と一致する前提 (override = yadozei.yadozeiPropertyLabel)
async function selectYadozeiProperty(page, targetLabel, jobId) {
  if (!targetLabel) return;
  const headBtn = () =>
    page
      .locator("header button, nav button, [class*=header] button")
      .filter({ hasText: /長浜|Hiroshima|Pocket|KOMACHI|Terrace|House|ホテル|ムラタク|Zen|宇品/ })
      .first();

  // 施設セレクタのロード完了を待つ (ヘッダが「読み込み中...」の間は待機)
  for (let i = 0; i < 25; i++) {
    if (await page.getByText(targetLabel, { exact: false }).count()) return; // 既に対象施設
    const btn = headBtn();
    if (await btn.count()) {
      const t = (await btn.innerText().catch(() => "")).trim();
      if (t && !/読み込み中|loading/i.test(t)) break; // ロード完了 (別施設)
    }
    await page.waitForTimeout(800);
  }

  // 対象施設でなければ切替
  if (!(await page.getByText(targetLabel, { exact: false }).count())) {
    try {
      const btn = headBtn();
      if (await btn.count()) {
        await btn.click({ timeout: 4000 });
        await page.waitForTimeout(900);
        const opt = page
          .locator(
            `[role="menuitem"]:has-text("${targetLabel}"), [role="option"]:has-text("${targetLabel}"), li:has-text("${targetLabel}"), button:has-text("${targetLabel}")`
          )
          .first();
        if (await opt.count()) {
          await opt.click({ timeout: 4000 });
          await page.waitForTimeout(1800);
        }
      }
    } catch (_) {
      /* best effort */
    }
  }

  // 「施設を切り替えています...」オーバーレイの消滅を待つ
  // (切替直後は画面全体が再描画され、インポート等のボタンが一時的に未描画のまま次工程に進んで失敗するため)
  await page
    .getByText("施設を切り替えています", { exact: false })
    .first()
    .waitFor({ state: "hidden", timeout: 25_000 })
    .catch(() => {});

  // 最終確認 (施設切替後は再ロードで「読み込み中...」の間があるので、対象施設名が出るまで最大16秒待つ)
  for (let i = 0; i < 20; i++) {
    if (await page.getByText(targetLabel, { exact: false }).count()) return;
    await page.waitForTimeout(800);
  }
  await saveScreenshot(page, jobId, "yadozei_property_select_failed");
  throw new Error(`やどぜい施設の選択に失敗 (期待: ${targetLabel}) — やどぜい未登録の物件の可能性`);
}

// option[value=yearMonth] を持つ select を選択
async function selectMonth(page, yearMonth) {
  const monthSelect = page
    .locator("select")
    .filter({ has: page.locator(`option[value="${yearMonth}"]`) })
    .first();
  if (await monthSelect.count()) {
    await monthSelect.selectOption(yearMonth).catch(() => {});
    await page.waitForTimeout(1500);
    return true;
  }
  return false;
}

// PDF出力ボタンを押してダウンロードを受け取る
async function downloadPdf(page, selectors, jobId, tag) {
  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.count()) {
      if (await btn.isDisabled().catch(() => false)) return { disabled: true };
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 60_000 }).catch(() => null),
        btn.click({ timeout: 5000 }).catch(() => {}),
      ]);
      if (download) {
        const tmp = path.join(TMP_DIR, `${tag}_${jobId}_${Date.now()}.pdf`);
        await download.saveAs(tmp);
        return { tmp };
      }
      return {};
    }
  }
  return {};
}

// やどぜいへ後続ジョブを投入
async function enqueueFollowupJob(kind, job, params) {
  await db.collection("yadozeiQueue").add({
    kind,
    propertyId: job.propertyId,
    propertyName: job.propertyName || job.propertyId,
    yearMonth: job.yearMonth,
    params: params || {},
    status: "pending",
    result: null,
    createdBy: "listener-chain",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    startedAt: null,
    completedAt: null,
    error: null,
    retries: 0,
  });
  console.log(`${LOG_PREFIX} 後続ジョブ投入: kind=${kind} property=${job.propertyName} ym=${job.yearMonth}`);
}

// 同一 物件+年月 の PDF取得ジョブが pending で既に居れば true (重複投入防止)
async function pdfJobPending(propertyId, yearMonth) {
  const snap = await db
    .collection("yadozeiQueue")
    .where("propertyId", "==", propertyId)
    .where("kind", "==", "yadozei_pdf_fetch")
    .where("yearMonth", "==", yearMonth)
    .where("status", "==", "pending")
    .limit(1)
    .get();
  return !snap.empty;
}

// ================== F3: やどぜい CSV アップロード ==================
// CSVインポート モーダル内のボタン(次へ/インポート実行等)だけをクリックする。
// ページ下部のテーブルページネーション「次へ」を誤クリックしないため、
// モーダル見出し「CSVインポート」の祖先コンテナ内に限定する。
async function clickWizardButton(page, texts) {
  return await page.evaluate((texts) => {
    const all = [...document.querySelectorAll("*")];
    const heading = all.find((e) => e.children.length === 0 && e.textContent.trim() === "CSVインポート");
    if (!heading) return false;
    let container = heading;
    for (let i = 0; i < 10 && container; i++) {
      for (const t of texts) {
        const btns = [...container.querySelectorAll("button")].filter((b) => b.textContent.trim() === t && !b.disabled);
        if (btns.length) {
          btns[btns.length - 1].click();
          return true;
        }
      }
      container = container.parentElement;
    }
    return false;
  }, texts);
}

// モーダル内に指定テキストのボタンが存在するか (クリックしない・dryRun判定用)
async function findWizardButton(page, texts) {
  return await page.evaluate((texts) => {
    const all = [...document.querySelectorAll("*")];
    const heading = all.find((e) => e.children.length === 0 && e.textContent.trim() === "CSVインポート");
    if (!heading) return false;
    let container = heading;
    for (let i = 0; i < 10 && container; i++) {
      for (const t of texts) {
        if ([...container.querySelectorAll("button")].some((b) => b.textContent.trim() === t && !b.disabled)) return true;
      }
      container = container.parentElement;
    }
    return false;
  }, texts);
}

// CSVインポート モーダルが開いているか
async function isWizardOpen(page) {
  return await page.evaluate(() =>
    [...document.querySelectorAll("*")].some((e) => e.children.length === 0 && e.textContent.trim() === "CSVインポート")
  );
}

async function handleYadozeiCsvUpload(job, ctx, jobId) {
  const { propertyId, propertyName, yearMonth, params } = job;
  const ota = params?.ota;
  const sourceFileId = params?.sourceFileId;
  const otaLabel = OTA_YADOZEI_LABEL[ota];
  if (!otaLabel) throw new Error(`未対応の ota: ${ota}`);
  if (!sourceFileId) throw new Error("params.sourceFileId が未指定");
  if (!yearMonth) throw new Error("yearMonth 未指定");

  const propSnap = await db.collection("properties").doc(propertyId).get();
  const propData = propSnap.exists ? propSnap.data() : {};
  const yadozeiLabel = propData?.yadozei?.yadozeiPropertyLabel || propertyName;

  // Drive から CSV を temp に取り戻す
  const tmpCsv = path.join(TMP_DIR, `upload_${jobId}_${Date.now()}.csv`);
  await downloadDriveFileToTemp(propertyId, sourceFileId, tmpCsv);

  const dryRun = params?.dryRun === true || params?.dryRun === "true"; // インポート実行の直前で停止 (書き込まない)

  const page = await ctx.newPage();
  try {
    await gotoYadozei(page, "/stays", jobId, "yadozei_upload");
    await selectYadozeiProperty(page, yadozeiLabel, jobId);
    await debugShot(page, jobId, "yadozei_stays");

    // インポートボタン → ウィザード起動 (施設切替直後の再描画に備えて出現を待つ)
    const importBtn = page.locator('button:has-text("インポート")').first();
    try {
      await importBtn.waitFor({ state: "visible", timeout: 15_000 });
    } catch (_) {
      await saveScreenshot(page, jobId, "yadozei_import_btn_not_found");
      throw new Error("やどぜい「インポート」ボタンが見つからない (UI 変更の可能性)");
    }
    await importBtn.click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    await debugShot(page, jobId, "yadozei_wizard_open");

    // ステップ1: OTA + 対象月 を選択
    // ウィザードの select は「all オプションを持たない」のが特徴 (ページ上部フィルタは option[value=all] を持つ)。
    // 実 select ハンドルを1つずつ調べ、該当 select に Playwright の selectOption(ネイティブ操作=React確実反映) を使う。
    const allSelects = await page.locator("select").all();
    let otaVal = "", monthVal = "";
    for (const s of allSelects) {
      const hasAll = (await s.locator('option[value="all"]').count()) > 0;
      if (hasAll) continue;
      const hasOta = (await s.locator(`option:has-text("${otaLabel}")`).count()) > 0;
      const hasMonth = (await s.locator(`option[value="${yearMonth}"]`).count()) > 0;
      if (hasOta && !otaVal) {
        await s.selectOption({ label: otaLabel }).catch((e) => console.warn(`${LOG_PREFIX} OTA select失敗: ${e.message}`));
        otaVal = await s.inputValue().catch(() => "?");
      } else if (hasMonth && !monthVal) {
        await s.selectOption(yearMonth).catch((e) => console.warn(`${LOG_PREFIX} 月select失敗: ${e.message}`));
        monthVal = await s.inputValue().catch(() => "?");
      }
    }
    console.log(`${LOG_PREFIX} ステップ1選択: OTA=${otaVal} 対象月=${monthVal}`);
    await page.waitForTimeout(600);
    await debugShot(page, jobId, "yadozei_step1_filled");
    await clickWizardButton(page, ["次へ"]);
    await page.waitForTimeout(2000);
    await debugShot(page, jobId, "yadozei_after_next1");

    // ステップ2: CSV ファイルアップロード (file input が現れるまでリトライ。
    // 次への反映が遅れると step2 に進めていないことがあるので、その場合はもう一度 次へ を押す)
    const fileInput = page.locator('input[type="file"]').first();
    try {
      await fileInput.waitFor({ state: "attached", timeout: 12000 });
    } catch (e) {
      console.warn(`${LOG_PREFIX} file input 未出現 → 次へ再試行`);
      await clickWizardButton(page, ["次へ"]);
      await page.waitForTimeout(2000);
      await fileInput.waitFor({ state: "attached", timeout: 12000 });
    }
    await fileInput.setInputFiles(tmpCsv);
    await page.waitForTimeout(2500);
    await debugShot(page, jobId, "yadozei_file_uploaded");

    // ステップ3〜5: 「インポート実行」があれば押す。無ければ「次へ」で進む。
    // 完了検知 = モーダル(CSVインポート)が閉じたら成功。dryRun は「インポート実行」到達で停止。
    const execTexts = ["インポート実行", "取り込む", "実行"];
    let reachedExec = false;
    let executed = false;
    for (let i = 0; i < 8; i++) {
      await debugShot(page, jobId, `yadozei_step_p${i}`);
      if (!(await isWizardOpen(page))) {
        executed = true; // モーダルが閉じた = インポート完了
        break;
      }
      if (await findWizardButton(page, execTexts)) {
        reachedExec = true;
        if (dryRun) {
          console.log(`${LOG_PREFIX} [dryRun] インポート実行ボタンに到達 — 実行せず停止`);
          break;
        }
        await clickWizardButton(page, execTexts);
        console.log(`${LOG_PREFIX} インポート実行クリック — 「インポート完了」待ち`);
        // 「インポート中...」→ step5「インポート完了」表示 まで最大40秒待つ (モーダルは自動で閉じない)
        for (let w = 0; w < 40; w++) {
          await page.waitForTimeout(1000);
          const done = await page.evaluate(() => document.body.innerText.includes("インポート完了")).catch(() => false);
          if (done || !(await isWizardOpen(page))) { executed = true; break; }
        }
        // 完了画面の「閉じる」でモーダルを閉じる
        await clickWizardButton(page, ["閉じる"]).catch(() => {});
        await page.waitForTimeout(800);
        break;
      }
      if (!(await clickWizardButton(page, ["次へ"]))) break;
      await page.waitForTimeout(2000);
    }

    if (dryRun) {
      await debugShot(page, jobId, "yadozei_dryrun_end");
      if (!reachedExec) {
        await saveScreenshot(page, jobId, "yadozei_dryrun_no_exec");
        throw new Error("[dryRun] インポート実行ボタンに到達できなかった (ウィザード UI 要確認)");
      }
      console.log(`${LOG_PREFIX} [dryRun] やどぜいインポート ウィザードOK (実行せず): ${otaLabel} ${yearMonth}`);
      return { uploaded: false, dryRun: true, reachedExec: true, ota, yearMonth };
    }

    await page.waitForTimeout(1000);
    await debugShot(page, jobId, "yadozei_upload_end");
    if (!executed && (await isWizardOpen(page))) {
      await saveScreenshot(page, jobId, "yadozei_upload_no_exec");
      throw new Error("やどぜいインポートが完了しなかった (モーダルが閉じない)");
    }
    console.log(`${LOG_PREFIX} やどぜいアップロード完了: ${otaLabel} ${yearMonth} (${propertyName})`);
    return { uploaded: true, ota, yearMonth };
  } finally {
    safeUnlink(tmpCsv);
    try {
      await page.close();
    } catch (_) {
      /* ignore */
    }
  }
}

// ================== 自動印刷 (v0.3.9) ==================
// やどぜいPDF(月計表+申告書)を保存したら自宅プリンターへ自動印刷する。
// Acrobat DC の /t (指定プリンターへサイレント印刷) を使う。設定=settings/yadozeiListener:
//   autoPrintPdf=false で無効化 / printerName でプリンター指定(既定=Brother DCP-J4140N Printer)
// 注意: Acrobat が既に起動中だと /t は既存インスタンスに委譲され子プロセスは即終了する。
// その場合ウィンドウが残ることがあるが印刷自体は行われる(こちらから既存Acrobatはkillしない)。
const ACROBAT_EXE = "C:\\Program Files\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe";
const PS_EXE = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const DEFAULT_PRINTER = "Brother DCP-J4140N Printer"; // やますけ指定(2026-07-29): 常にこのプリンター・白黒
const sleep_ = (ms) => new Promise((r) => setTimeout(r, ms));

// 印刷前に白黒(Color=False)を強制する。Acrobat の /t はカラー指定ができないため、
// プリンター既定を毎回そろえる方式にした(他アプリの印刷にも効くが、やますけ合意済み)。
async function ensureMonochrome_(printer) {
  return new Promise((resolve) => {
    const ps = spawn(PS_EXE, ["-NoProfile", "-Command",
      `$c = Get-PrintConfiguration -PrinterName '${printer}' -ErrorAction Stop; if ($c.Color) { Set-PrintConfiguration -PrinterName '${printer}' -Color $false; Write-Output 'fixed' } else { Write-Output 'already-mono' }`,
    ], { windowsHide: true });
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("error", () => resolve("error"));
    ps.on("close", () => resolve(out.trim() || "unknown"));
  });
}

// 常駐bun(discord-secretary-resident.mjs)にボタン付き投稿を依頼する。
// webhook ではボタンを出せないため、pending ファイル経由で bot に投げる(30秒以内に投稿される)。
const BUTTONED_NOTICE_FILE = path.join(os.homedir(), ".claude", "channels", "discord", "buttoned-notice-pending.json");
function queueButtonedNotice_(item) {
  try {
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(BUTTONED_NOTICE_FILE, "utf8")); if (!Array.isArray(arr)) arr = [arr]; } catch (_) { arr = []; }
    arr.push({ ...item, ts: new Date().toISOString() });
    fs.mkdirSync(path.dirname(BUTTONED_NOTICE_FILE), { recursive: true });
    fs.writeFileSync(BUTTONED_NOTICE_FILE, JSON.stringify(arr, null, 1));
    console.log(`${LOG_PREFIX} [notice] ボタン付き投稿を秘書へ依頼 (${item.buttons || "no-buttons"})`);
  } catch (e) {
    console.warn(`${LOG_PREFIX} [notice] 依頼書き込み失敗: ${e.message}`);
  }
}

async function printPdfsLocally(files, jobId) {
  try {
    const s = await db.collection("settings").doc("yadozeiListener").get();
    const cfg = s.exists ? s.data() : {};
    if (cfg.autoPrintPdf === false) return { printed: false, reason: "disabled" };
    const printer = cfg.printerName || DEFAULT_PRINTER;
    const mono = await ensureMonochrome_(printer);
    console.log(`${LOG_PREFIX} [print] 白黒設定: ${mono}`);
    if (!fs.existsSync(ACROBAT_EXE)) {
      console.warn(`${LOG_PREFIX} [print] Acrobat が見つからない — 自動印刷スキップ`);
      return { printed: false, reason: "acrobat_missing" };
    }
    const kids = [];
    for (const f of files) {
      const p = spawn(ACROBAT_EXE, ["/t", f, printer], { windowsHide: true });
      p.on("error", (e) => console.warn(`${LOG_PREFIX} [print] spawn失敗: ${e.message}`));
      kids.push(p);
      await sleep_(3000); // 連続起動の競合回避
    }
    await sleep_(25000); // スプール完了待ち
    for (const k of kids) { try { process.kill(k.pid); } catch (_) { /* 既に終了 */ } }
    console.log(`${LOG_PREFIX} [print] ${files.length}件を「${printer}」へ印刷投入 (${jobId})`);
    return { printed: true, printer, count: files.length, mono };
  } catch (e) {
    console.warn(`${LOG_PREFIX} [print] 自動印刷失敗(本体処理は継続): ${e.message}`);
    return { printed: false, reason: e.message };
  }
}

// ================== F3: やどぜい 月計表/申告書 PDF 取得 ==================
async function handleYadozeiPdfFetch(job, ctx, jobId) {
  const { propertyId, propertyName, yearMonth } = job;
  if (!yearMonth) throw new Error("yearMonth 未指定");
  const propSnap = await db.collection("properties").doc(propertyId).get();
  const propData = propSnap.exists ? propSnap.data() : {};
  const yadozeiLabel = propData?.yadozei?.yadozeiPropertyLabel || propertyName;

  const page = await ctx.newPage();
  const tmpFiles = [];
  try {
    await gotoYadozei(page, "/reports", jobId, "yadozei_pdf");
    await selectYadozeiProperty(page, yadozeiLabel, jobId);
    await selectMonth(page, yearMonth);

    const results = [];

    // 月計表/申告書とも「取れなければ失敗」にする (v0.3.8)。従来は申告書のDLが空振りしても
    // 月計表だけ保存して done になり、欠落が無音だった(稀に申告書を再保存しない既知事象)。
    // 空振り時はタブを開き直して1回リトライ→それでもダメなら throw (失敗は v0.3.7 でDiscord通知される)
    const fetchPdfStrict = async (tabLabel, selectors, kindKey, typeLabel) => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        await clickByText(page, [tabLabel], 3000).catch(() => {});
        await page.waitForTimeout(800);
        const dl = await downloadPdf(page, selectors, jobId, kindKey);
        if (dl.disabled) throw new Error("PDF出力ボタンが無効 — やどぜいスタンダードプラン以上が必要");
        if (dl.tmp) return dl;
        console.warn(`${LOG_PREFIX} ${typeLabel}のPDFダウンロードが空振り (${attempt}/2)${attempt < 2 ? " → タブ開き直してリトライ" : ""}`);
        await page.waitForTimeout(1500);
      }
      await saveScreenshot(page, jobId, `yadozei_pdf_${kindKey}_missing`);
      throw new Error(`${typeLabel}のPDFを取得できなかった (2回試行・UI変更の可能性)`);
    };

    const geppyo = await fetchPdfStrict("月計表プレビュー", ['button:has-text("月計表をPDF出力")', 'button:has-text("月計表")'], "geppyo", "月計表");
    tmpFiles.push(geppyo.tmp);
    results.push({
      type: "月計表",
      ...(await uploadFileToDrive(
        propertyId, propertyName, yearMonth,
        `yadozei_月計表_${yearMonth}_${Date.now()}.pdf`, "application/pdf", geppyo.tmp
      )),
    });

    const shinkoku = await fetchPdfStrict("申告書プレビュー", ['button:has-text("申告書をPDF出力")', 'button:has-text("申告書")'], "shinkoku", "申告書");
    tmpFiles.push(shinkoku.tmp);
    results.push({
      type: "申告書",
      ...(await uploadFileToDrive(
        propertyId, propertyName, yearMonth,
        `yadozei_申告書_${yearMonth}_${Date.now()}.pdf`, "application/pdf", shinkoku.tmp
      )),
    });
    const primary = results.find((r) => r.type === "申告書") || results[0];
    console.log(`${LOG_PREFIX} やどぜいPDF取得完了: ${results.map((r) => r.type).join("+")} ${yearMonth}`);
    // 自宅プリンターへ自動印刷 (tmp削除前に実行。失敗しても本体処理は done)
    const printResult = await printPdfsLocally(tmpFiles, jobId);
    if (printResult.printed) {
      // ボタン付きで秘書に投稿させる(webhookはボタン不可)。押せば申告・納付を完了記録できる
      queueButtonedNotice_({
        message: `🖨️ **宿泊税PDFを印刷しました（白黒）** — ${propertyName} ${yearMonth}分\n`
          + `月計表+申告書の2枚 → ${printResult.printer}\n`
          + results.map((r) => `・[${r.type}PDF](${r.webViewLink})`).join("\n")
          + `\n✍️ 宛先の県税事務所名を記入し、月計表を添えて提出・納入してください。`,
        buttons: "yadozei_tax",
        channelPersona: "minpaku",
      });
    } else if (printResult.reason && printResult.reason !== "disabled") {
      await notifyDiscord_(
        `⚠️ 宿泊税PDFの自動印刷に失敗しました（${propertyName} ${yearMonth}分）: ${String(printResult.reason).slice(0, 120)}\nDrive保存は完了しています。`
      ).catch(() => {});
    }
    return { fileId: primary.fileId, fileName: primary.fileName, webViewLink: primary.webViewLink, taxCopy: primary.taxCopy || null, pdfs: results, printResult };
  } finally {
    for (const f of tmpFiles) safeUnlink(f);
    try {
      await page.close();
    } catch (_) {
      /* ignore */
    }
  }
}

// ================== セッション健全性チェック(キープアライブ兼) ==================
// Discord Webhook へ単純POST (minpaku-v2 settings/notifications の discordOwnerWebhookUrl を流用)
function postDiscord_(webhookUrl, content) {
  return new Promise((resolve) => {
    try {
      const u = new URL(webhookUrl);
      const body = JSON.stringify({ content: String(content || "").slice(0, 1900) });
      const req = https.request(
        {
          hostname: u.hostname, path: u.pathname + u.search, method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "User-Agent": "yadozei-listener" },
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
    const url = doc.exists && doc.data()?.settings?.discordOwnerWebhookUrl;
    if (!url) { console.warn(`${LOG_PREFIX} [session_check] Discord webhook 未設定 (settings/notifications.settings.discordOwnerWebhookUrl)`); return; }
    const r = await postDiscord_(url, content);
    console.log(`${LOG_PREFIX} [session_check] Discord通知 ${r.ok ? "送信OK" : "失敗:" + (r.error || r.status)}`);
  } catch (e) { console.warn(`${LOG_PREFIX} [session_check] Discord通知失敗: ${e.message}`); }
}

// Discord Webhook へ画像添付POST(multipart)。OTA自動返信のテストモードで「実際に入力された文面」の
// スクショを owner に見せて確認できるようにするため。失敗時はテキストのみにフォールバック。
async function notifyDiscordImage_(pngPath, caption) {
  try {
    const doc = await db.collection("settings").doc("notifications").get();
    const url = doc.exists && doc.data()?.settings?.discordOwnerWebhookUrl;
    if (!url || !pngPath || !fs.existsSync(pngPath)) { await notifyDiscord_(caption); return; }
    const u = new URL(url);
    const boundary = "----yzimg" + Date.now();
    const fileBuf = fs.readFileSync(pngPath);
    const pre = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n${String(caption || "").slice(0, 1900)}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="preview.png"\r\nContent-Type: image/png\r\n\r\n`,
      "utf8"
    );
    const post = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const body = Buffer.concat([pre, fileBuf, post]);
    await new Promise((resolve) => {
      const req = https.request(
        {
          hostname: u.hostname, path: u.pathname + u.search, method: "POST",
          headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length, "User-Agent": "yadozei-listener" },
        },
        (res) => { res.on("data", () => {}); res.on("end", () => resolve()); }
      );
      req.on("error", () => resolve());
      req.write(body); req.end();
    });
    console.log(`${LOG_PREFIX} Discord画像通知 送信`);
  } catch (e) {
    console.warn(`${LOG_PREFIX} Discord画像通知失敗: ${e.message}`);
    try { await notifyDiscord_(caption); } catch (_) {}
  }
}

// ---- セッション状態の永続化 (サイト別: sessionStartAt / lastOkAt / expiredSince / lastExpiredNotifyAt) ----
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

// 次の月次取得日 (dispatcher と同じ properties.yadozei.schedule を参照) と残り日数を返す。
// 読めない場合は dispatcher のデフォルト dayOfMonth=2 で計算する。
async function nextMonthlyFetchInfo_() {
  let days = [];
  try {
    const snap = await db.collection("properties").where("active", "==", true).get();
    snap.forEach((d) => {
      const s = d.data()?.yadozei?.schedule;
      if (s?.enabled === true) days.push(Number(s.dayOfMonth) || 2);
    });
  } catch (e) {
    console.warn(`${LOG_PREFIX} [session_check] properties 読取失敗 (デフォルト2日で計算): ${e.message}`);
  }
  if (!days.length) days = [2];
  const j = new Date(Date.now() + 9 * 3600 * 1000); // JST
  const todayUtc = Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate());
  let best = null;
  for (const dom of new Set(days)) {
    let cand = Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), dom);
    if (dom < j.getUTCDate()) cand = Date.UTC(j.getUTCFullYear(), j.getUTCMonth() + 1, dom);
    if (best === null || cand < best) best = cand;
  }
  const bd = new Date(best);
  return {
    dateLabel: `${bd.getUTCMonth() + 1}/${bd.getUTCDate()}`,
    daysUntil: Math.round((best - todayUtc) / 86400000),
  };
}

// OTA失効検知時、秘書(#民泊管理)のワンタップ再ログインを有効化する pending を書く。
// ota-login-check.mjs(朝4時)と同一ファイル・スキーマ。これで「どのタイミングでも」失効検知→即プロンプトが成立する。
// message を渡すと、常駐bun(discord-secretary-resident.mjs)がその本文＋ボタンで #民泊管理 へ1本だけ投稿する。
// listener 自身は webhook で失効通知を出さない(テキスト版とボタン版の二重通知をやめ、ボタン方式に統一)。
function writeOtaReloginPending_(sites, message) {
  try {
    fs.mkdirSync(path.dirname(OTA_RELOGIN_PENDING_FILE), { recursive: true });
    fs.writeFileSync(
      OTA_RELOGIN_PENDING_FILE,
      JSON.stringify(
        { pending: true, ts: new Date().toISOString(), sites, channelId: MINPAKU_CHANNEL_ID, message: message || null },
        null, 2
      )
    );
    console.log(`${LOG_PREFIX} [session_check] OTA再ログイン pending 書込 (${sites.join("/")})`);
  } catch (e) {
    console.warn(`${LOG_PREFIX} [session_check] pending 書込失敗: ${e.message}`);
  }
}
// 復帰(再ログイン確認)時に stale な pending を掃除する(別経路でログインした場合の後始末)。
function clearOtaReloginPending_() {
  try {
    if (fs.existsSync(OTA_RELOGIN_PENDING_FILE)) {
      fs.writeFileSync(OTA_RELOGIN_PENDING_FILE, JSON.stringify({ pending: false, clearedAt: new Date().toISOString() }));
    }
  } catch (_) { /* ignore */ }
}
// 再ログイン導線(ボタン方式)。newlyExpired/リマインド 双方で共通に使う。
// 実際のボタンは常駐bunが添える(🔑 ログイン画面を開く / 📱 リモートデスクトップ / 🆗 あとで)。
function reloginPromptLines_() {
  return [
    `下の **「🔑 ログイン画面を開く」** を押すとメインPCにログイン画面が開きます（不要なら「🆗 あとで」）。`,
    `📱 外出先からは「リモートデスクトップ」ボタンでメインPCに接続して操作できます。`,
  ];
}

// 3サイトのログイン状態を点検。切れていれば Discord 通知。アクセス自体がキープアライブ(セッション延命)。
async function handleSessionCheck(ctx, jobId) {
  const sites = [
    { name: "Airbnb", url: "https://www.airbnb.com/hosting/reservations", re: /\/login|signin|sign_in|authwall/i },
    // Booking は取得(fetchBookingCsvRange)と全く同じ共通判定を使う。点検OKなのに取得は未ログイン、という
    // 食い違いを構造的に無くすため、URL正規表現ではなく resolveBookingLoginState_ で判定する。
    { name: "Booking.com", url: BOOKING_ADMIN_URL, check: (p) => resolveBookingLoginState_(p, jobId, { tag: "session_booking" }) },
    { name: "やどぜい", url: "https://app.yadozei.com/", re: /\/login/i },
  ];
  const sessions = {};
  const loggedOut = [];
  for (const s of sites) {
    const p = await ctx.newPage();
    try {
      let url;
      let out;
      if (s.check) {
        // 共通ログイン判定(取得と同一ロジック)。自前で遷移・バウンス待ち・スクショまで行う。
        const state = await s.check(p);
        out = state !== "ok";
        url = p.url();
      } else {
        await p.goto(s.url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
        await p.waitForTimeout(3500); // リダイレクト確定待ち
        url = p.url();
        out = s.re.test(url);
        if (out) {
          // 誤検知対策(2026-07-14実測: リダイレクト途中の sign-in URL を掴む一過性がある)。
          // 5秒置いて再訪問し、2回連続で未ログインのときだけ失効と判定する。
          await p.waitForTimeout(5000);
          await p.goto(s.url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
          await p.waitForTimeout(3500);
          url = p.url();
          out = s.re.test(url);
          if (!out) console.log(`${LOG_PREFIX} [session_check] ${s.name}: 初回の未ログイン判定は一過性(再訪問でOK)`);
        }
      }
      sessions[s.name] = out ? "logged_out" : "ok";
      if (out) loggedOut.push(s.name);
      console.log(`${LOG_PREFIX} [session_check] ${s.name}: ${out ? "✗ 未ログイン" : "✓ OK"} (${url.slice(0, 70)})`);
    } catch (e) {
      // アクセス失敗は判定不能扱い(誤通知を避け、未ログインには含めない)
      sessions[s.name] = "error";
      console.warn(`${LOG_PREFIX} [session_check] ${s.name} 点検失敗: ${e.message}`);
    } finally {
      await p.close().catch(() => {});
    }
  }
  // 状態を必ず記録(webhook未設定でも失効を検知・可視化できる)。heartbeat と同じ doc。
  try {
    await db.collection("settings").doc("yadozeiListener").set(
      { sessionCheck: { at: admin.firestore.FieldValue.serverTimestamp(), sessions, loggedOut } },
      { merge: true });
  } catch (_) { /* ignore */ }

  // ---- 通知ポリシー (鳴りっぱなし防止) ----
  //   失効の初回検知: 即通知 (セッション持続日数の実測付き)
  //   失効継続中:     次の月次取得 EXPIRE_REMIND_BEFORE_DAYS 日前から、EXPIRE_REMIND_MIN_INTERVAL_H 時間間隔でリマインド
  //   復旧(再ログイン): 即「✅確認」を通知し、持続日数の計測を再スタート
  const state = loadSessionState_();
  const nowIso = new Date().toISOString();
  const recovered = [];
  const newlyExpired = [];
  const stillExpired = [];
  for (const s of sites) {
    const st = state[s.name] || (state[s.name] = {});
    const status = sessions[s.name];
    if (status === "ok") {
      if (st.expiredSince) {
        recovered.push(s.name);
        st.sessionStartAt = nowIso; // 新セッションの計測開始
        st.expiredSince = null;
        st.lastExpiredNotifyAt = null;
      } else if (!st.sessionStartAt) {
        st.sessionStartAt = nowIso; // 初回観測 (実ログインより遅い可能性あり=下限値)
      }
      st.lastOkAt = nowIso;
    } else if (status === "logged_out") {
      if (!st.expiredSince) {
        st.expiredSince = nowIso;
        st.lastExpiredNotifyAt = nowIso;
        newlyExpired.push(s.name);
      } else {
        stillExpired.push(s.name);
      }
    }
    // status === "error" は判定不能のため状態を変更しない
  }

  let _nextInfo = null;
  const getNextInfo = async () => (_nextInfo ??= await nextMonthlyFetchInfo_());
  const notices = [];

  if (recovered.length) {
    notices.push(
      `✅ **OTA/宿泊税: ${recovered.join(" / ")} 再ログイン確認** — 自動取得・キープアライブを再開しました。セッション持続日数はここから自動計測します。`
    );
    clearOtaReloginPending_(); // 復帰したので stale な「はい」待ちを掃除
  }

  // 再ログインで Airbnb/Booking が復帰したら、失効で滞っていた OTA 実予約取得(calendar_audit)を即実行する。
  // 日付ベースID(calendar_audit_{ymd})は既存でスキップされうるので、ユニークIDで強制新規投入する
  // (handleCalendarAudit が当日スナップショットを新鮮なデータで上書き→朝の突合が正しく回る)。
  if (recovered.some((n) => /airbnb|booking/i.test(n))) {
    try {
      await db.collection("yadozeiQueue").doc(`calendar_audit_recovery_${Date.now()}`).create({
        kind: "calendar_audit",
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        source: "listener_relogin_recovery",
      });
      console.log(`${LOG_PREFIX} [session_check] 再ログイン復帰(${recovered.join("/")}) → calendar_audit を即時投入`);
      notices.push(`🔄 再ログイン復帰につき、OTA実予約の取得(カレンダー突合用)を今すぐ実行します。`);
    } catch (e) {
      console.warn(`${LOG_PREFIX} [session_check] 復帰時 calendar_audit 投入失敗: ${e.message}`);
    }
  }
  if (newlyExpired.length) {
    const lines = [
      `🔑 **OTAのログインが切れています（${newlyExpired.join(" / ")}）**`,
      `未ログインのままだと自動取得が空振りします。`,
    ];
    for (const name of newlyExpired) {
      const st = state[name];
      if (st.sessionStartAt && st.lastOkAt) {
        const days = ((new Date(st.lastOkAt) - new Date(st.sessionStartAt)) / 86400000).toFixed(1);
        lines.push(`📏 持続実測: ${fmtJst_(st.sessionStartAt)} ログイン確認 〜 ${fmtJst_(st.lastOkAt)} 正常 (約${days}日)`);
      }
    }
    const next = await getNextInfo();
    lines.push(`次の月次取得は ${next.dateLabel}（あと${next.daysUntil}日）。`);
    lines.push(...reloginPromptLines_());
    // 本文は pending に預け、常駐bunがボタン付きで1本だけ投稿する(webhook のテキスト通知はしない)
    writeOtaReloginPending_(newlyExpired, lines.join("\n"));
  }
  if (stillExpired.length) {
    const next = await getNextInfo();
    const due = [];
    for (const name of stillExpired) {
      const st = state[name];
      const hoursSince = (Date.now() - new Date(st.lastExpiredNotifyAt || 0).getTime()) / 3600000;
      if (next.daysUntil <= EXPIRE_REMIND_BEFORE_DAYS && hoursSince >= EXPIRE_REMIND_MIN_INTERVAL_H) {
        st.lastExpiredNotifyAt = nowIso;
        due.push(name);
      }
    }
    if (due.length) {
      // リマインドもボタン方式で1本だけ(常駐bunが投稿)。webhook のテキスト通知はしない。
      writeOtaReloginPending_(due, [
        `⏰ **リマインド: ${due.join(" / ")} が未ログインのまま月次取得が迫っています**`,
        `次の月次取得: ${next.dateLabel}（あと${next.daysUntil}日）。`,
        ...reloginPromptLines_(),
      ].join("\n"));
    } else {
      console.log(`${LOG_PREFIX} [session_check] 失効継続中(${stillExpired.join(",")}) — 再通知条件外のため抑制`);
    }
  }

  saveSessionState_(state);
  if (notices.length) await notifyDiscord_(notices.join("\n\n"));
  if (!loggedOut.length) console.log(`${LOG_PREFIX} [session_check] 全サイトOK (キープアライブ完了)`);
  return { sessions, loggedOut };
}

// ================== ジョブディスパッチ ==================
async function handleJob(docId, job) {
  const ref = db.collection("yadozeiQueue").doc(docId);
  console.log(`${LOG_PREFIX} 処理開始 ${docId} kind=${job.kind} property=${job.propertyName || job.propertyId}`);

  // ロック (already-locked なら skip)
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
    console.log(`${LOG_PREFIX} ロック取得失敗 (skip) ${docId}: ${e.message}`);
    return;
  }

  // ジョブごとに新規コンテキストを起動する (共有すると死んだ context を再利用して
  // "context has been closed" になるため)。直列処理なので同時起動の競合は起きない。
  let ctx;
  try {
    ctx = await getContext();
  } catch (e) {
    await ref.update({
      status: "failed",
      error: `Chromium 起動失敗: ${String(e.message || e).slice(0, 400)}`,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      retries: admin.firestore.FieldValue.increment(1),
    });
    console.error(`${LOG_PREFIX} Chromium 起動失敗:`, e);
    return;
  }

  try {
    let result = null;
    if (job.kind === "airbnb_csv_fetch") {
      result = await handleAirbnbCsv(job, ctx, docId);
    } else if (job.kind === "booking_csv_fetch") {
      result = await handleBookingCsv(job, ctx, docId);
    } else if (job.kind === "yadozei_csv_upload") {
      result = await handleYadozeiCsvUpload(job, ctx, docId);
    } else if (job.kind === "yadozei_pdf_fetch") {
      result = await handleYadozeiPdfFetch(job, ctx, docId);
    } else if (job.kind === "session_check") {
      result = await handleSessionCheck(ctx, docId);
    } else if (job.kind === "calendar_audit") {
      result = await handleCalendarAudit(job, ctx, docId);
    } else if (job.kind === "ota_message") {
      // OTA自動返信（名簿確認メッセージ）。隔離モジュールに委譲。ctx/ログイン資産を再利用。
      result = await handleOtaMessage(job, ctx, docId, { db, admin, notifyDiscord_, notifyDiscordImage_, LOG_PREFIX, saveScreenshot });
    } else {
      throw new Error(`未知の kind: ${job.kind}`);
    }

    const isFetch = job.kind === "airbnb_csv_fetch" || job.kind === "booking_csv_fetch";
    const isUpload = job.kind === "yadozei_csv_upload";
    const isPdf = job.kind === "yadozei_pdf_fetch";
    const isSessionCheck = job.kind === "session_check";
    const isCalendarAudit = job.kind === "calendar_audit";
    const isOtaMessage = job.kind === "ota_message";

    // queue ドキュメントの result を kind 別に整形
    const queueResult =
      isSessionCheck
        ? { sessions: result.sessions, loggedOut: result.loggedOut }
        : isCalendarAudit
          ? { date: result.date, status: result.status, counts: result.counts, errors: result.errors, unassignedCount: result.unassignedCount }
          : isOtaMessage
            ? { sent: result.sent, verified: result.verified, ota: result.ota, dryRun: result.dryRun }
            : isFetch || isPdf
              ? { fileName: result.fileName, driveFileId: result.fileId, driveLink: result.webViewLink, taxCopy: result.taxCopy || null }
              : { uploaded: true };
    await ref.update({
      status: "done",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      error: null,
      result: queueResult,
    });

    // 物件側 lastRun の更新 (kind 別)
    try {
      const now = admin.firestore.FieldValue.serverTimestamp();
      let lastRunPatch = null;
      if (isFetch && job.propertyId) {
        const otaKey = job.kind === "airbnb_csv_fetch" ? "airbnb" : "booking";
        lastRunPatch = {
          [otaKey]: {
            runAt: now, status: "done",
            fileName: result.fileName, driveFileId: result.fileId, driveLink: result.webViewLink, error: null,
          },
        };
      } else if (isUpload && job.propertyId) {
        lastRunPatch = { yadozeiUpload: { runAt: now, status: "done", ota: job.params?.ota || null, yearMonth: job.yearMonth, error: null } };
      } else if (isPdf && job.propertyId) {
        lastRunPatch = {
          yadozeiPdf: {
            runAt: now, status: "done",
            fileName: result.fileName, driveFileId: result.fileId, driveLink: result.webViewLink,
            pdfTypes: (result.pdfs || []).map((p) => p.type), error: null,
            // 月計表・申告書 両方のDriveリンク (宿泊税リマインドが両方貼るため。v0.3.9)
            files: (result.pdfs || []).map((p) => ({ type: p.type, fileId: p.fileId, webViewLink: p.webViewLink })),
          },
        };
      }
      if (lastRunPatch) {
        await db.collection("properties").doc(job.propertyId).set({ yadozei: { lastRun: lastRunPatch } }, { merge: true });
      }
    } catch (e) {
      console.warn(`${LOG_PREFIX} lastRun 更新失敗 ${docId}: ${e.message}`);
    }

    // 後続ジョブの連鎖投入 (F3 パイプライン: fetch → upload → pdf)
    try {
      if (isFetch && job.propertyId) {
        const pSnap = await db.collection("properties").doc(job.propertyId).get();
        const uploadEnabled = pSnap.exists && pSnap.data()?.yadozei?.yadozeiUpload?.enabled === true;
        if (uploadEnabled && result.fileId) {
          const ota = job.kind === "airbnb_csv_fetch" ? "airbnb" : "booking";
          await enqueueFollowupJob("yadozei_csv_upload", job, { ota, sourceFileId: result.fileId });
        }
      } else if (isUpload && job.propertyId && !job.params?.dryRun) {
        // 全アップロード後に申告書PDFを取得 (pending 重複は防止し、後発のアップロードで再生成)
        // dryRun (実インポートしていない) の場合は PDF 連鎖しない
        if (!(await pdfJobPending(job.propertyId, job.yearMonth))) {
          await enqueueFollowupJob("yadozei_pdf_fetch", job, {});
        }
      }
    } catch (e) {
      console.warn(`${LOG_PREFIX} 後続ジョブ連鎖投入失敗 ${docId}: ${e.message}`);
    }

    console.log(`${LOG_PREFIX} 完了 ${docId} (${job.kind})${result.fileName ? " → " + result.fileName : ""}`);
  } catch (e) {
    const errMsg = String(e.message || e).slice(0, 500);
    console.error(`${LOG_PREFIX} 失敗 ${docId}: ${errMsg}`);
    // retries: MAX_RETRIES を超えても自動リトライしない (dispatcher 側で日次再投入する設計)
    const curSnap = await ref.get().catch(() => null);
    const curRetries = curSnap && curSnap.exists ? curSnap.data().retries || 0 : 0;
    await ref.update({
      status: "failed",
      error: errMsg,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      retries: Math.min(curRetries + 1, MAX_RETRIES + 1),
    });

    // ジョブ失敗を Discord へ即時通知 (2026-07-29 新設。従来は Firestore に failed と書くだけで無音だった)。
    // 例外: ①session_check は失効通知の専用フロー(pending+ボタン)があるので出さない
    //       ②未ログイン起因の失敗も同フローが「🔑ログインが切れています」を出すので二重通知しない
    try {
      const isLoginIssue = /未ログイン|not_logged_in|ログインが切れ/.test(errMsg);
      if (job.kind !== "session_check" && !isLoginIssue) {
        await notifyDiscord_(
          `🚨 **OTA/宿泊税 自動処理が失敗しました**\n` +
          `ジョブ: \`${job.kind}\`${job.propertyName ? ` (${job.propertyName}${job.yearMonth ? " " + job.yearMonth : ""})` : ""}\n` +
          `エラー: ${errMsg.slice(0, 300)}\n` +
          (job.kind === "calendar_audit"
            ? `→ 当日中に自動リトライします(毎時・最大3回)。続報がなければ復旧済みです。`
            : `→ 自動リトライはありません。放置すると当月の処理が欠けます。`)
        );
      }
    } catch (e3) {
      console.warn(`${LOG_PREFIX} 失敗通知の送信に失敗: ${e3.message}`);
    }

    try {
      const otaKey =
        job.kind === "airbnb_csv_fetch"
          ? "airbnb"
          : job.kind === "booking_csv_fetch"
          ? "booking"
          : null;
      if (otaKey && job.propertyId) {
        await db
          .collection("properties")
          .doc(job.propertyId)
          .set(
            {
              yadozei: {
                lastRun: {
                  [otaKey]: {
                    runAt: admin.firestore.FieldValue.serverTimestamp(),
                    status: "failed",
                    error: errMsg,
                  },
                },
              },
            },
            { merge: true }
          );
      }
    } catch (e2) {
      console.warn(`${LOG_PREFIX} lastRun(failed) 更新失敗: ${e2.message}`);
    }
  }
}

// ================== 起動 ==================
const LOGIN_MODE = process.argv.includes("--login");
console.log(`${LOG_PREFIX} 起動 v${VERSION} host=${os.hostname()} cwd=${process.cwd()}${LOGIN_MODE ? " [ログインモード]" : ""}`);
console.log(`${LOG_PREFIX} USER_DATA_DIR=${USER_DATA_DIR}`);

let heartbeatTimer = null;
let unsubscribe = null;

if (LOGIN_MODE) {
  // ログインモード: Chromium を即起動し、Airbnb / Booking / やどぜい のログインページを開いて待つ。
  // ここでログインすると Cookie が USER_DATA_DIR に保存され、以降の通常起動で自動継続する。
  (async () => {
    const ctx = await getContext();
    // ブラウザ(全ウィンドウ)が閉じられたら自動終了 → yadozei-relogin.cmd が pm2 再開に進める
    ctx.on("close", () => {
      console.log(`${LOG_PREFIX} ブラウザが閉じられました。ログインモードを終了します。`);
      process.exit(0);
    });
    const sites = [
      { name: "Airbnb", url: "https://www.airbnb.com/hosting/reservations" },
      { name: "Booking.com extranet", url: "https://admin.booking.com/" },
      { name: "やどぜい", url: "https://app.yadozei.com/" },
    ];
    for (const s of sites) {
      const p = await ctx.newPage();
      await p.goto(s.url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => {
        console.warn(`${LOG_PREFIX} ${s.name} を開けませんでした: ${e.message}`);
      });
    }
    // 初期タブ+キープアライブの about:blank を閉じ、3サイトのタブだけにする
    for (const p of ctx.pages()) {
      if (p.url() === "about:blank") await p.close().catch(() => {});
    }
    console.log(`${LOG_PREFIX} ================================================`);
    console.log(`${LOG_PREFIX} 3サイトのタブを開きました。各タブでログインしてください:`);
    console.log(`${LOG_PREFIX}   1) Airbnb  2) Booking.com extranet  3) やどぜい`);
    console.log(`${LOG_PREFIX} ログイン完了後、ブラウザを閉じれば自動で終了します (Ctrl+C でも可 / Discordに「閉じて」でも可)`);
    console.log(`${LOG_PREFIX} ================================================`);
    // Discord「閉じて」コマンド用: シグナルファイルが現れたら行儀よく閉じる(ctx.close()=Cookie保存)。
    // kill ではなく context.close() を使うことでログイン Cookie が確実に USER_DATA_DIR へ保存される。
    const CLOSE_SIGNAL = path.join(USER_DATA_DIR, "close-login-signal");
    try { fs.rmSync(CLOSE_SIGNAL, { force: true }); } catch (_) {} // 古い残骸を掃除(誤閉じ防止)
    const closePoll = setInterval(async () => {
      if (!fs.existsSync(CLOSE_SIGNAL)) return;
      try { fs.rmSync(CLOSE_SIGNAL, { force: true }); } catch (_) {}
      clearInterval(closePoll);
      console.log(`${LOG_PREFIX} 「閉じて」シグナル受信 → ブラウザを閉じます(ログイン保存)。`);
      try { await ctx.close(); } catch (_) { process.exit(0); } // close()→'close'ハンドラ経由で exit(0)
    }, 2000);
    // プロセスを生かし続ける (Chromium を開いたまま)
    setInterval(() => {}, 1 << 30);
  })().catch((e) => {
    console.error(`${LOG_PREFIX} ログインモード起動失敗: ${e.message}`);
    process.exit(1);
  });
} else {
  // 通常モード: heartbeat (起動時 + 60秒毎) + yadozeiQueue 監視
  updateHeartbeat();
  heartbeatTimer = setInterval(updateHeartbeat, HEARTBEAT_INTERVAL_MS);

  // セッション健全性チェック(キープアライブ兼)を定期 enqueue。docId を JST の 8時間バケット固定で冪等化
  // (同一バケット内は create() が失敗しスキップ → 実質1日3回、日付/バケット跨ぎで新規)。実処理は handleSessionCheck。
  async function enqueueSessionCheck() {
    try {
      const j = new Date(Date.now() + 9 * 3600 * 1000); // JST
      const ymd = `${j.getUTCFullYear()}${String(j.getUTCMonth() + 1).padStart(2, "0")}${String(j.getUTCDate()).padStart(2, "0")}`;
      const bucket = Math.floor(j.getUTCHours() / 8); // 0/1/2 (8時間毎)
      const id = `session_check_${ymd}_${bucket}`;
      await db.collection("yadozeiQueue").doc(id).create({
        kind: "session_check", status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(), source: "listener_periodic",
      });
      console.log(`${LOG_PREFIX} session_check enqueued: ${id}`);
    } catch (e) {
      if (!/already exists/i.test(e.message)) console.warn(`${LOG_PREFIX} session_check enqueue: ${e.message}`);
    }
  }
  setTimeout(enqueueSessionCheck, 20_000); // 起動20秒後に初回
  setInterval(enqueueSessionCheck, 60 * 60 * 1000); // 毎時トライ(8hバケットで冪等 → 実質1日3回)

  // 夜間カレンダー監査 (OTA実予約とv2の突合用スナップショット取得) を毎日1回 enqueue。
  // docId=日付で冪等 (同日2回目以降は create() が already exists で自動スキップ)。
  // JST 2:30 より前は投入しない → 常時稼働なら 2:30〜3:30 の毎時ティックで実行。
  // PC が夜間停止していた場合は復帰後最初のティックで遅延実行される (morningOtaAudit 側が鮮度を検査)。
  async function enqueueCalendarAudit() {
    try {
      const j = new Date(Date.now() + 9 * 3600 * 1000); // JST
      if (j.getUTCHours() * 60 + j.getUTCMinutes() < 150) return; // 2:30 前は投入しない
      const ymd = `${j.getUTCFullYear()}${String(j.getUTCMonth() + 1).padStart(2, "0")}${String(j.getUTCDate()).padStart(2, "0")}`;
      const id = `calendar_audit_${ymd}`;
      await db.collection("yadozeiQueue").doc(id).create({
        kind: "calendar_audit", status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(), source: "listener_daily",
      });
      console.log(`${LOG_PREFIX} calendar_audit enqueued: ${id}`);
    } catch (e) {
      if (!/already exists/i.test(e.message)) console.warn(`${LOG_PREFIX} calendar_audit enqueue: ${e.message}`);
    }

    // 当日リトライ (2026-07-29 新設): 当日スナップショットが failed/欠損のままなら毎時ティックで
    // 再投入する(1日最大3回)。従来は再ログイン復帰(session_check)頼みで、失効が絡まない失敗だと
    // 誰も拾わず丸1日欠測になる構造だった。両OTAとも失効中は成功見込みゼロなのでスキップ
    // (失効はrelogin フローが復帰時に recovery を投入する)。
    try {
      const j2 = new Date(Date.now() + 9 * 3600 * 1000);
      if (j2.getUTCHours() * 60 + j2.getUTCMinutes() < 180) return; // 3:00前は本走行に任せる
      const dateStr = `${j2.getUTCFullYear()}-${String(j2.getUTCMonth() + 1).padStart(2, "0")}-${String(j2.getUTCDate()).padStart(2, "0")}`;
      const ymd2 = dateStr.replace(/-/g, "");
      const dailyRef = db.collection("yadozeiQueue").doc(`calendar_audit_${ymd2}`);
      const dailySnap = await dailyRef.get();
      if (!dailySnap.exists || dailySnap.data().status !== "failed") return;
      const snap = await db.collection("otaCalendarSnapshots").doc(dateStr).get();
      if (snap.exists && snap.data().status !== "failed") return; // recovery 等で既に復旧済み
      const st2 = loadSessionState_();
      const allExpired = ["Airbnb", "Booking.com"].every((k) => st2[k]?.expiredSince);
      if (allExpired) return; // 全滅中のリトライは無意味 (relogin フローに任せる)
      const tried = dailySnap.data().autoRetries || 0;
      if (tried >= 3) return;
      await dailyRef.update({ autoRetries: tried + 1 });
      await db.collection("yadozeiQueue").doc(`calendar_audit_retry_${ymd2}_${tried + 1}`).create({
        kind: "calendar_audit", status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(), source: "listener_auto_retry",
      });
      console.log(`${LOG_PREFIX} calendar_audit 自動リトライ投入 (${tried + 1}/3)`);
    } catch (e) {
      if (!/already exists/i.test(e.message)) console.warn(`${LOG_PREFIX} calendar_audit retry: ${e.message}`);
    }
  }
  setTimeout(enqueueCalendarAudit, 40_000); // 起動40秒後に初回トライ (2:30前なら無視される)
  setInterval(enqueueCalendarAudit, 60 * 60 * 1000); // 毎時トライ(日付IDで冪等 → 実質1日1回)

  // 失効検知中のまま再起動された場合 (=再ログイン直後の可能性が高い) は、8hバケットを
  // 待たずユニークIDで即チェックを投入し、「✅ 再ログイン確認」を早く返す。
  try {
    const st = loadSessionState_();
    if (Object.values(st).some((v) => v && v.expiredSince)) {
      setTimeout(async () => {
        try {
          await db.collection("yadozeiQueue").doc(`session_check_boot_${Date.now()}`).create({
            kind: "session_check", status: "pending",
            createdAt: admin.firestore.FieldValue.serverTimestamp(), source: "listener_boot_recovery",
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
    // ログイン Cookie は user-data-dir に永続化済みなので閉じても失われない。
    if (_persistentCtx) {
      try { await _persistentCtx.close(); } catch (_) { /* ignore */ }
      _persistentCtx = null;
      console.log(`${LOG_PREFIX} キュー空 — ブラウザを閉じました`);
    }
    _draining = false;
    if (_queue.length) drainQueue(); // close 中に到着したジョブを取りこぼさない
  }

  unsubscribe = db
    .collection("yadozeiQueue")
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
        console.error(`${LOG_PREFIX} onSnapshot エラー: ${err.message}`);
      }
    );
}

// ================== graceful shutdown ==================
async function shutdown(signal) {
  console.log(`${LOG_PREFIX} ${signal} 受信 — シャットダウン開始`);
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
