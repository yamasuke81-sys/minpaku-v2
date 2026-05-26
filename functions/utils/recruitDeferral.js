/**
 * 募集通知の 30 日繰延ロジック
 *
 * settings/notifications.channels.recruit_start.deferUntil30Days === true の場合、
 * 作業日 (清掃日 / 直前点検日) が今日から 30 日より先の予約は、
 * 予約時点では recruit_start を発火させず、recruitments.{id}.notifyDeferred=true を立てる。
 * 日次バッチ (dispatchDeferredRecruits) が日付経過で 30 日以内に入った時点で実発火する。
 */

const DEFER_THRESHOLD_DAYS = 30;

/**
 * 日付文字列 (YYYY-MM-DD) と現在時刻から、作業日まで何日あるか算出 (JST 基準・日単位の整数)
 * 過去日は負の数を返す。
 * @param {string} workDateStr "2026-07-01" 形式
 * @param {Date} [now] テスト用注入
 * @returns {number}
 */
function daysUntilJst(workDateStr, now = new Date()) {
  if (!workDateStr || typeof workDateStr !== "string") return 0;
  // JST 0時を基準とした「日数差」(28800000 = 9h*3600s*1000ms。UTC+9h ずらして 0時で切り捨て)
  const todayJst = new Date(now.getTime() + 9 * 3600 * 1000);
  todayJst.setUTCHours(0, 0, 0, 0);
  const workJst = new Date(workDateStr.slice(0, 10) + "T00:00:00.000Z");
  return Math.round((workJst.getTime() - todayJst.getTime()) / (24 * 3600 * 1000));
}

/**
 * 物件別の channelOverrides.recruit_start.deferUntil30Days を見て、
 * 作業日 workDateStr について繰延べるか判定。
 * 通知設定タブは廃止されており、設定 SSOT は properties/{pid}.channelOverrides[notifyKey]
 * (予約フロー画面の物件カード内トグル) のため、グローバル settings は参照しない。
 * @param {object|null} propertyOverrides properties/{pid}.channelOverrides
 * @param {string} workDateStr "YYYY-MM-DD"
 * @param {Date} [now]
 * @returns {boolean}
 */
function shouldDeferRecruitStart(propertyOverrides, workDateStr, now = new Date()) {
  const ch = (propertyOverrides && propertyOverrides.recruit_start) || {};
  if (!ch.deferUntil30Days) return false;
  const diff = daysUntilJst(workDateStr, now);
  return diff > DEFER_THRESHOLD_DAYS;
}

module.exports = {
  DEFER_THRESHOLD_DAYS,
  daysUntilJst,
  shouldDeferRecruitStart,
};
