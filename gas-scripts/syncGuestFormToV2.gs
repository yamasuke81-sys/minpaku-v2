/**
 * Googleフォーム回答 → 民泊管理v2 宿泊者名簿 自動転記スクリプト
 *
 * 【GAS row[] インデックス (2026-04-19 CSVを直接取得して再確認、全105列)】
 *  0: タイムスタンプ
 *  1: 事前に同意セクション
 *  2: 宿泊者情報入力説明
 *  3: チェックイン / Check-in
 *  4: チェックアウト / Check-out
 *  5: 直前担当
 *  6: 清掃担当
 *  7: 備考
 *  8: 氏名 / Full Name（代表者）
 *  9: 電話番号 / Phone Number
 * 10: メールアドレス / Email Address
 * 11: 住所 / Address
 * 12: 年齢 / Age
 * 13: 国籍 / Nationality
 * 14: 旅券番号
 * 15: パスポート写真
 * 16: 宿泊人数
 * 17: 3才以下乳幼児人数
 * 18-23: 同行者1（氏名,住所,年齢,国籍,旅券番号,パスポート写真）
 * 24-29: 同行者2
 * 30-35: 同行者3
 * 36-41: 同行者4
 * 42-47: 同行者5
 * 48-53: 同行者6
 * 54-59: 同行者7
 * 60-65: 同行者8
 * 66-71: 同行者9 (代表者含めて最大10名)
 * 72: 軽自動車・小型車台数
 * 73: ミニバン以下台数
 * 74: 全長5m級台数
 * 75: 公共交通機関
 * 76: タクシー
 * 77: 駐車しやすい有料駐車場
 * 78: BBQ利用
 * 79: どこで知ったか
 * 80: どこで予約したか (予約サイト)
 * 81: その他詳細
 * 82: 電話番号2（確認用）
 * 83: 大型車の注意説明
 * 84: 旅の目的
 * 85-90: 駐車場利用に関する注記・追加項目
 * 91: 前泊地
 * 92: 後泊地
 * 93: メールアドレス(確認用)
 * 100: 連絡事項
 */

// ===== 設定 =====
var API_URL = "https://api-5qrfx7ujcq-an.a.run.app/guests";
var GAS_SECRET = "minpaku2026secret"; // ← Firestore settings/taxDocs.gasSecret の値

// 宿泊者名簿スプレッドシート ID (新規 Apps Script プロジェクト用。紐付いていないスプシを明示的に指定)
var SPREADSHEET_ID = "1Kk8VZrMQoJwmNk4OZKVQ9riufiCEcVPi_xmYHHnHgCs";

/**
 * フォーム送信時トリガー
 */
