const { test } = require("node:test");
const assert = require("node:assert");
const { parseCsv, parseYen, sumAirbnbCsv, sumBookingCsv, computeSettlement } = require("./ota-csv-logic");

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

test("sumBookingCsv: the Terrace5月 = gross335,600 / comm50,340 / net285,260", () => {
  const r = sumBookingCsv(BOOKING_TERRACE_MAY);
  assert.strictEqual(r.grossRevenue, 335600);
  assert.strictEqual(r.commission, 50340);
  assert.strictEqual(r.netRevenue, 285260);
  assert.strictEqual(r.reservationCount, 3);
  assert.strictEqual(r.canceledCount, 1);
  assert.strictEqual(r.nights, 2 + 3 + 1); // 6泊
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

test("computeSettlement: 宿泊税預りBを差し引く", () => {
  const s = computeSettlement({ depositAmount: 201769, taxWithholding: 1769, feeRatePct: 50 });
  assert.strictEqual(s.salesBase, 200000);
  assert.strictEqual(s.feeExclTax, 100000);
  assert.strictEqual(s.consumptionTax, 10000);
  assert.strictEqual(s.feeInclTax, 110000);
});
