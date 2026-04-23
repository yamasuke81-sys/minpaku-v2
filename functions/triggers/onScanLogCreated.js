/**
 * スキャンログ作成時の通知トリガー
 * scan-sorterでOCR処理が完了し、確認待ちのログが作成されたら
 * Webアプリ管理者にLINE通知を送信する
 *
 * バッチ通知: 5分以内に複数スキャンがあった場合はまとめて1通にする
 * → 重複防止: 直近5分以内に同じtype=scan_pendingの通知があればスキップ
 */
const { notifyOwner } = require("../utils/lineNotify");

module.exports = async function onScanLogCreated(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();
  const data = event.data.data();

  // 確認待ちのログのみ通知
  if (!data || data.status !== "⏳ 確認待ち") return;

  // 重複防止: 直近5分以内に scan_pending 通知があればスキップ
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const recentSnap = await db.collection("notifications")
    .where("type", "==", "scan_pending")
    .where("sentAt", ">=", fiveMinAgo)
    .limit(1).get();

  if (!recentSnap.empty) {
    console.log("スキャン通知をスキップ（5分以内に送信済み）");
    return;
  }

  // 現在の確認待ち件数を取得
  const pendingSnap = await db.collection("scanLogs")
    .where("status", "==", "⏳ 確認待ち").get();
  const pendingCount = pendingSnap.size;

  const text = `📄 スキャン仕分け: ${pendingCount}件が確認待ちです\n`
    + `最新: ${data.vendor || "不明"} ${data.amount ? data.amount + "円" : ""} (${data.category || "未分類"})\n`
    + `→ scan-sorter で確認してください`;

  await notifyOwner(db, "scan_pending", "スキャン確認待ち", text);
};
