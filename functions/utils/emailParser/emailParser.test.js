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

// Booking.com ホスト側 - 新しい予約通知 (匿名化済)
const BOOKING_CONFIRMED = {
  subject: "Booking.com - 新しい予約がありました！ (5750794035, 2026年5月3日日曜日)",
  fromHeader: "noreply@booking.com",
  receivedAt: new Date("2026-04-19T14:34:00+09:00"),
  body: [
    "セキュリティ対策のため、ログインの前にアドレスバーのURLがhttps://admin.booking.comになっていることを確認してください。",
    "テスト物件名 Booking confirmation — 5750794035",
    "IATA/TIDS: PC029090",
    "たった今、Booking.comゲストから新しい予約がありました。",
    "本予約はスマート・フレックス予約です。",
    "上記のリンクが開かない場合は、こちらをコピーしてブラウザに貼り付けてください：",
    "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/booking.html?res_id=5750794035&hotel_id=14868587&lang=ja&from_confirmation_email=1",
    "以上、よろしくお願い申し上げます。",
  ].join("\n"),
};

// Booking.com ホスト側 - キャンセル通知 (匿名化済)
const BOOKING_CANCELLED = {
  subject: "Booking.com - 予約のキャンセルがありました (5750794035, 2026年5月3日日曜日)",
  fromHeader: "noreply@booking.com",
  receivedAt: new Date("2026-04-20T08:27:00+09:00"),
  body: [
    "セキュリティ対策のため、ログインの前にアドレスバーのURLがhttps://admin.booking.comになっていることを確認してください。",
    "テスト物件名 Cancellation — 5750794035",
    "IATA/TIDS: PC029090",
    "Test Guest様のご予約（予約番号： 5750794035）がキャンセルされましたので、Booking.comにてキャンセル処理をさせていただきました。",
    "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/booking.html?res_id=5750794035&hotel_id=14868587&lang=ja&from_confirmation_email=1",
  ].join("\n"),
};

