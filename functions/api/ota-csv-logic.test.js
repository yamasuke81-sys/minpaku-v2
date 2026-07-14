const { test } = require("node:test");
const assert = require("node:assert");
const {
  parseCsv, parseYen, sumAirbnbCsv, sumBookingCsv, computeSettlement,
  resolveOperationMode, isAgencyMode, effectiveFeeRatePct, computeDepositAmount,
  extractAirbnbReservations, extractBookingReservations,
} = require("./ota-csv-logic");
const { computeAccommodationTax } = require("./pnl-logic");

// 実データ(宿小町 2026-05 Airbnb CSV, yadozei保存物)。キャンセル1件(¥0)含む。
const AIRBNB_KOMACHI_MAY = `"確認コード","ステータス","ゲスト名","連絡先","大人の人数","子どもの人数","乳幼児の人数","開始日","終了日","宿泊日数","予約済み","リスティング","収入"
"HMQMR4S5D4","過去のゲスト","Jessie Lee","","2","0","0","2026/5/29","2026/6/1","3","2026-04-30","【YADO KOMACHI】広島中心部・洗練されたモダンアパートメントで暮らすように滞在","¥18,100"
"HMM8QEYQEE","過去のゲスト","士萱 游","","2","0","0","2026/5/26","2026/5/29","3","2026-05-14","【YADO KOMACHI】広島中心部・洗練されたモダンアパートメントで暮らすように滞在","¥19,773"
"HMAJXEJ8KW","ゲストによりキャンセル済み","佳敏","","2","0","0","2026/5/26","2026/5/29","3","2026-05-01","【YADO KOMACHI】広島中心部・洗練されたモダンアパートメントで暮らすように滞在","¥0"
"HM22JK4T4M","過去のゲスト","Luke Lacy","","3","0","0","2026/5/22","2026/5/24","2","2026-04-25","【YADO KOMACHI】広島中心部・洗練されたモダンアパートメントで暮らすように滞在","¥32,110"
"HMMMDXFRWK","過去のゲスト","재이 김","","2","0","0","2026/5/18","2026/5/22","4","2026-05-02","【YADO KOMACHI】広島中心部・洗練されたモダンアパートメントで暮らすように滞在","¥25,857"
"HMB8AENP9B","過去のゲスト","松本 和樹","","2","0","0","2026/5/16","2026/5/17","1","2026-04-29","【YADO KOMACHI】広島中心部・洗練されたモダンアパートメントで暮らすように滞在","¥12,675"
"HMJX3TWPDK","過去のゲスト","원중 이","","2","0","0","2026/5/10","2026/5/13","3","2026-04-29","【YADO KOMACHI】広島中心部・洗練されたモダンアパートメントで暮らすように滞在","¥15,514"
"HM2QHJB9A2","過去のゲスト","河津 雄介","","3","0","0","2026/5/4","2026/5/6","2","2026-04-23","【YADO KOMACHI】広島中心部・洗練されたモダンアパートメントで暮らすように滞在","¥37,180"
"HMN3W8WDR3","過去のゲスト","Marcel Leirer","","2","0","0","2026/5/2","2026/5/4","2","2026-04-23","【YADO KOMACHI】広島中心部・洗練されたモダンアパートメントで暮らすように滞在","¥40,560"
`;

// 実データ(the Terrace 2026-05 Booking CSV 抜粋)。cancelled_by_hotel 1件含む。
const BOOKING_TERRACE_MAY = `予約番号,予約者名,宿泊者氏名,チェックイン,チェックアウト,予約日,ステータス,客室数,人数,大人,子供,子供の年齢,料金,コミッション率,コミッション額,支払いステータス,お支払い方法（決済代行会社）,備考,Booker country,旅行目的,利用端末,ユニットタイプ,滞在期間（泊数）,キャンセル日,住所,電話番号
5750794035,"Matsuura, Masanori",Masanori Matsuura,2026-05-03,2026-05-04,2026-04-19 14:34:07,cancelled_by_hotel,1,4,2,2,"6, 9",36125 JPY,15,,,,,jp,レジャー,携帯電話,Villa with Sea View,1,2026-04-20 01:26:57,Shimanekenyasugisikuroidatyou200−130,
6787949698,"shimizu, takashi",takashi shimizu,2026-05-03,2026-05-05,2026-03-22 10:31:26,ok,1,10,5,5,"3, 9, 12, 10, 4",190000 JPY,15,28500 JPY,Booking.comによる支払い,,free parking,jp,レジャー,携帯電話,Villa with Sea View,2,,大阪府大阪狭山市池尻中3-1-8,
6276322528,"Jordaan, Lorraine",Lorraine Jordaan,2026-05-14,2026-05-17,2026-03-13 08:38:59,ok,1,2,2,0,,73600 JPY,15,11040 JPY,Booking.comによる支払い,,,za,レジャー,携帯電話,Villa with Sea View,3,,"20 Cranleigh Annex, Samantha Road",
6458156181,"Fujiwara, Takumi",Takumi Fujiwara,2026-05-23,2026-05-24,2026-03-26 10:20:06,ok,1,6,6,0,,72000 JPY,15,10800 JPY,Booking.comによる支払い,,free parking,jp,レジャー,携帯電話,Villa with Sea View,1,,兵庫県川辺郡猪名川町松尾台2-1-12 E-610,
`;

