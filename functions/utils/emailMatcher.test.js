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
  isChangeNotifyKind,
  computeRosterTotals,
  buildChangeEmailNotification,
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

  test("reservationCode なし、platform + checkIn + propertyIdHint で一致", () => {
    const r = findBookingMatch(
      bookings,
      { platform: "Airbnb", checkIn: { date: "2026-05-04" } },
      "p1"
    );
    assert.strictEqual(r.id, "ical_only_date");
    assert.strictEqual(r.matchReason, "dateAndPlatform");
  });

  test("物件ヒント無しは日付フォールバックしない(物件跨ぎ誤照合防止)", () => {
    // propertyIdHint を渡さないと source+日付だけの弱いマッチは採用しない(2026-07-09)
    const r = findBookingMatch(bookings, {
      platform: "Airbnb",
      checkIn: { date: "2026-05-04" },
    });
    assert.strictEqual(r, null);
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
  test("confirmed + unmatched (手がかりあり) → 'unmatched'", () => {
    // 予約番号 or チェックイン日があれば再評価で後追い可能 → unmatched
    assert.strictEqual(
      decideVerificationStatus({ kind: "confirmed", reservationCode: "HMXXXX" }, null),
      "unmatched"
    );
    assert.strictEqual(
      decideVerificationStatus({ kind: "confirmed", checkIn: { date: "2026-08-14" } }, null),
      "unmatched"
    );
  });
  test("手がかり無し(予約番号もCIも無い)未照合 → 'ignored'", () => {
    // メッセージスレッド等、永久に照合不能なノイズは終端化して再評価プールに入れない
    assert.strictEqual(decideVerificationStatus({ kind: "confirmed" }, null), "ignored");
    assert.strictEqual(decideVerificationStatus({ kind: "unknown" }, null), "ignored");
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

// ======================================================
// Airbnb 変更メール通知の判定/組立
// ======================================================

describe("isChangeNotifyKind", () => {
  test("change-approved / change-request のみ true", () => {
    assert.strictEqual(isChangeNotifyKind("change-approved"), true);
    assert.strictEqual(isChangeNotifyKind("change-request"), true);
    assert.strictEqual(isChangeNotifyKind("confirmed"), false);
    assert.strictEqual(isChangeNotifyKind("cancelled"), false);
    assert.strictEqual(isChangeNotifyKind(undefined), false);
  });
});

describe("computeRosterTotals", () => {
  test("空配列/undefined は 0 集計", () => {
    assert.deepStrictEqual(computeRosterTotals([]), {
      total: 0, adults: 0, children: 0, infants: 0, count: 0,
    });
    assert.deepStrictEqual(computeRosterTotals(undefined), {
      total: 0, adults: 0, children: 0, infants: 0, count: 0,
    });
  });
  test("複数レコード合算 (乳幼児は total に含めない)", () => {
    const r = computeRosterTotals([
      { numAdults: 2, numChildren: 1, numInfants: 1 },
      { numAdults: 3, numChildren: 0, numInfants: 0 },
    ]);
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.adults, 5);
    assert.strictEqual(r.children, 1);
    assert.strictEqual(r.infants, 1);
    assert.strictEqual(r.total, 6); // 大人5 + 子ども1
  });
  test("欠損フィールドは 0 として集計", () => {
    const r = computeRosterTotals([{}]);
    assert.strictEqual(r.total, 0);
    assert.strictEqual(r.count, 1);
  });
});

describe("buildChangeEmailNotification", () => {
  const parsedApproved = {
    kind: "change-approved",
    reservationCode: "HMJZRZ4C99",
    guestName: "美月山田",
  };
  const parsedRequest = {
    kind: "change-request",
    guestName: "Roxmara",
  };
  const booking = {
    propertyName: "the Terrace 長浜",
    guestName: "8月18日に美月山田",
    checkIn: "2026-08-18",
    checkOut: "2026-08-19",
    guestCount: 4,
  };

  test("change-approved: 名簿一致 → mismatch=false", () => {
    const roster = [{ numAdults: 3, numChildren: 1, numInfants: 0 }];
    const n = buildChangeEmailNotification(parsedApproved, booking, roster, {});
    assert.strictEqual(n.hasMismatch, false);
    assert.ok(n.body.includes("予約変更が承認されました"));
    assert.ok(n.body.includes("HMJZRZ4C99"));
    assert.ok(n.body.includes("2026-08-18 〜 2026-08-19"));
    assert.ok(n.body.includes("予約の登録人数: 4人"));
    assert.ok(n.body.includes("名簿の申告人数: 合計4人"));
    assert.ok(!n.body.includes("食い違い"));
    assert.strictEqual(n.vars.mismatch, "");
    assert.strictEqual(n.vars.roster_total, "4");
  });

  test("change-approved: 名簿人数が違う → mismatch=true + ⚠️", () => {
    const roster = [{ numAdults: 5, numChildren: 0, numInfants: 0 }];
    const n = buildChangeEmailNotification(parsedApproved, booking, roster, {});
    assert.strictEqual(n.hasMismatch, true);
    assert.ok(n.body.includes("⚠️ 名簿との食い違いあり"));
    assert.ok(n.body.includes("予約=4人 / 名簿=5人"));
    assert.strictEqual(n.vars.mismatch, "1");
  });

  test("change-request: 「予約変更希望」ラベルで組立", () => {
    const n = buildChangeEmailNotification(parsedRequest, null, [], { propertyName: "テラス" });
    assert.ok(n.body.includes("予約変更希望が届きました"));
    assert.ok(n.body.includes("Roxmara"));
    assert.ok(n.body.includes("名簿の申告人数: 未入力"));
    assert.ok(n.title.includes("予約変更希望"));
  });

  test("bookingData null でも動作 (unmatched でも通知は組める)", () => {
    const n = buildChangeEmailNotification(parsedApproved, null, [], { propertyName: "" });
    assert.strictEqual(n.hasMismatch, false); // booking なし → 判定不能で false
    assert.ok(n.body.includes("HMJZRZ4C99"));
    assert.ok(n.body.includes("(不明)"));
  });

  test("名簿0件でも booking.guestCount との食い違い判定は false (名簿未提出のうちは警告しない)", () => {
    const n = buildChangeEmailNotification(parsedApproved, booking, [], {});
    assert.strictEqual(n.hasMismatch, false);
    assert.ok(n.body.includes("名簿の申告人数: 未入力"));
  });
});

// ======================================================
// キャンセル → 同日程で別予約番号の再予約 (2026-08-12 the Terrace 8/26 の事故)
// Booking.com の iCal は同一日程なら同じ UID の CLOSED を返すため、
// 新旧の予約が同じ booking ドキュメントに着地する。
// ======================================================

describe("キャンセル済み予約の復活・差し替え", () => {
  // 旧予約 5990618442 がキャンセル済みで残っている状態
  const cancelledBooking = {
    status: "cancelled",
    cancelledAt: { _seconds: 1786000000 },
    cancelReason: "メール照合: キャンセル通知メール検知",
    cancelSource: "email",
    guestName: "Tomoko Miyama",
    guestCount: 4,
    checkIn: "2026-08-26",
    checkOut: "2026-08-27",
    source: "Booking.com",
    propertyId: "tsZybhDMcPrxqgcRy7wp",
    otaReservationCode: "5990618442",
  };
  // 新予約 5167790262 の確定メール (Booking.com は人数・氏名を本文に含まない)
  const confirmedInfo = {
    kind: "confirmed",
    platform: "Booking.com",
    reservationCode: "5167790262",
    checkIn: { date: "2026-08-26" },
    guestCount: null,
  };

  test("確定メールで復活するときキャンセル痕跡を削除する", () => {
    const { updates } = decideBookingUpdate(cancelledBooking, confirmedInfo, "m1", 1786100000000);
    assert.strictEqual(updates.status, "confirmed");
    assert.deepStrictEqual(updates.cancelledAt, { __placeholder: "delete" });
    assert.deepStrictEqual(updates.cancelReason, { __placeholder: "delete" });
    assert.deepStrictEqual(updates.cancelSource, { __placeholder: "delete" });
    assert.deepStrictEqual(updates.revivedAt, { __placeholder: "serverTimestamp" });
  });

  test("別予約への差し替えを検知して guestInfoStale を立てる", () => {
    const { updates } = decideBookingUpdate(cancelledBooking, confirmedInfo, "m1", 1786100000000);
    assert.strictEqual(updates.guestInfoStale, true);
    assert.ok(updates.guestInfoStaleReason);
    assert.deepStrictEqual(updates.replacedAt, { __placeholder: "serverTimestamp" });
  });

  test("新しい予約番号を保存する (次回は番号で厳密に突合できる)", () => {
    const { updates } = decideBookingUpdate(cancelledBooking, confirmedInfo, "m1", 1786100000000);
    assert.strictEqual(updates.otaReservationCode, "5167790262");
  });

  test("既存の人数は壊さない (誤った値で上書きしない・通知で人に確認させる)", () => {
    const { updates } = decideBookingUpdate(cancelledBooking, confirmedInfo, "m1", 1786100000000);
    assert.strictEqual(updates.guestCount, undefined);
  });

  test("キャンセルされていない通常の確定メールでは差し替え扱いしない", () => {
    const normal = { ...cancelledBooking, status: "confirmed", cancelledAt: null, otaReservationCode: "5167790262" };
    const { updates } = decideBookingUpdate(normal, confirmedInfo, "m1", 1786100000000);
    assert.strictEqual(updates.guestInfoStale, undefined);
    assert.strictEqual(updates.status, undefined);
  });

  test("status は confirmed でもキャンセル痕跡が残っていれば復活として扱う", () => {
    const residue = { ...cancelledBooking, status: "confirmed" };
    const { updates } = decideBookingUpdate(residue, confirmedInfo, "m1", 1786100000000);
    assert.deepStrictEqual(updates.cancelledAt, { __placeholder: "delete" });
    assert.strictEqual(updates.guestInfoStale, true);
  });

  test("予約番号だけが変わった場合も差し替えとして検知する", () => {
    const active = { ...cancelledBooking, status: "confirmed", cancelledAt: null };
    const { updates } = decideBookingUpdate(active, confirmedInfo, "m1", 1786100000000);
    assert.strictEqual(updates.guestInfoStale, true);
    // キャンセルされていないので status/痕跡削除は入らない
    assert.strictEqual(updates.status, undefined);
    assert.strictEqual(updates.cancelledAt, undefined);
  });

  test("otaReservationCode で厳密に突合できる", () => {
    const bookings = [
      { id: "old", data: { otaReservationCode: "5990618442", source: "Booking.com" } },
      { id: "new", data: { otaReservationCode: "5167790262", source: "Booking.com" } },
    ];
    const r = findBookingMatch(bookings, { reservationCode: "5167790262" });
    assert.strictEqual(r.id, "new");
    assert.strictEqual(r.matchReason, "otaReservationCode");
  });

  test("日付フォールバックで候補が割れたら active を優先する", () => {
    const bookings = [
      { id: "cancelled", data: { source: "Booking.com", propertyId: "P1", checkIn: "2026-08-26", status: "cancelled" } },
      { id: "active", data: { source: "Booking.com", propertyId: "P1", checkIn: "2026-08-26", status: "confirmed" } },
    ];
    const r = findBookingMatch(bookings, { platform: "Booking.com", checkIn: { date: "2026-08-26" } }, "P1");
    assert.strictEqual(r.id, "active");
    assert.strictEqual(r.matchReason, "dateAndPlatform-activePreferred");
  });

  test("active が複数なら従来どおり ambiguous (誤更新を防ぐ)", () => {
    const bookings = [
      { id: "a", data: { source: "Booking.com", propertyId: "P1", checkIn: "2026-08-26", status: "confirmed" } },
      { id: "b", data: { source: "Booking.com", propertyId: "P1", checkIn: "2026-08-26", status: "confirmed" } },
    ];
    const r = findBookingMatch(bookings, { platform: "Booking.com", checkIn: { date: "2026-08-26" } }, "P1");
    assert.strictEqual(r.matchReason, "ambiguous-dateAndPlatform");
  });

  test("キャンセルメールは従来どおりキャンセル化する (復活ロジックが邪魔しない)", () => {
    const active = { status: "confirmed", guestName: "Tomoko Miyama", checkIn: "2026-08-26" };
    const { updates } = decideBookingUpdate(active, { kind: "cancelled", platform: "Booking.com", reservationCode: "5990618442" }, "m2", 1786000000000);
    assert.strictEqual(updates.status, "cancelled");
    assert.deepStrictEqual(updates.cancelledAt, { __placeholder: "serverTimestamp" });
    assert.strictEqual(updates.guestInfoStale, undefined);
  });
});
