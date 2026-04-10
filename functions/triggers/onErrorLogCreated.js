/**
 * エラーログ作成時のAI翻訳+LINE通知トリガー
 * Cloud Functionsでエラーが発生→error_logsに書き込み→
 * このトリガーがAIでログを解析し、日本語で原因と対処法をオーナーに通知
 */
const { notifyOwner } = require("../utils/lineNotify");

module.exports = async function onErrorLogCreated(event) {
  const admin = require("firebase-admin");
  const db = admin.firestore();
  const data = event.data.data();

  if (!data || data.notified) return;

  // 重複防止: 同じ関数名で直近10分以内にエラー通知があればスキップ
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
  const recentSnap = await db.collection("notifications")
    .where("type", "==", "error_alert")
    .where("sentAt", ">=", tenMinAgo)
    .limit(5).get();

  const alreadyNotified = recentSnap.docs.some((d) =>
    d.data().body && d.data().body.includes(data.functionName)
  );
  if (alreadyNotified) {
    console.log("エラー通知スキップ（10分以内に同関数で通知済み）:", data.functionName);
    return;
  }

  // AI翻訳（LLMなしでもルールベースで人間が読める形に変換）
  const analysis = translateError_(data);

  // Firestoreに解析結果を書き戻し
  await event.data.ref.update({
    aiAnalysis: analysis,
    notified: true,
  });

  // LINE通知
  const severity = data.severity || "warning";
  const icon = severity === "critical" ? "🔴" : "🟡";
  const text = `${icon} エラー発生\n\n`
    + `関数: ${data.functionName || "不明"}\n`
    + `${analysis}\n\n`
    + `発生時刻: ${formatJST_(data.createdAt)}`;

  await notifyOwner(db, "error_alert", "エラー通知", text);
};

/**
 * エラーメッセージをルールベースで日本語に翻訳
 * 将来的にはClaude/Gemini APIで高度な解析も可能
 */
function translateError_(data) {
  const msg = (data.errorMessage || "").toLowerCase();
  const fn = data.functionName || "";

  // よくあるエラーパターン
  if (msg.includes("permission") || msg.includes("403")) {
    return "原因: アクセス権限エラー\n対処: サービスアカウントの権限を確認してください";
  }
  if (msg.includes("quota") || msg.includes("429")) {
    return "原因: APIの利用制限に到達\n対処: しばらく待ってから再実行するか、利用上限を引き上げてください";
  }
  if (msg.includes("timeout") || msg.includes("deadline")) {
    return "原因: 処理がタイムアウト\n対処: データ量が多すぎる可能性があります。バッチサイズを小さくしてください";
  }
  if (msg.includes("not found") || msg.includes("404")) {
    return "原因: リソースが見つかりません\n対処: ファイルやフォルダが削除されていないか確認してください";
  }
  if (msg.includes("token") && (msg.includes("expired") || msg.includes("invalid"))) {
    return "原因: 認証トークンの期限切れ\n対処: LINE Developers Console等でトークンを再発行してください";
  }
  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("network")) {
    return "原因: ネットワーク接続エラー\n対処: 外部APIが一時的にダウンしている可能性があります。自動リトライを待ってください";
  }
  if (msg.includes("gemini") || msg.includes("generativelanguage")) {
    return "原因: Gemini API エラー\n対処: APIキーの有効性とリクエスト上限を確認してください";
  }
  if (msg.includes("firestore") || msg.includes("grpc")) {
    return "原因: Firestoreへの接続エラー\n対処: Firebase Console でFirestoreのステータスを確認してください";
  }

  // 汎用
  return `原因: ${data.errorMessage || "不明なエラー"}\n対処: Cloud Functions のログで詳細を確認してください`;
}

function formatJST_(dateOrTimestamp) {
  let d;
  if (dateOrTimestamp && dateOrTimestamp.toDate) {
    d = dateOrTimestamp.toDate();
  } else if (dateOrTimestamp instanceof Date) {
    d = dateOrTimestamp;
  } else {
    return "不明";
  }
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace("T", " ").slice(0, 16);
}
