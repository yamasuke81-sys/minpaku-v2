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

// ================== 定数 ==================
const VERSION = "0.1.0";
const LOG_PREFIX = "[yadozei-listener]";

const USER_DATA_DIR = path.join(os.homedir(), ".yadozei-playwright-chrome");
const FAILURE_DIR = path.join(USER_DATA_DIR, "failures");
const TMP_DIR = path.join(os.tmpdir(), "yadozei-listener");
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_RETRIES = 2;
const APP_PARENT_FOLDER_NAME = "民泊宿泊税CSV";

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

// 永続コンテキスト (Chromium) は1度だけ起動し、複数ジョブで共有
let _persistentCtx = null;
async function getContext() {
  if (_persistentCtx) return _persistentCtx;
  console.log(`${LOG_PREFIX} Chromium を起動します (headless=${PLAYWRIGHT_HEADLESS})`);
  _persistentCtx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: PLAYWRIGHT_HEADLESS,
    viewport: null,
    args: ["--start-maximized"],
    acceptDownloads: true,
  });
  return _persistentCtx;
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

// ================== Drive アップロード (OAuth は invoices.js と同パターン) ==================
async function resolveOAuthClient(senderGmail) {
  const oauthDoc = await db.collection("settings").doc("gmailOAuth").get();
  if (!oauthDoc.exists) throw new Error("Gmail/Drive OAuth 未設定 (settings/gmailOAuth)");
  const { clientId, clientSecret } = oauthDoc.data();
  if (!clientId || !clientSecret) throw new Error("OAuth clientId/clientSecret 未設定");

  const cols = [
    db.collection("settings").doc("gmailOAuth").collection("tokens"),
    db.collection("settings").doc("gmailOAuthEmailVerification").collection("tokens"),
  ];

  let tokenData = null;
  if (senderGmail) {
    for (const col of cols) {
      const snap = await col.where("email", "==", senderGmail).limit(1).get();
      if (!snap.empty) {
        tokenData = snap.docs[0].data();
        break;
      }
    }
  }
  if (!tokenData) {
    for (const col of cols) {
      const snap = await col.limit(1).get();
      if (!snap.empty) {
        tokenData = snap.docs[0].data();
        break;
      }
    }
  }
  if (!tokenData) throw new Error("OAuth tokens 未登録");
  if (!tokenData.refreshToken) throw new Error("refreshToken なし (再認可が必要)");

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: tokenData.refreshToken });
  return oauth2Client;
}

async function ensureFolder(drive, name, parentId) {
  const q = parentId
    ? `'${parentId}' in parents and name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
    : `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const search = await drive.files.list({ q, fields: "files(id, name)", pageSize: 1 });
  if (search.data.files && search.data.files.length) return search.data.files[0].id;
  const requestBody = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) requestBody.parents = [parentId];
  const created = await drive.files.create({ requestBody, fields: "id" });
  return created.data.id;
}

