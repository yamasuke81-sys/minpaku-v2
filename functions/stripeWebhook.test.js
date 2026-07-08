/**
 * stripeWebhook の 2系統シークレット試行ロジック単体テスト。
 * 実行: node --test functions/stripeWebhook.test.js
 *
 * verifyEventDualAccount_ は片方失敗 → もう片方成功で {ok:true, accountKind} を返し、
 * 両方失敗で {ok:false, tried:[...]} を返す。ここでは utils/stripe.getStripeForKind と
 * getWebhookSecret を module cache 経由でモックし、constructEvent の成否を切替える。
 */
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

// require キャッシュから utils/stripe.js を差し替える
const stripeModPath = path.resolve(__dirname, "utils", "stripe.js");
const webhookModPath = path.resolve(__dirname, "stripeWebhook.js");

let originalStripeMod;

function installMock(mock) {
  // stripeWebhook.js を要求する前に utils/stripe.js の module.exports を差し替える
  require(stripeModPath); // ensure loaded
  originalStripeMod = require.cache[stripeModPath].exports;
  require.cache[stripeModPath].exports = { ...originalStripeMod, ...mock };
  // stripeWebhook.js は utils/stripe を require 時に destructure するため、
  // stripeWebhook 側のキャッシュも一度クリアして再ロードさせる。
  delete require.cache[webhookModPath];
}

function restoreMock() {
  if (originalStripeMod) {
    require.cache[stripeModPath].exports = originalStripeMod;
    originalStripeMod = null;
  }
  delete require.cache[webhookModPath];
}

describe("verifyEventDualAccount_", () => {
  afterEach(() => restoreMock());

  test("corporate 側で成功 → {ok:true, accountKind:'corporate'}", () => {
    installMock({
      allStripeSecrets: () => [],
      getStripeForKind: (kind) => {
        return {
          isEnabled: true,
          isLive: false,
          accountKind: kind,
          client: {
            webhooks: {
              constructEvent: (body, sig, secret) => {
                if (kind === "corporate" && secret === "whsec_corp") {
                  return { id: "evt_c1", type: "checkout.session.completed", livemode: false };
                }
                throw new Error("bad signature");
              },
            },
          },
        };
      },
      getWebhookSecret: (kind) => (kind === "corporate" ? "whsec_corp" : "whsec_ind"),
    });
    const { _internal } = require(webhookModPath);
    const r = _internal.verifyEventDualAccount_("body", "sig");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.accountKind, "corporate");
    assert.strictEqual(r.event.id, "evt_c1");
  });

  test("corporate 側で失敗 → individual 側で成功", () => {
    installMock({
      allStripeSecrets: () => [],
      getStripeForKind: (kind) => ({
        isEnabled: true,
        isLive: false,
        accountKind: kind,
        client: {
          webhooks: {
            constructEvent: (body, sig, secret) => {
              if (kind === "individual" && secret === "whsec_ind") {
                return { id: "evt_i1", type: "checkout.session.completed", livemode: false };
              }
              throw new Error("bad signature");
            },
          },
        },
      }),
      getWebhookSecret: (kind) => (kind === "corporate" ? "whsec_corp" : "whsec_ind"),
    });
    const { _internal } = require(webhookModPath);
    const r = _internal.verifyEventDualAccount_("body", "sig");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.accountKind, "individual");
    assert.strictEqual(r.event.id, "evt_i1");
  });

  test("両方失敗 → {ok:false, tried:[...]}", () => {
    installMock({
      allStripeSecrets: () => [],
      getStripeForKind: (kind) => ({
        isEnabled: true,
        isLive: false,
        accountKind: kind,
        client: {
          webhooks: {
            constructEvent: () => { throw new Error("bad signature"); },
          },
        },
      }),
      getWebhookSecret: () => "whsec_dummy",
    });
    const { _internal } = require(webhookModPath);
    const r = _internal.verifyEventDualAccount_("body", "sig");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.tried.length, 2);
    assert.strictEqual(r.tried[0].kind, "corporate");
    assert.strictEqual(r.tried[1].kind, "individual");
    assert.match(r.tried[0].reason, /bad signature/);
  });

  test("individual 側の secret 未設定 → 該当は skip されるが corporate 側で成功なら ok", () => {
    installMock({
      allStripeSecrets: () => [],
      getStripeForKind: (kind) => {
        // individual は Stripe 秘密鍵未設定 → isEnabled:false
        if (kind === "individual") {
          return { isEnabled: false, isLive: false, accountKind: "individual", client: null };
        }
        return {
          isEnabled: true, isLive: false, accountKind: kind,
          client: {
            webhooks: {
              constructEvent: () => ({ id: "evt_c2", type: "charge.refunded", livemode: false }),
            },
          },
        };
      },
      getWebhookSecret: (kind) => (kind === "corporate" ? "whsec_corp" : ""),
    });
    const { _internal } = require(webhookModPath);
    const r = _internal.verifyEventDualAccount_("body", "sig");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.accountKind, "corporate");
  });

  test("両方 未設定 → 両方 skip で ok:false + reason に未設定理由", () => {
    installMock({
      allStripeSecrets: () => [],
      getStripeForKind: (kind) => ({ isEnabled: false, isLive: false, accountKind: kind, client: null }),
      getWebhookSecret: () => "",
    });
    const { _internal } = require(webhookModPath);
    const r = _internal.verifyEventDualAccount_("body", "sig");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.tried.length, 2);
    assert.ok(r.tried.every((t) => /not_configured/.test(t.reason)));
  });
});
