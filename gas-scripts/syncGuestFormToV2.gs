/**
 * Googleフォーム回答 → 民泊管理v2 宿泊者名簿 自動転記スクリプト
 *
 * 【実際の列インデックス（debugColumnsで確認済み）】
 *  0: タイムスタンプ
 *  3: チェックイン（日時）  例: "Mon Mar 30 2026 15:00:00"
 *  4: チェックアウト（日時）例: "Tue Mar 31 2026 10:00:00"
 *  7: 備考
 *  8: 氏名（代表者）
 *  9: 電話番号1
 * 10: メールアドレス
 * 11: 住所
 * 12: 年齢
 * 13: 国籍
 * 14: 旅券番号
 * 15: パスポート写真
 * 16: 宿泊人数
 * 17: 乳幼児人数
 * 42〜: 同行者（6列ずつ: 氏名,住所,年齢,国籍,旅券番号,パスポート写真）
 *        ゲスト2=42, ゲスト3=48, ゲスト4=54, ゲスト5=60, ゲスト6=66
 * 72: 軽自動車・小型車台数
 * 73: ミニバン以下台数
 * 74: 全長5m級台数
 * 75: 公共交通機関
 * 76: タクシー
 * 78: BBQ利用
 * 79: どこで知ったか
 * 80: 予約サイト
 * 82: 電話番号2
 * 84: 旅の目的
 * 86: ベッド数選択（存在する場合）
 * 89: 有料駐車場
 * 90: 前泊地（存在する場合）
 * 91: 後泊地（存在する場合）
 * 93: メールアドレス（確認用）
 * 100: 連絡事項
 */

// ===== 設定 =====
var API_URL = "https://api-5qrfx7ujcq-an.a.run.app/guests";
var GAS_SECRET = "minpaku2026secret"; // ← Firestore settings/taxDocs.gasSecret の値

/**
 * フォーム送信時トリガー
 */
function onFormSubmit(e) {
  try {
    var row = e.values;
    if (!row || row.length < 5) return;

    // 日付+時刻を取得
    var ciRaw = row[3] || "";
    var coRaw = row[4] || "";
    var checkIn = fmtDate(ciRaw);
    var checkOut = fmtDate(coRaw);
    var checkInTime = fmtTime(ciRaw);
    var checkOutTime = fmtTime(coRaw);

    var guestName = (row[8] || "").trim();

    if (!checkIn || !guestName) {
      Logger.log("スキップ: CI=" + checkIn + " 名前=" + guestName);
      return;
    }

    // 代表者情報
    var phone       = (row[9] || "").trim();
    var email       = (row[10] || "").trim();
    var address     = (row[11] || "").trim();
    var age         = (row[12] || "").trim();
    var nationality = (row[13] || "").trim();
    var passport    = (row[14] || "").trim();
    var passportPhoto = (row[15] || "").trim();
    var guestCount     = parseInt(row[16]) || 1;
    var guestCountInfants = parseInt(row[17]) || 0;
    var phone2      = (row[82] || "").trim();
    var emailConfirm = (row[93] || "").trim();

    // メールが空なら確認用メールを使用
    if (!email && emailConfirm) email = emailConfirm;

    // 同行者（ゲスト2〜6: index 42から6列ずつ）
    var guests = [];
    // 代表者
    guests.push({
      name: guestName, address: address, age: age,
      nationality: nationality, passportNumber: passport,
      passportPhotoUrl: passportPhoto, phone: phone, email: email,
    });

    // 同行者: 42, 48, 54, 60, 66（最大5名追加）
    var companionStarts = [42, 48, 54, 60, 66];
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

    // 車両情報（72〜76）
    var carKei  = parseCar(row[72]);
    var carMini = parseCar(row[73]);
    var car5m   = parseCar(row[74]);
    var publicTransport = (row[75] || "").trim();
    var taxiUse = (row[76] || "").trim();

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
    var bookingSite = (row[80] || "").trim();
    var purpose     = (row[84] || "").trim();
    var bedChoice   = (row[86] || "").trim();
    var paidParking = (row[89] || "").trim();
    var prevStay    = (row[90] || "").trim();
    var nextStay    = (row[91] || "").trim();
    var memo        = (row[7] || "").trim();
    var contactNote = (row[100] || "").trim();
    if (contactNote && memo) memo += "\n" + contactNote;
    else if (contactNote) memo = contactNote;

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
      bedChoice: bedChoice,
      purpose: purpose,
      previousStay: prevStay,
      nextStay: nextStay,
      transport: transport,
      carCount: carCount,
      vehicleTypes: vehicleTypes,
      paidParking: paidParking,
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
 */
function parseCar(val) {
  if (!val) return 0;
  var m = String(val).match(/(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

/**
 * テスト: 最新行を手動転記
 */
function testSyncLatestRow() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
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
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
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
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var values = sheet.getRange(rowNum, 1, 1, sheet.getLastColumn()).getValues()[0];
  onFormSubmit({ values: values.map(String) });
}

/**
 * デバッグ: 指定ゲスト名の行の全列を出力
 */
function debugColumns() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
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
