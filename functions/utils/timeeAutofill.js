/**
 * タイミー求人複製 URL 生成ユーティリティ
 *
 * properties/{pid}.timeeAutofill に baseUrl + 自動入力パラメータを保持しておく前提。
 * userscripts/timee-autofill.user.js が hash パラメータを読んでフォームに自動入力する。
 *
 * 元々 functions/triggers/onBookingChange.js のローカル関数だったが、
 * dispatchDeferredRecruits (30日繰延通知バッチ) からも使うため共通化 (2026-05-27)。
 */

/**
 * タイミー求人複製 URL を生成する
 * @param {object} tf - propertyData.timeeAutofill
 * @param {string} checkOut - YYYY-MM-DD
 * @param {string} visibility - "group_limited" | "new_worker_for_client_limited"
 * @returns {string|null}
 */
function buildTimeeAutofillUrl_(tf, checkOut, visibility) {
  if (!tf || !tf.baseUrl || !checkOut) return null;
  // baseUrl に既存クエリがあれば & で、なければ ? で openExternalBrowser を付与
  // (LINE 内蔵ブラウザ回避: 公式仕様で任意 URL に有効)
  const url = new URL(tf.baseUrl);
  url.searchParams.set("openExternalBrowser", "1");
  const params = new URLSearchParams();
  params.set("date", checkOut);
  if (tf.start) params.set("start", tf.start);
  if (tf.end) params.set("end", tf.end);
  if (tf.restMin != null) params.set("restMin", String(tf.restMin));
  if (tf.workers) params.set("workers", String(tf.workers));
  params.set("visibility", visibility);
  if (visibility === "group_limited" && tf.groupIds) params.set("groupIds", tf.groupIds);
  if (tf.wage) params.set("wage", String(tf.wage));
  if (tf.transport != null) params.set("transport", String(tf.transport));
  if (tf.autoMsg != null) params.set("autoMsg", tf.autoMsg ? "true" : "false");
  if (tf.autoMsgTarget) params.set("autoMsgTarget", tf.autoMsgTarget);
  return `${url.toString()}#${params.toString()}`;
}

module.exports = { buildTimeeAutofillUrl_ };
