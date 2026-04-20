/**
 * emailVerification.js 純粋関数の単体テスト (node --test)
 * 実行: npm test
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const { _pure, _constants } = require("./emailVerification");

const { buildGmailQuery, getHeader, extractBody, guessPlatform, matchVerificationTarget } = _pure;

describe("buildGmailQuery", () => {
  test("基本: to OR 連結 / from OR 連結 / label 除外", () => {
    const q = buildGmailQuery(["a@example.com"], "Label_123");
    assert.ok(q.includes("to:a@example.com"), q);
    assert.ok(q.includes("from:automated@airbnb.com"), q);
    assert.ok(q.includes("-label:Label_123"), q);
  });

  test("複数 to を OR で連結", () => {
    const q = buildGmailQuery(["a@x.com", "b@x.com"], "L");
    assert.ok(q.includes("to:a@x.com OR to:b@x.com"), q);
  });

  test("verificationEmails が空なら空文字", () => {
    assert.strictEqual(buildGmailQuery([], "L"), "");
    assert.strictEqual(buildGmailQuery(null, "L"), "");
    assert.strictEqual(buildGmailQuery(undefined, "L"), "");
  });

  test("labelId なしでも query が返り -label 句は含まない", () => {
    const q = buildGmailQuery(["a@x.com"], null);
    assert.ok(q.includes("to:a@x.com"));
    assert.ok(!q.includes("-label:"));
  });

  test("senders を差し替え可能", () => {
    const q = buildGmailQuery(["a@x.com"], "L", ["custom@sender.test"]);
    assert.ok(q.includes("from:custom@sender.test"));
    assert.ok(!q.includes("airbnb"));
  });
});

describe("getHeader", () => {
  test("大小文字無視でマッチ", () => {
    const h = [{ name: "Subject", value: "Hello" }];
    assert.strictEqual(getHeader(h, "subject"), "Hello");
    assert.strictEqual(getHeader(h, "SUBJECT"), "Hello");
    assert.strictEqual(getHeader(h, "Subject"), "Hello");
  });

  test("存在しないヘッダは null", () => {
    assert.strictEqual(getHeader([{ name: "From", value: "a" }], "Subject"), null);
  });

  test("headers が非配列なら null", () => {
    assert.strictEqual(getHeader(null, "Subject"), null);
    assert.strictEqual(getHeader(undefined, "Subject"), null);
    assert.strictEqual(getHeader({}, "Subject"), null);
  });
});

describe("extractBody", () => {
  test("text/plain パートを取得", () => {
    const payload = {
      parts: [
        { mimeType: "text/html", body: { data: Buffer.from("<p>html</p>").toString("base64url") } },
        { mimeType: "text/plain", body: { data: Buffer.from("plain").toString("base64url") } },
      ],
    };
    assert.strictEqual(extractBody(payload, true), "plain");
  });

  test("preferText=false で text/html を取得", () => {
    const payload = {
      parts: [
        { mimeType: "text/html", body: { data: Buffer.from("<p>html</p>").toString("base64url") } },
      ],
    };
    assert.strictEqual(extractBody(payload, false), "<p>html</p>");
  });

  test("ネストした multipart もウォーク", () => {
    const inner = {
      parts: [{ mimeType: "text/plain", body: { data: Buffer.from("deep").toString("base64url") } }],
    };
    const payload = { parts: [{ parts: [inner] }] };
    assert.strictEqual(extractBody(payload, true), "deep");
  });

  test("該当なし / 空ペイロードは空文字", () => {
    assert.strictEqual(extractBody({ parts: [] }, true), "");
    assert.strictEqual(extractBody(null, true), "");
    assert.strictEqual(extractBody(undefined, true), "");
  });
});

describe("guessPlatform", () => {
  test("airbnb を含めば Airbnb", () => {
    assert.strictEqual(guessPlatform("Airbnb <automated@airbnb.com>"), "Airbnb");
    assert.strictEqual(guessPlatform("AIRBNB JP"), "Airbnb");
    assert.strictEqual(guessPlatform("noreply@airbnb.jp"), "Airbnb");
  });

  test("booking.com を含めば Booking.com", () => {
    assert.strictEqual(guessPlatform("Booking.com <noreply@booking.com>"), "Booking.com");
    assert.strictEqual(guessPlatform("customer.service@mail.booking.com"), "Booking.com");
  });

  test("どちらも含まないなら Unknown", () => {
    assert.strictEqual(guessPlatform("noreply@example.com"), "Unknown");
    assert.strictEqual(guessPlatform(""), "Unknown");
    assert.strictEqual(guessPlatform(null), "Unknown");
  });
});

describe("matchVerificationTarget", () => {
  const targets = [
    { propertyId: "p1", platform: "Airbnb", email: "owner+A@gmail.com" },
    { propertyId: "p2", platform: "Booking.com", email: "owner+B@gmail.com" },
  ];

  test("To ヘッダに含まれるターゲットを返す", () => {
    const m = matchVerificationTarget("Someone <owner+A@gmail.com>", targets);
    assert.strictEqual(m && m.propertyId, "p1");
  });

  test("大小文字無視", () => {
    const m = matchVerificationTarget("Someone <Owner+A@Gmail.Com>", targets);
    assert.strictEqual(m && m.propertyId, "p1");
  });

  test("plus addressing 付き To も素の address と一致判定", () => {
    // Gmail の Delivered-To 等で plus addressing 省略されているケース
    const simpler = [{ propertyId: "p3", email: "owner@gmail.com" }];
    const m = matchVerificationTarget("Someone <owner+extra@gmail.com>", simpler);
    // "owner@gmail.com" は "owner+extra@gmail.com" 内に部分一致しない (記号のため)
    assert.strictEqual(m, null);
    // でも完全一致ならマッチ
    const m2 = matchVerificationTarget("owner@gmail.com", simpler);
    assert.strictEqual(m2 && m2.propertyId, "p3");
  });

  test("該当なしは null", () => {
    assert.strictEqual(matchVerificationTarget("other@example.com", targets), null);
    assert.strictEqual(matchVerificationTarget("", targets), null);
  });

  test("targets が非配列なら null", () => {
    assert.strictEqual(matchVerificationTarget("a@b.com", null), null);
    assert.strictEqual(matchVerificationTarget("a@b.com", undefined), null);
  });
});

describe("定数", () => {
  test("PROCESSED_LABEL_NAME が定義済", () => {
    assert.strictEqual(_constants.PROCESSED_LABEL_NAME, "minpaku-v2-email-verified");
  });

  test("KNOWN_OTA_SENDERS に Airbnb / Booking の代表送信元を含む", () => {
    const list = _constants.KNOWN_OTA_SENDERS;
    assert.ok(list.some((s) => s.includes("airbnb")));
    assert.ok(list.some((s) => s.includes("booking")));
  });
});