async function uploadCsvToDrive(propertyId, propertyName, ota, yearMonth, localPath) {
  // 物件ドキュメントから senderGmail を取得
  let senderGmail = null;
  const propSnap = await db.collection("properties").doc(propertyId).get();
  const propData = propSnap.exists ? propSnap.data() : {};
  if (propSnap.exists) {
    senderGmail = propData.senderGmail || null;
  }

  const oauth2Client = await resolveOAuthClient(senderGmail);
  const drive = google.drive({ version: "v3", auth: oauth2Client });

  // 1. 親フォルダ (民泊宿泊税CSV) を確保。settings/driveYadozei に永続化
  let parentFolderId = null;
  try {
    const s = await db.collection("settings").doc("driveYadozei").get();
    if (s.exists && s.data().parentFolderId) parentFolderId = s.data().parentFolderId;
  } catch (_) {
    /* ignore */
  }
  // 既存IDがアクセス不能なら作り直し
  if (parentFolderId) {
    try {
      const meta = await drive.files.get({ fileId: parentFolderId, fields: "id, trashed" });
      if (meta.data.trashed) parentFolderId = null;
    } catch (_) {
      parentFolderId = null;
    }
  }
  if (!parentFolderId) {
    parentFolderId = await ensureFolder(drive, APP_PARENT_FOLDER_NAME, null);
    try {
      await db.collection("settings").doc("driveYadozei").set(
        {
          parentFolderId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (_) {
      /* ignore */
    }
  }

  // 2. 物件サブフォルダを確保 (properties.{pid}.yadozei.driveFolderId 優先)
  let propertyFolderId = propData?.yadozei?.driveFolderId || null;
  if (propertyFolderId) {
    try {
      const meta = await drive.files.get({ fileId: propertyFolderId, fields: "id, trashed" });
      if (meta.data.trashed) propertyFolderId = null;
    } catch (_) {
      propertyFolderId = null;
    }
  }
  if (!propertyFolderId) {
    propertyFolderId = await ensureFolder(drive, propertyName || propertyId, parentFolderId);
    try {
      await db
        .collection("properties")
        .doc(propertyId)
        .set({ yadozei: { driveFolderId: propertyFolderId } }, { merge: true });
    } catch (_) {
      /* ignore */
    }
  }

  // 3. 年月サブフォルダ
  const monthFolderId = await ensureFolder(drive, yearMonth, propertyFolderId);

  // 4. ファイルアップロード
  const fileName = `${ota}_reservations_${yearMonth}_${Date.now()}.csv`;
  const created = await drive.files.create({
    requestBody: { name: fileName, parents: [monthFolderId] },
    media: { mimeType: "text/csv", body: fs.createReadStream(localPath) },
    fields: "id, webViewLink",
  });
  return {
    fileId: created.data.id,
    fileName,
    webViewLink: created.data.webViewLink || `https://drive.google.com/file/d/${created.data.id}/view`,
  };
}

// ================== Airbnb ハンドラ ==================
async function handleAirbnbCsv(job, ctx, jobId) {
  const { propertyId, propertyName, yearMonth, params } = job;
  const listingId = params?.listingId;
  if (!listingId) throw new Error("params.listingId が未指定");
  if (!yearMonth) throw new Error("yearMonth が未指定");
  const { first, last } = monthRange(yearMonth);

  const page = await ctx.newPage();
  let tmpFile = null;
  try {
    await page.goto("https://www.airbnb.com/hosting/reservations/upcoming", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2000);

    if (/login|signin|sign_in/i.test(page.url())) {
      await saveScreenshot(page, jobId, "airbnb_not_logged_in");
      throw new Error("Airbnb 未ログイン (初回手動ログインが必要)");
    }

    // 「すべて」タブに切替 (見つからなくても致命的でないので try)
    const allTabCandidates = [
      'button:has-text("すべて")',
      'a:has-text("すべて")',
      'button:has-text("All")',
      '[role="tab"]:has-text("すべて")',
    ];
    for (const sel of allTabCandidates) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count()) {
          await loc.click({ timeout: 3000 });
          await page.waitForTimeout(1000);
          break;
        }
      } catch (_) {
        /* try next */
      }
    }

    // 「フィルター」を開く
    const filterBtnCandidates = [
      'button:has-text("フィルター")',
      'button:has-text("絞り込み")',
      'button:has-text("Filters")',
      'button[aria-label*="フィルター"]',
    ];
    let filterOpened = false;
    for (const sel of filterBtnCandidates) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count()) {
          await loc.click({ timeout: 3000 });
          await page.waitForTimeout(1500);
          filterOpened = true;
          break;
        }
      } catch (_) {
        /* try next */
      }
    }
    if (!filterOpened) {
      await saveScreenshot(page, jobId, "airbnb_filter_not_found");
      throw new Error("Airbnb 「フィルター」ボタンが見つからない (UI 変更の可能性)");
    }

    // 日付範囲入力 (フィルターモーダル内の input[type=date] や text input が UI 改定で揺れる)
    try {
      const dateInputs = await page.locator('input[type="date"]').all();
      if (dateInputs.length >= 2) {
        await dateInputs[0].fill(first);
        await dateInputs[1].fill(last);
      }
    } catch (_) {
      /* セレクタが無い UI もあるので致命的にしない */
    }

    // 適用ボタン
    const applyCandidates = [
      'button:has-text("適用")',
      'button:has-text("検索")',
      'button:has-text("Apply")',
      'button:has-text("結果を表示")',
    ];
    for (const sel of applyCandidates) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count()) {
          await loc.click({ timeout: 3000 });
          await page.waitForTimeout(2000);
          break;
        }
      } catch (_) {
        /* try next */
      }
    }

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

    // CSV ダウンロードリンク + download 待機
    const csvCandidates = [
      'a:has-text("CSV")',
      'button:has-text("CSV")',
      'a:has-text("CSVファイル")',
      'button:has-text("CSVファイル")',
    ];

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }).catch((e) => {
        throw new Error(`Airbnb CSV ダウンロード待機タイムアウト: ${e.message}`);
      }),
      (async () => {
        for (const sel of csvCandidates) {
          try {
            const loc = page.locator(sel).first();
            if (await loc.count()) {
              await loc.click({ timeout: 3000 });
              return;
            }
          } catch (_) {
            /* try next */
          }
        }
        throw new Error("Airbnb 「CSV ファイルをダウンロード」が見つからない (UI 変更の可能性)");
      })(),
    ]);

    tmpFile = path.join(TMP_DIR, `airbnb_${jobId}_${Date.now()}.csv`);
    await download.saveAs(tmpFile);
    console.log(`${LOG_PREFIX} Airbnb CSV 保存: ${tmpFile}`);

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
    await page.goto("https://admin.booking.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2500);

    if (/login|signin/i.test(page.url())) {
      await saveScreenshot(page, jobId, "booking_not_logged_in");
      throw new Error("Booking.com extranet 未ログイン (初回手動ログインが必要)");
    }

    // 「予約」メニュー
    const reservationsCandidates = [
      'a:has-text("予約")',
      'button:has-text("予約")',
      'a:has-text("Reservations")',
      '[data-testid*="reservation"]',
    ];
    let opened = false;
    for (const sel of reservationsCandidates) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count()) {
          await loc.click({ timeout: 3000 });
          await page.waitForTimeout(2000);
          opened = true;
          break;
        }
      } catch (_) {
        /* try next */
      }
    }
    if (!opened) {
      await saveScreenshot(page, jobId, "booking_reservations_not_found");
      throw new Error("Booking.com 「予約」メニューが見つからない (UI 変更の可能性)");
    }

    // 日付カテゴリ「チェックイン日」設定 (Booking.com extranet UI 揺れに try-fallback)
    try {
      const dateCategory = page
        .locator('select')
        .filter({ hasText: /チェックイン|Check-?in/i })
        .first();
      if (await dateCategory.count()) {
        await dateCategory.selectOption({ label: "チェックイン日" }).catch(async () => {
          await dateCategory.selectOption({ label: "Check-in date" });
        });
      }
    } catch (_) {
      /* try next */
    }

    // 期間入力 (date input が2つ並ぶ想定)
    try {
      const dateInputs = await page.locator('input[type="date"]').all();
      if (dateInputs.length >= 2) {
        await dateInputs[0].fill(first);
        await dateInputs[1].fill(last);
      }
    } catch (_) {
      /* ignore */
    }

    // 「表示」「検索」ボタン
    const searchCandidates = [
      'button:has-text("表示")',
      'button:has-text("検索")',
      'button:has-text("Search")',
      'button:has-text("Show")',
    ];
    for (const sel of searchCandidates) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count()) {
          await loc.click({ timeout: 3000 });
          await page.waitForTimeout(2500);
          break;
        }
      } catch (_) {
        /* try next */
      }
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

    // 「ダウンロード可能」になるまで最大5分ポーリング
    const readyCandidates = [
      'button:has-text("ダウンロードする")',
      'a:has-text("ダウンロードする")',
      'button:has-text("Ready")',
      ':text("ダウンロード可能")',
    ];
    const deadline = Date.now() + 5 * 60 * 1000;
    let downloadTrigger = null;
    while (Date.now() < deadline) {
      for (const sel of readyCandidates) {
        try {
          const loc = page.locator(sel).first();
          if (await loc.count()) {
            downloadTrigger = loc;
            break;
          }
        } catch (_) {
          /* try next */
        }
      }
      if (downloadTrigger) break;
      await page.waitForTimeout(5000);
      // ページに自動再読込が無い場合のため軽くリロードを挟む (10秒毎)
      if (Math.floor((Date.now() - (deadline - 5 * 60 * 1000)) / 10000) % 2 === 0) {
        try {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
        } catch (_) {
          /* ignore */
        }
      }
    }
    if (!downloadTrigger) {
      await saveScreenshot(page, jobId, "booking_dl_ready_timeout");
      throw new Error("Booking.com ダウンロード準備のポーリングタイムアウト (5分)");
    }

    // 「ダウンロードする」クリック → xlsx を受信
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }).catch((e) => {
        throw new Error(`Booking.com ダウンロード待機タイムアウト: ${e.message}`);
      }),
      downloadTrigger.click({ timeout: 5000 }),
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
      throw new Error("F3 未実装: yadozei_csv_upload");
    } else if (job.kind === "yadozei_pdf_fetch") {
      throw new Error("F3 未実装: yadozei_pdf_fetch");
    } else {
      throw new Error(`未知の kind: ${job.kind}`);
    }

    await ref.update({
      status: "done",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      error: null,
      result: {
        fileName: result.fileName,
        driveFileId: result.fileId,
        driveLink: result.webViewLink,
      },
    });

    // 物件側 lastRun の更新 (airbnb / booking)
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
                    status: "done",
                    fileName: result.fileName,
                    driveFileId: result.fileId,
                    driveLink: result.webViewLink,
                    error: null,
                  },
                },
              },
            },
            { merge: true }
          );
      }
    } catch (e) {
      console.warn(`${LOG_PREFIX} lastRun 更新失敗 ${docId}: ${e.message}`);
    }

    console.log(`${LOG_PREFIX} 完了 ${docId} → ${result.fileName}`);
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

