/**
 * pnl-logic の純粋関数ユニットテスト
 * 実行: cd functions && npx jest api/pnl-logic.test.js
 */
const {
  toInt,
  normLoose,
  normalizeStaffName,
  resolvePropertyForDoc,
  applyExpenses,
  computePnl,
} = require("./pnl-logic");

describe("toInt", () => {
  test("通常の数値", () => {
    expect(toInt(260000)).toBe(260000);
    expect(toInt(0)).toBe(0);
  });
  test("¥とカンマを除去", () => {
    expect(toInt("¥260,000")).toBe(260000);
    expect(toInt("¥7,800")).toBe(7800);
  });
  test("マイナスは絶対値で返す(手数料の符号誤りを防ぐ)", () => {
    expect(toInt("-7800")).toBe(7800);
    expect(toInt(-1234)).toBe(1234);
  });
  test("null/undefined/不正値は0", () => {
    expect(toInt(null)).toBe(0);
    expect(toInt(undefined)).toBe(0);
    expect(toInt("abc")).toBe(0);
    expect(toInt("")).toBe(0);
  });
});

describe("normLoose", () => {
  test("空白・装飾記号除去・小文字化", () => {
    expect(normLoose("the Terrace 長浜")).toBe("theterrace長浜");
    expect(normLoose("瀬戸内海ビュー大テラス｜10名OK・BBQ可")).toBe("瀬戸内海ビュー大テラス10名okbbq可");
  });
  test("null/undefined は空文字", () => {
    expect(normLoose(null)).toBe("");
    expect(normLoose(undefined)).toBe("");
  });
});

describe("normalizeStaffName", () => {
  test("法人格・敬称除去", () => {
    expect(normalizeStaffName("株式会社オオサワ創研 御中")).toBe("オオサワ創研");
    expect(normalizeStaffName("田中俊子様")).toBe("田中俊子");
  });
  test("カッコ書き(カナ読み等)を除去", () => {
    expect(normalizeStaffName("原垣琴美(ハラガキコトミ)")).toBe("原垣琴美");
    expect(normalizeStaffName("田中俊子（タナカトシコ）")).toBe("田中俊子");
  });
  test("空入力", () => {
    expect(normalizeStaffName("")).toBe("");
    expect(normalizeStaffName(null)).toBe("");
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
    expect(resolvePropertyForDoc(parsed, properties, null)).toBe("tsZybhDMcPrxqgcRy7wp");
  });

  test("Booking施設IDで一致(YADO KOMACHI)", () => {
    const parsed = { docKind: "booking_detail", booking: { propertyFacilityId: "15203947" } };
    expect(resolvePropertyForDoc(parsed, properties, null)).toBe("komachiPropertyId001");
  });

  test("Airbnbリスティング名で一致", () => {
    const parsed = { docKind: "airbnb_monthly", airbnb: { listingName: "瀬戸内海ビュー大テラス｜10名OK・BBQ可・駐車3台" } };
    expect(resolvePropertyForDoc(parsed, properties, null)).toBe("tsZybhDMcPrxqgcRy7wp");
  });

  test("Airbnb旧リスティング名(エイリアス)で一致", () => {
    const parsed = { docKind: "airbnb_monthly", airbnb: { listingName: "【NewOpenSALE】オーシャンビューテラスでBBQも。高台に佇む一棟貸切のお宿。最大10名様" } };
    expect(resolvePropertyForDoc(parsed, properties, null)).toBe("tsZybhDMcPrxqgcRy7wp");
  });

  test("清掃請求書: 物件名で曖昧一致", () => {
    const parsed = { docKind: "cleaning_invoice", cleaning: { propertyName: "the Terrace 長浜" } };
    expect(resolvePropertyForDoc(parsed, properties, null)).toBe("tsZybhDMcPrxqgcRy7wp");
  });

  test("該当なしで fallback 返す", () => {
    const parsed = { docKind: "other", propertyName: "存在しない宿" };
    expect(resolvePropertyForDoc(parsed, properties, "fallback-id")).toBe("fallback-id");
  });

  test("fallback も無ければ null", () => {
    const parsed = { docKind: "other" };
    expect(resolvePropertyForDoc(parsed, properties, null)).toBe(null);
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
    expect(rent.amount).toBe(80000);
    expect(rent.source).toBe("fixed");
    expect(rent.overridden).toBe(false);
  });

  test("manual費目は未入力なら0", () => {
    const data = { expenses: {} };
    const r = applyExpenses(data, categories, "anyProperty");
    const util = r.rows.find((x) => x.catId === "utility");
    expect(util.amount).toBe(0);
  });

  test("手入力(overridden)は保持してマスタの既定額を上書きする", () => {
    const data = { expenses: { rent: { amount: 100000, source: "fixed", overridden: true } } };
    const r = applyExpenses(data, categories, "anyProperty");
    const rent = r.rows.find((x) => x.catId === "rent");
    expect(rent.amount).toBe(100000);
    expect(rent.overridden).toBe(true);
  });

  test("active=false の費目は除外", () => {
    const r = applyExpenses({ expenses: {} }, categories, "anyProperty");
    expect(r.rows.find((x) => x.catId === "inactive")).toBeUndefined();
  });

  test("appliesTo が配列のとき、対象物件だけに適用", () => {
    const r1 = applyExpenses({ expenses: {} }, categories, "tsZybhDMcPrxqgcRy7wp");
    expect(r1.rows.find((x) => x.catId === "onlyTerrace")).toBeDefined();

    const r2 = applyExpenses({ expenses: {} }, categories, "komachiPropertyId001");
    expect(r2.rows.find((x) => x.catId === "onlyTerrace")).toBeUndefined();
  });

  test("total は採用された全費目の合計", () => {
    const data = { expenses: { utility: { amount: 20000, source: "manual" }, supplies: { amount: 5000, source: "manual" } } };
    const r = applyExpenses(data, categories, "anyProperty");
    expect(r.total).toBe(80000 + 20000 + 5000);
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
    expect(r.revenueGross).toBe(260000);
    expect(r.otaFees).toBe(7800);
    expect(r.cleaningTotal).toBe(15500);
    expect(r.expensesTotal).toBe(80000);
    expect(r.profit).toBe(156700);
    expect(r.profitRate).toBe(60.3);
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
    const r = computePnl(data, [/* no categories */]);
    expect(r.revenueGross).toBe(360000);
    expect(r.otaFees).toBe(7800 + 12000 + 2000);
    expect(r.profit).toBe(360000 - (7800 + 12000 + 2000));
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
    expect(r.cleaningTotal).toBe(10000);
  });

  test("売上0なら profitRate は0(ゼロ除算しない)", () => {
    const r = computePnl({ propertyId: "p1", revenue: {}, cleaningCosts: [], expenses: {} }, []);
    expect(r.revenueGross).toBe(0);
    expect(r.profitRate).toBe(0);
  });

  test("Booking の手数料2種(commission + paymentFee)を合算してOTA手数料に積む", () => {
    const data = {
      propertyId: "p1",
      revenue: { booking: { grossRevenue: 88200, commission: 10584, paymentFee: 2029, netRevenue: 75587 } },
      cleaningCosts: [],
      expenses: {},
    };
    const r = computePnl(data, []);
    expect(r.otaFees).toBe(12613);
    expect(r.profit).toBe(88200 - 12613);
  });
});