test("parseYen: ¥/JPY/カンマ除去", () => {
  assert.strictEqual(parseYen("¥18,100"), 18100);
  assert.strictEqual(parseYen("36125 JPY"), 36125);
  assert.strictEqual(parseYen("28,500"), 28500);
  assert.strictEqual(parseYen(""), 0);
  assert.strictEqual(parseYen(null), 0);
});

test("parseCsv: クォート内カンマを保持", () => {
  const rows = parseCsv(`a,"b,c",d\n1,"2,3",4\n`);
  assert.deepStrictEqual(rows[0], ["a", "b,c", "d"]);
  assert.deepStrictEqual(rows[1], ["1", "2,3", "4"]);
});

test("sumAirbnbCsv: 宿小町5月 = 201,769 (キャンセル除外)", () => {
  const r = sumAirbnbCsv(AIRBNB_KOMACHI_MAY);
  assert.strictEqual(r.grossRevenue, 201769);
  assert.strictEqual(r.reservationCount, 8);
  assert.strictEqual(r.canceledCount, 1);
  assert.strictEqual(r.nights, 3 + 3 + 2 + 4 + 1 + 3 + 2 + 2); // 20泊
});

test("sumAirbnbCsv: listingName フィルタ(一致)", () => {
  const r = sumAirbnbCsv(AIRBNB_KOMACHI_MAY, { listingName: "【YADO KOMACHI】広島中心部・洗練されたモダンアパートメントで暮らすように滞在" });
  assert.strictEqual(r.grossRevenue, 201769);
});

test("sumAirbnbCsv: listingName フィルタ(不一致→0)", () => {
  const r = sumAirbnbCsv(AIRBNB_KOMACHI_MAY, { listingName: "瀬戸内海ビュー大テラス" });
  assert.strictEqual(r.grossRevenue, 0);
  assert.strictEqual(r.reservationCount, 0);
});

test("sumBookingCsv: the Terrace5月 = gross335,600 / comm50,340 / fee7,719 / net277,541(銀行入金6/4と一致)", () => {
  const r = sumBookingCsv(BOOKING_TERRACE_MAY);
  assert.strictEqual(r.grossRevenue, 335600);
  assert.strictEqual(r.commission, 50340);
  // 決済手数料 round(gross×2.3%)/滞在: 190,000→4,370 + 73,600→1,693 + 72,000→1,656
  assert.strictEqual(r.paymentFee, 4370 + 1693 + 1656);
  // net = 実際の銀行入金額(2026-06-04 楽天第三 ¥277,541 と一致・実証済)
  assert.strictEqual(r.netRevenue, 277541);
  assert.strictEqual(r.reservationCount, 3);
  assert.strictEqual(r.canceledCount, 1); // 料金不徴収キャンセル(comm=0)
  assert.strictEqual(r.chargedCancelCount, 0);
  assert.strictEqual(r.nights, 2 + 3 + 1); // 6泊
});

test("sumBookingCsv: キャンセル料徴収(comm>0のcancelled)は売上として計上・泊数は加算しない", () => {
  // 実例: 2026-04 Stefan Lang 4/24-26 guest cancel 100%徴収 → 5/8入金 ¥38,704 と1円一致
  const csv = [
    "予約番号,チェックイン,チェックアウト,ステータス,料金,コミッション額,滞在期間（泊数）",
    "6090699951,2026-04-24,2026-04-26,cancelled_by_guest,46800 JPY,7020 JPY,2",
    "9999999999,2026-04-23,2026-04-26,cancelled_by_guest,130410 JPY,,3", // 無料キャンセル(comm空)
  ].join("\n") + "\n";
  const r = sumBookingCsv(csv);
  assert.strictEqual(r.grossRevenue, 46800);
  assert.strictEqual(r.commission, 7020);
  assert.strictEqual(r.paymentFee, 1076); // round(46,800×2.3%)
  assert.strictEqual(r.netRevenue, 38704);
  assert.strictEqual(r.reservationCount, 0);
  assert.strictEqual(r.nights, 0);
  assert.strictEqual(r.chargedCancelCount, 1);
  assert.strictEqual(r.canceledCount, 1);
});

