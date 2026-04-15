/**
 * Googleフォーム回答 → 民泊管理v2 宿泊者名簿 自動転記スクリプト
 *
 * 【設定手順】
 * 1. GASのスクリプトエディタ（スプレッドシート → 拡張機能 → Apps Script）にこのコードを貼り付け
 * 2. GAS_SECRET を設定（Firestoreの settings/taxDocs → gasSecret の値）
 * 3. トリガーを設定:
 *    → 左メニュー「トリガー」→「+ トリガーを追加」
 *    → 関数: onFormSubmit
 *    → イベントのソース: スプレッドシートから
 *    → イベントの種類: フォーム送信時
 *
 * 【列マッピング】（0始まりインデックス）
 *  0: タイムスタンプ
 *  3: チェックイン / Check-in
 *  4: チェックアウト / Check-out
 *  7: 備考
 *  8: 氏名（代表者）
 *  9: 電話番号
 * 10: メールアドレス
 * 11: 住所
 * 12: 年齢
 * 13: 国籍
 * 14: 旅券番号
 * 15: パスポート写真
 * 16: 宿泊人数
 * 17: 乳幼児人数
 * 18〜: ゲスト2〜10（6列ずつ: 氏名,住所,年齢,国籍,旅券番号,パスポート写真）
 * 74: 軽自動車・小型車台数
 * 75: ミニバン以下台数
 * 76: 全長5m級台数
 * 77: 公共交通機関
 * 78: タクシー
 * 79: 有料駐車場
 * 80: BBQ利用
 * 82: 予約サイト
 * 86: 旅の目的
 * 88: ベッド数選択
 * 90: その他の車
 * 93: 前泊地
 * 94: 後泊地
 */

// ===== 設定 =====
const API_URL = "https://api-5qrfx7ujcq-an.a.run.app/guests";
const GAS_SECRET = ""; // ← Firestore settings/taxDocs.gasSecret の値を入れる

/**
 * フォーム送信時トリガー
 */
function onFormSubmit(e) {
  try {
    const row = e.values;
    if (!row || row.length < 5) return;

    const checkIn  = fmtDate(row[3] || "");
    const checkOut = fmtDate(row[4] || "");
    const guestName = (row[8] || "").trim();

    if (!checkIn || !guestName) {
      Logger.log("スキップ: CI=" + checkIn + " 名前=" + guestName);
      return;
    }

    // 代表者情報
    const phone       = (row[9] || "").trim();
    const email       = (row[10] || "").trim();
    const address     = (row[11] || "").trim();
    const age         = (row[12] || "").trim();
    const nationality = (row[13] || "").trim();
    const passport    = (row[14] || "").trim();
    const passportPhoto = (row[15] || "").trim();
    const guestCount     = parseInt(row[16]) || 1;
    const guestCountInfants = parseInt(row[17]) || 0;

    // 同行者（ゲスト2〜10: index 18から6列ずつ）
    const guests = [];
    guests.push({
      name: guestName, address: address, age: age,
      nationality: nationality, passportNumber: passport,
      passportPhotoUrl: passportPhoto, phone: phone, email: email,
    });

    for (var i = 0; i < 9; i++) {
      var base = 18 + i * 6;
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

    // 車両情報（index 74〜79）
    var carKei  = parseInt(row[74]) || 0;
    var carMini = parseInt(row[75]) || 0;
    var car5m   = parseInt(row[76]) || 0;
    var publicTransport = (row[77] || "").trim();
    var taxiUse = (row[78] || "").trim();
    var paidParking = (row[79] || "").trim();
    var otherCar = (row[90] || "").trim();

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
    var bbq       = (row[80] || "").trim();
    var bookingSite = (row[82] || "").trim();
    var purpose   = (row[86] || "").trim();
    var bedChoice = (row[88] || "").trim();
    var prevStay  = (row[93] || "").trim();
    var nextStay  = (row[94] || "").trim();
    var memo      = (row[7] || "").trim();

    // API送信データ
    var data = {
      checkIn: checkIn,
      checkOut: checkOut,
      guestName: guestName,
      guestCount: guestCount,
      guestCountInfants: guestCountInfants,
      nationality: nationality,
      phone: phone,
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
 * 日付変換: "2026/10/25 0:00" → "2026-10-25"
 */
function fmtDate(raw) {
  if (!raw) return "";
  var d = new Date(raw);
  if (isNaN(d.getTime())) return "";
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
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
 * テスト: 指定行番号を転記
 */
function testSyncRow() {
  var rowNum = 2; // ← テストしたい行番号に変更
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var values = sheet.getRange(rowNum, 1, 1, sheet.getLastColumn()).getValues()[0];
  onFormSubmit({ values: values.map(String) });
}
