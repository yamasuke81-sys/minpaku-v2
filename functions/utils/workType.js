/**
 * workType → 表示ラベル変換 (通知変数 {work} 用)
 */
function workLabel(workType) {
  switch (workType) {
    case "pre_inspection":
      return "直前点検";
    case "cleaning":
    case "cleaning_by_count":
    case "":
    case undefined:
    case null:
      return "清掃";
    case "other":
      return "作業";
    default:
      return String(workType);
  }
}

module.exports = { workLabel };
