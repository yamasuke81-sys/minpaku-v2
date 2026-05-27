/**
 * Cloud Functions の OOM (Memory limit exceeded) を検知して通知する。
 *
 * 動作:
 *  - 毎 10 分実行 (Cloud Scheduler)
 *  - Cloud Logging から直近 12 分の "Memory limit" を含むエントリを取得
 *  - 各エントリを oom_alerts/{insertId} に upsert (重複防止)
 *  - 新規検出 (まだ通知未送信) のみ notifyByKey("error_alert", ...) で発火
 *  - クールダウン: 同じ functionName + 同日内は最初の1件のみ通知 (連発抑制)
 *
 * 必要権限:
 *  - Cloud Functions の実行サービスアカウントに "roles/logging.viewer" を付与
 *    (デフォルトの App Engine default service account に既に付与されていることが多い)
 */
const admin = require("firebase-admin");
const { Logging } = require("@google-cloud/logging");
const { notifyByKey } = require("../utils/lineNotify");

const LOOKBACK_MIN = 12;

module.exports = async function monitorOOM() {
  const db = admin.firestore();
  const logging = new Logging({ projectId: process.env.GCLOUD_PROJECT || "minpaku-v2" });

  const now = new Date();
  const since = new Date(now.getTime() - LOOKBACK_MIN * 60 * 1000).toISOString();

  // "Memory limit of NNN MiB exceeded" を含むログエントリを検索
  const filter = [
    `timestamp >= "${since}"`,
    `(textPayload:"Memory limit" OR jsonPayload.message:"Memory limit")`,
  ].join(" AND ");

  let entries = [];
  try {
    [entries] = await logging.getEntries({ filter, pageSize: 50, orderBy: "timestamp desc" });
  } catch (e) {
    console.error("[monitorOOM] log fetch error:", e.message);
    return;
  }

  if (entries.length === 0) {
    console.log(`[monitorOOM] OK (検出なし、since=${since})`);
    return;
  }

  let alertedCount = 0;
  let skippedCount = 0;

  for (const entry of entries) {
    const meta = entry.metadata || {};
    const insertId = meta.insertId || `unknown_${Date.now()}`;
    const fnName = meta.resource?.labels?.function_name || meta.resource?.labels?.service_name || "unknown";
    const t = meta.timestamp ? new Date(typeof meta.timestamp === "string" ? meta.timestamp : meta.timestamp.toISOString?.() || meta.timestamp) : now;
    const msg = entry.data?.message || meta.textPayload || JSON.stringify(entry.data || "").slice(0, 200);

    const docId = insertId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const ref = db.collection("oom_alerts").doc(docId);
    const snap = await ref.get();
    if (snap.exists) { skippedCount++; continue; }

    // クールダウンチェック: 同 functionName + yyyyMMdd で既に通知済みか
    const ymd = t.toISOString().slice(0, 10);
    const cooldownKey = `${fnName}_${ymd}`;
    const cdRef = db.collection("oom_alerts_cooldown").doc(cooldownKey);
    const cdSnap = await cdRef.get();
    const inCooldown = cdSnap.exists;

    // 必ず生ログとして oom_alerts にも残す
    await ref.set({
      insertId,
      functionName: fnName,
      timestamp: t,
      message: String(msg).slice(0, 500),
      notified: !inCooldown,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (inCooldown) {
      skippedCount++;
      console.log(`[monitorOOM] cooldown スキップ ${fnName} ${ymd}`);
      continue;
    }

    // 通知発火 (error_alert)
    try {
      await notifyByKey(db, "error_alert", {
        title: `⚠️ Cloud Functions OOM: ${fnName}`,
        body: `Cloud Functions が Memory limit を超過しました。\n\n関数: ${fnName}\n時刻: ${t.toISOString()}\n詳細: ${String(msg).slice(0, 200)}\n\nメモリ増量を検討してください。`,
        vars: {
          functionName: fnName,
          time: t.toISOString(),
          error: String(msg).slice(0, 200),
        },
        propertyId: null, // システムレベル通知のため null
      });
      // クールダウン登録 (1日1回)
      await cdRef.set({
        functionName: fnName,
        ymd,
        firstAlertAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      alertedCount++;
      console.log(`[monitorOOM] 通知発火 ${fnName} ${insertId}`);
    } catch (e) {
      console.error(`[monitorOOM] 通知失敗 ${fnName}:`, e.message);
    }
  }

  console.log(`[monitorOOM] 完了 entries=${entries.length} alerted=${alertedCount} skipped=${skippedCount}`);
};
