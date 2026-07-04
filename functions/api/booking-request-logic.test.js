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