test("computeSettlement: 宿小町5月 料率50%/消費税10%/宿泊税0", () => {
  const s = computeSettlement({ depositAmount: 201769, taxWithholding: 0, feeRatePct: 50, consumptionTaxPct: 10 });
  assert.strictEqual(s.salesBase, 201769);
  // 201769 × 50% = 100884.5 → 四捨五入 100885
  assert.strictEqual(s.feeExclTax, 100885);
  // 100885 × 10% = 10088.5 → 四捨五入 10089
  assert.strictEqual(s.consumptionTax, 10089);
  assert.strictEqual(s.feeInclTax, 110974);
});

test("computeSettlement: 宿泊税預りBを差し引く(後方互換・売上ベース)", () => {
  const s = computeSettlement({ depositAmount: 201769, taxWithholding: 1769, feeRatePct: 50 });
  assert.strictEqual(s.basis, "revenue");
  assert.strictEqual(s.salesBase, 200000);
  assert.strictEqual(s.feeExclTax, 100000);
  assert.strictEqual(s.consumptionTax, 10000);
  assert.strictEqual(s.feeInclTax, 110000);
});

test("computeSettlement: 利益ベース(feeBase) — 運営利益×料率", () => {
  // 運営利益 90000 × 50% = 45000、消費税 4500、税込 49500
  const s = computeSettlement({ feeBase: 90000, feeRatePct: 50, consumptionTaxPct: 10 });
  assert.strictEqual(s.basis, "profit");
  assert.strictEqual(s.feeBase, 90000);
  assert.strictEqual(s.salesBase, 90000); // 後方互換の別名
  assert.strictEqual(s.feeExclTax, 45000);
  assert.strictEqual(s.consumptionTax, 4500);
  assert.strictEqual(s.feeInclTax, 49500);
});

test("computeSettlement: 利益ベース — 宿泊税は基礎に影響しない", () => {
  // feeBase(運営利益) 100000 が基礎。taxWithholding を渡しても feeBase 側が優先され不変
  const s = computeSettlement({ feeBase: 100000, taxWithholding: 5000, depositAmount: 300000, feeRatePct: 50 });
  assert.strictEqual(s.feeBase, 100000);
  assert.strictEqual(s.feeExclTax, 50000);
});

test("computeSettlement: 利益ベース — 運営利益が0以下なら手数料0(フロア)", () => {
  const s = computeSettlement({ feeBase: -12000, feeRatePct: 50, consumptionTaxPct: 10 });
  assert.strictEqual(s.feeBase, 0);
  assert.strictEqual(s.feeExclTax, 0);
  assert.strictEqual(s.consumptionTax, 0);
  assert.strictEqual(s.feeInclTax, 0);
});

test("resolveOperationMode: operationMode優先 / settlementMode後方互換 / 既定=八朔", () => {
  assert.strictEqual(resolveOperationMode({ operationMode: "self" }), "self");
  assert.strictEqual(resolveOperationMode({ operationMode: "agency_other" }), "agency_other");
  // 不正値は無視して後方互換にフォールバック
  assert.strictEqual(resolveOperationMode({ operationMode: "xxx", settlementMode: "self" }), "self");
  assert.strictEqual(resolveOperationMode({ settlementMode: "self" }), "self");
  assert.strictEqual(resolveOperationMode({ settlementMode: "daiko" }), "agency_hassac");
  assert.strictEqual(resolveOperationMode({}), "agency_hassac");
  assert.strictEqual(resolveOperationMode(null), "agency_hassac");
});

test("isAgencyMode: 代行あり2種のみ true", () => {
  assert.strictEqual(isAgencyMode("agency_hassac"), true);
  assert.strictEqual(isAgencyMode("agency_other"), true);
  assert.strictEqual(isAgencyMode("self"), false);
});

