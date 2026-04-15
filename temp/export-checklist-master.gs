/**
 * チェックリストマスタの全データをログ出力
 * GASエディタ（checklist-app）で実行 → 実行ログで全項目を確認
 *
 * 出力形式: JSON（カテゴリ別にグループ化）
 */
function exportChecklistMaster() {
  var masterRes = JSON.parse(getChecklistMaster());
  if (!masterRes.success) {
    Logger.log("エラー: " + masterRes.error);
    return;
  }

  // カテゴリ別にグループ化
  var categories = {};
  masterRes.items.forEach(function(item) {
    var cat = item.category || "未分類";
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push({
      id: item.id,
      name: item.name,
      sortOrder: item.sortOrder,
      supplyItem: item.supplyItem,
      memo: item.memo
    });
  });

  // カテゴリごとに出力
  var catNames = Object.keys(categories);
  Logger.log("=== チェックリストマスタ (" + masterRes.items.length + "項目, " + catNames.length + "カテゴリ) ===");

  catNames.forEach(function(catName) {
    var items = categories[catName];
    Logger.log("\n【" + catName + "】(" + items.length + "項目)");
    items.forEach(function(item, i) {
      Logger.log("  " + (i+1) + ". " + item.name + (item.supplyItem ? " [要補充]" : "") + (item.memo ? " (" + item.memo + ")" : ""));
    });
  });

  // JSON全体も出力（v2にインポート用）
  Logger.log("\n=== JSON出力 ===");
  Logger.log(JSON.stringify(categories));
}
