/**
 * 有料駐車場（うみとやまと）利用希望の自動通知
 *
 * 宿泊者名簿の paidParking が「1台利用」「2台利用」の場合に、
 * オーナー（やますけ）へ通知を送る。オーナーはこの内容を
 * うみとやまとの石井様へ LINE 転送する運用。
 *
 * 通知先チャネルは properties/{pid}.channelOverrides.paid_parking_notify で制御
 * （予約清掃フロー設定画面から ON/OFF・チャネル選択可能）。
 * いまのところ the Terrace 長浜 のみ有効化する想定。
 */
const { notifyByKey } = require("./lineNotify");

const DOW = ["日", "月", "火", "水", "木", "金", "土"];

// "YYYY-MM-DD" → "M/D（曜）"
function fmtMd(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return "";
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dow = DOW[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${mo}/${d}（${dow}）`;
}

// paidParking 値 → 利用台数（1台利用→1 / 2台利用→2 / それ以外→0）
function parseCars(paidParking) {
  if (paidParking === "1台利用") return 1;
  if (paidParking === "2台利用") return 2;
  return 0;
}

/**
 * 有料駐車場 利用通知を送信する。
 * paidParking が 1台利用 / 2台利用 のときのみ送信し、それ以外は何もしない。
 * @returns {Promise<object|null>} notifyByKey の戻り値。送信対象外なら null
 */
async function notifyPaidParking(db, data, propertyId) {
  const cars = parseCars(data && data.paidParking);
  if (!cars) return null;

  const ci = fmtMd(data.checkIn);
  const co = fmtMd(data.checkOut);
  const feeNum = cars * 2000; // 1台2,000円
  const fee = feeNum.toLocaleString("en-US"); // "2,000" / "4,000"

  // 通知本文（石井様へ転送するテンプレート。CI/CO・台数・料金を自動挿入）
  const body =
`有料駐車場利用希望が入りました。うみとやまとの石井様へ下記内容をLINE送信してください。

お世話になっております！

民泊の宿泊者から、御社の駐車場を利用させていただきたいとの申し出がございました。

${ci}17:00〜
${co}9:30

駐車台数：${cars}台

料金：${fee}円（1台2,000円）

ご利用させていただくことは可能でしょうか？`;

  return notifyByKey(db, "paid_parking_notify", {
    title: `有料駐車場 利用希望（${cars}台）`,
    body,
    vars: {
      ci, co,
      cars: String(cars),
      fee,
      property: (data && data.propertyName) || "",
    },
    propertyId: propertyId || (data && data.propertyId) || null,
  });
}

module.exports = { notifyPaidParking, parseCars };
