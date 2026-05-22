/**
 * ICS (RFC 5545) 単一イベント生成ユーティリティ
 * 確定通知メールに添付する用途を想定
 */

function escapeIcsText(s) {
  if (s == null) return "";
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function dtstampNow() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// "YYYY-MM-DD" → "YYYYMMDD"
function ymdCompact(ymd) {
  return String(ymd || "").replace(/-/g, "").slice(0, 8);
}

// "YYYY-MM-DD" → 翌日 "YYYYMMDD"
function nextYmdCompact(ymd) {
  const d = new Date(String(ymd) + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * 1 イベントの ICS テキストを生成
 * @param {object} ev
 *  - uid: 一意キー (再送時も同じならカレンダー上で重複しない)
 *  - date: "YYYY-MM-DD" (終日イベント)
 *  - summary: タイトル
 *  - description: 詳細
 *  - location: 場所
 *  - calName: カレンダー名 (オプション)
 * @returns {string}
 */
function buildIcsEvent(ev) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//minpaku-v2//Staff Calendar//JA",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-TIMEZONE:Asia/Tokyo",
  ];
  if (ev.calName) lines.push(`X-WR-CALNAME:${escapeIcsText(ev.calName)}`);
  lines.push(
    "BEGIN:VEVENT",
    `UID:${ev.uid}`,
    `DTSTAMP:${dtstampNow()}`,
    `DTSTART;VALUE=DATE:${ymdCompact(ev.date)}`,
    `DTEND;VALUE=DATE:${nextYmdCompact(ev.date)}`,
    `SUMMARY:${escapeIcsText(ev.summary || "")}`,
    `DESCRIPTION:${escapeIcsText(ev.description || "")}`,
    `LOCATION:${escapeIcsText(ev.location || "")}`,
    "END:VEVENT",
    "END:VCALENDAR",
  );
  return lines.join("\r\n");
}

module.exports = { buildIcsEvent };
