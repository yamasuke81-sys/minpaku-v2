/**
 * scan-sorter 自動処理スケジューラ
 *
 * 5分おきに起動し、Firestore settings/scanSorter.scheduler の設定に従って処理。
 *   scheduler: {
 *     enabled: boolean,          // ON/OFF
 *     intervalMinutes: number,   // 実行間隔（5/10/30/60 等）
 *     lastRunAt: timestamp,      // 最終実行日時
 *     lastResult: object,        // 最終結果のサマリ
 *   }
 *
 * 受信BOX の未処理 PDF を最大 maxFilesPerRun 件まで処理。
 * 各ファイルの実処理は scan-sorter.js が公開する router.processOneFile を使う。
 */
const admin = require("firebase-admin");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { FieldValue } = require("firebase-admin/firestore");
const { google } = require("googleapis");
const scanSorterApi = require("../api/scan-sorter");

const MAX_FILES_PER_RUN = 20;

// error_logs 記録のデデュープ (6時間)。連発を防ぎつつ owner への通知経路 (onErrorLogCreated) は確保する
const ERROR_LOG_DEDUP_MS = 6 * 60 * 60 * 1000;

/**
 * scan-sorter の致命的失敗 (APIキー/設定/quota系) を error_logs に記録する。
 * onErrorLogCreated トリガー経由で owner に通知が届く。
 * settings/scanSorter.errorAlert.{kind}LastLoggedAt で 6時間デデュープ。
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {FirebaseFirestore.DocumentReference} settingsRef - settings/scanSorter
 * @param {object} settings - settings/scanSorter の現在値
 * @param {string} kind - デデュープキー ("config" | "gemini")
 * @param {string} errorMessage - 要約 (onErrorLogCreated の翻訳対象)
 * @param {string} detail - 詳細メッセージ
 */
async function logScanSorterError_(db, settingsRef, settings, kind, errorMessage, detail) {
  try {
    const alertState = (settings.errorAlert && typeof settings.errorAlert === "object")
      ? settings.errorAlert
      : {};
    const last = alertState[`${kind}LastLoggedAt`];
    const lastMs = last && last.toMillis ? last.toMillis() : 0;
    if (lastMs && Date.now() - lastMs < ERROR_LOG_DEDUP_MS) return; // 6時間デデュープ

    // 先にデデュープフラグを立てる (連発抑制)
    await settingsRef.set(
      { errorAlert: { [`${kind}LastLoggedAt`]: FieldValue.serverTimestamp() } },
      { merge: true }
    );
    await db.collection("error_logs").add({
      functionName: "scanSorterProcess",
      errorMessage,
      message: detail,
      severity: "warning",
      createdAt: new Date(),
    });
    console.warn(`[scanSorter] error_logs に記録 (${kind}): ${errorMessage}`);
  } catch (e) {
    // 記録失敗で本処理を止めない
    console.error("[scanSorter] error_logs 記録失敗:", e.message);
  }
}

exports.scanSorterProcess = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "Asia/Tokyo",
    region: "asia-northeast1",
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async () => {
    const db = admin.firestore();
    const settingsRef = db.collection("settings").doc("scanSorter");
    const cfgDoc = await settingsRef.get();
    const settings = cfgDoc.exists ? cfgDoc.data() : {};
    const sched = settings.scheduler || {};

    // ON/OFF判定
    if (!sched.enabled) {
      console.log("[scanSorter] scheduler disabled, skip");
      return;
    }

    // 間隔判定
    const intervalMs = (sched.intervalMinutes || 30) * 60 * 1000;
    const lastRunMs = sched.lastRunAt && sched.lastRunAt.toMillis ? sched.lastRunAt.toMillis() : 0;
    const elapsed = Date.now() - lastRunMs;
    if (lastRunMs && elapsed < intervalMs) {
      console.log(`[scanSorter] not yet (elapsed=${Math.floor(elapsed / 1000)}s < interval=${sched.intervalMinutes}min)`);
      return;
    }

    // 設定チェック
    // console.warn だけだと owner に届かず処理停止に気付けないため error_logs にも記録する
    if (!settings.folderInbox || !settings.geminiApiKey) {
      console.warn("[scanSorter] folderInbox or geminiApiKey not set");
      await logScanSorterError_(
        db, settingsRef, settings, "config",
        "scan-sorter 自動処理が停止中: 受信BOXフォルダまたはGemini APIキーが未設定",
        `settings/scanSorter の設定を確認してください。\n`
          + `folderInbox: ${settings.folderInbox ? "設定済" : "未設定"}\n`
          + `geminiApiKey: ${settings.geminiApiKey ? "設定済" : "未設定"}`
      );
      await settingsRef.set(
        {
          scheduler: {
            ...sched,
            lastRunAt: FieldValue.serverTimestamp(),
            lastResult: { ok: false, error: "受信BOXフォルダまたはGemini APIキーが未設定" },
          },
        },
        { merge: true }
      );
      return;
    }

    // 受信BOX 一覧取得
    const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/drive"] });
    const drive = google.drive({ version: "v3", auth: await auth.getClient() });
    const listRes = await drive.files.list({
      q: `'${settings.folderInbox}' in parents and mimeType='application/pdf' and trashed=false`,
      fields: "files(id,name,createdTime)",
      orderBy: "createdTime asc",
      pageSize: MAX_FILES_PER_RUN,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    // 処理済みを除外
    const processedSnap = await db.collection("scanLogs").select("fileId").get();
    const processedIds = new Set(processedSnap.docs.map((d) => d.data().fileId));
    const unprocessed = (listRes.data.files || []).filter((f) => !processedIds.has(f.id));

    console.log(`[scanSorter] inbox=${listRes.data.files?.length || 0}, unprocessed=${unprocessed.length}`);

    // scan-sorter API の processOneFile を呼ぶ
    const apiRouter = scanSorterApi(db);
    const results = { ok: 0, ng: 0, skipped: 0, errors: [] };

    for (const f of unprocessed) {
      try {
        await apiRouter.processOneFile(f.id);
        results.ok++;
      } catch (e) {
        if (e.code === "ALREADY_PROCESSED") {
          results.skipped++;
        } else {
          results.ng++;
          results.errors.push({ fileId: f.id, name: f.name, error: e.message });
          console.error(`[scanSorter] processOneFile failed for ${f.name}:`, e.message);
        }
      }
    }

    // APIキー/quota系の失敗は console だけでなく error_logs にも記録して owner に届ける
    const apiErrors = results.errors.filter((er) =>
      /quota|429|api.?key|permission|unauthorized|401|403/i.test(String(er.error || ""))
    );
    if (apiErrors.length > 0) {
      await logScanSorterError_(
        db, settingsRef, settings, "gemini",
        `scan-sorter で APIキー/quota系エラー (${apiErrors.length}件の処理失敗)`,
        apiErrors.slice(0, 5).map((er) => `${er.name}: ${String(er.error).slice(0, 150)}`).join("\n")
      );
    }

    // 結果を保存
    await settingsRef.set(
      {
        scheduler: {
          ...sched,
          lastRunAt: FieldValue.serverTimestamp(),
          lastResult: {
            ok: true,
            inboxTotal: listRes.data.files?.length || 0,
            unprocessed: unprocessed.length,
            processed: results.ok,
            failed: results.ng,
            skipped: results.skipped,
            errors: results.errors.slice(0, 5),
          },
        },
      },
      { merge: true }
    );

    console.log(`[scanSorter] done: ok=${results.ok}, ng=${results.ng}, skipped=${results.skipped}`);
  }
);
