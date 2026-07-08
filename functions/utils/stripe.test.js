/**
 * utils/stripe.js の 2アカウント振り分けロジック単体テスト。
 * 実行: node --test functions/utils/stripe.test.js
 *
 * 実際の Stripe SDK を叩かない: defineSecret / getStripeForKind の value() 部分は
 * 環境変数ベースの薄いモックで差し替えできないため、resolveAccountKind と
 * PROPERTY_TO_STRIPE_ACCOUNT の分岐だけを厳密に検証する。
 * getStripeForProperty の client 生成側は本番デプロイ後の E2E で検証する方針。
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const {
  resolveAccountKind,
  PROPERTY_TO_STRIPE_ACCOUNT,
  DEFAULT_ACCOUNT_KIND,
  getStripeForKind,
  getStripeForProperty,
} = require("./stripe");

describe("PROPERTY_TO_STRIPE_ACCOUNT マップ", () => {
  test("小町(RZV9IwtQgMAsvrdM3j8J) は individual", () => {
    assert.strictEqual(PROPERTY_TO_STRIPE_ACCOUNT["RZV9IwtQgMAsvrdM3j8J"], "individual");
  });
  test("若草(ZXW6wdpnBFk1azQ87KXQ) は individual", () => {
    assert.strictEqual(PROPERTY_TO_STRIPE_ACCOUNT["ZXW6wdpnBFk1azQ87KXQ"], "individual");
  });
  test("テラス(tsZybhDMcPrxqgcRy7wp) は corporate", () => {
    assert.strictEqual(PROPERTY_TO_STRIPE_ACCOUNT["tsZybhDMcPrxqgcRy7wp"], "corporate");
  });
  test("宇品(ncUKeD4yQo0kfAoznITu) は corporate", () => {
    assert.strictEqual(PROPERTY_TO_STRIPE_ACCOUNT["ncUKeD4yQo0kfAoznITu"], "corporate");
  });
  test("安芸津(nM5JdfecBDdRvTovqVD7) は corporate (八朔)", () => {
    assert.strictEqual(PROPERTY_TO_STRIPE_ACCOUNT["nM5JdfecBDdRvTovqVD7"], "corporate");
  });
  test("竹原(uzGpqAYqFWZxBygPhllv) は corporate (八朔)", () => {
    assert.strictEqual(PROPERTY_TO_STRIPE_ACCOUNT["uzGpqAYqFWZxBygPhllv"], "corporate");
  });
  test("音戸(OXWgBcBWnmqFZSVpjAcn) は corporate (八朔)", () => {
    assert.strictEqual(PROPERTY_TO_STRIPE_ACCOUNT["OXWgBcBWnmqFZSVpjAcn"], "corporate");
  });
  test("DEFAULT_ACCOUNT_KIND は corporate", () => {
    assert.strictEqual(DEFAULT_ACCOUNT_KIND, "corporate");
  });
});

describe("resolveAccountKind", () => {
  test("小町 → individual", () => {
    assert.strictEqual(resolveAccountKind("RZV9IwtQgMAsvrdM3j8J"), "individual");
  });
  test("若草 → individual", () => {
    assert.strictEqual(resolveAccountKind("ZXW6wdpnBFk1azQ87KXQ"), "individual");
  });
  test("テラス → corporate", () => {
    assert.strictEqual(resolveAccountKind("tsZybhDMcPrxqgcRy7wp"), "corporate");
  });
  test("宇品 → corporate", () => {
    assert.strictEqual(resolveAccountKind("ncUKeD4yQo0kfAoznITu"), "corporate");
  });
  test("新3宿(安芸津/竹原/音戸) → corporate かつ warn 無し (明示登録・暗黙フォールバックでない)", () => {
    const ids = ["nM5JdfecBDdRvTovqVD7", "uzGpqAYqFWZxBygPhllv", "OXWgBcBWnmqFZSVpjAcn"];
    const origWarn = console.warn;
    let warned = false;
    console.warn = () => { warned = true; };
    try {
      for (const id of ids) {
        assert.strictEqual(resolveAccountKind(id), "corporate");
      }
      assert.ok(!warned, "明示登録済みなので warn は呼ばれない");
    } finally {
      console.warn = origWarn;
    }
  });
  test("未マップID → corporate デフォルト (warn)", () => {
    // 副作用の warn ログ抑制
    const origWarn = console.warn;
    let warned = false;
    console.warn = () => { warned = true; };
    try {
      assert.strictEqual(resolveAccountKind("unknown-property-id"), "corporate");
      assert.ok(warned, "未マップ propertyId で warn が呼ばれる");
    } finally {
      console.warn = origWarn;
    }
  });
  test("空文字/undefined → corporate デフォルト (warn 無し)", () => {
    assert.strictEqual(resolveAccountKind(""), "corporate");
    assert.strictEqual(resolveAccountKind(undefined), "corporate");
  });
});

describe("getStripeForKind / getStripeForProperty (未設定時)", () => {
  // node --test 実行環境では defineSecret の value() は空文字を返す想定なので、
  // isEnabled:false + accountKind が正しく返ることを確認する。
  test("小町ID → accountKind:'individual' (isEnabled は環境次第)", () => {
    const s = getStripeForProperty("RZV9IwtQgMAsvrdM3j8J");
    assert.strictEqual(s.accountKind, "individual");
    // 未設定なら isEnabled:false / client:null
    if (!s.isEnabled) {
      assert.strictEqual(s.client, null);
      assert.strictEqual(s.isLive, false);
    }
  });
  test("テラスID → accountKind:'corporate'", () => {
    const s = getStripeForProperty("tsZybhDMcPrxqgcRy7wp");
    assert.strictEqual(s.accountKind, "corporate");
  });
  test("未マップID → accountKind:'corporate' フォールバック", () => {
    const s = getStripeForProperty("no-such-property");
    assert.strictEqual(s.accountKind, "corporate");
  });
  test("getStripeForKind('individual') は accountKind:'individual'", () => {
    const s = getStripeForKind("individual");
    assert.strictEqual(s.accountKind, "individual");
  });
  test("getStripeForKind(不正値) は corporate にフォールバック", () => {
    const s = getStripeForKind("xxx");
    assert.strictEqual(s.accountKind, "corporate");
  });
});
