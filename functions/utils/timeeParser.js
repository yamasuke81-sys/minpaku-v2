/**
 * Timee メール (supporter@timee.co.jp) を構造化するパーサ
 *
 * 入力: { subject, body, internalDate, messageId }
 * 出力: {
 *   eventType: "matched" | "summary" | "cancelled" | "fix_request" | "unknown",
 *   propertyName: string,       // Subject から抽出 (【タイミー XXX】の XXX)
 *   workDate: string,           // "YYYY-MM-DD" (本文の日時から)
 *   workStartTime: string,      // "HH:MM"
 *   workEndTime: string,        // "HH:MM"
 *   jobTitle: string,           // 業務タイトル
 *   workers: [{ name, age, gender }],
 *   offeringId: string,         // タイミー求人 ID (URL の offerings/XXX)
 *   capacity: { filled, total } // マッチ済 / 募集人数 (取れる場合のみ)
 * }
 */

function parseTimeeEmail({ subject = "", body = "" }) {
  const result = {
    eventType: classifyEventType(subject),
    propertyName: extractPropertyName(subject),
    workDate: "",
    workStartTime: "",
    workEndTime: "",
    jobTitle: "",
    workers: [],
    offeringId: "",
    capacity: null,
  };

  // 日時抽出 (本文): "2026年05月18日10:15 〜 2026年05月18日11:45"
  // または 全角スペース版にも対応
  const dt = body.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*\(?[月火水木金土日]?\)?\s*(\d{1,2}):(\d{2})\s*[〜～~]\s*(?:\d{4}年\s*(\d{1,2})月\s*(\d{1,2})日\s*\(?[月火水木金土日]?\)?\s*)?(\d{1,2}):(\d{2})/);
  if (dt) {
    const y = dt[1], m = String(dt[2]).padStart(2, "0"), d = String(dt[3]).padStart(2, "0");
    result.workDate = `${y}-${m}-${d}`;
    result.workStartTime = `${String(dt[4]).padStart(2, "0")}:${dt[5]}`;
    result.workEndTime = `${String(dt[8]).padStart(2, "0")}:${dt[9]}`;
  } else {
    // フォールバック: Subject から日付のみ取得 (例: ｜05月18日)
    // 年は internalDate から推定する必要があるが、ここでは省略
    const subjDate = subject.match(/(\d{1,2})月(\d{1,2})日/);
    if (subjDate) {
      // 年は内部日時から推測 (本年と仮定)
      const y = new Date().getFullYear();
      result.workDate = `${y}-${String(subjDate[1]).padStart(2, "0")}-${String(subjDate[2]).padStart(2, "0")}`;
    }
  }

  // 業務タイトル
  const jt = body.match(/【([^【】]*(?:【[^】]*】[^【】]*)*)】(?:[\s\S]{0,3})$/m);
  if (jt) result.jobTitle = jt[0].trim();
  // より頑健: 本文中の「客室清掃スタッフ募集」を含む行
  const titleLine = body.split("\n").find((l) => /客室清掃|清掃スタッフ|清掃募集/.test(l) && l.includes("【"));
  if (titleLine) result.jobTitle = titleLine.trim();

  // 求人 ID (URL: offerings/XXXXX)
  const oid = body.match(/offerings\/(\d+)/);
  if (oid) result.offeringId = oid[1];

  // 募集人数 (例: "2人 / 2人")
  const cap = body.match(/(\d+)\s*人\s*\/\s*(\d+)\s*人/);
  if (cap) result.capacity = { filled: Number(cap[1]), total: Number(cap[2]) };

  // ワーカー抽出
  result.workers = extractWorkers(body);

  return result;
}

function classifyEventType(subject) {
  if (/がマッチングしました/.test(subject)) return "matched";
  if (/キャンセル/.test(subject)) return "cancelled";
  if (/マッチング状況/.test(subject)) return "summary";
  if (/修正依頼/.test(subject)) return "fix_request";
  if (/募集が終了|応募締切/.test(subject)) return "closed";
  return "unknown";
}

function extractPropertyName(subject) {
  // パターン 1: 【タイミー (XXX)】 (括弧あり)
  let m = subject.match(/【タイミー\s*[(（]\s*([^)）]+?)\s*[)）]】/);
  if (m) return m[1].trim();
  // パターン 2: 【タイミー XXX】 (括弧なし)
  m = subject.match(/【タイミー\s+([^】]+?)】/);
  if (m) return m[1].trim();
  return "";
}

function extractWorkers(body) {
  // 主に 2 種類のパターン:
  // (A) 単数:
  //   ◆名前
  //   宮本 楓花 (ミヤモト フウカ) さん
  //   ◆年齢
  //   23歳
  //   ◆性別
  //   女性
  // (B) 複数 (summary):
  //   ・近藤 侑子 (コンドウ ユウコ) さん / 36歳 / 女性
  //   ・宮本 楓花 (ミヤモト フウカ) さん / 23歳 / 女性
  const workers = [];

  // (B) 行頭が ・ or ◆ で / 区切りの行 (複数)
  const reMulti = /[・◆]\s*([^\/\n]+?)\s*(?:\(([^)]+)\))?\s*さん\s*\/\s*(\d+)\s*歳\s*\/\s*([男女]性)/g;
  let m;
  while ((m = reMulti.exec(body)) !== null) {
    workers.push({
      name: m[1].trim(),
      nameKana: (m[2] || "").trim(),
      age: Number(m[3]),
      gender: m[4],
    });
  }
  if (workers.length > 0) return workers;

  // (A) ◆名前 ブロック (単数)
  const single = body.match(/◆名前\s*\n\s*([^\n]+?)\s*(?:\(([^)]+)\))?\s*さん\s*\n[\s\S]*?◆年齢\s*\n\s*(\d+)\s*歳[\s\S]*?◆性別\s*\n\s*([男女]性)/);
  if (single) {
    workers.push({
      name: single[1].trim(),
      nameKana: (single[2] || "").trim(),
      age: Number(single[3]),
      gender: single[4],
    });
    return workers;
  }

  // キャンセルメールには「ワーカーの名前」「村中 謙吾」だけの場合あり
  const cancelW = body.match(/◆ワーカーの名前\s*\n\s*([^\n]+?)\s*\n/);
  if (cancelW) {
    workers.push({ name: cancelW[1].trim() });
  }

  return workers;
}

module.exports = {
  parseTimeeEmail,
  classifyEventType,
  extractPropertyName,
  extractWorkers,
};
