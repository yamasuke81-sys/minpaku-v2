/**
 * syncIcal.js 純粋関数の単体テスト (node --test)
 * 実行: npm test
 *
 * 主対象: isPlaceholderBlockResidue — Booking.com CLOSED 等の
 * 「ブロックイベント残骸」を物理削除してよいかの判定。
 * 実予約のキャンセル履歴を誤って true にしないことを固定する。
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const { _pure } = require("./syncIcal");

const { isPlaceholderBlockResidue, isBlockEvent } = _pure;

// ブロック残骸の代表形 (the Terrace で実際に蓄積していた形)
function baseResidue(overrides = {}) {
  return {
    guestName: "Booking.com予約",
    checkIn: "2027-02-01",
    checkOut: "2027-08-17",
    source: "Booking.com",
    syncSource: "ical",
    icalUid: "daily-changing-uid@ical.booking.com",
    status: "cancelled",
    guestCount: 0,
    ...overrides,
  };
}

describe("isPlaceholderBlockResidue: 削除してよい残骸", () => {
  test("Booking.com匿名プレースホルダ (Booking.com予約)", () => {
    assert.strictEqual(isPlaceholderBlockResidue(baseResidue()), true);
  });

  test("Airbnb (Not available) ブロック名", () => {
    assert.strictEqual(
      isPlaceholderBlockResidue(baseResidue({ guestName: "Airbnb (Not available)", source: "Airbnb" })),
      true
    );
  });

  test("CLOSED - Not available (Booking.com summary そのまま)", () => {
    assert.strictEqual(
      isPlaceholderBlockResidue(baseResidue({ guestName: "CLOSED - Not available" })),
      true
    );
  });

  test("ゲスト名が空", () => {
    assert.strictEqual(isPlaceholderBlockResidue(baseResidue({ guestName: "" })), true);
  });

  test("曖昧名 Airbnb / Booking / Booking.com / 予約", () => {
    for (const name of ["Airbnb", "Booking", "Booking.com", "予約", "booking.com予約"]) {
      assert.strictEqual(isPlaceholderBlockResidue(baseResidue({ guestName: name })), true, name);
    }
  });

  test("Reserved (Reservation URL なし = Airbnbブロック)", () => {
    assert.strictEqual(
      isPlaceholderBlockResidue(baseResidue({ guestName: "Reserved", source: "Airbnb", notes: "" })),
      true
    );
  });

  test("status が confirmed でも判定は名前と痕跡のみ (キャンセル検知フェーズでの削除用)", () => {
    assert.strictEqual(isPlaceholderBlockResidue(baseResidue({ status: "confirmed" })), true);
  });
});

describe("isPlaceholderBlockResidue: 絶対に消してはいけないもの", () => {
  test("実名の予約 (日本語/英語)", () => {
    assert.strictEqual(isPlaceholderBlockResidue(baseResidue({ guestName: "山田太郎" })), false);
    assert.strictEqual(isPlaceholderBlockResidue(baseResidue({ guestName: "John Smith" })), false);
  });

  test("名簿リンクあり (guestFormId)", () => {
    assert.strictEqual(
      isPlaceholderBlockResidue(baseResidue({ guestFormId: "abc123" })),
      false
    );
  });

  test("メール照合済み (emailVerifiedAt / emailMessageId / emailMatchedBy)", () => {
    assert.strictEqual(isPlaceholderBlockResidue(baseResidue({ emailVerifiedAt: { seconds: 1 } })), false);
    assert.strictEqual(isPlaceholderBlockResidue(baseResidue({ emailMessageId: "msg1" })), false);
    assert.strictEqual(isPlaceholderBlockResidue(baseResidue({ emailMatchedBy: "auto" })), false);
  });

  test("メールアドレスあり (guestEmail)", () => {
    assert.strictEqual(
      isPlaceholderBlockResidue(baseResidue({ guestEmail: "guest@example.com" })),
      false
    );
  });

  test("手動で confirmed に復元された予約 (manualOverride)", () => {
    assert.strictEqual(isPlaceholderBlockResidue(baseResidue({ manualOverride: true })), false);
  });

  test("人数入力あり (guestCount > 0) は手動編集された予約とみなす", () => {
    assert.strictEqual(isPlaceholderBlockResidue(baseResidue({ guestCount: 2 })), false);
  });

  test("Airbnb実予約 (Reserved + Reservation URL)", () => {
    assert.strictEqual(
      isPlaceholderBlockResidue(baseResidue({
        guestName: "Reserved",
        source: "Airbnb",
        notes: "Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABC123",
      })),
      false
    );
  });

  test("iCal由来でないもの (手動作成・直販)", () => {
    assert.strictEqual(isPlaceholderBlockResidue(baseResidue({ syncSource: "manual" })), false);
    assert.strictEqual(isPlaceholderBlockResidue(baseResidue({ syncSource: undefined })), false);
  });

  test("null / undefined は false", () => {
    assert.strictEqual(isPlaceholderBlockResidue(null), false);
    assert.strictEqual(isPlaceholderBlockResidue(undefined), false);
  });
});

describe("isBlockEvent (既存挙動の固定)", () => {
  test("ブロック名は true", () => {
    for (const s of ["Not available", "Airbnb (Not available)", "CLOSED", "Blocked", "Reserved", "Unavailable"]) {
      assert.strictEqual(isBlockEvent(s), true, s);
    }
  });
  test("実名・空は false", () => {
    assert.strictEqual(isBlockEvent("山田太郎"), false);
    assert.strictEqual(isBlockEvent(""), false);
  });
});
