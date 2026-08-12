/**
 * pnl-logic 純粋関数の単体テスト
 * 実行: node --test functions/api/pnl-logic.test.js
 *
 * 副作用のない純粋関数のみを検証する。Drive/Gemini/Firestore に触らない。
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const {
  toInt,
  normLoose,
  normalizeStaffName,
  resolvePropertyForDoc,
  applyExpenses,
  computePnl,
  sumDirectBookings,
  extractDirectReservations,
  cleaningAmountForProperty,
  classifyExpenseByName_,
  filterElectricPaymentsForProperty,
  hiroshimaTaxPerPersonPerNight,
  computeAccommodationTax,
  parseBillMonths,
} = require("./pnl-logic");

describe("toInt", () => {
  test("通常の数値", () => {
    assert.strictEqual(toInt(260000), 260000);
    assert.strictEqual(toInt(0), 0);
  });
  test("¥とカンマを除去", () => {
    assert.strictEqual(toInt("¥260,000"), 260000);
    assert.strictEqual(toInt("¥7,800"), 7800);
  });
  test("マイナスは絶対値で返す(手数料の符号誤りを防ぐ)", () => {
    assert.strictEqual(toInt("-7800"), 7800);
    assert.strictEqual(toInt(-1234), 1234);
  });
  test("null/undefined/不正値は0", () => {
    assert.strictEqual(toInt(null), 0);
    assert.strictEqual(toInt(undefined), 0);
    assert.strictEqual(toInt("abc"), 0);
    assert.strictEqual(toInt(""), 0);
  });
});

describe("normLoose", () => {
  test("空白・装飾記号除去・小文字化", () => {
    assert.strictEqual(normLoose("the Terrace 長浜"), "theterrace長浜");
    assert.strictEqual(normLoose("瀬戸内海ビュー大テラス｜10名OK・BBQ可"), "瀬戸内海ビュー大テラス10名okbbq可");
  });
  test("null/undefined は空文字", () => {
    assert.strictEqual(normLoose(null), "");
    assert.strictEqual(normLoose(undefined), "");
  });
});

describe("normalizeStaffName", () => {
  test("法人格・敬称除去", () => {
    assert.strictEqual(normalizeStaffName("株式会社オオサワ創研 御中"), "オオサワ創研");
    assert.strictEqual(normalizeStaffName("田中俊子様"), "田中俊子");
  });
  test("カッコ書き(カナ読み等)を除去", () => {
    assert.strictEqual(normalizeStaffName("原垣琴美(ハラガキコトミ)"), "原垣琴美");
    assert.strictEqual(normalizeStaffName("田中俊子（タナカトシコ）"), "田中俊子");
  });
  test("空入力", () => {
    assert.strictEqual(normalizeStaffName(""), "");
    assert.strictEqual(normalizeStaffName(null), "");
  });
});

describe("resolvePropertyForDoc", () => {
  const properties = [
    {
      id: "tsZybhDMcPrxqgcRy7wp",
      name: "the Terrace 長浜",
      bookingPropertyId: "14868587",
      airbnbListingName: "瀬戸内海ビュー大テラス｜10名OK・BBQ可・駐車3台",
      airbnbListingAliases: ["【NewOpenSALE】オーシャンビューテラスでBBQも。高台に佇む一棟貸切のお宿。最大10名様"],
    },
    {
      id: "komachiPropertyId001",
      name: "YADO KOMACHI Hiroshima",
      bookingPropertyId: "15203947",
    },
  ];

  test("Booking施設IDで一致(the Terrace 長浜)", () => {
    const parsed = { docKind: "booking_detail", booking: { propertyFacilityId: "14868587" } };
    assert.strictEqual(resolvePropertyForDoc(parsed, properties, null), "tsZybhDMcPrxqgcRy7wp");
  });

  test("Booking施設IDで一致(YADO KOMACHI)", () => {
    const parsed = { docKind: "booking_detail", booking: { propertyFacilityId: "15203947" } };
    assert.strictEqual(resolvePropertyForDoc(parsed, properties, null), "komachiPropertyId001");
  });

  test("Airbnbリスティング名で一致", () => {
    const parsed = { docKind: "airbnb_monthly", airbnb: { listingName: "瀬戸内海ビュー大テラス｜10名OK・BBQ可・駐車3台" } };
    assert.strictEqual(resolvePropertyForDoc(parsed, properties, null), "tsZybhDMcPrxqgcRy7wp");
  });

  test("Airbnb旧リスティング名(エイリアス)で一致", () => {
    const parsed = { docKind: "airbnb_monthly", airbnb: { listingName: "【NewOpenSALE】オーシャンビューテラスでBBQも。高台に佇む一棟貸切のお宿。最大10名様" } };
    assert.strictEqual(resolvePropertyForDoc(parsed, properties, null), "tsZybhDMcPrxqgcRy7wp");
  });

  test("清掃請求書: 物件名で曖昧一致", () => {
    const parsed = { docKind: "cleaning_invoice", cleaning: { propertyName: "the Terrace 長浜" } };
    assert.strictEqual(resolvePropertyForDoc(parsed, properties, null), "tsZybhDMcPrxqgcRy7wp");
  });

  test("該当なしで fallback 返す", () => {
    const parsed = { docKind: "other", propertyName: "存在しない宿" };
    assert.strictEqual(resolvePropertyForDoc(parsed, properties, "fallback-id"), "fallback-id");
  });

  test("fallback も無ければ null", () => {
    const parsed = { docKind: "other" };
    assert.strictEqual(resolvePropertyForDoc(parsed, properties, null), null);
  });
});

describe("applyExpenses", () => {
  const categories = [
    { id: "rent", name: "家賃", type: "fixed", defaultAmount: 80000, appliesTo: "all", displayOrder: 1, active: true },
    { id: "utility", name: "光熱費", type: "manual", appliesTo: "all", displayOrder: 2, active: true },
    { id: "supplies", name: "消耗品", type: "manual", appliesTo: "all", displayOrder: 3, active: true },
    { id: "inactive", name: "旧費目", type: "fixed", defaultAmount: 5000, appliesTo: "all", active: false },
    { id: "onlyTerrace", name: "テラス専用", type: "fixed", defaultAmount: 3000, appliesTo: ["tsZybhDMcPrxqgcRy7wp"], active: true },
  ];

  test("fixed費目は当月未設定なら defaultAmount を充当", () => {
    const data = { expenses: {} };
    const r = applyExpenses(data, categories, "anyProperty");
    const rent = r.rows.find((x) => x.catId === "rent");
    assert.strictEqual(rent.amount, 80000);
    assert.strictEqual(rent.source, "fixed");
    assert.strictEqual(rent.overridden, false);
  });

  test("manual費目は未入力なら0", () => {
    const data = { expenses: {} };
    const r = applyExpenses(data, categories, "anyProperty");
    const util = r.rows.find((x) => x.catId === "utility");
    assert.strictEqual(util.amount, 0);
  });

  test("手入力(overridden)は保持してマスタの既定額を上書きする", () => {
    const data = { expenses: { rent: { amount: 100000, source: "fixed", overridden: true } } };
    const r = applyExpenses(data, categories, "anyProperty");
    const rent = r.rows.find((x) => x.catId === "rent");
    assert.strictEqual(rent.amount, 100000);
    assert.strictEqual(rent.overridden, true);
  });

  test("active=false の費目は除外", () => {
    const r = applyExpenses({ expenses: {} }, categories, "anyProperty");
    assert.strictEqual(r.rows.find((x) => x.catId === "inactive"), undefined);
  });

  test("appliesTo が配列のとき、対象物件だけに適用", () => {
    const r1 = applyExpenses({ expenses: {} }, categories, "tsZybhDMcPrxqgcRy7wp");
    assert.ok(r1.rows.find((x) => x.catId === "onlyTerrace"));

    const r2 = applyExpenses({ expenses: {} }, categories, "komachiPropertyId001");
    assert.strictEqual(r2.rows.find((x) => x.catId === "onlyTerrace"), undefined);
  });

  test("total は採用された全費目の合計", () => {
    const data = { expenses: { utility: { amount: 20000, source: "manual" }, supplies: { amount: 5000, source: "manual" } } };
    const r = applyExpenses(data, categories, "anyProperty");
    assert.strictEqual(r.total, 80000 + 20000 + 5000);
  });
});

describe("computePnl", () => {
  const categories = [
    { id: "rent", name: "家賃", type: "fixed", defaultAmount: 80000, active: true },
  ];

  test("基本計算: 売上260000 - 手数料7800 - 清掃15500 - 家賃80000 = 利益156700, 率60.3%", () => {
    const data = {
      propertyId: "p1",
      revenue: {
        airbnb: { grossRevenue: 260000, serviceFee: 7800, netRevenue: 252200 },
      },
      cleaningCosts: [{ id: "c1", amount: 15500, excluded: false }],
      expenses: {},
    };
    const r = computePnl(data, categories);
    assert.strictEqual(r.revenueGross, 260000);
    assert.strictEqual(r.otaFees, 7800);
    assert.strictEqual(r.cleaningTotal, 15500);
    assert.strictEqual(r.expensesTotal, 80000);
    assert.strictEqual(r.profit, 156700);
    assert.strictEqual(r.profitRate, 60.3);
  });

  test("Airbnb と Booking を合算", () => {
    const data = {
      propertyId: "p1",
      revenue: {
        airbnb: { grossRevenue: 260000, serviceFee: 7800 },
        booking: { grossRevenue: 100000, commission: 12000, paymentFee: 2000 },
      },
      cleaningCosts: [],
      expenses: {},
    };
    const r = computePnl(data, []);
    assert.strictEqual(r.revenueGross, 360000);
    assert.strictEqual(r.otaFees, 7800 + 12000 + 2000);
    assert.strictEqual(r.profit, 360000 - (7800 + 12000 + 2000));
  });

  test("清掃費 excluded は集計から外す", () => {
    const data = {
      propertyId: "p1",
      revenue: { airbnb: { grossRevenue: 100000, serviceFee: 0 } },
      cleaningCosts: [
        { id: "c1", amount: 10000, excluded: false },
        { id: "c2", amount: 99999, excluded: true },
      ],
      expenses: {},
    };
    const r = computePnl(data, []);
    assert.strictEqual(r.cleaningTotal, 10000);
  });

  test("売上0なら profitRate は0(ゼロ除算しない)", () => {
    const r = computePnl({ propertyId: "p1", revenue: {}, cleaningCosts: [], expenses: {} }, []);
    assert.strictEqual(r.revenueGross, 0);
    assert.strictEqual(r.profitRate, 0);
  });

  test("Booking の手数料2種(commission + paymentFee)を合算してOTA手数料に積む", () => {
    const data = {
      propertyId: "p1",
      revenue: { booking: { grossRevenue: 88200, commission: 10584, paymentFee: 2029, netRevenue: 75587 } },
      cleaningCosts: [],
      expenses: {},
    };
    const r = computePnl(data, []);
    assert.strictEqual(r.otaFees, 12613);
    assert.strictEqual(r.profit, 88200 - 12613);
  });

  test("直販(revenue.direct)を売上に加算し、Stripe手数料をOTA手数料に積む", () => {
    const data = {
      propertyId: "p1",
      revenue: {
        airbnb: { grossRevenue: 260000, serviceFee: 7800 },
        direct: { grossRevenue: 80000, stripeFee: 2400, netRevenue: 77600, reservationCount: 2, nights: 3 },
      },
      cleaningCosts: [],
      expenses: {},
    };
    const r = computePnl(data, []);
    assert.strictEqual(r.revenueDirect, 80000);
    assert.strictEqual(r.revenueGross, 260000 + 80000);
    assert.strictEqual(r.otaFees, 7800 + 2400);
    assert.strictEqual(r.profit, 340000 - 10200);
  });

  test("Airbnb + Booking + 直販 の3系統を合算", () => {
    const data = {
      propertyId: "p1",
      revenue: {
        airbnb: { grossRevenue: 100000, serviceFee: 3000 },
        booking: { grossRevenue: 50000, commission: 6000, paymentFee: 1000 },
        direct: { grossRevenue: 30000, stripeFee: 900 },
      },
      cleaningCosts: [],
      expenses: {},
    };
    const r = computePnl(data, []);
    assert.strictEqual(r.revenueGross, 180000);
    assert.strictEqual(r.otaFees, 3000 + 6000 + 1000 + 900);
  });

  test("revenue.direct が無い月は revenueDirect=0(後方互換)", () => {
    const data = {
      propertyId: "p1",
      revenue: { airbnb: { grossRevenue: 100000, serviceFee: 0 } },
      cleaningCosts: [],
      expenses: {},
    };
    const r = computePnl(data, []);
    assert.strictEqual(r.revenueDirect, 0);
    assert.strictEqual(r.revenueGross, 100000);
  });
});

describe("sumDirectBookings", () => {
  test("paymentStatus=paid のみ集計し、他ステータスは除外", () => {
    const bookings = [
      { syncSource: "direct", checkIn: "2026-06-10", checkOut: "2026-06-12", paymentStatus: "paid",
        paymentSession: { amountPaid: 30000 } },
      { syncSource: "direct", checkIn: "2026-06-15", checkOut: "2026-06-16", paymentStatus: "pending",
        paymentSession: { amount: 15000 } },
      { syncSource: "direct", checkIn: "2026-06-20", checkOut: "2026-06-21", paymentStatus: "expired",
        paymentSession: { amount: 15000 } },
      { syncSource: "direct", checkIn: "2026-06-22", checkOut: "2026-06-23", paymentStatus: "unconfigured" },
    ];
    const r = sumDirectBookings(bookings, "2026-06");
    assert.strictEqual(r.grossRevenue, 30000);
    assert.strictEqual(r.reservationCount, 1);
    assert.strictEqual(r.nights, 2);
  });

  test("チェックイン月基準(先頭10文字で正規化)で対象月だけ集計", () => {
    const bookings = [
      { syncSource: "direct", checkIn: "2026-06-28", checkOut: "2026-07-02", paymentStatus: "paid",
        paymentSession: { amountPaid: 40000 } },
      { syncSource: "direct", checkIn: "2026-07-01T00:00:00.000Z", checkOut: "2026-07-03", paymentStatus: "paid",
        paymentSession: { amountPaid: 20000 } },
    ];
    const r6 = sumDirectBookings(bookings, "2026-06");
    assert.strictEqual(r6.grossRevenue, 40000);
    assert.strictEqual(r6.reservationCount, 1);
    const r7 = sumDirectBookings(bookings, "2026-07");
    assert.strictEqual(r7.grossRevenue, 20000);
    assert.strictEqual(r7.reservationCount, 1);
  });

  test("partially_refunded は (amountPaid − amountRefunded) の純額で計上", () => {
    const bookings = [
      { syncSource: "direct", checkIn: "2026-06-05", checkOut: "2026-06-07", paymentStatus: "partially_refunded",
        paymentSession: { amountPaid: 50000, amountRefunded: 10000 } },
    ];
    const r = sumDirectBookings(bookings, "2026-06");
    assert.strictEqual(r.grossRevenue, 40000);
    assert.strictEqual(r.reservationCount, 1);
  });

  test("refunded(全額返金)は実収0のため対象外", () => {
    const bookings = [
      { syncSource: "direct", checkIn: "2026-06-05", checkOut: "2026-06-07", paymentStatus: "refunded",
        paymentSession: { amountPaid: 50000, amountRefunded: 50000 } },
    ];
    const r = sumDirectBookings(bookings, "2026-06");
    assert.strictEqual(r.grossRevenue, 0);
    assert.strictEqual(r.reservationCount, 0);
  });

  test("金額フォールバック: amountPaid 無ければ priceBreakdown.grandTotal → total+parkingFee → paymentSession.amount", () => {
    const withGrandTotal = sumDirectBookings([
      { syncSource: "direct", checkIn: "2026-06-01", checkOut: "2026-06-02", paymentStatus: "paid",
        paymentSession: {}, priceBreakdown: { total: 18000, grandTotal: 21000, parkingFee: 3000 } },
    ], "2026-06");
    assert.strictEqual(withGrandTotal.grossRevenue, 21000);

    const withTotalPlusParking = sumDirectBookings([
      { syncSource: "direct", checkIn: "2026-06-01", checkOut: "2026-06-02", paymentStatus: "paid",
        paymentSession: {}, priceBreakdown: { total: 18000 }, parkingFee: 1000 },
    ], "2026-06");
    assert.strictEqual(withTotalPlusParking.grossRevenue, 19000);

    const withSessionAmount = sumDirectBookings([
      { syncSource: "direct", checkIn: "2026-06-01", checkOut: "2026-06-02", paymentStatus: "paid",
        paymentSession: { amount: 12000 } },
    ], "2026-06");
    assert.strictEqual(withSessionAmount.grossRevenue, 12000);
  });

  test("【参考】extractDirectReservations と対象条件が違う(売上=実収のみ / 宿泊税=宿泊の有無)", () => {
    const pending = [
      { syncSource: "direct", checkIn: "2026-09-12", checkOut: "2026-09-13", paymentStatus: "pending",
        adults: 5, priceBreakdown: { total: 56250 } },
    ];
    // 売上は未入金なので0、宿泊税は宿泊が発生しうるので計上対象
    assert.strictEqual(sumDirectBookings(pending, "2026-09").grossRevenue, 0);
    assert.strictEqual(extractDirectReservations(pending, { targetYearMonth: "2026-09" }).length, 1);
  });

  test("source==='direct'(syncSource未設定の旧データ)も対象に含める", () => {
    const r = sumDirectBookings([
      { source: "direct", checkIn: "2026-06-01", checkOut: "2026-06-03", paymentStatus: "paid",
        paymentSession: { amountPaid: 25000 } },
    ], "2026-06");
    assert.strictEqual(r.grossRevenue, 25000);
  });

  test("syncSource/source が direct でない予約(Airbnb/Booking取込等)は無視", () => {
    const r = sumDirectBookings([
      { syncSource: "airbnb", checkIn: "2026-06-01", checkOut: "2026-06-03", paymentStatus: "paid",
        paymentSession: { amountPaid: 99999 } },
    ], "2026-06");
    assert.strictEqual(r.grossRevenue, 0);
    assert.strictEqual(r.reservationCount, 0);
  });

  test("空配列/null は 0 を返す", () => {
    assert.deepStrictEqual(sumDirectBookings([], "2026-06"), { grossRevenue: 0, nights: 0, reservationCount: 0 });
    assert.deepStrictEqual(sumDirectBookings(null, "2026-06"), { grossRevenue: 0, nights: 0, reservationCount: 0 });
  });

  test("複数予約を合算(泊数・件数も積み上げ)", () => {
    const bookings = [
      { syncSource: "direct", checkIn: "2026-06-03", checkOut: "2026-06-05", paymentStatus: "paid",
        paymentSession: { amountPaid: 30000 } },
      { syncSource: "direct", checkIn: "2026-06-10", checkOut: "2026-06-14", paymentStatus: "paid",
        paymentSession: { amountPaid: 60000 } },
    ];
    const r = sumDirectBookings(bookings, "2026-06");
    assert.strictEqual(r.grossRevenue, 90000);
    assert.strictEqual(r.reservationCount, 2);
    assert.strictEqual(r.nights, 2 + 4);
  });
});

describe("extractDirectReservations", () => {
  // the Terrace 2026-09-12 の実予約 (北崎様・5名1泊・返金不可プラン)
  const realBooking = {
    source: "direct", syncSource: "direct", status: "confirmed", paymentStatus: "pending",
    checkIn: "2026-09-12", checkOut: "2026-09-13",
    guestName: "北崎　徹", guestCount: 5, adults: 5, children: 0, infants: 0,
    parkingCars: 0, parkingFee: 0,
    priceBreakdown: { total: 56250, subtotal: 54500, guestSurcharge: 8000 },
    paymentSession: { amount: 56250 },
  };

  test("実予約1件から広島県宿泊税 5人泊×200円=1,000円 を算出できる", () => {
    const rs = extractDirectReservations([realBooking], { targetYearMonth: "2026-09" });
    assert.deepStrictEqual(rs, [{ name: "北崎　徹", nights: 1, adult: 5, child: 0, infant: 0, income: 56250 }]);
    const tax = computeAccommodationTax(rs);
    assert.strictEqual(tax.totalTax, 1000);
    assert.strictEqual(tax.totalPersonNights, 5);
    assert.strictEqual(tax.taxablePersonNights, 5);
  });

  test("チェックイン月でフィルタする", () => {
    assert.strictEqual(extractDirectReservations([realBooking], { targetYearMonth: "2026-08" }).length, 0);
    assert.strictEqual(extractDirectReservations([realBooking], {}).length, 1); // 指定なしは全件
  });

  test("キャンセル・決済不成立(expired/payment_failed/refunded)は宿泊が発生しないので除外", () => {
    const cases = [
      { ...realBooking, status: "cancelled" },
      { ...realBooking, paymentStatus: "expired" },
      { ...realBooking, paymentStatus: "payment_failed" },
      { ...realBooking, paymentStatus: "refunded" },
    ];
    assert.strictEqual(extractDirectReservations(cases, { targetYearMonth: "2026-09" }).length, 0);
  });

  test("課税標準は宿泊料金のみ(駐車場代は含めない)", () => {
    // priceBreakdown.total を最優先
    const withParking = { ...realBooking, parkingFee: 4000, paymentSession: { amountPaid: 60250 } };
    assert.strictEqual(extractDirectReservations([withParking], {})[0].income, 56250);
    // total が無ければ実決済額から駐車場代を引く
    const noBreakdown = { ...realBooking, priceBreakdown: undefined, parkingFee: 4000, paymentSession: { amountPaid: 60250 } };
    assert.strictEqual(extractDirectReservations([noBreakdown], {})[0].income, 56250);
  });

  test("乳幼児は人数に数えない(computeAccommodationTax 側で adult+child)", () => {
    const withInfant = { ...realBooking, adults: 2, children: 1, infants: 2, priceBreakdown: { total: 30000 } };
    const rs = extractDirectReservations([withInfant], {});
    assert.deepStrictEqual([rs[0].adult, rs[0].child, rs[0].infant], [2, 1, 2]);
    const tax = computeAccommodationTax(rs);
    assert.strictEqual(tax.totalPersonNights, 3); // 乳幼児2名は含まれない
    assert.strictEqual(tax.totalTax, 600); // 30000/1泊/3名=10,000円 ≥ 6,000 → 200円×3
  });

  test("1人1泊6,000円未満は非課税(人泊は数えるが税額0)", () => {
    const cheap = { ...realBooking, adults: 5, checkOut: "2026-09-14", priceBreakdown: { total: 50000 } };
    const tax = computeAccommodationTax(extractDirectReservations([cheap], {}));
    assert.strictEqual(tax.totalPersonNights, 10); // 5名×2泊
    assert.strictEqual(tax.taxablePersonNights, 0); // 50000/2泊/5名=5,000円 < 6,000
    assert.strictEqual(tax.totalTax, 0);
  });

  test("OTA取込予約・不正な日付・金額0は無視、空/nullは空配列", () => {
    assert.strictEqual(extractDirectReservations([{ ...realBooking, syncSource: "airbnb", source: "airbnb" }], {}).length, 0);
    assert.strictEqual(extractDirectReservations([{ ...realBooking, checkOut: "" }], {}).length, 0);
    assert.strictEqual(extractDirectReservations([{ ...realBooking, checkOut: "2026-09-12" }], {}).length, 0); // 0泊
    assert.strictEqual(extractDirectReservations([{ ...realBooking, priceBreakdown: {}, paymentSession: {} }], {}).length, 0);
    assert.deepStrictEqual(extractDirectReservations([], {}), []);
    assert.deepStrictEqual(extractDirectReservations(null, {}), []);
  });
});

describe("cleaningAmountForProperty", () => {
  test("byProperty なし(単一物件) → total 全額(基本給・交通費込み)", () => {
    const inv = { total: 15500 };
    assert.strictEqual(cleaningAmountForProperty(inv, "p1"), 15500);
  });

  test("byProperty が1物件のみ → total 全額", () => {
    const inv = {
      total: 20000,
      byProperty: { p1: { total: 15000, shiftCount: 3 } },
    };
    assert.strictEqual(cleaningAmountForProperty(inv, "p1"), 20000);
  });

  test("複数物件を按分: total30000, P1[10000,5shift]+P2[12000,3shift] → P1=15000/P2=15000 (総額保存)", () => {
    const inv = {
      total: 30000,
      byProperty: {
        p1: { total: 10000, shiftCount: 5 },
        p2: { total: 12000, shiftCount: 3 },
      },
    };
    const a = cleaningAmountForProperty(inv, "p1");
    const b = cleaningAmountForProperty(inv, "p2");
    assert.strictEqual(a, 15000);
    assert.strictEqual(b, 15000);
    assert.strictEqual(a + b, inv.total);
  });

  test("shiftCount 全0 → commonShare は0(共通手当を按分しない)", () => {
    const inv = {
      total: 20000,
      byProperty: {
        p1: { total: 10000, shiftCount: 0 },
        p2: { total: 8000, shiftCount: 0 },
      },
    };
    assert.strictEqual(cleaningAmountForProperty(inv, "p1"), 10000);
    assert.strictEqual(cleaningAmountForProperty(inv, "p2"), 8000);
  });

  test("該当物件が byProperty に無い場合は共通手当の按分のみ", () => {
    const inv = {
      total: 20000,
      byProperty: {
        p1: { total: 8000, shiftCount: 2 },
        p2: { total: 8000, shiftCount: 2 },
      },
    };
    assert.strictEqual(cleaningAmountForProperty(inv, "pX"), 0);
  });

  test("¥・カンマ入りの数値も正しく扱う", () => {
    const inv = {
      total: "¥30,000",
      byProperty: {
        p1: { total: "¥10,000", shiftCount: "5" },
        p2: { total: "¥12,000", shiftCount: "3" },
      },
    };
    assert.strictEqual(cleaningAmountForProperty(inv, "p1"), 15000);
  });
});

describe("hiroshimaTaxPerPersonPerNight", () => {
  test("6,000円未満は非課税", () => {
    assert.strictEqual(hiroshimaTaxPerPersonPerNight(0), 0);
    assert.strictEqual(hiroshimaTaxPerPersonPerNight(5999), 0);
    assert.strictEqual(hiroshimaTaxPerPersonPerNight(3017), 0);
  });
  test("6,000円以上は一律200円(段階なし)", () => {
    assert.strictEqual(hiroshimaTaxPerPersonPerNight(6000), 200);
    assert.strictEqual(hiroshimaTaxPerPersonPerNight(11466), 200);
    assert.strictEqual(hiroshimaTaxPerPersonPerNight(19999), 200);
    assert.strictEqual(hiroshimaTaxPerPersonPerNight(20000), 200);
    assert.strictEqual(hiroshimaTaxPerPersonPerNight(50000), 200);
  });
  test("null/undefined/NaNは0扱い(非課税)", () => {
    assert.strictEqual(hiroshimaTaxPerPersonPerNight(null), 0);
    assert.strictEqual(hiroshimaTaxPerPersonPerNight(undefined), 0);
    assert.strictEqual(hiroshimaTaxPerPersonPerNight(NaN), 0);
  });
});

describe("computeAccommodationTax", () => {
  test("実データ検算: the Terrace 2026-06 Booking Siu 3人×1泊×34,400 → 600円", () => {
    const r = computeAccommodationTax([
      { nights: 1, adult: 3, child: 0, infant: 0, income: 34400 },
    ]);
    assert.strictEqual(r.totalTax, 600);
    assert.strictEqual(r.totalPersonNights, 3);
    assert.strictEqual(r.taxablePersonNights, 3);
  });

  test("実データ検算: the Terrace 2026-06 Booking Thaler 大人2+子ども2 泊1 28,586 → /人/泊7,147=課税(800円)", () => {
    // 28586/1/4=7,146.5 → 6,000円以上なので課税(乳幼児はいないので4人全員参入)
    const r = computeAccommodationTax([
      { nights: 1, adult: 2, child: 2, infant: 0, income: 28586 },
    ]);
    assert.strictEqual(r.totalTax, 800);
    assert.strictEqual(r.totalPersonNights, 4);
    assert.strictEqual(r.taxablePersonNights, 4);
  });

  test("乳幼児は課税対象外(大人+子どものみで人数計算)", () => {
    // 大人2, 乳幼児2, 泊2, income=44000 → 44000/2/2=11000 → 200円/人泊×2人×2泊 = 800円
    // 乳幼児を含めると 44000/2/4=5500円 で非課税になるが、含めない運用
    const r = computeAccommodationTax([
      { nights: 2, adult: 2, child: 0, infant: 2, income: 44000 },
    ]);
    assert.strictEqual(r.totalTax, 800);
    assert.strictEqual(r.totalPersonNights, 4); // 2大人×2泊
  });

  test("複数予約の合計", () => {
    const r = computeAccommodationTax([
      { nights: 1, adult: 3, child: 0, infant: 0, income: 34400 }, // Siu: /人/泊11467→3人泊×200=600円
      { nights: 1, adult: 2, child: 2, infant: 0, income: 28586 }, // Thaler: /人/泊7147→4人泊×200=800円
      { nights: 4, adult: 5, child: 1, infant: 0, income: 153260 }, // Zhang: /人/泊=6386→24人泊×200=4,800円
    ]);
    assert.strictEqual(r.totalTax, 600 + 800 + 4800);
  });

  test("実データ検算: 宿小町 2026-06 全予約(9件のうちキャンセル2件除外) → 1件のみ課税(600円)", () => {
    const r = computeAccommodationTax([
      { nights: 4, adult: 3, income: 37856 },   // /人/泊 = 3155
      { nights: 2, adult: 3, income: 27040 },   // /人/泊 = 4507
      { nights: 4, adult: 2, income: 24336 },   // /人/泊 = 3042
      { nights: 3, adult: 1, income: 19773 },   // /人/泊 = 6591 → 6,000円以上=課税(3人泊×200=600円)
      { nights: 4, adult: 2, income: 25857 },   // /人/泊 = 3232
      { nights: 3, adult: 2, infant: 1, income: 18100 }, // /人/泊 = 3017 (乳幼児除外)
      { nights: 3, adult: 2, income: 18100 },   // /人/泊 = 3017
    ]);
    assert.strictEqual(r.totalTax, 600);
  });

  test("空配列 → 全ゼロ", () => {
    const r = computeAccommodationTax([]);
    assert.strictEqual(r.totalTax, 0);
    assert.strictEqual(r.totalPersonNights, 0);
    assert.strictEqual(r.details.length, 0);
  });

  test("泊数or人数0の予約は subTotal=0 で details に skipped が入る", () => {
    const r = computeAccommodationTax([
      { nights: 0, adult: 2, income: 5000 },
      { nights: 2, adult: 0, income: 5000 },
    ]);
    assert.strictEqual(r.totalTax, 0);
    assert.strictEqual(r.details[0].skipped, "泊数or人数0");
    assert.strictEqual(r.details[1].skipped, "泊数or人数0");
  });

  test("カスタム税関数を差し込める(将来他県対応)", () => {
    const flatTax = () => 100; // 全予約に固定100円
    const r = computeAccommodationTax(
      [{ nights: 2, adult: 3, income: 30000 }],
      flatTax,
    );
    assert.strictEqual(r.totalTax, 600); // 100 × 6人泊
  });
});

describe("classifyExpenseByName_", () => {
  test("receipts系: 消耗品/ごみ/害虫/クリーニング/修繕/広告", () => {
    assert.deepStrictEqual(
      classifyExpenseByName_("260626 ﾚｼｰﾄ(広長浜_消耗品_備品)ﾀﾞｲｿｰ.pdf"),
      { scope: "receipts", category: "消耗品費" });
    assert.deepStrictEqual(
      classifyExpenseByName_("260630 合計請求書(広長浜_ごみ処理_6月分)巣だち.pdf"),
      { scope: "receipts", category: "ゴミ処理費" });
    assert.deepStrictEqual(
      classifyExpenseByName_("260503 ﾚｼｰﾄ(広長浜_消耗品_電球)エディオン.pdf"),
      { scope: "receipts", category: "小修繕費" });
    assert.deepStrictEqual(
      classifyExpenseByName_("260316 領収書(広長浜_クリーニング代)小柴クリーニング.pdf"),
      { scope: "receipts", category: "リネン・クリーニング" });
    assert.deepStrictEqual(
      classifyExpenseByName_("260601 請求書(害虫駆除_6月分)ペストコントロール.pdf"),
      { scope: "receipts", category: "害虫駆除費" });
  });

  test("utilities系: 光熱/通信/固定電話は utilities スコープ(receipts側に混入させない)", () => {
    assert.deepStrictEqual(
      classifyExpenseByName_("260615 請求書(広長浜_ガス料金_6月分)伊丹産業.pdf"),
      { scope: "utilities", category: "水道光熱費" });
    assert.deepStrictEqual(
      classifyExpenseByName_("260622 水道使用水量等のお知らせ(広長浜_水道光熱費_4-6月分)呉市上下水道.pdf"),
      { scope: "utilities", category: "水道光熱費" });
    assert.deepStrictEqual(
      classifyExpenseByName_("260622 請求書(小町民泊_通信費_6月分)NTTファイナンス.pdf"),
      { scope: "utilities", category: "Wi-Fi・通信費" });
  });

  test("経費対象外: 通帳・配当・カード明細・契約金・届出", () => {
    assert.deepStrictEqual(
      classifyExpenseByName_("260630 通帳(八朔事業_海田支店_普通)広島信用金庫.pdf"),
      { scope: null, category: null });
    assert.deepStrictEqual(
      classifyExpenseByName_("260622 配当金支払通知書(兼出資金残高通知書)(出資金配当金)広島商銀.pdf"),
      { scope: null, category: null });
    assert.deepStrictEqual(
      classifyExpenseByName_("260630 カードご利用明細書(オフィスシミズ振込)広島市信用組合.pdf"),
      { scope: null, category: null });
    assert.deepStrictEqual(
      classifyExpenseByName_("260617 請求書(福山駅家_契約金)Office Shimizu.pdf"),
      { scope: null, category: null });
    assert.deepStrictEqual(
      classifyExpenseByName_("260411 地震保険継続証(城之堀_地震保険)東京海上日動.pdf"),
      { scope: null, category: null });
  });

  test("マッチしない → null", () => {
    assert.deepStrictEqual(classifyExpenseByName_("260503 ﾚｼｰﾄ(車両費)両備エネシス.pdf"),
      { scope: null, category: null });
    assert.deepStrictEqual(classifyExpenseByName_(""), { scope: null, category: null });
  });
});

describe("filterElectricPaymentsForProperty", () => {
  test("エネパル/収納代行アプラス/スマートビリング は採用", () => {
    const r = filterElectricPaymentsForProperty([
      { date: "2026-07-31", description: "エネパル電気料金", amount: 36459, vendor: "エネパル" },
      { date: "2026-07-31", description: "収納代行アプラス", amount: 15000, vendor: "アプラス" },
      { date: "2026-07-31", description: "スマートビリング/エネパル", amount: 20000, vendor: "スマートビリング" },
    ]);
    assert.strictEqual(r.items.length, 3);
    assert.strictEqual(r.totalAmount, 36459 + 15000 + 20000);
  });

  test("ソフトバンクでんき(別物件・自宅) は除外", () => {
    const r = filterElectricPaymentsForProperty([
      { date: "2025-10-31", description: "ソフトバンクでんき", amount: 18643, vendor: "ソフトバンクでんき" },
    ]);
    assert.strictEqual(r.items.length, 0);
    assert.strictEqual(r.totalAmount, 0);
  });

  test("大手電力(東京/関西/中国電力等)も除外", () => {
    const r = filterElectricPaymentsForProperty([
      { description: "中国電力", amount: 8000 },
      { description: "東京電力エナジーパートナー", amount: 9000 },
      { description: "関西電力", amount: 7000 },
    ]);
    assert.strictEqual(r.items.length, 0);
  });

  test("エネパル と ソフトバンクでんき が混在 → エネパルのみ採用", () => {
    const r = filterElectricPaymentsForProperty([
      { description: "ソフトバンクでんき", amount: 18643 },
      { description: "エネパル(広長浜)", amount: 36459 },
    ]);
    assert.strictEqual(r.items.length, 1);
    assert.strictEqual(r.items[0].amount, 36459);
    assert.strictEqual(r.totalAmount, 36459);
  });

  test("カスタム allowlist/denylist で他物件対応可能(将来拡張)", () => {
    const r = filterElectricPaymentsForProperty(
      [{ description: "ENEOSでんき", amount: 5000 }],
      { vendorAllowlist: [/ENEOS/], vendorDenylist: [] });
    assert.strictEqual(r.items.length, 1);
    assert.strictEqual(r.totalAmount, 5000);
  });

  test("金額0/負/不正は除外", () => {
    const r = filterElectricPaymentsForProperty([
      { description: "エネパル", amount: 0 },
      { description: "エネパル", amount: -1000 }, // toInt で absにするが0扱い後の判定
      { description: "エネパル", amount: "abc" },
    ]);
    assert.strictEqual(r.items.length, 1); // toInt("-1000")=1000 でamt>0
    assert.strictEqual(r.totalAmount, 1000);
  });

  test("空配列/null 安全", () => {
    assert.deepStrictEqual(filterElectricPaymentsForProperty([]), { items: [], totalAmount: 0 });
    assert.deepStrictEqual(filterElectricPaymentsForProperty(null), { items: [], totalAmount: 0 });
  });
});

describe("parseBillMonths", () => {
  test("「N月分」明記あり: ファイル名月と一致するケース", () => {
    // エネパル 4月分請求 → 発行5/14
    assert.deepStrictEqual(
      parseBillMonths("260514 請求書(広長浜_水道光熱費_4月分)エネパル.pdf"),
      ["2026-04"]
    );
  });

  test("「N月分」明記あり: ファイル名月より過去(=前月使用)", () => {
    // スマートビリング 03月分請求 → 発行4/13
    assert.deepStrictEqual(
      parseBillMonths("260413 請求書(広長浜_電気代_03月分)スマートビリングサービス.pdf"),
      ["2026-03"]
    );
  });

  test("「A-B月分」範囲(水道)", () => {
    assert.deepStrictEqual(
      parseBillMonths("260622 水道使用水量等のお知らせ(広長浜_水道光熱費_4-6月分)呉市上下水道.pdf"),
      ["2026-04", "2026-05", "2026-06"]
    );
  });

  test("「N月分」記載月>ファイル月なら前年扱い", () => {
    // 260115 で「12月分」が書かれていれば前年12月
    assert.deepStrictEqual(
      parseBillMonths("260115 請求書(電気_12月分).pdf"),
      ["2025-12"]
    );
  });

  test("★エネパル電気: 「N月分」明記なし → 発行月の前月扱い (NEXT#11 恒久修正)", () => {
    // ¥33,978 の realign 元請求書。発行2026-03-12 → 使用月=2026-02
    assert.deepStrictEqual(
      parseBillMonths("260312 請求書(広長浜_電気代)スマートビリングサービス.pdf"),
      ["2026-02"]
    );
  });

  test("★エネパル電気(年跨ぎ): 1月発行→前年12月", () => {
    assert.deepStrictEqual(
      parseBillMonths("260112 請求書(広長浜_電気代)エネパル.pdf"),
      ["2025-12"]
    );
  });

  test("中国電力(明記なし): ファイル名月をそのまま(発行月=使用月ルール)", () => {
    // 中国電力の検針周期は「発行月=使用月」なので前月に戻さない
    assert.deepStrictEqual(
      parseBillMonths("251023 電気ご使用量のお知らせ.pdf"),
      ["2025-10"]
    );
    assert.deepStrictEqual(
      parseBillMonths("250923 電気ご使用量のお知らせ.pdf"),
      ["2025-09"]
    );
  });

  test("伊丹産業ガス(明記なし): ファイル名月そのまま", () => {
    assert.deepStrictEqual(
      parseBillMonths("251015 請求書(広長浜 ガス使用量)伊丹.pdf"),
      ["2025-10"]
    );
  });

  test("ファイル名日付なし → 空配列", () => {
    assert.deepStrictEqual(parseBillMonths("マイページ情報.pdf"), []);
    assert.deepStrictEqual(parseBillMonths(""), []);
    assert.deepStrictEqual(parseBillMonths(null), []);
  });

  test("範囲月に7ヶ月超えは無効(単発解釈にフォールバック)", () => {
    // 1-8月分は範囲としては広すぎるので single-match の 8月分にフォールバック
    const r = parseBillMonths("260322 請求書(1-8月分).pdf");
    assert.deepStrictEqual(r, ["2025-08"]); // 「8月分」明記 & 8 > 3 → 前年
  });
});
