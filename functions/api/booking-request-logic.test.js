/**
 * booking-request-logic 純粋関数の単体テスト
 * 実行: node --test functions/api/booking-request-logic.test.js
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const {
  ymd,
  isValidYmd,
  enumerateBlockedDates,
  periodsOverlap,
  nightsBetween,
  isValidEmail,
  validateBookingRequest,
  isSpamSubmission,
} = require("./booking-request-logic");

describe("ymd", () => {
  test("文字列はそのまま先頭10文字", () => {
    assert.strictEqual(ymd("2026-07-10"), "2026-07-10");
    assert.strictEqual(ymd("2026-07-10T00:00:00Z"), "2026-07-10");
  });
  test("Timestamp風オブジェクト (toDate あり)", () => {
    const fake = { toDate: () => new Date("2026-07-10T00:00:00Z") };
    assert.strictEqual(ymd(fake), "2026-07-10");
  });
  test("null/undefined は空文字", () => {
    assert.strictEqual(ymd(null), "");
    assert.strictEqual(ymd(undefined), "");
  });
});

describe("isValidYmd", () => {
  test("正しい形式", () => {
    assert.strictEqual(isValidYmd("2026-07-10"), true);
  });
  test("不正な形式", () => {
    assert.strictEqual(isValidYmd("2026/07/10"), false);
    assert.strictEqual(isValidYmd(""), false);
    assert.strictEqual(isValidYmd(null), false);
  });
});

describe("enumerateBlockedDates", () => {
  test("通常の2泊 (checkOut は非包含)", () => {
    const r = enumerateBlockedDates("2026-08-01", "2026-08-03", { todayStr: "2026-07-01" });
    assert.deepStrictEqual(r, ["2026-08-01", "2026-08-02"]);
  });
  test("過去日は含めない (todayStr より前を除外)", () => {
    const r = enumerateBlockedDates("2026-07-01", "2026-07-05", { todayStr: "2026-07-03" });
    assert.deepStrictEqual(r, ["2026-07-03", "2026-07-04"]);
  });
  test("checkOut <= checkIn は空配列", () => {
    assert.deepStrictEqual(enumerateBlockedDates("2026-08-03", "2026-08-01", { todayStr: "2026-07-01" }), []);
    assert.deepStrictEqual(enumerateBlockedDates("2026-08-01", "2026-08-01", { todayStr: "2026-07-01" }), []);
  });
  test("上限 (maxMonths) より先は含めない", () => {
    // 2026-07-01 + 12ヶ月 = 2027-07-01 が上限。2027-08-01〜は上限より後なので空
    const r = enumerateBlockedDates("2027-08-01", "2027-08-03", { todayStr: "2026-07-01", maxMonths: 12 });
    assert.deepStrictEqual(r, []);
  });
  test("上限ちょうど内側の日付は含まれる", () => {
    const r = enumerateBlockedDates("2027-06-30", "2027-07-02", { todayStr: "2026-07-01", maxMonths: 12 });
    assert.deepStrictEqual(r, ["2027-06-30", "2027-07-01"]);
  });
  test("不正な日付は空配列", () => {
    assert.deepStrictEqual(enumerateBlockedDates("invalid", "2026-08-03"), []);
  });
});

describe("periodsOverlap", () => {
  test("完全重複", () => {
    assert.strictEqual(periodsOverlap("2026-08-01", "2026-08-05", "2026-08-01", "2026-08-05"), true);
  });
  test("部分重複", () => {
    assert.strictEqual(periodsOverlap("2026-08-01", "2026-08-05", "2026-08-03", "2026-08-07"), true);
  });
  test("隣接 (CO=CI) は重複しない (半開区間)", () => {
    assert.strictEqual(periodsOverlap("2026-08-01", "2026-08-05", "2026-08-05", "2026-08-08"), false);
  });
  test("完全に離れている", () => {
    assert.strictEqual(periodsOverlap("2026-08-01", "2026-08-05", "2026-08-10", "2026-08-12"), false);
  });
  test("不正な入力は false", () => {
    assert.strictEqual(periodsOverlap("", "2026-08-05", "2026-08-03", "2026-08-07"), false);
  });
});

describe("nightsBetween", () => {
  test("通常計算", () => {
    assert.strictEqual(nightsBetween("2026-08-01", "2026-08-03"), 2);
  });
  test("同日は0", () => {
    assert.strictEqual(nightsBetween("2026-08-01", "2026-08-01"), 0);
  });
  test("不正な入力は0", () => {
    assert.strictEqual(nightsBetween("", "2026-08-01"), 0);
  });
});

describe("isValidEmail", () => {
  test("正しい形式", () => {
    assert.strictEqual(isValidEmail("test@example.com"), true);
  });
  test("不正な形式", () => {
    assert.strictEqual(isValidEmail("test@"), false);
    assert.strictEqual(isValidEmail("test"), false);
    assert.strictEqual(isValidEmail(""), false);
  });
});

describe("validateBookingRequest", () => {
  const property = { capacity: 4 };
  const base = {
    checkIn: "2026-08-01",
    checkOut: "2026-08-03",
    guests: 2,
    name: "山田太郎",
    email: "test@example.com",
    plan: "standard",
    notes: "",
    nationality: "日本",
    memberComposition: "ファミリー利用",
  };
  test("正常系は ok:true", () => {
    const r = validateBookingRequest(base, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, true);
  });
  test("チェックイン日が過去", () => {
    const r = validateBookingRequest({ ...base, checkIn: "2026-06-01" }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
  test("チェックアウト <= チェックイン", () => {
    const r = validateBookingRequest({ ...base, checkOut: "2026-08-01" }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
  test("30泊超過", () => {
    const r = validateBookingRequest({ ...base, checkIn: "2026-08-01", checkOut: "2026-09-15" }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
  test("定員超過", () => {
    const r = validateBookingRequest({ ...base, guests: 5 }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
  test("人数0以下", () => {
    const r = validateBookingRequest({ ...base, guests: 0 }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
  test("名前が空", () => {
    const r = validateBookingRequest({ ...base, name: "" }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
  test("名前が101文字", () => {
    const r = validateBookingRequest({ ...base, name: "あ".repeat(101) }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
  test("メール形式不正", () => {
    const r = validateBookingRequest({ ...base, email: "invalid" }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
  test("備考1001文字", () => {
    const r = validateBookingRequest({ ...base, notes: "a".repeat(1001) }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
  test("プラン不正値", () => {
    const r = validateBookingRequest({ ...base, plan: "invalid" }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
  test("capacity 未設定(0)の物件は人数上限チェックをスキップ", () => {
    const r = validateBookingRequest({ ...base, guests: 20 }, { capacity: 0 }, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, true);
  });
  test("minNights 未指定/1 は 1泊でも通る (従来互換)", () => {
    const oneNight = { ...base, checkIn: "2026-08-01", checkOut: "2026-08-02" };
    assert.strictEqual(validateBookingRequest(oneNight, property, { todayStr: "2026-07-01" }).ok, true);
    assert.strictEqual(validateBookingRequest(oneNight, property, { todayStr: "2026-07-01", minNights: 1 }).ok, true);
  });
  test("minNights:3 の宿は 2泊で拒否・3泊で通過", () => {
    // base は 8/1〜8/3 = 2泊
    assert.strictEqual(validateBookingRequest(base, property, { todayStr: "2026-07-01", minNights: 3 }).ok, false);
    const threeNights = { ...base, checkIn: "2026-08-01", checkOut: "2026-08-04" };
    assert.strictEqual(validateBookingRequest(threeNights, property, { todayStr: "2026-07-01", minNights: 3 }).ok, true);
  });

  // ===== 人数内訳 (adults/children/infants) 2026-07 追加 =====
  test("adults/children 未送信は guests から大人扱いにフォールバックし通過する (後方互換)", () => {
    const { adults, children, ...noBreakdown } = base;
    const r = validateBookingRequest(noBreakdown, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, true);
  });
  test("adults+children が guests と一致すれば通過", () => {
    const r = validateBookingRequest({ ...base, guests: 3, adults: 2, children: 1 }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, true);
  });
  test("adults+children が guests と不一致ならエラー", () => {
    const r = validateBookingRequest({ ...base, guests: 2, adults: 2, children: 1 }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
  test("adults が0以下はエラー", () => {
    const r = validateBookingRequest({ ...base, guests: 1, adults: 0, children: 1 }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
  test("children が負数はエラー", () => {
    const r = validateBookingRequest({ ...base, guests: 1, adults: 2, children: -1 }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
  test("infants が負数はエラー", () => {
    const r = validateBookingRequest({ ...base, infants: -1 }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
  test("infants は定員・整合チェックに含めない", () => {
    const r = validateBookingRequest({ ...base, guests: 2, adults: 2, children: 0, infants: 2 }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, true);
  });
  test("adults+children が定員超過ならエラー", () => {
    const r = validateBookingRequest({ ...base, guests: 4, adults: 3, children: 1 }, { capacity: 3 }, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });

  // ===== 国籍・メンバー構成 2026-07 追加 =====
  test("nationality が空はエラー", () => {
    const r = validateBookingRequest({ ...base, nationality: "" }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
  test("nationality が61文字はエラー", () => {
    const r = validateBookingRequest({ ...base, nationality: "あ".repeat(61) }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
  test("memberComposition が空はエラー", () => {
    const r = validateBookingRequest({ ...base, memberComposition: "" }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
  test("memberComposition が101文字はエラー", () => {
    const r = validateBookingRequest({ ...base, memberComposition: "あ".repeat(101) }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });

  // ===== 代表者の年代・性別 2026-07 追加 (任意) =====
  test("age/gender 未送信でも後方互換で通過する", () => {
    const r = validateBookingRequest(base, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, true);
  });
  test("age/gender を指定しても通過する", () => {
    const r = validateBookingRequest({ ...base, age: "20代", gender: "男性" }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, true);
  });
  test("age が61文字はエラー", () => {
    const r = validateBookingRequest({ ...base, age: "あ".repeat(61) }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
  test("gender が21文字はエラー", () => {
    const r = validateBookingRequest({ ...base, gender: "あ".repeat(21) }, property, { todayStr: "2026-07-01" });
    assert.strictEqual(r.ok, false);
  });
});

describe("isSpamSubmission", () => {
  test("ハニーポットが空・経過時間十分ならスパムでない", () => {
    assert.strictEqual(isSpamSubmission({ website: "", elapsedMs: 3000 }), false);
  });
  test("ハニーポットに値があればスパム", () => {
    assert.strictEqual(isSpamSubmission({ website: "http://spam.example", elapsedMs: 3000 }), true);
  });
  test("経過時間が短すぎればスパム", () => {
    assert.strictEqual(isSpamSubmission({ website: "", elapsedMs: 500 }), true);
  });
  test("elapsedMs 未指定は経過チェックをスキップ", () => {
    assert.strictEqual(isSpamSubmission({ website: "" }), false);
  });
});

describe("computeParkingCharge (有料駐車場の追加料金)", () => {
  const { computeParkingCharge } = require("./booking-request-logic");
  const cfg = { enabled: true, pricePerNightPerCar: 2000, maxCars: 2 };

  test("1台×2泊 = 4,000円", () => {
    const r = computeParkingCharge(cfg, "2026-08-01", "2026-08-03", 1);
    assert.deepStrictEqual(r, { cars: 1, fee: 4000, nights: 2, pricePerNightPerCar: 2000 });
  });
  test("2台×3泊 = 12,000円", () => {
    const r = computeParkingCharge(cfg, "2026-08-01", "2026-08-04", 2);
    assert.strictEqual(r.fee, 12000);
    assert.strictEqual(r.cars, 2);
  });
  test("maxCars 超過は上限にクランプ (5台希望→2台)", () => {
    const r = computeParkingCharge(cfg, "2026-08-01", "2026-08-02", 5);
    assert.strictEqual(r.cars, 2);
    assert.strictEqual(r.fee, 4000);
  });
  test("carCount を超える有料台数は carCount にクランプ (車1台で有料2台希望→1台)", () => {
    const r = computeParkingCharge(cfg, "2026-08-01", "2026-08-02", 2, 1);
    assert.strictEqual(r.cars, 1);
    assert.strictEqual(r.fee, 2000);
  });
  test("carCount 未指定/0/不正なら carCount 制約なし (従来どおり maxCars まで)", () => {
    assert.strictEqual(computeParkingCharge(cfg, "2026-08-01", "2026-08-02", 2).cars, 2);
    assert.strictEqual(computeParkingCharge(cfg, "2026-08-01", "2026-08-02", 2, 0).cars, 2);
    assert.strictEqual(computeParkingCharge(cfg, "2026-08-01", "2026-08-02", 2, "abc").cars, 2);
  });
  test("設定なし/無効なら常に0", () => {
    assert.strictEqual(computeParkingCharge(null, "2026-08-01", "2026-08-03", 1).fee, 0);
    assert.strictEqual(computeParkingCharge({ enabled: false, pricePerNightPerCar: 2000 }, "2026-08-01", "2026-08-03", 1).fee, 0);
  });
  test("単価が不正 (0/NaN) なら0", () => {
    assert.strictEqual(computeParkingCharge({ enabled: true, pricePerNightPerCar: 0 }, "2026-08-01", "2026-08-03", 1).fee, 0);
    assert.strictEqual(computeParkingCharge({ enabled: true }, "2026-08-01", "2026-08-03", 1).fee, 0);
  });
  test("台数0・負値・文字列ゴミは0台", () => {
    assert.strictEqual(computeParkingCharge(cfg, "2026-08-01", "2026-08-03", 0).cars, 0);
    assert.strictEqual(computeParkingCharge(cfg, "2026-08-01", "2026-08-03", -1).cars, 0);
    assert.strictEqual(computeParkingCharge(cfg, "2026-08-01", "2026-08-03", "abc").cars, 0);
  });
  test("文字列の台数は数値に解釈 ('2'→2台)", () => {
    assert.strictEqual(computeParkingCharge(cfg, "2026-08-01", "2026-08-02", "2").fee, 4000);
  });
  test("泊数0 (日付不正/同日) なら0", () => {
    assert.strictEqual(computeParkingCharge(cfg, "2026-08-03", "2026-08-01", 1).fee, 0);
    assert.strictEqual(computeParkingCharge(cfg, "bad", "2026-08-01", 1).fee, 0);
  });
  test("maxCars 未設定は既定2", () => {
    const r = computeParkingCharge({ enabled: true, pricePerNightPerCar: 2000 }, "2026-08-01", "2026-08-02", 3);
    assert.strictEqual(r.cars, 2);
  });
});
