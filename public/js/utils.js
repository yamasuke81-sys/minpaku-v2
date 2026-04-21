// 共通ユーティリティ (全ページ共通でグローバル露出)

// HTML エスケープ済み文字列内の URL を <a> タグに置換
// 入力は必ず既に escape 済みであること (XSS 対策)
window.linkifyUrls = function(escapedHtml) {
  if (!escapedHtml) return "";
  return String(escapedHtml).replace(
    /(https?:\/\/[^\s<>"'（）【】]+)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>'
  );
};

// 日付を「YYYY年M月D日(曜)」形式に統一
// 受け付ける入力: YYYY-MM-DD 文字列 / Date / Firestore Timestamp
window.formatDateFull = function(val) {
  if (val === null || val === undefined || val === "") return "-";
  let y, mo, d;
  if (typeof val === "string") {
    const m = val.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (!m) return val;
    [, y, mo, d] = m;
  } else {
    const date = (val && typeof val.toDate === "function") ? val.toDate() : new Date(val);
    if (isNaN(date.getTime())) return "-";
    // JST 補正 (Firestore Timestamp は UTC なので +9h でずれ防止)
    const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    y = jst.getUTCFullYear();
    mo = jst.getUTCMonth() + 1;
    d = jst.getUTCDate();
  }
  const dow = ["日", "月", "火", "水", "木", "金", "土"][new Date(+y, +mo - 1, +d).getDay()];
  return `${+y}年${+mo}月${+d}日(${dow})`;
};

// 回答日時などの短縮表示: Timestamp/Date/ISO文字列 → "M/D HH:MM"
// 年月日・曜日・秒は省略 (募集詳細テーブル等で横幅節約)
window.formatTimeShort = function(val) {
  if (val === null || val === undefined || val === "") return "";
  let d;
  if (val && typeof val.toDate === "function") {
    d = val.toDate();
  } else if (typeof val === "string" || typeof val === "number") {
    d = new Date(val);
  } else if (val instanceof Date) {
    d = val;
  } else {
    return "";
  }
  if (isNaN(d.getTime())) return "";
  const mo = d.getMonth() + 1;
  const da = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${mo}/${da} ${hh}:${mm}`;
};

// BBQ などの三値 (true/false/未設定) を記号 ◎ / × / - に変換
// 許容入力: true/false 真偽値、"true"/"false"/"yes"/"no"/"有"/"無"/"◎"/"×" 文字列、数値
window.bbqToSymbol = function(val) {
  if (val === null || val === undefined || val === "") return "-";
  if (val === true) return "◎";
  if (val === false) return "×";
  const s = String(val).trim().toLowerCase();
  if (["true", "yes", "y", "有", "あり", "◎", "1"].includes(s)) return "◎";
  if (["false", "no", "n", "無", "なし", "×", "x", "0"].includes(s)) return "×";
  return "-";
};
