/**
 * 日付ユーティリティ (JST 基準)
 * 各 scheduled/ ファイルにコピペ重複していた実装を集約 (2026-06-13)
 */

/** 現在の JST 日付と時を返す: { date: "YYYY-MM-DD", hour: 0-23 } */
function nowJst() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

/** "YYYY-MM-DD" + N日 → "YYYY-MM-DD" */
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = { nowJst, addDays };
