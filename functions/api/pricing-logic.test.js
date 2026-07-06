/**
 * pricing-logic 純粋関数の単体テスト
 * 実行: node --test functions/api/pricing-logic.test.js
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const {
  dowUtc,
  eachNight,
  seasonForDate,
  nightlyRate,
  losDiscountPercent,
  computeQuote,
} = require("./pricing-logic");

// 小町 (YADO KOMACHI) の実料金 (Airbnb 2026-07 取得値) をフィクスチャに使う
const komachi = {
  currency: "JPY",
  basePrice: 15000,
  weekendPrice: 20000,
  weekendDays: [5, 6], // 金・土
  seasons: [],
  lengthOfStayDiscounts: [
    { minNights: 7, discountPercent: 25 },
    { minNights: 28, discountPercent: 26 },
  ],
  guestSurcharge: { includedGuests: 2, perExtraGuest: 4000 },
  planModifiers: { standard: 0, nonrefundable: -10 },
  minNights: 1,
  maxNights: 365,
};

describe("dowUtc", () => {
  test("曜日を 0=日..6=土 で返す", () => {
    assert.strictEqual(dowUtc("2026-07-10"), 5); // 金
    assert.strictEqual(dowUtc("2026-07-11"), 6); // 土
    assert.strictEqual(dowUtc("2026-07-12"), 0); // 日
    assert.strictEqual(dowUtc("2026-07-06"), 1); // 月
  });
});

describe("eachNight", () => {
  test("[CI, CO) の宿泊夜を列挙 (CO日は含まない)", () => {
    assert.deepStrictEqual(eachNight("2026-07-06", "2026-07-09"), [
      "2026-07-06", "2026-07-07", "2026-07-08",
    ]);
  });
  test("同日・逆転・不正は空配列", () => {
    assert.deepStrictEqual(eachNight("2026-07-06", "2026-07-06"), []);
    assert.deepStrictEqual(eachNight("2026-07-09", "2026-07-06"), []);
    assert.deepStrictEqual(eachNight("bad", "2026-07-06"), []);
  });
});

describe("seasonForDate", () => {
  const rates = {
    seasons: [{ id: "obon", start: "2026-08-10", end: "2026-08-16", price: 22000 }],
  };
  test("期間内は該当シーズンを返す", () => {
    assert.strictEqual(seasonForDate(rates, "2026-08-10").id, "obon");
    assert.strictEqual(seasonForDate(rates, "2026-08-16").id, "obon");
    assert.strictEqual(seasonForDate(rates, "2026-08-13").id, "obon");
  });
  test("期間外は null", () => {
    assert.strictEqual(seasonForDate(rates, "2026-08-09"), null);
    assert.strictEqual(seasonForDate(rates, "2026-08-17"), null);
  });
  test("seasons 未定義でも落ちない", () => {
    assert.strictEqual(seasonForDate({}, "2026-08-13"), null);
  });
});

describe("nightlyRate", () => {
  test("平日は基準料金", () => {
    assert.deepStrictEqual(nightlyRate(komachi, "2026-07-06"), { price: 15000, kind: "base" }); // 月
  });
  test("金・土は週末料金", () => {
    assert.deepStrictEqual(nightlyRate(komachi, "2026-07-10"), { price: 20000, kind: "weekend" }); // 金
    assert.deepStrictEqual(nightlyRate(komachi, "2026-07-11"), { price: 20000, kind: "weekend" }); // 土
  });
  test("日別 override が最優先", () => {
    const ov = { "2026-07-10": { price: 50000 } };
    assert.deepStrictEqual(nightlyRate(komachi, "2026-07-10", ov), { price: 50000, kind: "override" });
  });
  test("シーズンは週末/平日を区別 (override が無い場合)", () => {
    const rates = {
      basePrice: 15000, weekendPrice: 20000, weekendDays: [5, 6],
      seasons: [{ start: "2026-08-10", end: "2026-08-16", price: 22000, weekendPrice: 25000 }],
    };
    assert.deepStrictEqual(nightlyRate(rates, "2026-08-13"), { price: 22000, kind: "season" });       // 木
    assert.deepStrictEqual(nightlyRate(rates, "2026-08-14"), { price: 25000, kind: "season-weekend" }); // 金
  });
});

describe("losDiscountPercent", () => {
  test("閾値を満たす最大割引率", () => {
    assert.strictEqual(losDiscountPercent(komachi, 1), 0);
    assert.strictEqual(losDiscountPercent(komachi, 6), 0);
    assert.strictEqual(losDiscountPercent(komachi, 7), 25);
    assert.strictEqual(losDiscountPercent(komachi, 27), 25);
    assert.strictEqual(losDiscountPercent(komachi, 28), 26);
    assert.strictEqual(losDiscountPercent(komachi, 40), 26);
  });
});

describe("computeQuote — 小町の実料金で検算", () => {
  test("7泊2名スタンダード = 小計115,000 / 週割25% / 合計86,250 (Airbnb表示と一致)", () => {
    // 2026-07-06(月)〜07-13、7泊。7連泊はどこを起点にしても 金1泊+土1泊 を必ず含む
    const r = computeQuote({ rates: komachi, checkIn: "2026-07-06", checkOut: "2026-07-13", guests: 2, plan: "standard" });
    assert.strictEqual(r.ok, true);
    const q = r.quote;
    assert.strictEqual(q.nights, 7);
    assert.strictEqual(q.subtotal, 115000); // 平日5×15000 + 週末2×20000
    assert.strictEqual(q.lengthOfStayDiscountPercent, 25);
    assert.strictEqual(q.lengthOfStayDiscountAmount, 28750);
    assert.strictEqual(q.guestSurcharge, 0);
    assert.strictEqual(q.planModifierAmount, 0);
    assert.strictEqual(q.total, 86250);
    assert.strictEqual(q.nightlyBreakdown.length, 7);
  });

  test("3名は追加人数料金 (2名超・1名 ×4,000 ×泊数)", () => {
    const r = computeQuote({ rates: komachi, checkIn: "2026-07-06", checkOut: "2026-07-13", guests: 3, plan: "standard" });
    const q = r.quote;
    assert.strictEqual(q.extraGuests, 1);
    assert.strictEqual(q.guestSurcharge, 1 * 4000 * 7); // 28,000
    // 115000 - 28750 + 28000 = 114,250
    assert.strictEqual(q.total, 114250);
  });

  test("返金不可プランは最終段で -10%", () => {
    const r = computeQuote({ rates: komachi, checkIn: "2026-07-06", checkOut: "2026-07-13", guests: 2, plan: "nonrefundable" });
    const q = r.quote;
    // beforePlan=86,250 → -10% = -8,625 → total 77,625
    assert.strictEqual(q.planModifierPercent, -10);
    assert.strictEqual(q.planModifierAmount, -8625);
    assert.strictEqual(q.total, 77625);
  });

  test("平日2泊は割引なし", () => {
    const r = computeQuote({ rates: komachi, checkIn: "2026-07-06", checkOut: "2026-07-08", guests: 2, plan: "standard" });
    const q = r.quote;
    assert.strictEqual(q.nights, 2);
    assert.strictEqual(q.subtotal, 30000);
    assert.strictEqual(q.lengthOfStayDiscountPercent, 0);
    assert.strictEqual(q.total, 30000);
  });

  test("日別 override が小計に反映される", () => {
    const overrides = { "2026-07-10": { price: 50000 } }; // 元は週末20000の金曜
    const r = computeQuote({ rates: komachi, checkIn: "2026-07-06", checkOut: "2026-07-13", guests: 2, plan: "standard", overrides });
    // 小計 115000 - 20000 + 50000 = 145000
    assert.strictEqual(r.quote.subtotal, 145000);
  });

  test("不正日付・0泊はエラー", () => {
    assert.strictEqual(computeQuote({ rates: komachi, checkIn: "2026-07-06", checkOut: "2026-07-06", guests: 2 }).ok, false);
    assert.strictEqual(computeQuote({ rates: komachi, checkIn: "bad", checkOut: "2026-07-13", guests: 2 }).ok, false);
    assert.strictEqual(computeQuote({ rates: null, checkIn: "2026-07-06", checkOut: "2026-07-13", guests: 2 }).ok, false);
  });

  test("不明なプランは standard 扱い", () => {
    const r = computeQuote({ rates: komachi, checkIn: "2026-07-06", checkOut: "2026-07-08", guests: 2, plan: "xxx" });
    assert.strictEqual(r.quote.plan, "standard");
  });
});
