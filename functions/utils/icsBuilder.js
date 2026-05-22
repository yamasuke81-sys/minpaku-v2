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

// "HH:MM" → "HHMM00" (秒は固定 00)
function hmsCompact(hm) {
  const m = String(hm || "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hh = String(Math.max(0, Math.min(23, parseInt(m[1], 10)))).padStart(2, "0");
  const mm = String(Math.max(0, Math.min(59, parseInt(m[2], 10)))).padStart(2, "0");
  return `${hh}${mm}00`;
}

// "HH:MM" + duration(分) → end "HH:MM" (24h 跨ぎは翌日返却フラグ)
function addMinutes(hm, mins) {
  const m = String(hm || "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let total = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + (mins | 0);
  let overflow = 0;
  while (total >= 24 * 60) { total -= 24 * 60; overflow++; }
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return { hm: `${hh}:${mm}`, overflow };
}

/**
 * 1 イベントの ICS テキストを生成
 * @param {object} ev
 *  - uid: 一意キー
 *  - date: "YYYY-MM-DD"
 *  - startTime: "HH:MM" (省略時は終日イベント)
 *  - endTime: "HH:MM" (省略時は startTime + 60分。 startTime も無ければ終日)
 *  - summary / description / location / calName
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
  );
  const startHms = hmsCompact(ev.startTime);
  if (startHms) {
    // 時間指定イベント (Asia/Tokyo)
    let endTime = ev.endTime;
    let endDate = ev.date;
    if (!endTime) {
      const r = addMinutes(ev.startTime, 60);
      endTime = r.hm;
      if (r.overflow > 0) {
        const d = new Date(ev.date + "T00:00:00.000Z");
        d.setUTCDate(d.getUTCDate() + r.overflow);
        endDate = d.toISOString().slice(0, 10);
      }
    } else {
      // endTime <= startTime なら翌日扱い
      const sM = ev.startTime.split(":").map(Number);
      const eM = endTime.split(":").map(Number);
      if (eM[0] * 60 + eM[1] <= sM[0] * 60 + sM[1]) {
        const d = new Date(ev.date + "T00:00:00.000Z");
        d.setUTCDate(d.getUTCDate() + 1);
        endDate = d.toISOString().slice(0, 10);
      }
    }
    const endHms = hmsCompact(endTime);
    lines.push(
      `DTSTART;TZID=Asia/Tokyo:${ymdCompact(ev.date)}T${startHms}`,
      `DTEND;TZID=Asia/Tokyo:${ymdCompact(endDate)}T${endHms}`,
    );
  } else {
    // 終日イベント
    lines.push(
      `DTSTART;VALUE=DATE:${ymdCompact(ev.date)}`,
      `DTEND;VALUE=DATE:${nextYmdCompact(ev.date)}`,
    );
  }
  lines.push(
    `SUMMARY:${escapeIcsText(ev.summary || "")}`,
    `DESCRIPTION:${escapeIcsText(ev.description || "")}`,
    `LOCATION:${escapeIcsText(ev.location || "")}`,
    "END:VEVENT",
    "END:VCALENDAR",
  );
  return lines.join("\r\n");
}

module.exports = { buildIcsEvent };
