/**
 * ========================================================
 * 汎用エクスポートスクリプト（全GASアプリ共通）
 * ========================================================
 *
 * このスクリプトを各GASプロジェクトに貼り付けて実行するだけで
 * 紐づいたスプレッドシートの全シートデータをJSON出力します。
 *
 * 対応アプリ:
 *   - 民泊メイン
 *   - 清掃チェックリスト
 *   - チェックイン
 *   - アラーム
 *   - PDFリネーム
 *   - その他、任意のスプレッドシート紐づきGASプロジェクト
 *
 * 使い方:
 *   1. GASエディタで新規スクリプトファイル「migration」を作成
 *   2. このコードを貼り付け
 *   3. exportAll を実行（▶ボタン）
 *   4. ログに出力されたJSONをコピー
 *   5. https://minpaku-v2.web.app/#/settings に貼り付け→インポート
 *
 * 注: スプレッドシートに紐づいていないGASプロジェクト（スタンドアロン型）の場合は
 *     SPREADSHEET_ID に対象スプレッドシートのIDを設定してください。
 */

// スタンドアロン型GASの場合のみ設定（スプレッドシート紐づき型は空でOK）
var SPREADSHEET_ID = '';

function exportAll() {
  var ss;
  if (SPREADSHEET_ID) {
    ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  } else {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  }

  if (!ss) {
    Logger.log('ERROR: スプレッドシートが見つかりません。SPREADSHEET_IDを設定してください。');
    return;
  }

  var result = {
    exportedAt: new Date().toISOString(),
    spreadsheetName: ss.getName(),
    spreadsheetId: ss.getId(),
    spreadsheetUrl: ss.getUrl(),
    appName: _detectAppName(ss),
    sheets: {}
  };

  // 全シートを巡回
  var sheets = ss.getSheets();
  for (var s = 0; s < sheets.length; s++) {
    var sheet = sheets[s];
    var sheetName = sheet.getName();
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();

    if (lastRow < 1 || lastCol < 1) {
      result.sheets[sheetName] = { headers: [], rows: [], rowCount: 0 };
      continue;
    }

    // ヘッダー（1行目）
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) {
      return String(h).trim();
    });

    // データ行（2行目以降）
    var rows = [];
    if (lastRow >= 2) {
      var rawRows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
      for (var r = 0; r < rawRows.length; r++) {
        var row = rawRows[r];
        // 全カラム空の行はスキップ
        var hasData = false;
        for (var c = 0; c < row.length; c++) {
          if (row[c] !== '' && row[c] !== null && row[c] !== undefined) {
            hasData = true;
            break;
          }
        }
        if (!hasData) continue;

        var obj = {};
        for (var c = 0; c < headers.length; c++) {
          var key = headers[c] || ('col_' + (c + 1));
          var val = c < row.length ? row[c] : '';
          // 日付型はISO文字列に変換
          if (val instanceof Date) {
            obj[key] = val.toISOString();
          } else {
            obj[key] = val;
          }
        }
        rows.push(obj);
      }
    }

    result.sheets[sheetName] = {
      headers: headers,
      rows: rows,
      rowCount: rows.length
    };
  }

  // JSON出力
  var json = JSON.stringify(result);

  // サマリーをログに出力
  Logger.log('');
  Logger.log('====================================');
  Logger.log('エクスポート完了: ' + result.spreadsheetName);
  Logger.log('アプリ種別: ' + result.appName);
  Logger.log('====================================');
  var sheetNames = Object.keys(result.sheets);
  for (var i = 0; i < sheetNames.length; i++) {
    var name = sheetNames[i];
    Logger.log('  ' + name + ': ' + result.sheets[name].rowCount + '行');
  }
  Logger.log('====================================');
  Logger.log('合計JSONサイズ: ' + json.length + '文字');
  Logger.log('');

  // JSON本体を分割出力（GASログの文字数制限対策）
  Logger.log('===== JSON START =====');
  var CHUNK = 50000;
  for (var i = 0; i < json.length; i += CHUNK) {
    Logger.log(json.substring(i, i + CHUNK));
  }
  Logger.log('===== JSON END =====');

  // PropertiesServiceにも保存（500KB以下の場合）
  try {
    if (json.length < 500000) {
      PropertiesService.getScriptProperties().setProperty('migrationData', json);
      Logger.log('PropertiesServiceにも保存しました。');
    } else {
      Logger.log('JSONサイズが大きいため、ログからコピーしてください。');
    }
  } catch (e) {
    Logger.log('PropertiesService保存エラー（無視可）: ' + e.toString());
  }

  return json;
}

/**
 * スプレッドシートの内容からアプリ種別を自動判定
 */
function _detectAppName(ss) {
  var sheetNames = ss.getSheets().map(function(s) { return s.getName(); });

  // 民泊メイン
  if (sheetNames.indexOf('フォームの回答 1') >= 0 && sheetNames.indexOf('募集') >= 0) {
    return 'minpaku-main';
  }
  // チェックリスト
  if (sheetNames.indexOf('チェックリストマスタ') >= 0 || sheetNames.indexOf('チェックリスト記録') >= 0) {
    return 'checklist';
  }
  // チェックイン
  if (sheetNames.some(function(n) { return n.indexOf('チェックイン') >= 0; })) {
    return 'checkin';
  }
  // PDFリネーム
  if (sheetNames.some(function(n) { return n.indexOf('PDF') >= 0 || n.indexOf('リネーム') >= 0; })) {
    return 'pdf-rename';
  }
  // アラーム
  if (sheetNames.some(function(n) { return n.indexOf('アラーム') >= 0 || n.indexOf('通知') >= 0; })) {
    return 'alarm';
  }

  return 'unknown';
}
