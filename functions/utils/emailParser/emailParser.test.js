/**
 * OTA メールパーサー単体テスト (node --test)
 * 実行: npm test
 *
 * フィクスチャは実メール構造ベースだが **匿名化済** (個人情報不含)。
 * ゲスト名・確認コード・リスティング名を全てテスト用に書き換えている。
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");

const { parseAirbnbEmail, _pure: airbnbPure } = require("./airbnb");
const { parseBookingEmail } = require("./booking");
const { parseEmail, detectPlatform } = require("./index");

// ======================================================
// フィクスチャ (匿名化済)
// ======================================================

// Airbnb 予約確定 (国内ゲスト想定、日本語本文)
const AIRBNB_CONFIRMED_JP = {
  subject: "予約確定 - テスト太郎 山田さんが11月2日ご到着です",
  fromHeader: "Airbnb <automated@airbnb.com>",
  receivedAt: new Date("2025-10-04T19:26:00+09:00"),
  body: [
    "新規予約確定です! テスト太郎さんが11月2日到着。テスト太郎さんに歓迎のメッセージを送り、当日の入室の段取りを確認しておきましょう。",
    "テスト太郎",
    "ID認証済み",
    "Japan",
    "【NewOpenSALE】オーシャンビューテラスでBBQも。",
    "チェックイン11月2日(日)15:00",
    "チェックアウト11月3日(月)10:00",
    "ゲスト人数大人4人, 子ども2人",
    "確認コードHMTESTAB01",
    "旅程表を見る",
    "ゲスト支払い済み¥ 45,000 x 1泊¥ 45,000",
    "ゲストサービス料¥ 6,988",
    "合計（JPY）¥ 51,988",
    "ホストの受取金",
  ].join("\n"),
};

// Airbnb 予約確定 (海外ゲスト、日本語本文)
const AIRBNB_CONFIRMED_INTL = {
  subject: "予約確定 - Test Traveler-Exampleさんが9月26日ご到着です",
  fromHeader: "Airbnb <automated@airbnb.com>",
  receivedAt: new Date("2025-09-23T13:01:00+09:00"),
  body: [
    "新規予約確定です! Testさんが9月26日到着。Testさんに歓迎のメッセージを送り、当日の入室の段取りを確認しておきましょう。",
    "Test",
    "ID認証済み · レビュー3件",
    "Anywhere, Country",
    "【NewOpenSALE】オーシャンビューテラスでBBQも。",
    "チェックイン9月26日(金)15:00",
    "チェックアウト9月27日(土)10:00",
    "ゲスト人数大人2人",
    "確認コードHMTESTXY99",
    "合計（JPY）¥ 35,491",
  ].join("\n"),
};

// Airbnb 予約変更承認 (詳細情報なし、kind 判定のみ)
const AIRBNB_CHANGED = {
  subject: "予約変更が承認されました",
  fromHeader: "Airbnb <automated@airbnb.com>",
  receivedAt: new Date("2025-10-04T06:28:00+09:00"),
  body: "テストゲストさんが予約の変更に同意しました\nテストゲスト\nAnywhere, 日本",
};

// Booking.com 確認メール (予約番号あり、ゲスト側 or ホスト側 stub 動作確認)
const BOOKING_EMAIL = {
  subject: "予約が確定しました",
  fromHeader: "Booking.com <noreply@booking.com>",
  receivedAt: new Date("2026-04-06T14:17:00+09:00"),
  body: "予約ID 5622417501\n建物タイトル...\n宿泊期間 2026-04-26 15:00 〜2026-04-27 11:00",
};

// ======================================================
// Airbnb 純粋関数テスト
// ======================================================

describe("airbnb 純粋関数: extractReservationCode", () => {
  test("本文中の HM + 8 文字を抽出", () => {
    assert.strictEqual(airbnbPure.extractReservationCode("確認コードHMH2KHHTF5\n旅程表"), "HMH2KHHTF5");
  });
  test("HM 接頭なしの文字列は null", () => {
    assert.strictEqual(airbnbPure.extractReservationCode("ABC12345"), null);
  });
  test("本文なしは null", () => {
    assert.strictEqual(airbnbPure.extractReservationCode(""), null);
    assert.strictEqual(airbnbPure.extractReservationCode(null), null);
  });
});

describe("airbnb 純粋関数: extractGuestNameFromSubject", () => {
  test("件名からフルネーム抽出", () => {
    assert.strictEqual(
      airbnbPure.extractGuestNameFromSubject("予約確定 - テスト太郎 山田さんが11月2日ご到着です"),
      "テスト太郎 山田"
    );
  });
  test("ハイフン/ダッシュ各種対応", () => {
    assert.strictEqual(
      airbnbPure.extractGuestNameFromSubject("予約確定 ー 山田さんが1月1日ご到着です"),
      "山田"
    );
  });
  test("フォーマット不一致は null", () => {
    assert.strictEqual(airbnbPure.extractGuestNameFromSubject("予約変更が承認されました"), null);
  });
});

describe("airbnb 純粋関数: extractCheckIn / extractCheckOut", () => {
  test("チェックイン「M月D日(曜)HH:MM」形式", () => {
    const m = airbnbPure.extractCheckIn("チェックイン11月2日(日)15:00");
    assert.deepStrictEqual(m, { month: 11, day: 2, hour: 15, minute: 0 });
  });
  test("チェックアウト同じく", () => {
    const m = airbnbPure.extractCheckOut("チェックアウト11月3日(月)10:00");
    assert.deepStrictEqual(m, { month: 11, day: 3, hour: 10, minute: 0 });
  });
  test("該当なしは null", () => {
    assert.strictEqual(airbnbPure.extractCheckIn("(無関係)"), null);
  });
});

describe("airbnb 純粋関数: extractGuestCount", () => {
  test("大人のみ", () => {
    assert.deepStrictEqual(airbnbPure.extractGuestCount("ゲスト人数大人2人"), {
      adults: 2, children: 0, infants: 0, total: 2,
    });
  });
  test("大人+子ども", () => {
    assert.deepStrictEqual(airbnbPure.extractGuestCount("ゲスト人数大人4人, 子ども2人"), {
      adults: 4, children: 2, infants: 0, total: 6,
    });
  });
  test("大人+子ども+乳幼児", () => {
    assert.deepStrictEqual(airbnbPure.extractGuestCount("ゲスト人数大人2人, 子ども1人, 乳幼児1人"), {
      adults: 2, children: 1, infants: 1, total: 4,
    });
  });
  test("該当なしは null", () => {
    assert.strictEqual(airbnbPure.extractGuestCount("(無関係)"), null);
  });
});

describe("airbnb 純粋関数: extractTotalAmount", () => {
  test("全角カッコ", () => {
    assert.strictEqual(airbnbPure.extractTotalAmount("合計（JPY）¥ 51,988"), 51988);
  });
  test("半角カッコも許容", () => {
    assert.strictEqual(airbnbPure.extractTotalAmount("合計(JPY) ¥ 35,491"), 35491);
  });
  test("該当なしは null", () => {
    assert.strictEqual(airbnbPure.extractTotalAmount("(無関係)"), null);
  });
});

describe("airbnb 純粋関数: detectSubjectKind", () => {
  test("予約確定 → confirmed", () => {
    assert.strictEqual(airbnbPure.detectSubjectKind("予約確定 - 太郎さんが11月2日ご到着です"), "confirmed");
  });
  test("予約変更が承認 → changed", () => {
    assert.strictEqual(airbnbPure.detectSubjectKind("予約変更が承認されました"), "changed");
  });
  test("予約キャンセル → cancelled", () => {
    assert.strictEqual(airbnbPure.detectSubjectKind("予約がキャンセルされました"), "cancelled");
  });
  test("予約リクエスト → request", () => {
    assert.strictEqual(airbnbPure.detectSubjectKind("保留中: 予約リクエスト・【NewOpenSALE】..."), "request");
  });
  test("無関係 → unknown", () => {
    assert.strictEqual(airbnbPure.detectSubjectKind("お知らせ"), "unknown");
  });
});

describe("airbnb 純粋関数: inferYear", () => {
  test("受信日以降の同月日 → 同年", () => {
    // 受信: 2025-10-04 / check-in: 11月2日 → 2025年
    const y = airbnbPure.inferYear(11, 2, new Date("2025-10-04T00:00:00+09:00"));
    assert.strictEqual(y, 2025);
  });
  test("受信日の遥か過去 (30日超) → 翌年", () => {
    // 受信: 2025-11-15 / check-in: 1月1日 → 2026年 (1月1日は受信から大過去扱い)
    const y = airbnbPure.inferYear(1, 1, new Date("2025-11-15T00:00:00+09:00"));
    assert.strictEqual(y, 2026);
  });
  test("直近の過去 30日以内 → 同年 (遅延メール対応)", () => {
    const y = airbnbPure.inferYear(10, 1, new Date("2025-10-15T00:00:00+09:00"));
    assert.strictEqual(y, 2025);
  });
});

// ======================================================
// Airbnb 統合テスト (フィクスチャ全体をパース)
// ======================================================

describe("parseAirbnbEmail: 国内ゲスト 予約確定", () => {
  const r = parseAirbnbEmail(AIRBNB_CONFIRMED_JP);

  test("platform / kind", () => {
    assert.strictEqual(r.platform, "Airbnb");
    assert.strictEqual(r.kind, "confirmed");
  });
  test("確認コード", () => {
    assert.strictEqual(r.reservationCode, "HMTESTAB01");
  });
  test("件名からフルネーム / 本文からファーストネーム", () => {
    assert.strictEqual(r.guestName, "テスト太郎 山田");
    assert.strictEqual(r.guestFirstName, "テスト太郎");
  });
  test("チェックイン/アウト 年推論込み", () => {
    assert.deepStrictEqual(r.checkIn, { date: "2025-11-02", time: "15:00" });
    assert.deepStrictEqual(r.checkOut, { date: "2025-11-03", time: "10:00" });
  });
  test("ゲスト人数", () => {
    assert.deepStrictEqual(r.guestCount, { adults: 4, children: 2, infants: 0, total: 6 });
  });
  test("合計金額", () => {
    assert.strictEqual(r.totalAmount, 51988);
  });
});

describe("parseAirbnbEmail: 海外ゲスト 予約確定", () => {
  const r = parseAirbnbEmail(AIRBNB_CONFIRMED_INTL);

  test("件名からフルネーム (ハイフン含む英語名)", () => {
    assert.strictEqual(r.guestName, "Test Traveler-Example");
  });
  test("本文からファーストネーム", () => {
    assert.strictEqual(r.guestFirstName, "Test");
  });
  test("確認コード / 人数", () => {
    assert.strictEqual(r.reservationCode, "HMTESTXY99");
    assert.deepStrictEqual(r.guestCount, { adults: 2, children: 0, infants: 0, total: 2 });
  });
  test("チェックイン 9月26日 / 受信 9/23 → 2025 年", () => {
    assert.deepStrictEqual(r.checkIn, { date: "2025-09-26", time: "15:00" });
    assert.deepStrictEqual(r.checkOut, { date: "2025-09-27", time: "10:00" });
  });
});

describe("parseAirbnbEmail: 予約変更承認 (詳細なし)", () => {
  const r = parseAirbnbEmail(AIRBNB_CHANGED);

  test("kind は changed、詳細フィールドは null", () => {
    assert.strictEqual(r.kind, "changed");
    assert.strictEqual(r.reservationCode, null);
    assert.strictEqual(r.checkIn, null);
    assert.strictEqual(r.checkOut, null);
    assert.strictEqual(r.guestCount, null);
  });
});

describe("parseAirbnbEmail: 年またぎ", () => {
  // 12月受信で checkIn が 1月 → 翌年
  const input = {
    subject: "予約確定 - テストさんが1月3日ご到着です",
    body: "新規予約確定です! テストさんが1月3日到着。\nチェックイン1月3日(土)15:00\nチェックアウト1月4日(日)10:00\nゲスト人数大人2人\n確認コードHMYEAREDGE",
    receivedAt: new Date("2025-12-20T10:00:00+09:00"),
  };
  const r = parseAirbnbEmail(input);

  test("checkIn / checkOut とも 2026 年", () => {
    assert.strictEqual(r.checkIn.date, "2026-01-03");
    assert.strictEqual(r.checkOut.date, "2026-01-04");
  });
});

describe("parseAirbnbEmail: 月またぎ checkIn 12月 → checkOut 1月", () => {
  const input = {
    subject: "予約確定 - テストさんが12月31日ご到着です",
    body: "新規予約確定です! テストさんが12月31日到着。\nチェックイン12月31日(水)15:00\nチェックアウト1月1日(木)10:00\nゲスト人数大人2人\n確認コードHMYEAREDG2",
    receivedAt: new Date("2025-12-15T10:00:00+09:00"),
  };
  const r = parseAirbnbEmail(input);

  test("checkIn 2025, checkOut 2026 (月跨ぎ)", () => {
    assert.strictEqual(r.checkIn.date, "2025-12-31");
    assert.strictEqual(r.checkOut.date, "2026-01-01");
  });
});

// ======================================================
// Booking.com テスト (stub)
// ======================================================

describe("parseBookingEmail: stub 動作確認", () => {
  const r = parseBookingEmail(BOOKING_EMAIL);

  test("platform Booking.com", () => {
    assert.strictEqual(r.platform, "Booking.com");
  });
  test("予約 ID を best-effort で抽出", () => {
    assert.strictEqual(r.reservationCode, "5622417501");
  });
  test("件名 '確定' で kind=confirmed", () => {
    assert.strictEqual(r.kind, "confirmed");
  });
  test("詳細フィールドは null (本実装待ち)", () => {
    assert.strictEqual(r.checkIn, null);
    assert.strictEqual(r.checkOut, null);
    assert.strictEqual(r.guestCount, null);
  });
  test("_note で stub であることが明示されている", () => {
    assert.ok(r._note);
    assert.ok(r._note.includes("stub"));
  });
});

// ======================================================
// dispatcher テスト
// ======================================================

describe("detectPlatform", () => {
  test("Airbnb", () => {
    assert.strictEqual(detectPlatform("automated@airbnb.com"), "Airbnb");
    assert.strictEqual(detectPlatform("Airbnb <no-reply@airbnb.jp>"), "Airbnb");
  });
  test("Booking.com", () => {
    assert.strictEqual(detectPlatform("Booking.com <noreply@booking.com>"), "Booking.com");
    assert.strictEqual(detectPlatform("customer.service@mail.booking.com"), "Booking.com");
  });
  test("不明", () => {
    assert.strictEqual(detectPlatform("random@example.com"), null);
    assert.strictEqual(detectPlatform(""), null);
    assert.strictEqual(detectPlatform(undefined), null);
  });
});

describe("parseEmail ディスパッチャ", () => {
  test("fromHeader から Airbnb を判定してパース", () => {
    const r = parseEmail({
      subject: AIRBNB_CONFIRMED_JP.subject,
      body: AIRBNB_CONFIRMED_JP.body,
      fromHeader: AIRBNB_CONFIRMED_JP.fromHeader,
      receivedAt: AIRBNB_CONFIRMED_JP.receivedAt,
    });
    assert.strictEqual(r.platform, "Airbnb");
    assert.strictEqual(r.reservationCode, "HMTESTAB01");
  });
  test("platform 明示指定が優先", () => {
    const r = parseEmail({
      platform: "Airbnb",
      subject: AIRBNB_CONFIRMED_JP.subject,
      body: AIRBNB_CONFIRMED_JP.body,
      receivedAt: AIRBNB_CONFIRMED_JP.receivedAt,
    });
    assert.strictEqual(r.platform, "Airbnb");
  });
  test("判定不能で Unknown を返す", () => {
    const r = parseEmail({ subject: "x", body: "y", fromHeader: "rand@example.com" });
    assert.strictEqual(r.platform, "Unknown");
    assert.strictEqual(r.kind, "unknown");
  });
});
