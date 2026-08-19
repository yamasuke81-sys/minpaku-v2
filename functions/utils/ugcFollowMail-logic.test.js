/**
 * ugcFollowMail-logic 純粋関数の単体テスト
 * 実行: node --test functions/utils/ugcFollowMail-logic.test.js
 *
 * 要点は「送ってはいけない予約に送らない」ことと、
 * 「配信停止導線と #PR 表記が本文から欠けない」こと。
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const {
  UGC_PROPERTIES,
  isUgcProperty,
  isEligibleBooking,
  buildUgcFollowMail,
  buildUgcPastGuestMail,
} = require("./ugcFollowMail-logic");

const TERRACE = "tsZybhDMcPrxqgcRy7wp";
const OPTOUT = "https://setouchi-stay.com/ugc-optout?t=dGVzdEBleGFtcGxlLmNvbQ.abc";

const booking = (over = {}) => ({
  propertyId: TERRACE,
  status: "confirmed",
  email: "guest@example.com",
  guestName: "山田 太郎",
  checkIn: "2026-08-18",
  checkOut: "2026-08-20",
  ...over,
});

describe("isUgcProperty", () => {
  test("稼働中の民泊4宿が対象", () => {
    assert.strictEqual(Object.keys(UGC_PROPERTIES).length, 4);
    assert.ok(isUgcProperty(TERRACE));
  });

  test("民泊以外の物件(戸建賃貸など)は対象外", () => {
    assert.strictEqual(isUgcProperty("gpGCvNFfPh6GYpv9HmiI"), false);
    assert.strictEqual(isUgcProperty(""), false);
    assert.strictEqual(isUgcProperty(undefined), false);
  });

  test("全宿にタグ付け先・ハッシュタグ・写真の例が定義されている", () => {
    for (const [id, v] of Object.entries(UGC_PROPERTIES)) {
      assert.ok(v.handle.startsWith("@"), `${id} のハンドルが不正`);
      assert.ok(v.hashtags.includes("#"), `${id} のハッシュタグが不正`);
      // ハッシュタグに中黒や空白が混ざると Instagram 側でタグが途切れる
      assert.ok(!/[・\s]/.test(v.hashtags.replace(/ #/g, "#")), `${id} のハッシュタグに使えない文字`);
      assert.ok(v.photoExamples && v.photoExamplesEn, `${id} の写真の例が未定義`);
    }
  });

  test("BBQを案内してよいのはテラスだけ (宇品はハウスルールで禁止)", () => {
    assert.ok(UGC_PROPERTIES[TERRACE].photoExamples.includes("バーベキュー"));
    for (const [id, v] of Object.entries(UGC_PROPERTIES)) {
      if (id === TERRACE) continue;
      assert.ok(!v.photoExamples.includes("バーベキュー"), `${id} にBBQを案内している`);
      assert.ok(!/BBQ/i.test(v.photoExamplesEn), `${id} にBBQを案内している(英語)`);
    }
  });
});

describe("isEligibleBooking", () => {
  test("通常の確定予約は対象", () => {
    assert.deepStrictEqual(isEligibleBooking(booking()), { ok: true });
  });

  test("対象外物件は送らない", () => {
    assert.strictEqual(isEligibleBooking(booking({ propertyId: "xxxx" })).ok, false);
  });

  test("キャンセル済みは送らない", () => {
    assert.strictEqual(isEligibleBooking(booking({ status: "cancelled" })).ok, false);
  });

  test("Airbnb 承認待ち(pendingApproval)は送らない", () => {
    assert.strictEqual(isEligibleBooking(booking({ pendingApproval: true })).ok, false);
  });

  test("Booking.com 未照合(unverified)は送らない", () => {
    assert.strictEqual(isEligibleBooking(booking({ unverified: true })).ok, false);
  });

  test("メールアドレスが無い/壊れている予約は送らない", () => {
    assert.strictEqual(isEligibleBooking(booking({ email: "" })).ok, false);
    assert.strictEqual(isEligibleBooking(booking({ email: null })).ok, false);
    assert.strictEqual(isEligibleBooking(booking({ email: "not-an-email" })).ok, false);
  });

  test("送信済みの予約には二度送らない", () => {
    assert.strictEqual(isEligibleBooking(booking({ ugcFollowMailSentAt: new Date() })).ok, false);
  });

  test("空オブジェクト/undefined でも落ちない", () => {
    assert.strictEqual(isEligibleBooking({}).ok, false);
    assert.strictEqual(isEligibleBooking(undefined).ok, false);
  });
});

describe("buildUgcFollowMail", () => {
  const mail = () => buildUgcFollowMail({
    guestName: "山田 太郎",
    propertyId: TERRACE,
    propertyName: "the Terrace 長浜",
    checkIn: "2026-08-18",
    checkOut: "2026-08-20",
    optoutUrl: OPTOUT,
  });

  test("件名に宿名と特典額が入る", () => {
    const { subject } = mail();
    assert.ok(subject.includes("the Terrace 長浜"));
    assert.ok(subject.includes("500円"));
  });

  test("本文に宛先ごとの配信停止リンクが入る (法定の表示義務)", () => {
    const { body } = mail();
    assert.ok(body.includes(OPTOUT));
    assert.ok(body.includes("合同会社八朔"));
    assert.ok(body.includes("広島県安芸郡海田町上市4-23-12"));
  });

  test("ステマ規制対応の #PR 表記の案内が入る", () => {
    assert.ok(mail().body.includes("#PR"));
  });

  test("アカウントのタグ付けとハッシュタグを別々に案内する (混同されやすい)", () => {
    const { body } = mail();
    assert.ok(body.includes("をタグ付け"));
    assert.ok(body.includes("のハッシュタグを記載"));
  });

  test("提供していないお料理を写真の例に出さない", () => {
    assert.ok(!mail().body.includes("お料理"));
  });

  test("宿ごとのタグ付け先が差し込まれる", () => {
    assert.ok(mail().body.includes("@the.terrace.nagahama"));
    const komachi = buildUgcFollowMail({
      guestName: "Jane",
      propertyId: "RZV9IwtQgMAsvrdM3j8J",
      propertyName: "YADO KOMACHI Hiroshima",
      checkIn: "2026-08-18",
      checkOut: "2026-08-20",
      optoutUrl: OPTOUT,
    });
    assert.ok(komachi.body.includes("@yado.komachi.hiroshima"));
    assert.ok(!komachi.body.includes("@the.terrace.nagahama"));
  });

  test("日英併記 (海外ゲスト対応)", () => {
    const { body } = mail();
    assert.ok(body.includes("Thank you very much for staying"));
    assert.ok(body.includes("Unsubscribe"));
  });

  test("応募フォームは恒久URL (印刷物のQRと同じ)", () => {
    assert.ok(mail().body.includes("https://setouchi-stay.com/ugc"));
  });

  test("ゲスト名が空でも「ゲスト様」で成立する", () => {
    const { body } = buildUgcFollowMail({
      guestName: "",
      propertyId: TERRACE,
      propertyName: "the Terrace 長浜",
      checkIn: "2026-08-18",
      checkOut: "2026-08-20",
      optoutUrl: OPTOUT,
    });
    assert.ok(body.startsWith("ゲスト 様"));
  });

  test("配信停止URLが無ければ例外 (導線なしでは送らせない)", () => {
    assert.throws(() => buildUgcFollowMail({
      guestName: "山田", propertyId: TERRACE, propertyName: "x",
      checkIn: "2026-08-18", checkOut: "2026-08-20", optoutUrl: "",
    }), /optoutUrl/);
  });

  test("対象外物件は例外", () => {
    assert.throws(() => buildUgcFollowMail({
      guestName: "山田", propertyId: "xxxx", propertyName: "x",
      checkIn: "2026-08-18", checkOut: "2026-08-20", optoutUrl: OPTOUT,
    }), /UGC対象外/);
  });
});

describe("buildUgcPastGuestMail (過去ゲスト向けローリング配信)", () => {
  const mail = () => buildUgcPastGuestMail({
    guestName: "山田 太郎",
    propertyId: TERRACE,
    propertyName: "the Terrace 長浜",
    optoutUrl: OPTOUT,
  });

  test("利用目的追加の通知が入る (個人情報保護法・削ってはいけない)", () => {
    const { body } = mail();
    assert.ok(body.includes("宿泊者管理の目的で頂戴していたご連絡先"));
    assert.ok(body.includes("キャンペーン等の"));
  });

  test("配信停止リンク・送信者名・住所が入る (特定電子メール法)", () => {
    const { body } = mail();
    assert.ok(body.includes(OPTOUT));
    assert.ok(body.includes("合同会社八朔"));
    assert.ok(body.includes("広島県安芸郡海田町上市4-23-12"));
  });

  test("件名に宿名と特典額500円が入る", () => {
    const { subject } = mail();
    assert.ok(subject.includes("the Terrace 長浜"));
    assert.ok(subject.includes("500円"));
  });

  test("#PR の案内と日英併記", () => {
    const { body } = mail();
    assert.ok(body.includes("#PR"));
    assert.ok(body.includes("Unsubscribe"));
    assert.ok(!body.includes("お料理"));
  });

  test("配信停止URLが無ければ例外", () => {
    assert.throws(() => buildUgcPastGuestMail({
      guestName: "山田", propertyId: TERRACE, propertyName: "x", optoutUrl: "",
    }), /optoutUrl/);
  });

  test("対象外物件は例外", () => {
    assert.throws(() => buildUgcPastGuestMail({
      guestName: "山田", propertyId: "xxxx", propertyName: "x", optoutUrl: OPTOUT,
    }), /UGC対象外/);
  });
});
