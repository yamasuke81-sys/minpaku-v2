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

// ================== 定数 ==================
const VERSION = "0.2.0"; // 0.2.0: 失効アラート抑制(初回+月次3日前のみ)+持続日数計測+復旧通知+relogin.cmd対応
const LOG_PREFIX = "[yadozei-listener]";

const USER_DATA_DIR = path.join(os.homedir(), ".yadozei-playwright-chrome");
const FAILURE_DIR = path.join(USER_DATA_DIR, "failures");
// セッション失効アラートの状態ファイル (サイト別のログイン確認/失効/通知履歴を永続化)
const SESSION_STATE_FILE = path.join(USER_DATA_DIR, "session-state.json");
// 失効中の再通知は「次の月次取得 N 日前」から、最低 H 時間間隔でのみ行う
const EXPIRE_REMIND_BEFORE_DAYS = 3;
const EXPIRE_REMIND_MIN_INTERVAL_H = 20;
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
    args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
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

// Airbnb 純正CSVを「リスティング」列が listingName を含む行だけに絞る (形式は無加工=行を減らすだけ)。
// 1宿が複数Airbnbリスティングでも、共通する名前部分でまとめて対象にできる。
function filterAirbnbCsvByListing(csvText, listingName) {
  if (!listingName) return { csv: csvText, total: 0, kept: 0, note: "listingName未設定=全行" };
  const lines = csvText.split(/\r?\n/);
  if (lines.length < 2) return { csv: csvText, total: 0, kept: 0 };
  const header = lines[0];
  const cols = parseCsvLine(header);
  const idx = cols.findIndex((c) => c.replace(/"/g, "").includes("リスティング"));
  if (idx < 0) return { csv: csvText, total: lines.length - 1, kept: lines.length - 1, note: "リスティング列不明=全行" };
  const key = listingName.trim();
  const out = [header];
  let total = 0, kept = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    total++;
    const listing = (parseCsvLine(lines[i])[idx] || "").trim();
    if (listing.includes(key) || key.includes(listing)) { out.push(lines[i]); kept++; }
  }
  return { csv: out.join("\r\n") + "\r\n", total, kept };
}

// ================== Airbnb ハンドラ ==================
async function handleAirbnbCsv(job, ctx, jobId) {
  const { propertyId, propertyName, yearMonth, params } = job;
  if (!yearMonth) throw new Error("yearMonth が未指定");
  const [ty, tm] = yearMonth.split("-").map(Number);
  const targetLabel = `${ty}年${tm}月`;
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();

  // フィルタに使うリスティング名 (yadozei.airbnb.listingName 優先、params でも可)
  const propSnap = await db.collection("properties").doc(propertyId).get();
  const listingName =
    (propSnap.exists && propSnap.data()?.yadozei?.airbnb?.listingName) || params?.listingName || "";

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
    // listener 側で CSV の「リスティング」列を listingName で行フィルタする (形式は無加工)。

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
      // 対象月見出しが DOM に現れるまで prev/next で移動
      for (let i = 0; i < 30; i++) {
        const has = await page.evaluate(
          (lbl) => [...document.querySelectorAll('[role="dialog"] *')].some((e) => e.children.length === 0 && e.textContent.trim() === lbl),
          targetLabel
        );
        if (has) break;
        const cur = await page.evaluate(() => {
          const h = [...document.querySelectorAll('[role="dialog"] *')].find((e) => e.children.length === 0 && /^\d{4}年\d{1,2}月$/.test(e.textContent.trim()));
          return h ? h.textContent.trim() : "";
        });
        const mm = cur.match(/(\d+)年(\d+)月/);
        const goPrev = mm ? parseInt(mm[1]) * 12 + parseInt(mm[2]) > ty * 12 + tm : true;
        await page
          .locator(goPrev ? 'button[aria-label="表示する月を前月に戻します。"]' : 'button[aria-label="表示する月を翌月に進めます。"]')
          .first()
          .click()
          .catch(() => {});
        await page.waitForTimeout(500);
      }
      // 対象月の日セルを「文書順」で特定してクリック
      // (カレンダーは3ヶ月分を同時描画するので、対象月見出し〜次の月見出しの間にある td[role=button] を選ぶ)
      const clickDay = (day) =>
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
          { lbl: targetLabel, day }
        );
      const r1 = await clickDay(1);
      await page.waitForTimeout(700);
      const r2 = await clickDay(lastDay);
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
        console.warn(`${LOG_PREFIX} 日付選択が不完全: 1日=${r1} ${lastDay}日=${r2}`);
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

    // リスティング列で行フィルタ (形式は無加工=元の行をそのまま残す)。全リスティング出力から対象宿のみ抽出。
    if (listingName) {
      try {
        const raw = fs.readFileSync(tmpFile, "utf8");
        const f = filterAirbnbCsvByListing(raw, listingName);
        fs.writeFileSync(tmpFile, f.csv, "utf8");
        console.log(`${LOG_PREFIX} リスティング「${listingName.slice(0, 14)}…」で ${f.total}→${f.kept}行に絞込`);
        if (f.kept === 0) console.warn(`${LOG_PREFIX} 該当行0件 — listingName が Airbnb の実リスティング名と一致しているか確認`);
      } catch (e) {
        console.warn(`${LOG_PREFIX} CSV行フィルタ失敗 (元CSVのまま続行): ${e.message}`);
      }
    }

    const result = await uploadCsvToDrive(propertyId, propertyName, "airbnb", yearMonth, tmpFile);
    return result;
  } finally {
    safeUnlink(tmpFile);
    try {
      await page.close();
    } catch (_) {
      /* ignore */
    }
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

async function handleBookingCsv(job, ctx, jobId) {
  const { propertyId, propertyName, yearMonth, params } = job;
  const bookingPropertyId = params?.bookingPropertyId;
  if (!bookingPropertyId) throw new Error("params.bookingPropertyId が未指定");
  if (!yearMonth) throw new Error("yearMonth が未指定");
  const { first, last } = monthRange(yearMonth);

  const page = await ctx.newPage();
  let tmpXlsx = null;
  let tmpCsv = null;
  try {
    // lang=ja を明示して日本語表示を強制 (アカウント言語が英語だとセレクタ("予約"等)が一致しないため)
    await page.goto("https://admin.booking.com/?lang=ja", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2500);

    // 未ログインだと account.booking.com/sign-in へ飛ぶ (ハイフン有り"sign-in"・別ホスト)。
    // 予約ページUIの有無も併せて判定し、ログアウト時は明確にエラーにする。
    const loggedOut =
      /account\.booking\.com|\/(login|signin|sign-in|sign_in)/i.test(page.url()) ||
      (await page.locator(':text("Sign in to manage"), :text("パートナーアカウント"), input[name="username"], input[name="loginname"]').first().count().catch(() => 0)) > 0;
    if (loggedOut) {
      await saveScreenshot(page, jobId, "booking_not_logged_in");
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

    // 対象行の「ダウンロード可能」クリック → xlsx を受信
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }).catch((e) => {
        throw new Error(`Booking.com ダウンロード待機タイムアウト: ${e.message}`);
      }),
      downloadTrigger.click({ timeout: 8000 }),
    ]);

    tmpXlsx = path.join(TMP_DIR, `booking_${jobId}_${Date.now()}.xlsx`);
    await download.saveAs(tmpXlsx);
    console.log(`${LOG_PREFIX} Booking.com xlsx 保存: ${tmpXlsx}`);

    // xlsx → csv 変換
    const wb = XLSX.readFile(tmpXlsx);
    const firstSheetName = wb.SheetNames[0];
    if (!firstSheetName) throw new Error("Booking.com xlsx にシートが無い");
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[firstSheetName]);
    tmpCsv = path.join(TMP_DIR, `booking_${jobId}_${Date.now()}.csv`);
    fs.writeFileSync(tmpCsv, csv, "utf8");

    // 取得内容が要求月と一致するか検証(別月の取り違え=月ズレを保存前に検出してエラー化)
    const vr = verifyBookingCsvMonth(csv, yearMonth);
    console.log(`${LOG_PREFIX} Booking CSV 検証OK: ${yearMonth} の予約 ${vr.count} 件(全て対象月チェックイン)`);

    const result = await uploadCsvToDrive(propertyId, propertyName, "booking", yearMonth, tmpCsv);
    return result;
  } finally {
    safeUnlink(tmpXlsx);
    safeUnlink(tmpCsv);
    try {
      await page.close();
    } catch (_) {
      /* ignore */
    }
  }
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

    // インポートボタン → ウィザード起動
    const importBtn = page.locator('button:has-text("インポート")').first();
    if (!(await importBtn.count())) throw new Error("やどぜい「インポート」ボタンが見つからない (UI 変更の可能性)");
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

    // 月計表プレビュータブ → 月計表をPDF出力
    await clickByText(page, ["月計表プレビュー"], 3000).catch(() => {});
    await page.waitForTimeout(800);
    const geppyo = await downloadPdf(page, ['button:has-text("月計表をPDF出力")', 'button:has-text("月計表")'], jobId, "geppyo");
    if (geppyo.disabled) {
      throw new Error("PDF出力ボタンが無効 — やどぜいスタンダードプラン以上が必要");
    }
    if (geppyo.tmp) {
      tmpFiles.push(geppyo.tmp);
      const r = await uploadFileToDrive(
        propertyId, propertyName, yearMonth,
        `yadozei_月計表_${yearMonth}_${Date.now()}.pdf`, "application/pdf", geppyo.tmp
      );
      results.push({ type: "月計表", ...r });
    }

    // 申告書プレビュータブ → 申告書をPDF出力
    await clickByText(page, ["申告書プレビュー"], 3000).catch(() => {});
    await page.waitForTimeout(800);
    const shinkoku = await downloadPdf(page, ['button:has-text("申告書をPDF出力")', 'button:has-text("申告書")'], jobId, "shinkoku");
    if (shinkoku.disabled) {
      throw new Error("PDF出力ボタンが無効 — やどぜいスタンダードプラン以上が必要");
    }
    if (shinkoku.tmp) {
      tmpFiles.push(shinkoku.tmp);
      const r = await uploadFileToDrive(
        propertyId, propertyName, yearMonth,
        `yadozei_申告書_${yearMonth}_${Date.now()}.pdf`, "application/pdf", shinkoku.tmp
      );
      results.push({ type: "申告書", ...r });
    }

    if (!results.length) {
      await saveScreenshot(page, jobId, "yadozei_pdf_none");
      throw new Error("PDF を1つも取得できなかった (UI 変更またはプラン制限の可能性)");
    }
    const primary = results.find((r) => r.type === "申告書") || results[0];
    console.log(`${LOG_PREFIX} やどぜいPDF取得完了: ${results.map((r) => r.type).join("+")} ${yearMonth}`);
    return { fileId: primary.fileId, fileName: primary.fileName, webViewLink: primary.webViewLink, taxCopy: primary.taxCopy || null, pdfs: results };
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