test("effectiveFeeRatePct: 自社運営は誤入力を無視して常に0", () => {
  // operationMode=self なら物件料率50でも月料率30でも0
  assert.strictEqual(effectiveFeeRatePct({ feeRatePct: 30 }, { operationMode: "self", managementFeeRate: 50 }), 0);
  assert.strictEqual(effectiveFeeRatePct({}, { settlementMode: "self", managementFeeRate: 50 }), 0);
});

test("effectiveFeeRatePct: 月固定 > 物件既定 > 50。0も有効値", () => {
  const prop = { operationMode: "agency_hassac", managementFeeRate: 40 };
  // 月固定が最優先(0含む)
  assert.strictEqual(effectiveFeeRatePct({ feeRatePct: 30 }, prop), 30);
  assert.strictEqual(effectiveFeeRatePct({ feeRatePct: 0 }, prop), 0);
  // 月未設定 → 物件既定(0含む)
  assert.strictEqual(effectiveFeeRatePct({}, prop), 40);
  assert.strictEqual(effectiveFeeRatePct(null, { operationMode: "agency_hassac", managementFeeRate: 0 }), 0);
  // どちらも無ければ 50
  assert.strictEqual(effectiveFeeRatePct(null, { operationMode: "agency_hassac" }), 50);
  // 範囲外はクランプ
  assert.strictEqual(effectiveFeeRatePct({ feeRatePct: 150 }, prop), 100);
  assert.strictEqual(effectiveFeeRatePct({ feeRatePct: -5 }, prop), 0);
});

test("computeDepositAmount: Airbnb総額 + Booking手取り(net無ければgross-comm)", () => {
  const d1 = computeDepositAmount({ airbnb: { grossRevenue: 201769 }, booking: {} });
  assert.strictEqual(d1.depositAmount, 201769);
  const d2 = computeDepositAmount({
    airbnb: { grossRevenue: 335785 },
    booking: { grossRevenue: 335600, commission: 50340, netRevenue: 285260 },
  });
  assert.strictEqual(d2.depositBooking, 285260);
  assert.strictEqual(d2.depositAmount, 335785 + 285260);
  // netRevenue 無し → gross - commission
  const d3 = computeDepositAmount({ airbnb: {}, booking: { grossRevenue: 100000, commission: 15000 } });
  assert.strictEqual(d3.depositBooking, 85000);
});

test("extractAirbnbReservations: 宿小町5月CSV → 8件(キャンセル1除外)", () => {
  const rs = extractAirbnbReservations(AIRBNB_KOMACHI_MAY);
  assert.strictEqual(rs.length, 8);
  const marcel = rs.find((r) => r.name === "Marcel Leirer");
  assert.deepStrictEqual({ adult: marcel.adult, child: marcel.child, infant: marcel.infant, nights: marcel.nights, income: marcel.income },
    { adult: 2, child: 0, infant: 0, nights: 2, income: 40560 });
});

test("extractAirbnbReservations + computeAccommodationTax: 宿小町5月 → 800円(plan.md実証値)", () => {
  const rs = extractAirbnbReservations(AIRBNB_KOMACHI_MAY);
  const r = computeAccommodationTax(rs);
  assert.strictEqual(r.totalTax, 800);
  // Marcel Leirer 2人×2泊×200 = 800円 のみ課税、他は全て /人/泊<10000
});

test("extractBookingReservations: the Terrace 5月抜粋CSV → 3件(cancelled 1除外)", () => {
  const rs = extractBookingReservations(BOOKING_TERRACE_MAY);
  assert.strictEqual(rs.length, 3);
  const shimizu = rs.find((r) => r.name.includes("shimizu"));
  // 子供の年齢 "3, 9, 12, 10, 4" → 0-5歳が2名(3,4), 6歳以上が3名(9,12,10)
  assert.strictEqual(shimizu.adult, 5);
  assert.strictEqual(shimizu.child, 3);
  assert.strictEqual(shimizu.infant, 2);
  assert.strictEqual(shimizu.nights, 2);
  assert.strictEqual(shimizu.income, 190000);
});

test("extractBookingReservations + computeAccommodationTax: the Terrace 5月抜粋 → 5,600円", () => {
  const rs = extractBookingReservations(BOOKING_TERRACE_MAY);
  const r = computeAccommodationTax(rs);
  // shimizu: guests=8(大人5+子ども3), /人/泊=190000/2/8=11875 → 200円/人泊×16=3200
  // Jordaan: guests=2, /人/泊=73600/3/2=12267 → 200円/人泊×6=1200
  // Fujiwara: guests=6, /人/泊=72000/1/6=12000 → 200円/人泊×6=1200
  assert.strictEqual(r.totalTax, 5600);
});
