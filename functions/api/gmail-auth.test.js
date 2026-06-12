/**
 * gmail-auth.js 純粋関数の単体テスト
 * 実行: node --test functions/api/gmail-auth.test.js
 *
 * OAuth フロー全体は実 Google 連携が必要なためテスト不可。
 * ここでは state パース / context 正規化などの純粋関数のみを検証する。
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const gmailAuthApi = require("./gmail-auth");

// ダミー db を渡してファクトリを呼び出し、内部ヘルパを _helpers 経由で取得
function loadHelpers() {
  const dummyDb = {
    collection: () => ({
      doc: () => ({
        collection: () => ({ doc: () => ({}) }),
        get: async () => ({ exists: false, data: () => ({}) }),
        set: async () => {},
      }),
    }),
  };
  gmailAuthApi(dummyDb);
  return gmailAuthApi._helpers;
}

describe("normalizeContext_", () => {
  const { normalizeContext_ } = loadHelpers();

  test("emailVerification はそのまま返す", () => {
    assert.strictEqual(normalizeContext_("emailVerification"), "emailVerification");
  });

  test("default は default を返す", () => {
    assert.strictEqual(normalizeContext_("default"), "default");
  });

  test("未知の値は default にフォールバック", () => {
    assert.strictEqual(normalizeContext_("hacker"), "default");
    assert.strictEqual(normalizeContext_(""), "default");
    assert.strictEqual(normalizeContext_(undefined), "default");
    assert.strictEqual(normalizeContext_(null), "default");
  });
});

describe("parseState_", () => {
  const { parseState_ } = loadHelpers();

  // state = `${context}|${email}|${propertyId}|${ownerId}` の4フィールド形式 (2026-06 拡張)

  test("新形式 default|email を正しくパース", () => {
    assert.deepStrictEqual(parseState_("default|owner@example.com"), {
      context: "default",
      email: "owner@example.com",
      propertyId: "",
      ownerId: "",
    });
  });

  test("新形式 emailVerification|email を正しくパース", () => {
    assert.deepStrictEqual(parseState_("emailVerification|verify@example.com"), {
      context: "emailVerification",
      email: "verify@example.com",
      propertyId: "",
      ownerId: "",
    });
  });

  test("4フィールド形式 (propertyId/ownerId 付き) を正しくパース", () => {
    assert.deepStrictEqual(parseState_("property|p@example.com|prop123|owner456"), {
      context: "property",
      email: "p@example.com",
      propertyId: "prop123",
      ownerId: "owner456",
    });
  });

  test("旧形式 (email 単体) は default 扱い (後方互換)", () => {
    assert.deepStrictEqual(parseState_("legacy@example.com"), {
      context: "default",
      email: "legacy@example.com",
      propertyId: "",
      ownerId: "",
    });
  });

  test("空 state は context=default, email=''", () => {
    assert.deepStrictEqual(parseState_(""), { context: "default", email: "", propertyId: "", ownerId: "" });
    assert.deepStrictEqual(parseState_(undefined), { context: "default", email: "", propertyId: "", ownerId: "" });
  });

  test("未知 context は default にフォールバック (state 全体を email 扱い)", () => {
    assert.deepStrictEqual(parseState_("unknown|foo@example.com"), {
      context: "default",
      email: "unknown|foo@example.com",
      propertyId: "",
      ownerId: "",
    });
  });

  test("パイプは全てフィールド区切りとして扱う (3つ目以降は propertyId/ownerId)", () => {
    assert.deepStrictEqual(parseState_("emailVerification|a|b@example.com"), {
      context: "emailVerification",
      email: "a",
      propertyId: "b@example.com",
      ownerId: "",
    });
  });

  test("context のみで email なし", () => {
    assert.deepStrictEqual(parseState_("emailVerification|"), {
      context: "emailVerification",
      email: "",
      propertyId: "",
      ownerId: "",
    });
  });
});
