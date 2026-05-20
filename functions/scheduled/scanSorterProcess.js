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
    if (!settings.folderInbox || !settings.geminiApiKey) {
      console.warn("[scanSorter] folderInbox or geminiApiKey not set");
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