function onFormSubmit(e) {
  try {
    var row = e.values;
    if (!row || row.length < 5) return;

    // 日付+時刻を取得 (GAS row: チェックイン=3, チェックアウト=4)
    var ciRaw = row[3] || "";
    var coRaw = row[4] || "";
    var checkIn = fmtDate(ciRaw);
    var checkOut = fmtDate(coRaw);
    var checkInTime = fmtTime(ciRaw);
    var checkOutTime = fmtTime(coRaw);

    // 代表者氏名 = row[8]
    var guestName = (row[8] || "").trim();

    if (!checkIn || !guestName) {
      Logger.log("スキップ: CI=" + checkIn + " 名前=" + guestName);
      return;
    }

    // 代表者情報 (row[9]〜row[17])
    var phone       = (row[9] || "").trim();
    var email       = (row[10] || "").trim();
    var address     = (row[11] || "").trim();
    var age         = (row[12] || "").trim();
    var nationality = (row[13] || "").trim();
    var passport    = (row[14] || "").trim();
    var passportPhoto = (row[15] || "").trim();
    var guestCount     = parseInt(row[16]) || 1;
    var guestCountInfants = parseInt(row[17]) || 0;
    // 電話番号2(確認用)
    var phone2      = (row[82] || "").trim();

    // 同行者（1〜9人: index 18から6列ずつ、代表者含めて最大10名対応）
    var guests = [];
    // 代表者
    guests.push({
      name: guestName, address: address, age: age,
      nationality: nationality, passportNumber: passport,
      passportPhotoUrl: passportPhoto, phone: phone, email: email,
    });

    // 同行者: [18, 24, 30, 36, 42, 48, 54, 60, 66] 最大9人
    var companionStarts = [18, 24, 30, 36, 42, 48, 54, 60, 66];
    for (var i = 0; i < companionStarts.length; i++) {
      var base = companionStarts[i];
      var name = (row[base] || "").trim();
      if (!name) continue;
      guests.push({
        name: name,
        address: (row[base + 1] || "").trim(),
        age: (row[base + 2] || "").trim(),
        nationality: (row[base + 3] || "").trim(),
        passportNumber: (row[base + 4] || "").trim(),
        passportPhotoUrl: (row[base + 5] || "").trim(),
      });
    }

    // 車両情報（72〜77）
    var carKei  = parseCar(row[72]);
    var carMini = parseCar(row[73]);
    var car5m   = parseCar(row[74]);
    var publicTransport = (row[75] || "").trim();
    var taxiUse = (row[76] || "").trim();
    var paidParking = (row[77] || "").trim();

    var carCount = carKei + carMini + car5m;
    var vehicleTypes = [];
    for (var j = 0; j < carKei; j++) vehicleTypes.push("軽自動車・小型車");
    for (var j = 0; j < carMini; j++) vehicleTypes.push("ミニバン以下");
    for (var j = 0; j < car5m; j++) vehicleTypes.push("全長5m級");

    var transport = "";
    if (carCount > 0) transport = "自家用車";
    else if (publicTransport) transport = "公共交通機関";
    else if (taxiUse) transport = "タクシー";

    // その他フィールド
    var bbq         = (row[78] || "").trim();
    var whereLearn  = (row[79] || "").trim();
    var bookingSite = (row[80] || "").trim();
    var otherDetail = (row[81] || "").trim();
    var purpose     = (row[84] || "").trim();
    var prevStay    = (row[91] || "").trim();
    var nextStay    = (row[92] || "").trim();
    var emailConfirm = (row[93] || "").trim();
    var contactNote = (row[100] || "").trim();
    var memo        = (row[7] || "").trim();
    // メール空なら確認用メールで補完
    if (!email && emailConfirm) email = emailConfirm;
    // その他詳細・連絡事項は memo に結合
    if (otherDetail) memo = memo ? memo + "\n" + otherDetail : otherDetail;
    if (contactNote) memo = memo ? memo + "\n" + contactNote : contactNote;

    // API送信データ
    var data = {
      checkIn: checkIn,
      checkOut: checkOut,
      checkInTime: checkInTime,
      checkOutTime: checkOutTime,
      guestName: guestName,
      guestCount: guestCount,
      guestCountInfants: guestCountInfants,
      nationality: nationality,
      phone: phone,
      phone2: phone2,
      email: email,
      address: address,
      passportNumber: passport,
      passportPhotoUrl: passportPhoto,
      guests: guests.slice(1),
      allGuests: guests,
      bookingSite: bookingSite,
      bbq: bbq,
      purpose: purpose,
      whereLearn: whereLearn,
      transport: transport,
      carCount: carCount,
      vehicleTypes: vehicleTypes,
      paidParking: paidParking,
      previousStay: prevStay,
      nextStay: nextStay,
      source: "gas_form_sync",
      memo: memo,
    };

    // v2 APIに送信
    var options = {
      method: "post",
      contentType: "application/json",
      headers: { "Authorization": "Bearer gas-" + GAS_SECRET },
      payload: JSON.stringify(data),
      muteHttpExceptions: true,
    };

    var response = UrlFetchApp.fetch(API_URL, options);
    var status = response.getResponseCode();

    if (status === 201 || status === 200) {
      Logger.log("✅ 転記成功: " + guestName + " " + checkIn + "〜" + checkOut);
    } else {
      Logger.log("❌ 転記エラー: HTTP " + status + " " + response.getContentText());
    }
  } catch (err) {
    Logger.log("❌ 転記例外: " + err.message);
  }
}

/**
 * 日付変換: "Mon Mar 30 2026 15:00:00 GMT+0900" → "2026-03-30"
 * または "2026/10/25 0:00" → "2026-10-25"
 */