// ================== onSnapshot 監視 ==================
console.log(`${LOG_PREFIX} 起動 v${VERSION} host=${os.hostname()} cwd=${process.cwd()}`);
console.log(`${LOG_PREFIX} USER_DATA_DIR=${USER_DATA_DIR}`);

// heartbeat: 起動時 + 60秒毎
updateHeartbeat();
const heartbeatTimer = setInterval(updateHeartbeat, HEARTBEAT_INTERVAL_MS);

// yadozeiQueue 監視 (pending を added で拾う)
const unsubscribe = db
  .collection("yadozeiQueue")
  .where("status", "==", "pending")
  .onSnapshot(
    async (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== "added") continue;
        try {
          await handleJob(change.doc.id, change.doc.data());
        } catch (e) {
          console.error(`${LOG_PREFIX} ジョブ処理で未捕捉例外: ${e.message}`);
        }
      }
    },
    (err) => {
      console.error(`${LOG_PREFIX} onSnapshot エラー: ${err.message}`);
    }
  );

// ================== graceful shutdown ==================
async function shutdown(signal) {
  console.log(`${LOG_PREFIX} ${signal} 受信 — シャットダウン開始`);
  try {
    clearInterval(heartbeatTimer);
  } catch (_) {
    /* ignore */
  }
  try {
    unsubscribe();
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
