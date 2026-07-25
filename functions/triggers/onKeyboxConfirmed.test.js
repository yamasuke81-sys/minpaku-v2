/**
 * onKeyboxConfirmed の純粋関数の単体テスト
 * 実行: node --test functions/triggers/onKeyboxConfirmed.test.js
 * 副作用なし（Firestore/送信に触れない。純粋関数のみ検証）。
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const handler = require("./onKeyboxConfirmed");
const { otaKindFromSource, extractAirbnbCode, extractBookingResNo } = handler;

describe("onKeyboxConfirmed 純粋関数", () => {
  test("otaKindFromSource は bookings.source を OTA種別に正規化", () => {
    assert.strictEqual(otaKindFromSource("Airbnb"), "airbnb");
    assert.strictEqual(otaKindFromSource("airbnb"), "airbnb");
    assert.strictEqual(otaKindFromSource("Booking.com"), "booking");
    assert.strictEqual(otaKindFromSource("Booking"), "booking");
    assert.strictEqual(otaKindFromSource("direct"), "direct");
    assert.strictEqual(otaKindFromSource(""), null);
    assert.strictEqual(otaKindFromSource(undefined), null);
    assert.strictEqual(otaKindFromSource("なにか別のもの"), null);
  });

  test("extractAirbnbCode は予約URL(details/CODE)から確認コードを取り出す", () => {
    const booking = {
      notes: "Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABCDE123\nGuest: Foo",
    };
    assert.strictEqual(extractAirbnbCode(booking), "HMABCDE123");
  });

  test("extractAirbnbCode は素の HM コードも拾う", () => {
    assert.strictEqual(extractAirbnbCode({ description: "予約 HMXYZ789Q の件" }), "HMXYZ789Q");
    assert.strictEqual(extractAirbnbCode({ icalUid: "HM12AB34CD@airbnb" }), "HM12AB34CD");
  });

  test("extractAirbnbCode は該当なしで空文字", () => {
    assert.strictEqual(extractAirbnbCode({ notes: "Booking.com予約 特になし" }), "");
    assert.strictEqual(extractAirbnbCode({}), "");
  });

  test("extractBookingResNo は emailSubject から予約番号を取り出す", () => {
    assert.strictEqual(
      extractBookingResNo({ emailSubject: "Booking.com - 新しい予約がありました！ (6066243360, 2026年8月7日金曜日)" }),
      "6066243360"
    );
  });

  test("extractBookingResNo は notes の『予約番号NNNN』も拾う／該当なしは空", () => {
    assert.strictEqual(extractBookingResNo({ notes: "Booking.com確定メール(予約番号6720204366, CI ...)" }), "6720204366");
    assert.strictEqual(extractBookingResNo({ notes: "予約番号: 5213274076" }), "5213274076");
    assert.strictEqual(extractBookingResNo({}), "");
  });

  test("モジュールは async ハンドラ関数をエクスポート", () => {
    assert.strictEqual(typeof handler, "function");
  });
});
