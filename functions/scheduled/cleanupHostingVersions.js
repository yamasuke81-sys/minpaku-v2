/**
 * Firebase Hosting の古いリリース版を自動削除 + 容量超過前に警告する。
 *
 * 背景:
 *  - Firebase Hosting は累積したリリースを 10GB まで無料保存。超えるとサイト配信が壊れることがある
 *  - GitHub Actions による自動デプロイで毎回 ~50MB 増えるため、放置すると数百件溜まる
 *
 * 動作:
 *  - 毎日 03:00 JST 実行 (Cloud Scheduler)
 *  - 全 hosting sites の versions を列挙
 *  - 各 site で最新 KEEP_LATEST 件を残し、それ以前を削除
 *  - 削除後の合計バイト数が WARN_THRESHOLD_GB を超えたら notifyByKey("error_alert") で警告
 *
 * 必要権限:
 *  - 実行 SA に "roles/firebasehosting.admin" もしくは Editor/Owner 相当
 *    (App Engine default SA は通常 Editor を持つ)
 *
 * 関連: 2026-05-29 the Terrace 長浜 6/7 トラブル時に 989 versions / 16.67GB まで膨らみ
 *       Hosting が "Site Not Found" を返す状態になった。再発防止としてこの関数を追加
 */
const admin = require("firebase-admin");
const { GoogleAuth } = require("google-auth-library");
const { notifyByKey } = require("../utils/lineNotify");

const KEEP_LATEST = 20;                  // 各サイトで残すリリース数
const WARN_THRESHOLD_GB = 7;             // 警告閾値 (10GB 上限の 70%)
const HOSTING_API = "https://firebasehosting.googleapis.com/v1beta1";
const PROJECT_ID = process.env.GCLOUD_PROJECT || "minpaku-v2";

async function getAuthClient() {
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/firebase"],
  });
  return auth.getClient();
}

async function apiGet(client, url) {
  const res = await client.request({ url, method: "GET" });
  return res.data;
}

async function apiDelete(client, url) {
  await client.request({ url, method: "DELETE" });
}

// 全 sites を列挙
async function listSites(client) {
  const data = await apiGet(client, `${HOSTING_API}/projects/${PROJECT_ID}/sites`);
  return (data.sites || []).map((s) => s.name.split("/").pop()); // siteId 配列
}

// 1 site の全 versions を列挙 (ページング対応)
async function listAllVersions(client, siteId) {
  const all = [];
  let token = null;
  do {
    const url = `${HOSTING_API}/sites/${siteId}/versions?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
    const data = await apiGet(client, url);
    all.push(...(data.versions || []));
    token = data.nextPageToken;
  } while (token);
  return all;
}

module.exports = async function cleanupHostingVersions() {
  const db = admin.firestore();
  const client = await getAuthClient();

  const sites = await listSites(client);
  console.log(`[cleanupHostingVersions] 対象 sites: ${sites.length} 件 (${sites.join(", ")})`);

  let totalDeleted = 0;
  let totalFreedBytes = 0;
  let totalRemainBytes = 0;
  const perSite = [];

  for (const siteId of sites) {
    let versions = [];
    try {
      versions = await listAllVersions(client, siteId);
    } catch (e) {
      console.error(`[cleanupHostingVersions] ${siteId} list 失敗:`, e.message);
      continue;
    }

    // FINALIZED のみ削除対象 (CREATED 中の進行中リリースは触らない)
    const finalized = versions.filter((v) => v.status === "FINALIZED");
    finalized.sort((a, b) => (b.createTime || "").localeCompare(a.createTime || ""));

    const keep = finalized.slice(0, KEEP_LATEST);
    const del = finalized.slice(KEEP_LATEST);
    const keepBytes = keep.reduce((s, v) => s + Number(v.versionBytes || 0), 0);

    let deleted = 0;
    let freed = 0;
    let errs = 0;
    // 並列 10 で削除
    const concurrency = 10;
    for (let i = 0; i < del.length; i += concurrency) {
      const batch = del.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map((v) => apiDelete(client, `${HOSTING_API}/${v.name}`).then(() => ({ bytes: Number(v.versionBytes || 0) })))
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          deleted++;
          freed += r.value.bytes;
        } else {
          errs++;
          if (errs <= 3) console.error(`[cleanupHostingVersions] ${siteId} delete err:`, r.reason && r.reason.message);
        }
      }
    }

    totalDeleted += deleted;
    totalFreedBytes += freed;
    totalRemainBytes += keepBytes;
    perSite.push({ siteId, kept: keep.length, deleted, errs, keepBytes, freed });
    console.log(`[cleanupHostingVersions] ${siteId}: 残${keep.length} 削除${deleted} (失敗${errs}) 解放${(freed / 1024 / 1024).toFixed(1)}MB 残量${(keepBytes / 1024 / 1024).toFixed(1)}MB`);
  }

  const remainGB = totalRemainBytes / 1024 / 1024 / 1024;
  console.log(`[cleanupHostingVersions] 完了: 削除 ${totalDeleted} 件 解放 ${(totalFreedBytes / 1024 / 1024 / 1024).toFixed(2)} GB / 残量合計 ${remainGB.toFixed(2)} GB`);

  // 実行ログを Firestore に残す (履歴用)
  try {
    await db.collection("ops_logs").doc("hostingCleanup").collection("runs").add({
      ranAt: admin.firestore.FieldValue.serverTimestamp(),
      totalDeleted,
      totalFreedBytes,
      totalRemainBytes,
      perSite,
    });
  } catch (e) {
    console.error("[cleanupHostingVersions] ログ書込失敗:", e.message);
  }

  // 早期警告: 削除後でも閾値を超えていれば通知
  if (remainGB >= WARN_THRESHOLD_GB) {
    try {
      await notifyByKey(db, "error_alert", {
        title: `⚠️ Firebase Hosting ストレージ警告 (${remainGB.toFixed(2)} GB)`,
        body: `古いリリース ${totalDeleted} 件を自動削除しましたが、残量が ${remainGB.toFixed(2)} GB あり、10 GB の無料枠に対して ${WARN_THRESHOLD_GB} GB の警告閾値を超えています。\n\nKEEP_LATEST (${KEEP_LATEST}) をさらに減らすか、不要な site を整理してください。\n\nサイト別:\n${perSite.map((s) => `  - ${s.siteId}: ${(s.keepBytes / 1024 / 1024).toFixed(0)}MB (${s.kept}件)`).join("\n")}`,
        vars: {
          remainGB: remainGB.toFixed(2),
          deleted: String(totalDeleted),
        },
        propertyId: null,
      });
      console.log(`[cleanupHostingVersions] 警告通知発火 (残量 ${remainGB.toFixed(2)} GB)`);
    } catch (e) {
      console.error("[cleanupHostingVersions] 警告通知失敗:", e.message);
    }
  }

  return { totalDeleted, totalFreedBytes, totalRemainBytes, perSite };
};