// Booking.com ホスト側 - 変更通知 (匿名化済)
const BOOKING_CHANGED = {
  subject: "Booking.com - 予約の変更がありました！ (6787949698, 2026年5月3日日曜日)",
  fromHeader: "noreply@booking.com",
  receivedAt: new Date("2026-04-21T10:00:00+09:00"),
  body: [
    "テスト物件名 Modification — 6787949698",
    "IATA/TIDS: PC029090",
    "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/booking.html?res_id=6787949698&hotel_id=14868587&lang=ja",
  ].join("\n"),
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
  test("予約変更が承認 → change-approved", () => {
    assert.strictEqual(airbnbPure.detectSubjectKind("予約変更が承認されました"), "change-approved");
  });
  test("予約変更をご希望 → change-request", () => {
    assert.strictEqual(
      airbnbPure.detectSubjectKind("Muhamad Nurakmalさんが予約変更をご希望です"),
      "change-request"
    );
  });
  test("予約キャンセル → cancelled (旧形式)", () => {
    assert.strictEqual(airbnbPure.detectSubjectKind("予約がキャンセルされました"), "cancelled");
  });
  test("キャンセルのお知らせ → cancelled (新形式)", () => {
    assert.strictEqual(
      airbnbPure.detectSubjectKind("キャンセルのお知らせ：2026年5月4日～6日のご予約（HMJENWXRMS）"),
      "cancelled"
    );
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

  test("kind は change-approved、詳細フィールドは null", () => {
    assert.strictEqual(r.kind, "change-approved");
    assert.strictEqual(r.reservationCode, null);
    assert.strictEqual(r.checkIn, null);
    assert.strictEqual(r.checkOut, null);
    assert.strictEqual(r.guestCount, null);
  });
});

// ======================================================
// Airbnb キャンセル (新形式件名 + 本文) / 変更リクエスト テスト
// ======================================================

// キャンセルメール (匿名化): 件名主導で情報抽出
const AIRBNB_CANCELLED_NEW = {
  subject: "キャンセルのお知らせ：2026年5月4日～6日のご予約（HMJENWXRMS）",
  fromHeader: "Airbnb <automated@airbnb.com>",
  receivedAt: new Date("2026-04-14T09:08:00+09:00"),
  body: [
    "予約がキャンセルされました",
    "テスト物件リスティング名｜10名OK・BBQ可・駐車3台",
    "リスティング#1496523336810635360",
    "5月4日～6日, 4人",
    "大変恐れ入りますが、ゲストのテストゲストさんにより、やむを得ず5月4日～6日のご予約（HMJENWXRMS）がキャンセルされました。",
    "Airbnb Ireland UC8 Hanover Quay",
  ].join("\n"),
};

// 予約変更リクエスト (匿名化): 件名のみ主情報
const AIRBNB_CHANGE_REQUEST = {
  subject: "Test Guestさんが予約変更をご希望です",
  fromHeader: "Airbnb <automated@airbnb.com>",
  receivedAt: new Date("2026-04-15T10:00:00+09:00"),
  body: "新しいチェックイン日 / チェックアウト日など詳細は旅程表を確認してください。",
};

describe("airbnb 純粋関数: parseCancelSubject", () => {
  test("件名から年+日付範囲+確認コード抽出", () => {
    const r = airbnbPure.parseCancelSubject("キャンセルのお知らせ：2026年5月4日～6日のご予約（HMJENWXRMS）");
    assert.strictEqual(r.reservationCode, "HMJENWXRMS");
    assert.deepStrictEqual(r.checkIn, { year: 2026, month: 5, day: 4 });
    assert.deepStrictEqual(r.checkOut, { year: 2026, month: 5, day: 6 });
  });
  test("月またぎ: 2026年5月30日～6月2日", () => {
    const r = airbnbPure.parseCancelSubject("キャンセルのお知らせ：2026年5月30日～6月2日のご予約（HMTEST0000）");
    assert.strictEqual(r.checkIn.month, 5);
    assert.strictEqual(r.checkOut.month, 6);
    assert.strictEqual(r.checkOut.year, 2026);
  });
  test("年またぎ: 2025年12月31日～1月2日", () => {
    const r = airbnbPure.parseCancelSubject("キャンセルのお知らせ：2025年12月31日～1月2日のご予約（HMYEAREND1）");
    assert.strictEqual(r.checkIn.year, 2025);
    assert.strictEqual(r.checkOut.year, 2026);
  });
  test("フォーマット不一致は null", () => {
    assert.strictEqual(airbnbPure.parseCancelSubject("無関係"), null);
  });
});

describe("airbnb 純粋関数: parseChangeRequestSubject", () => {
  test("半角スペース込み英語名", () => {
    const r = airbnbPure.parseChangeRequestSubject("Muhamad Nurakmalさんが予約変更をご希望です");
    assert.strictEqual(r.guestName, "Muhamad Nurakmal");
  });
  test("日本語名", () => {
    const r = airbnbPure.parseChangeRequestSubject("山田 太郎さんが予約変更をご希望です");
    assert.strictEqual(r.guestName, "山田 太郎");
  });
  test("フォーマット不一致は null", () => {
    assert.strictEqual(airbnbPure.parseChangeRequestSubject("無関係"), null);
  });
});

describe("airbnb 純粋関数: キャンセル本文フィールド抽出", () => {
  test("extractCancelGuestFirstName", () => {
    assert.strictEqual(
      airbnbPure.extractCancelGuestFirstName("ゲストの和行さんにより、やむを得ず..."),
      "和行"
    );
    assert.strictEqual(
      airbnbPure.extractCancelGuestFirstName("ゲストのTestGuestさんにより"),
      "TestGuest"
    );
  });
  test("extractListingId", () => {
    assert.strictEqual(
      airbnbPure.extractListingId("リスティング#1496523336810635360"),
      "1496523336810635360"
    );
  });
  test("extractCancelGuestCount: 単月", () => {
    assert.deepStrictEqual(
      airbnbPure.extractCancelGuestCount("5月4日～6日, 4人"),
      { adults: 4, children: 0, infants: 0, total: 4 }
    );
  });
  test("extractCancelGuestCount: 月またぎ", () => {
    assert.deepStrictEqual(
      airbnbPure.extractCancelGuestCount("5月30日～6月2日, 2人"),
      { adults: 2, children: 0, infants: 0, total: 2 }
    );
  });
});

describe("parseAirbnbEmail: キャンセル (新形式件名)", () => {
  const r = parseAirbnbEmail(AIRBNB_CANCELLED_NEW);

  test("kind=cancelled", () => {
    assert.strictEqual(r.kind, "cancelled");
  });
  test("reservationCode は件名から", () => {
    assert.strictEqual(r.reservationCode, "HMJENWXRMS");
  });
  test("checkIn/checkOut は件名から (年含む、time=null)", () => {
    assert.deepStrictEqual(r.checkIn, { date: "2026-05-04", time: null });
    assert.deepStrictEqual(r.checkOut, { date: "2026-05-06", time: null });
  });
  test("guestFirstName は本文から", () => {
    assert.strictEqual(r.guestFirstName, "テストゲスト");
  });
  test("listingId / guestCount も本文から", () => {
    assert.strictEqual(r.listingId, "1496523336810635360");
    assert.deepStrictEqual(r.guestCount, { adults: 4, children: 0, infants: 0, total: 4 });
  });
});

describe("parseAirbnbEmail: 予約変更リクエスト", () => {
  const r = parseAirbnbEmail(AIRBNB_CHANGE_REQUEST);

  test("kind=change-request", () => {
    assert.strictEqual(r.kind, "change-request");
  });
  test("件名からゲスト名抽出", () => {
    assert.strictEqual(r.guestName, "Test Guest");
  });
  test("詳細は null (本文に情報なし)", () => {
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
// Booking.com テスト (ホスト側 noreply@booking.com 3 種)
// ======================================================

const { _pure: bookingPure } = require("./booking");

describe("booking 純粋関数: parseSubject", () => {
  test("新しい予約 件名", () => {
    const r = bookingPure.parseSubject("Booking.com - 新しい予約がありました！ (5750794035, 2026年5月3日日曜日)");
    assert.deepStrictEqual(r, {
      reservationId: "5750794035",
      checkIn: { year: 2026, month: 5, day: 3 },
    });
  });
  test("キャンセル 件名", () => {
    const r = bookingPure.parseSubject("Booking.com - 予約のキャンセルがありました (5750794035, 2026年5月3日日曜日)");
    assert.strictEqual(r.reservationId, "5750794035");
    assert.strictEqual(r.checkIn.year, 2026);
  });
  test("半角カッコでもマッチ", () => {
    const r = bookingPure.parseSubject("Booking.com - 新しい予約がありました！ (1234567890, 2026年1月1日水曜日)");
    assert.strictEqual(r.reservationId, "1234567890");
  });
  test("全角カッコでもマッチ", () => {
    const r = bookingPure.parseSubject("Booking.com - 新しい予約がありました！ （1234567890, 2026年1月1日水曜日）");
    assert.strictEqual(r.reservationId, "1234567890");
  });
  test("フォーマット不一致は null", () => {
    assert.strictEqual(bookingPure.parseSubject("別件"), null);
    assert.strictEqual(bookingPure.parseSubject(""), null);
  });
});

describe("booking 純粋関数: detectSubjectKind", () => {
  test("新しい予約 → confirmed", () => {
    assert.strictEqual(bookingPure.detectSubjectKind("Booking.com - 新しい予約がありました！ (...)"), "confirmed");
  });
  test("キャンセル → cancelled", () => {
    assert.strictEqual(bookingPure.detectSubjectKind("Booking.com - 予約のキャンセルがありました (...)"), "cancelled");
  });
  test("変更 → changed", () => {
    assert.strictEqual(bookingPure.detectSubjectKind("Booking.com - 予約の変更がありました！ (...)"), "changed");
  });
  test("Booking.com を含まない → unknown", () => {
    assert.strictEqual(bookingPure.detectSubjectKind("Airbnb 予約確定"), "unknown");
  });
});

describe("booking 純粋関数: 本文フィールド抽出", () => {
  test("reservationId を本文からフォールバック", () => {
    assert.strictEqual(
      bookingPure.extractReservationIdFromBody("the Terrace 長浜 Booking confirmation — 5750794035"),
      "5750794035"
    );
    // URL からでもフォールバック
    assert.strictEqual(
      bookingPure.extractReservationIdFromBody("https://example/booking.html?res_id=1234567890&hotel_id=1"),
      "1234567890"
    );
  });
  test("propertyName 抽出", () => {
    assert.strictEqual(
      bookingPure.extractPropertyName("the Terrace 長浜 Booking confirmation — 5750794035"),
      "the Terrace 長浜"
    );
    assert.strictEqual(
      bookingPure.extractPropertyName("テスト物件 Cancellation — 1234567890"),
      "テスト物件"
    );
  });
  test("hotel_id 抽出", () => {
    assert.strictEqual(
      bookingPure.extractHotelId("res_id=5750794035&hotel_id=14868587&lang=ja"),
      "14868587"
    );
  });
  test("guestName (キャンセルメールのみ)", () => {
    assert.strictEqual(
      bookingPure.extractGuestName("Masanori Matsuura様のご予約（予約番号： 5750794035）がキャンセル"),
      "Masanori Matsuura"
    );
    assert.strictEqual(
      bookingPure.extractGuestName("山田太郎様のご予約（予約番号：1234）"),
      "山田太郎"
    );
  });
});

describe("parseBookingEmail: 新しい予約", () => {
  const r = parseBookingEmail(BOOKING_CONFIRMED);

  test("platform / kind", () => {
    assert.strictEqual(r.platform, "Booking.com");
    assert.strictEqual(r.kind, "confirmed");
  });
  test("reservationCode は件名から取得", () => {
    assert.strictEqual(r.reservationCode, "5750794035");
  });
  test("checkIn 年月日が件名から取得 (time は null)", () => {
    assert.deepStrictEqual(r.checkIn, { date: "2026-05-03", time: null });
  });
  test("checkOut は null (メールに含まれない)", () => {
    assert.strictEqual(r.checkOut, null);
  });
  test("confirmed メールには guestName なし", () => {
    assert.strictEqual(r.guestName, null);
  });
  test("propertyName / hotelId は本文から取得", () => {
    assert.strictEqual(r.propertyName, "テスト物件名");
    assert.strictEqual(r.hotelId, "14868587");
  });
});

describe("parseBookingEmail: キャンセル", () => {
  const r = parseBookingEmail(BOOKING_CANCELLED);

  test("kind=cancelled", () => {
    assert.strictEqual(r.kind, "cancelled");
  });
  test("reservationCode / checkIn 共通", () => {
    assert.strictEqual(r.reservationCode, "5750794035");
    assert.deepStrictEqual(r.checkIn, { date: "2026-05-03", time: null });
  });
  test("cancelled メールは guestName を取得できる", () => {
    assert.strictEqual(r.guestName, "Test Guest");
  });
});

describe("parseBookingEmail: 変更", () => {
  const r = parseBookingEmail(BOOKING_CHANGED);

  test("kind=changed", () => {
    assert.strictEqual(r.kind, "changed");
  });
  test("別の reservationId を拾う", () => {
    assert.strictEqual(r.reservationCode, "6787949698");
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
  test("Booking.com (noreply@booking.com ホスト通知)", () => {
    assert.strictEqual(detectPlatform("noreply@booking.com"), "Booking.com");
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
  test("Booking.com ホスト通知メールを dispatcher 経由でパース", () => {
    const r = parseEmail({
      subject: BOOKING_CONFIRMED.subject,
      body: BOOKING_CONFIRMED.body,
      fromHeader: BOOKING_CONFIRMED.fromHeader,
      receivedAt: BOOKING_CONFIRMED.receivedAt,
    });
    assert.strictEqual(r.platform, "Booking.com");
    assert.strictEqual(r.kind, "confirmed");
    assert.strictEqual(r.reservationCode, "5750794035");
    assert.strictEqual(r.checkIn.date, "2026-05-03");
  });
});
