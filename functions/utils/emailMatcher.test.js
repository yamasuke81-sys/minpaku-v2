/**
 * emailMatcher 単体テスト (node --test)
 * 実行: npm test
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const {
  findBookingMatch,
  decideBookingUpdate,
  decideVerificationStatus,
  _normalizeCheckInDate,
} = require("./emailMatcher");

// ======================================================
// findBookingMatch
// ======================================================

describe("findBookingMatch: icalUid 部分一致", () => {
  const bookings = [
    { id: "ical_HMH2KHHTF5_airbnb_com", data: { icalUid: "HMH2KHHTF5@airbnb.com", source: "Airbnb" } },
    { id: "ical_other", data: { icalUid: "OTHER@airbnb.com", source: "Airbnb" } },
    { id: "ical_booking_5750794035", data: { icalUid: "5750794035@booking.com", source: "Booking.com" } },
  ];

  test("Airbnb 確認コードで一致 (icalUid 内)", () => {
    const r = findBookingMatch(bookings, { reservationCode: "HMH2KHHTF5" });
    assert.strictEqual(r.id, "ical_HMH2KHHTF5_airbnb_com");
    assert.strictEqual(r.matchReason, "codeInHaystack");
  });

  test("Booking.com 予約 ID で一致", () => {
    const r = findBookingMatch(bookings, { reservationCode: "5750794035" });
    assert.strictEqual(r.id, "ical_booking_5750794035");
  });

  test("大小文字無視", () => {
    const r = findBookingMatch(bookings, { reservationCode: "hmh2khhtf5" });
    assert.ok(r);
  });

  test("該当なしは null", () => {
    assert.strictEqual(findBookingMatch(bookings, { reservationCode: "HMNOMATCH" }), null);
  });

  test("空配列は null", () => {
    assert.strictEqual(findBookingMatch([], { reservationCode: "X" }), null);
  });

  test("parsedInfo なしは null", () => {
    assert.strictEqual(findBookingMatch(bookings, null), null);
  });
});

describe("findBookingMatch: beds24BookingId 完全一致", () => {
  const bookings = [
    { id: "b1", data: { beds24BookingId: "12345", source: "Airbnb" } },
  ];

  test("beds24 の ID で一致", () => {
    const r = findBookingMatch(bookings, { reservationCode: "12345" });
    assert.strictEqual(r.matchReason, "beds24BookingId");
  });
});

describe("findBookingMatch: 日付 + platform フォールバック", () => {
  const bookings = [
    {
      id: "ical_only_date",
      data: { icalUid: "xyz@airbnb.com", source: "Airbnb", propertyId: "p1", checkIn: "2026-05-04" },
    },
    {
      id: "different_platform",
      data: { icalUid: "def@booking.com", source: "Booking.com", propertyId: "p1", checkIn: "2026-05-04" },
    },
  ];

  test("reservationCode なし、platform + checkIn で一致", () => {
    const r = findBookingMatch(bookings, {
      platform: "Airbnb",
      checkIn: { date: "2026-05-04" },
    });
    assert.strictEqual(r.id, "ical_only_date");
    assert.strictEqual(r.matchReason, "dateAndPlatform");
  });

  test("propertyIdHint でさらに絞り込み", () => {
    const r = findBookingMatch(
      bookings,
      { platform: "Booking.com", checkIn: { date: "2026-05-04" } },
      "p1"
    );
    assert.strictEqual(r.id, "different_platform");
  });

  test("propertyIdHint 不一致は除外", () => {
    const r = findBookingMatch(
      bookings,
      { platform: "Airbnb", checkIn: { date: "2026-05-04" } },
      "p-other"
    );
    assert.strictEqual(r, null);
  });
});

describe("_normalizeCheckInDate", () => {
  test("YYYY-MM-DD 文字列", () => {
    assert.strictEqual(_normalizeCheckInDate("2026-05-04"), "2026-05-04");
    assert.strictEqual(_normalizeCheckInDate("2026-05-04T15:00:00+09:00"), "2026-05-04");
  });
  test("Date オブジェクト", () => {
    assert.strictEqual(
      _normalizeCheckInDate(new Date(2026, 4, 4, 15, 0, 0)),
      "2026-05-04"
    );
  });
  test("Firestore Timestamp ライク (toDate)", () => {
    const mockTs = { toDate: () => new Date(2026, 4, 4, 15, 0, 0) };
    assert.strictEqual(_normalizeCheckInDate(mockTs), "2026-05-04");
  });
  test("Firestore Timestamp ライク (_seconds)", () => {
    // 2026-05-04 00:00:00 JST ≒ 2026-05-03 15:00:00 UTC
    const ts = { _seconds: new Date(2026, 4, 4, 0, 0, 0).getTime() / 1000 };
    assert.strictEqual(_normalizeCheckInDate(ts), "2026-05-04");
  });
  test("null / 不正値は null", () => {
    assert.strictEqual(_normalizeCheckInDate(null), null);
    assert.strictEqual(_normalizeCheckInDate(undefined), null);
    assert.strictEqual(_normalizeCheckInDate("invalid"), null);
    assert.strictEqual(_normalizeCheckInDate({}), null);
  });
});

// ======================================================
// decideBookingUpdate
// ======================================================

describe("decideBookingUpdate: confirmed メール + 既存 iCal 予約", () => {
  test("generic な iCal guestName は上書き", () => {
    const booking = {
      guestName: "Airbnb (Not available)",
      _icalOriginalName: "Airbnb (Not available)",
      guestCount: 0,
      status: "confirmed",
    };
    const parsedInfo = {
      kind: "confirmed",
      guestName: "テスト太郎 山田",
      guestFirstName: "テスト太郎",
      guestCount: { adults: 4, children: 2, infants: 0, total: 6 },
    };
    const { updates } = decideBookingUpdate(booking, parsedInfo, "msg123", Date.now());
    assert.strictEqual(updates.guestName, "テスト太郎 山田");
    assert.strictEqual(updates.guestCount, 6);
    assert.strictEqual(updates.emailMessageId, "msg123");
    assert.ok(updates.emailVerifiedAt);
  });

  test("CLOSED - Not available も generic 扱いで上書き", () => {
    const booking = {
      guestName: "CLOSED - Not available",
      _icalOriginalName: "CLOSED - Not available",
    };
    const { updates } = decideBookingUpdate(booking, { guestName: "Masanori Matsuura", kind: "confirmed" }, "m1", Date.now());
    assert.strictEqual(updates.guestName, "Masanori Matsuura");
  });

  test("手動編集済みゲスト名は保持 (上書きしない)", () => {
    const booking = {
      guestName: "田中太郎 (手動編集)",
      _icalOriginalName: "Airbnb (Not available)", // 元の iCal 値
    };
    const { updates } = decideBookingUpdate(
      booking,
      { guestName: "Different Name", kind: "confirmed" },
      "m1",
      Date.now()
    );
    assert.strictEqual(updates.guestName, undefined); // 上書きしない
  });

  test("既存 guestCount>0 は上書きしない", () => {
    const booking = { guestCount: 2 };
    const { updates } = decideBookingUpdate(
      booking,
      { guestCount: { total: 5 }, kind: "confirmed" },
      "m1",
      Date.now()
    );
    assert.strictEqual(updates.guestCount, undefined);
  });

  test("parsedInfo に guestCount なしの場合は何もしない", () => {
    const booking = { guestCount: 0 };
    const { updates } = decideBookingUpdate(booking, { kind: "confirmed" }, "m1", Date.now());
    assert.strictEqual(updates.guestCount, undefined);
  });

  test("guestName / guestFirstName どちらも null ならゲスト名更新なし", () => {
    const booking = { guestName: "Airbnb (Not available)", _icalOriginalName: "Airbnb (Not available)" };
    const { updates } = decideBookingUpdate(booking, { kind: "confirmed" }, "m1", Date.now());
    assert.strictEqual(updates.guestName, undefined);
  });

  test("guestFirstName のみあれば fallback で使う", () => {
    const booking = { guestName: "", _icalOriginalName: "" };
    const { updates } = decideBookingUpdate(
      booking,
      { kind: "confirmed", guestFirstName: "Taro" },
      "m1",
      Date.now()
    );
    assert.strictEqual(updates.guestName, "Taro");
  });

  test("最新勝ち: 古いメールはスキップ", () => {
    const now = Date.now();
    const booking = {
      guestName: "Generic",
      _icalOriginalName: "Generic",
      emailVerifiedAt: { toMillis: () => now },
    };
    const { updates, skippedReason } = decideBookingUpdate(
      booking,
      { kind: "confirmed", guestName: "Old Email" },
      "m1",
      now - 10000 // 10 秒前のメール
    );
    assert.strictEqual(updates, null);
    assert.ok(skippedReason && skippedReason.includes("古いメール"));
  });

  test("最新勝ち: 新しいメールは通る", () => {
    const booking = {
      guestName: "Generic",
      _icalOriginalName: "Generic",
      emailVerifiedAt: { toMillis: () => Date.now() - 60000 },
    };
    const { updates } = decideBookingUpdate(
      booking,
      { kind: "confirmed", guestName: "New Email" },
      "m1",
      Date.now()
    );
    assert.ok(updates);
    assert.strictEqual(updates.guestName, "New Email");
  });
});

describe("decideBookingUpdate: cancelled メール", () => {
  test("manualOverride=false なら status=cancelled", () => {
    const booking = { status: "confirmed", manualOverride: false };
    const { updates } = decideBookingUpdate(booking, { kind: "cancelled" }, "m1", Date.now());
    assert.strictEqual(updates.status, "cancelled");
    assert.strictEqual(updates.cancelSource, "email");
  });

  test("manualOverride=true は保護、status 変更せず note のみ残す", () => {
    const booking = { status: "confirmed", manualOverride: true };
    const { updates } = decideBookingUpdate(booking, { kind: "cancelled" }, "m1", Date.now());
    assert.strictEqual(updates.status, undefined);
    assert.ok(updates._emailVerificationNote);
    assert.ok(updates._emailVerificationNote.includes("manualOverride"));
  });

  test("既に cancelled なら status 再設定しない", () => {
    const booking = { status: "cancelled" };
    const { updates } = decideBookingUpdate(booking, { kind: "cancelled" }, "m1", Date.now());
    assert.strictEqual(updates.status, undefined);
  });
});

describe("decideBookingUpdate: 異常系", () => {
  test("booking / parsedInfo どちらか null なら skippedReason", () => {
    const r1 = decideBookingUpdate(null, { kind: "confirmed" }, "m1");
    assert.strictEqual(r1.updates, null);
    assert.ok(r1.skippedReason);
    const r2 = decideBookingUpdate({}, null, "m1");
    assert.strictEqual(r2.updates, null);
  });
});

// ======================================================
// decideVerificationStatus
// ======================================================

describe("decideVerificationStatus", () => {
  test("confirmed + matched → 'matched'", () => {
    assert.strictEqual(
      decideVerificationStatus({ kind: "confirmed" }, { id: "x" }),
      "matched"
    );
  });
  test("confirmed + unmatched → 'unmatched'", () => {
    assert.strictEqual(decideVerificationStatus({ kind: "confirmed" }, null), "unmatched");
  });
  test("cancelled + matched → 'cancelled'", () => {
    assert.strictEqual(
      decideVerificationStatus({ kind: "cancelled" }, { id: "x" }),
      "cancelled"
    );
  });
  test("cancelled + unmatched → 'cancelled-unmatched'", () => {
    assert.strictEqual(
      decideVerificationStatus({ kind: "cancelled" }, null),
      "cancelled-unmatched"
    );
  });
  test("change-approved / change-request → 'changed'", () => {
    assert.strictEqual(
      decideVerificationStatus({ kind: "change-approved" }, { id: "x" }),
      "changed"
    );
    assert.strictEqual(
      decideVerificationStatus({ kind: "change-request" }, { id: "x" }),
      "changed"
    );
  });
  test("parsedInfo null → 'pending'", () => {
    assert.strictEqual(decideVerificationStatus(null, null), "pending");
  });
});
