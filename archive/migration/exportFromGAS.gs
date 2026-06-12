/**
 * データ移行ツール — 全データエクスポート
 *
 * 使い方:
 * 1. 既存のminpaku-fixスプレッドシートのGASエディタにこのファイルを追加
 * 2. exportAllForMigration() を実行
 * 3. ログに出力されたJSONをコピー
 * 4. 民泊管理v2の「設定」→「データ移行」→ JSON貼り付け → インポート実行
 */

function exportAllForMigration() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var result = { exportedAt: new Date().toISOString() };

  // ===== 1. 清掃スタッフ =====
  result.staff = readSheet_(ss, '清掃スタッフ', [
    'name', 'address', 'email', 'bankName', 'branchName',
    'accountType', 'accountNumber', 'accountHolder', 'active'
  ]);

  // ===== 2. 予約データ（フォームの回答 1） =====
  result.bookings = readSheetDynamic_(ss, 'フォームの回答 1');

  // ===== 3. 募集 =====
  result.recruitments = readSheet_(ss, '募集', [
    'checkOutDate', 'bookingRowNum', 'notifyDate', 'status',
    'selectedStaff', 'reminderLastDate', 'createdDate', 'bookingId',
    'notifyMethod', 'bookingDate', 'bookingCount', 'bookingBBQ',
    'bookingNationality', 'memo'
  ]);

  // ===== 4. 募集_立候補 =====
  result.volunteers = readSheet_(ss, '募集_立候補', [
    'recruitId', 'staffName', 'email', 'volunteerDate',
    'availability', 'status', 'holdReason'
  ]);

  // ===== 5. スタッフ報酬 =====
  result.rewards = readSheet_(ss, 'スタッフ報酬', [
    'staffName', 'jobType', 'amount', 'memo'
  ]);

  // ===== 6. 仕事内容マスタ =====
  result.jobTypes = readSheet_(ss, '仕事内容マスタ', [
    'jobName', 'displayOrder', 'active'
  ]);

  // ===== 7. 特別料金 =====
  result.specialRates = readSheet_(ss, '特別料金', [
    'jobName', 'startDate', 'endDate', 'itemName', 'additionalAmount'
  ]);

  // ===== 8. 募集設定 =====
  result.recruitSettings = readKeyValue_(ss, '募集設定');

  // ===== 9. 設定_オーナー =====
  result.ownerSettings = readKeyValue_(ss, '設定_オーナー');

  // ===== 10. 設定_連携（iCal URL等） =====
  result.syncSettings = readSheet_(ss, '設定_連携', [
    'platform', 'icalUrl', 'active', 'lastSync'
  ]);

  // ===== 11. スタッフ共有用 =====
  result.staffShare = readSheetDynamic_(ss, 'スタッフ共有用');

  // ===== 12. 通知履歴 =====
  result.notifications = readSheet_(ss, '通知履歴', [
    'datetime', 'type', 'content', 'read'
  ]);

  // ===== 13. キャンセル申請 =====
  result.cancelRequests = readSheet_(ss, 'キャンセル申請', [
    'recruitId', 'staffName', 'email', 'requestDate'
  ]);

  // ===== 14. ベッド数マスタ =====
  result.bedCounts = readSheetDynamic_(ss, 'ベッド数マスタ');

  // ===== チェックリスト関連 =====
  result.checklistMaster = readSheetDynamic_(ss, 'チェックリストマスタ');
  result.photoSpots = readSheetDynamic_(ss, '撮影箇所マスタ');
  result.checklistRecords = readSheetDynamic_(ss, 'チェックリスト記録');
  result.checklistPhotos = readSheetDynamic_(ss, 'チェックリスト写真');
  result.supplyRecords = readSheetDynamic_(ss, '要補充記録');

  var json = JSON.stringify(result);

  // ログ出力（分割）
  Logger.log('===== MIGRATION START =====');
  var chunk = 50000;
  for (var i = 0; i < json.length; i += chunk) {
    Logger.log(json.substring(i, i + chunk));
  }
  Logger.log('===== MIGRATION END =====');

  // PropertiesServiceにも保存（大きすぎなければ）
  if (json.length < 500000) {
    PropertiesService.getScriptProperties().setProperty('migrationData', json);
    Logger.log('PropertiesServiceにも保存しました。getMigrationData()でWeb経由で取得可能です。');
  }

  return json;
}

/**
 * Web経由でエクスポートデータを取得するエンドポイント
 * GASのWebアプリとしてデプロイして使う（オプション）
 */
function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'export') {
    var data = PropertiesService.getScriptProperties().getProperty('migrationData');
    if (data) {
      return ContentService.createTextOutput(data).setMimeType(ContentService.MimeType.JSON);
    }
  }
  return ContentService.createTextOutput('No data. Run exportAllForMigration() first.');
}

// ===== ユーティリティ =====

/**
 * シートデータを指定カラム名で読み取り
 */
function readSheet_(ss, sheetName, colNames) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];

  var lastRow = sheet.getLastRow();
  var maxCol = Math.min(colNames.length, sheet.getLastColumn());
  var rows = sheet.getRange(2, 1, lastRow - 1, maxCol).getValues();

  return rows.map(function(row) {
    var obj = {};
    for (var i = 0; i < colNames.length; i++) {
      var val = i < row.length ? row[i] : '';
      // 日付はISO文字列に
      if (val instanceof Date) {
        obj[colNames[i]] = val.toISOString();
      } else {
        obj[colNames[i]] = val;
      }
    }
    return obj;
  }).filter(function(obj) {
    // 全カラムが空でないもの
    return Object.values(obj).some(function(v) { return v !== '' && v !== null && v !== undefined; });
  });
}

/**
 * ヘッダーを動的に読み取り
 */
function readSheetDynamic_(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) {
    return String(h).trim();
  });
  var rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  return rows.map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) {
      if (!h) return;
      var val = row[i];
      if (val instanceof Date) {
        obj[h] = val.toISOString();
      } else {
        obj[h] = val;
      }
    });
    return obj;
  }).filter(function(obj) {
    return Object.values(obj).some(function(v) { return v !== '' && v !== null && v !== undefined && v !== 0; });
  });
}

/**
 * キー・値形式のシートを読み取り（設定系）
 */
function readKeyValue_(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return {};

  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  var obj = {};
  rows.forEach(function(row) {
    var key = String(row[0]).trim();
    if (key) obj[key] = row[1];
  });
  return obj;
}
