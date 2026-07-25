/**
 * otaAckMessage 組み立ての単体テスト
 * 実行: node --test functions/utils/otaAckMessage.test.js
 * 副作用なし（Firestore/Drive に触れない）。
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const { buildOtaAckMessage, neutralGuideUrl, ackBody } = require("./otaAckMessage");

const TERRACE = "tsZybhDMcPrxqgcRy7wp";
const KOMACHI = "RZV9IwtQgMAsvrdM3j8J";

describe("otaAckMessage", () => {
  test("本文はユーザー支給の定型文（冒頭・結び・チェックイン方法見出し）", () => {
    const { text } = buildOtaAckMessage({ ota: "Airbnb", prop: { id: TERRACE } });
    assert.ok(text.startsWith("こんにちは！\n名簿の確認が取れました😊"));
    assert.ok(text.includes("それでは当日、キーボックスの解錠番号などをお送り致します。"));
    assert.ok(text.includes("たのしい滞在になることを願っています😊"));
    assert.ok(text.includes("▶チェックイン方法"));
  });

  test("両OTAとも中立ドメイン入口の {slug}/guide を末尾に付ける", () => {
    const a = buildOtaAckMessage({ ota: "Airbnb", prop: { id: TERRACE } });
    assert.strictEqual(a.guideUrl, "https://guest-checkin-link.web.app/terrace/guide");
    assert.ok(a.text.trim().endsWith("https://guest-checkin-link.web.app/terrace/guide"));

    const b = buildOtaAckMessage({ ota: "Booking.com", prop: { id: TERRACE } });
    assert.strictEqual(b.guideUrl, "https://guest-checkin-link.web.app/terrace/guide");

    const k = buildOtaAckMessage({ ota: "Airbnb", prop: { id: KOMACHI } });
    assert.strictEqual(k.guideUrl, "https://guest-checkin-link.web.app/komachi/guide");
  });

  test("未マッピング物件は URL 空（チェックイン方法ブロックを出さない）", () => {
    assert.strictEqual(neutralGuideUrl("unknownId"), "");
    const { text, guideUrl } = buildOtaAckMessage({ ota: "Booking.com", prop: { id: "unknownId" } });
    assert.strictEqual(guideUrl, "");
    assert.ok(!text.includes("▶チェックイン方法"));
  });

  test("ackBody は guideUrl 無しでも結びまでは出す", () => {
    const body = ackBody("");
    assert.ok(body.includes("たのしい滞在になることを願っています😊"));
    assert.ok(!body.includes("▶チェックイン方法"));
  });
});
