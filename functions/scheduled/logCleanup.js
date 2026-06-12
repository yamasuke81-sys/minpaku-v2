/**
 * 蓄積ログの日次クリーンアップ (毎日 03:30 JST)
 *
 * TTL を持たないログ系コレクションが無限に増え続けるのを防ぐ。
 * Firestore ネイティブ TTL ではなくバッチ削除方式を採用した理由:
 *  - expiresAt の書き込み箇所が 40 以上に散在しており、漏れが出やすい
 *  - 既存ドキュメントのバックフィルも不要になる
 *
 * 保持期間:
 *  - notifications      180日 (通知履歴の参照用に半年残す。重複防止クエリは当日分のみ参照)
 *  - error_logs          90日
 *  - notificationQueue   30日 (バッチ送信済みキュー)
 *  - client_errors       30日 (フロント診断ログ)
 *
 * 1コレクションあたり1回の実行で最大 MAX_DELETES_PER_RUN 件まで削除
 * (溜まりすぎていても数日かけて追いつく。タイムアウト/メモリを守る)
 */
const admin = require("firebase-admin");

const TARGETS = [
  { collection: "notifications", field: "sentAt", days: 180 },
  { collection: "error_logs", field: "createdAt", days: 90 },
  { collection: "notificationQueue", field: "createdAt", days: 30 },
  { collection: "client_errors", field: "createdAt", days: 30 },
];

const BATCH_SIZE = 400;
const MAX_DELETES_PER_RUN = 4000;

module.exports = async function logCleanup() {
  const db = admin.firestore();
  const summary = [];

  for (const t of TARGETS) {
    const cutoff = new Date(Date.now() - t.days * 24 * 3600 * 1000);
    let deleted = 0;
    try {
      while (deleted < MAX_DELETES_PER_RUN) {
        const snap = await db.collection(t.collection)
          .where(t.field, "<", cutoff)
          .select() // ドキュメント本文は不要 (削除参照だけ取る)
          .limit(BATCH_SIZE)
          .get();
        if (snap.empty) break;

        const batch = db.batch();
        snap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        deleted += snap.size;
        if (snap.size < BATCH_SIZE) break;
      }
      summary.push(`${t.collection}: ${deleted}件削除 (${t.days}日超)`);
    } catch (e) {
      console.error(`[logCleanup] ${t.collection} 削除エラー:`, e.message);
      summary.push(`${t.collection}: エラー (${e.message})`);
    }
  }

  console.log(`[logCleanup] 完了: ${summary.join(" / ")}`);
};