function fmtDate(raw) {
  if (!raw) return "";
  var d = new Date(raw);
  if (isNaN(d.getTime())) return "";
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

/**
 * 時刻抽出: "Mon Mar 30 2026 15:00:00 GMT+0900" → "15:00"
 */
function fmtTime(raw) {
  if (!raw) return "";
  var d = new Date(raw);
  if (isNaN(d.getTime())) return "";
  var h = d.getHours();
  var m = d.getMinutes();
  if (h === 0 && m === 0) return ""; // 0:00は時刻なしとみなす
  return pad2(h) + ":" + pad2(m);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * 車台数パース: "1台" → 1, "2台" → 2, "" → 0
 * 念のため上限 20 台で打ち止め (列ずれで日付を誤取得した時の暴発防止)
 */
function parseCar(val) {
  if (!val) return 0;
  var m = String(val).match(/(\d+)/);
  if (!m) return 0;
  var n = parseInt(m[1]);
  if (isNaN(n) || n < 0) return 0;
  if (n > 20) return 0; // 20台超は異常値として 0 扱い
  return n;
}

/**
 * テスト: 最新行を手動転記
 */
function testSyncLatestRow() {
  var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheets()[0];
  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(lastRow, 1, 1, sheet.getLastColumn()).getValues()[0];
  onFormSubmit({ values: values.map(String) });
}

/**
 * CI日範囲を指定して v2 へインポート
 * fromDate / toDate は "YYYY-MM-DD" 形式
 * GASエディタから直接呼ぶ or doGet 経由で v2 フロントから呼ばれる
 */
function syncByCheckInDateRange(fromDate, toDate) {
  var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheets()[0];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { count: 0, message: "データがありません" };
  var values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  var count = 0, skipped = 0, errors = 0;
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var ci = fmtDate(row[3]);
    if (!ci) { skipped++; continue; }
    if (fromDate && ci < fromDate) { skipped++; continue; }
    if (toDate && ci > toDate) { skipped++; continue; }
    try {
      onFormSubmit({ values: row.map(String) });
      count++;
    } catch (e) {
      Logger.log("エラー 行" + (i+2) + ": " + e.message);
      errors++;
    }
  }
  var msg = count + "件インポート / " + skipped + "件スキップ / " + errors + "件エラー";
  Logger.log(msg);
  return { count: count, skipped: skipped, errors: errors, message: msg };
}

/**
 * v2 フロントから呼び出すための Web App エンドポイント
 * デプロイ手順: GASエディタ → デプロイ → 新しいデプロイ → 種類:「ウェブアプリ」
 *   実行ユーザー: 自分、アクセス: 全員
 * URL は Firestore settings/notifications.gasSyncWebAppUrl に保存して使う
 *
 * パラメータ: ?from=YYYY-MM-DD&to=YYYY-MM-DD&secret=...
 */
function doGet(e) {
  try {
    var p = e && e.parameter ? e.parameter : {};
    // 簡易シークレットチェック（GAS_SECRET と同じ値）
    if (p.secret !== GAS_SECRET) {
      return ContentService.createTextOutput(JSON.stringify({ error: "Invalid secret" }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var result = syncByCheckInDateRange(p.from || "", p.to || "");
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * テスト: 指定行番号を転記
 */
function testSyncRow() {
  var rowNum = 2; // ← テストしたい行番号に変更
  var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheets()[0];
  var values = sheet.getRange(rowNum, 1, 1, sheet.getLastColumn()).getValues()[0];
  onFormSubmit({ values: values.map(String) });
}

/**
 * デバッグ: 指定ゲスト名の行の全列を出力
 */
function debugColumns() {
  var sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheets()[0];
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var targetRow = null;
  for (var i = 1; i < data.length; i++) {
    for (var j = 0; j < data[i].length; j++) {
      if (String(data[i][j]).indexOf("角田光琉") >= 0) {
        targetRow = data[i];
        break;
      }
    }
    if (targetRow) break;
  }
  if (!targetRow) { Logger.log("角田光琉が見つかりません"); return; }
  for (var i = 0; i < targetRow.length; i++) {
    var val = String(targetRow[i]).trim();
    if (val && val !== "" && val !== "undefined") {
      var header = String(headers[i] || "").substring(0, 40);
      Logger.log("INDEX " + i + " | " + header + " | " + val.substring(0, 60));
    }
  }
}