// 3サイトのログイン状態を点検。切れていれば Discord 通知。アクセス自体がキープアライブ(セッション延命)。
async function handleSessionCheck(ctx, jobId) {
  const sites = [
    { name: "Airbnb", url: "https://www.airbnb.com/hosting/reservations", re: /\/login|signin|sign_in|authwall/i },
    { name: "Booking.com", url: "https://admin.booking.com/?lang=ja", re: /account\.booking\.com|\/(login|signin|sign-in|sign_in)/i },
    { name: "やどぜい", url: "https://app.yadozei.com/", re: /\/login/i },
  ];
  const sessions = {};
  const loggedOut = [];
  for (const s of sites) {
    const p = await ctx.newPage();
    try {
      await p.goto(s.url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      await p.waitForTimeout(3500); // リダイレクト確定待ち
      let url = p.url();
      let out = s.re.test(url);
      if (out) {
        // 誤検知対策(2026-07-14実測: Booking がリダイレクト途中の op_token 付きsign-in URLを掴まれ
        // 「失効」誤報→1時間後のチェックで自然にOKへ戻った)。5秒置いて再訪問し、
        // 2回連続で未ログインのときだけ失効と判定する。
        await p.waitForTimeout(5000);
        await p.goto(s.url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
        await p.waitForTimeout(3500);
        url = p.url();
        out = s.re.test(url);
        if (!out) console.log(`${LOG_PREFIX} [session_check] ${s.name}: 初回の未ログイン判定は一過性(再訪問でOK)`);
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
  }
  if (newlyExpired.length) {
    const lines = [
      `⚠️ **OTA/宿泊税 自動取得: セッション失効**`,
      `未ログイン: **${newlyExpired.join(" / ")}**`,
    ];
    for (const name of newlyExpired) {
      const st = state[name];
      if (st.sessionStartAt && st.lastOkAt) {
        const days = ((new Date(st.lastOkAt) - new Date(st.sessionStartAt)) / 86400000).toFixed(1);
        lines.push(`📏 持続実測: ${fmtJst_(st.sessionStartAt)} ログイン確認 〜 ${fmtJst_(st.lastOkAt)} 正常 (約${days}日)`);
      }
    }
    const next = await getNextInfo();
    lines.push(`次の月次取得は ${next.dateLabel}（あと${next.daysUntil}日）。その${EXPIRE_REMIND_BEFORE_DAYS}日前までは再通知しません。`);
    lines.push(`再ログイン: このチャンネルに **「OTA再ログイン」** と送信（PC側の準備は全自動）→ 開いたブラウザでログイン → 閉じるだけ。PCから直接なら \`scripts\\yadozei-relogin.cmd\` でも可`);
    notices.push(lines.join("\n"));
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
      notices.push(
        `⏰ **リマインド: ${due.join(" / ")} が未ログインのまま月次取得が迫っています**\n` +
        `次の月次取得: ${next.dateLabel}（あと${next.daysUntil}日）。このチャンネルに **「OTA再ログイン」** と送信 → 開いたブラウザでログイン → 閉じるだけ（PCから直接なら \`scripts\\yadozei-relogin.cmd\`）`
      );
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
    } else {
      throw new Error(`未知の kind: ${job.kind}`);
    }

    const isFetch = job.kind === "airbnb_csv_fetch" || job.kind === "booking_csv_fetch";
    const isUpload = job.kind === "yadozei_csv_upload";
    const isPdf = job.kind === "yadozei_pdf_fetch";
    const isSessionCheck = job.kind === "session_check";

    // queue ドキュメントの result を kind 別に整形
    const queueResult =
      isSessionCheck
        ? { sessions: result.sessions, loggedOut: result.loggedOut }
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
    console.log(`${LOG_PREFIX} ================================================`);
    console.log(`${LOG_PREFIX} 3サイトのタブを開きました。各タブでログインしてください:`);
    console.log(`${LOG_PREFIX}   1) Airbnb  2) Booking.com extranet  3) やどぜい`);
    console.log(`${LOG_PREFIX} ログイン完了後、ブラウザを閉じれば自動で終了します (Ctrl+C でも可)`);
    console.log(`${LOG_PREFIX} ================================================`);
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
