/**
 * parse_errors コレクションへの記録 + 閾値判定 + 通知
 *
 * ・docId = Gmail messageId (冪等性確保: 同じメールを再処理しても上書きのみ)
 * ・expiresAt = createdAt + 90日 (Firestore TTL 対象。migration/enable-ttl-parse-errors.js で有効化)
 * ・本処理を止めないため、書き込み失敗は握り潰してログのみ
 *
 * 通知ロジック:
 *   A) 6時間以内に errorType="unmatched" が 2件以上 → notifyOwner で通知
 *   B) 24時間以内に errorType IN [parse_failed, unmatched] が 3件以上 → notifyOwner で通知
 *   抑制: 同一 lockKey の連続発火を 1時間に 1回まで (notification_locks)
 *
 * 通知は notifyOwner(db, "parse_alert", title, body) 経由なので、
 * settings/notifications の "parse_alert" チャンネル選択 (LINE/グループLINE/メール) が尊重される。
 */
const { PARSER_VERSION } = require("./__constants__/parserVersion");
const { tryAcquireNotificationLock } = require("./notificationLock");
const { notifyOwner } = require("./lineNotify");

const RAW_SNIPPET_MAX = 2048;
const PROJECT_ID = "minpaku-v2"; // Console URL 用 (固定)
const SAMPLE_LIMIT = 5;

/**
 * @typedef {"parse_failed"|"unmatched"|"schema_changed"|"reservation_code_missing"} ErrorType
 */

/**
 * parse_errors への記録 (失敗してもログのみで握り潰す)
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {Object} payload
 * @param {string} payload.messageId
 * @param {"airbnb"|"booking"|"unknown"} payload.ota
 * @param {ErrorType} payload.errorType
 * @param {string} [payload.subject]
 * @param {string} [payload.from]
 * @param {FirebaseFirestore.Timestamp|null} [payload.receivedAt]
 * @param {string} [payload.rawSnippet]
 * @param {string} [payload.reason]
 */
async function recordParseError(db, payload) {
  if (!db || !payload || !payload.messageId) return;
  try {
    const admin = require("firebase-admin");
    const now = Date.now();
    const expiresMs = now + 90 * 24 * 60 * 60 * 1000;
    const snippet = payload.rawSnippet
      ? String(payload.rawSnippet).slice(0, RAW_SNIPPET_MAX)
      : "";

    await db.collection("parse_errors").doc(payload.messageId).set({
      messageId: payload.messageId,
      ota: payload.ota || "unknown",
      errorType: payload.errorType,
      subject: payload.subject || "",
      from: payload.from || "",
      receivedAt: payload.receivedAt || null,
      rawSnippet: snippet,
      parserVersion: PARSER_VERSION,
      reason: String(payload.reason || "").slice(0, 1000),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(expiresMs),
    }, { merge: true });
  } catch (e) {
    console.error("[parse_errors] 書き込み失敗 (握り潰し):", e.message);
  }
}

/**
 * 閾値判定 + 通知。emailVerificationCore の末尾で 1 回呼ぶ。
 *
 * 失敗してもログのみで本処理は止めない。
 *
 * @param {FirebaseFirestore.Firestore} db
 */
async function checkThresholdsAndNotify(db) {
  if (!db) return;
  try {
    const admin = require("firebase-admin");
    const now = Date.now();
    const sixHoursAgo = admin.firestore.Timestamp.fromMillis(now - 6 * 3600 * 1000);
    const dayAgo = admin.firestore.Timestamp.fromMillis(now - 24 * 3600 * 1000);

    // A: 6h 内 unmatched ≥ 2
    const aSnap = await db.collection("parse_errors")
      .where("errorType", "==", "unmatched")
      .where("createdAt", ">=", sixHoursAgo)
      .limit(20)
      .get();
    if (aSnap.size >= 2) {
      await tryFireNotification_(db, {
        lockKey: "parse_threshold_6h_unmatched",
        reason: `6時間以内に unmatched が ${aSnap.size} 件発生`,
        sampleDocs: aSnap.docs.slice(0, SAMPLE_LIMIT),
      });
    }

    // B: 24h 内 parse_failed + unmatched ≥ 3
    const bSnap = await db.collection("parse_errors")
      .where("errorType", "in", ["parse_failed", "unmatched"])
      .where("createdAt", ">=", dayAgo)
      .limit(20)
      .get();
    if (bSnap.size >= 3) {
      await tryFireNotification_(db, {
        lockKey: "parse_threshold_24h_combined",
        reason: `24時間以内に parse_failed+unmatched が ${bSnap.size} 件発生`,
        sampleDocs: bSnap.docs.slice(0, SAMPLE_LIMIT),
      });
    }
  } catch (e) {
    console.error("[parse_errors] 閾値判定エラー (握り潰し):", e.message);
  }
}

/**
 * 抑制ロックを取得できたら notifyOwner 経由で通知を送る
 */
async function tryFireNotification_(db, { lockKey, reason, sampleDocs }) {
  const acquired = await tryAcquireNotificationLock(db, lockKey, 60 * 60 * 1000, reason);
  if (!acquired) {
    console.log(`[parse_errors] 通知抑制中: ${lockKey}`);
    return;
  }

  const title = "メール照合 異常検知";
  const body = buildAlertText_(reason, sampleDocs);

  try {
    // settings/notifications の "parse_alert" チャンネル設定を尊重
    // (LINE / グループLINE / メールを設定画面で個別 ON/OFF 可)
    await notifyOwner(db, "parse_alert", title, body);
    console.log(`[parse_errors] 通知送信完了: ${lockKey}`);
  } catch (e) {
    console.error(`[parse_errors] 通知失敗: ${e.message}`);
  }
}

/**
 * 通知本文を組み立て。サンプル 5件まで件名と OTA を載せる。
 */
function buildAlertText_(reason, sampleDocs) {
  const lines = [
    "⚠️ メール照合 異常検知",
    "",
    reason,
    "",
    "直近サンプル:",
  ];
  for (const d of sampleDocs) {
    const x = d.data() || {};
    const subject = (x.subject || "(件名なし)").slice(0, 60);
    const ota = x.ota || "unknown";
    const errorType = x.errorType || "";
    lines.push(`・[${ota}/${errorType}] ${subject}`);
  }
  lines.push("");
  lines.push("確認: https://console.firebase.google.com/project/" +
    PROJECT_ID + "/firestore/data/~2Fparse_errors");
  return lines.join("\n");
}

module.exports = {
  recordParseError,
  checkThresholdsAndNotify,
  // テスト/再利用用
  _internal: { buildAlertText_ },
  RAW_SNIPPET_MAX,
  SAMPLE_LIMIT,
};
