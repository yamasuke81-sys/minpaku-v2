/**
 * reevaluateUnmatched の buildRematchPatch 単体テスト (node --test)
 * 実行: npm test
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const { buildRematchPatch } = require("./reevaluateUnmatched");

// FieldValue/Timestamp のダミー (admin 非依存で検証する)
const FV = {
  serverTimestamp: () => "SERVER_TS",
  timestampFromMillis: (ms) => ({ __ts: ms }),
};

describe("buildRematchPatch: 承認待ちフラグの降下", () => {
  test("decision が null でも confirmed なら pendingApproval を降ろす", () => {
    // 「古いメール」ガードで decision.updates=null になるケース。
    // ここで打ち切ると承認待ちの縞々が永久に残る (宿小町 10/27 予約の実障害)
    const booking = { pendingApproval: true, guestName: "Reserved" };
    const decision = { updates: null, skippedReason: "古いメール" };
    const patch = buildRematchPatch(booking, decision, { kind: "confirmed" }, "reevaluate", FV);
    assert.strictEqual(patch.pendingApproval, false);
    assert.strictEqual(patch.pendingApprovalResolvedAt, "SERVER_TS");
    // フィールド更新は行わない (古いメールで上書きしない)
    assert.strictEqual(patch.guestName, undefined);
    assert.strictEqual(patch.emailMatchedBy, undefined);
  });

  test("decision が null でも confirmed なら unverified を降ろす", () => {
    const booking = { unverified: true };
    const patch = buildRematchPatch(booking, { updates: null }, { kind: "confirmed" }, "reevaluate", FV);
    assert.strictEqual(patch.unverified, false);
    assert.strictEqual(patch.unverifiedResolvedAt, "SERVER_TS");
  });

  test("confirmed 以外はフラグを触らない", () => {
    const booking = { pendingApproval: true, unverified: true };
    const patch = buildRematchPatch(booking, { updates: null }, { kind: "request" }, "reevaluate", FV);
    assert.deepStrictEqual(patch, {});
  });

  test("フラグが元から false/未設定なら何も足さない", () => {
    const patch = buildRematchPatch({ pendingApproval: false }, { updates: null }, { kind: "confirmed" }, "reevaluate", FV);
    assert.deepStrictEqual(patch, {});
  });
});

describe("buildRematchPatch: 通常のフィールド更新", () => {
  test("updates を展開し emailMatchedBy を付ける", () => {
    const decision = { updates: { guestName: "Benjamin Marin", guestCount: 2 } };
    const patch = buildRematchPatch({}, decision, { kind: "confirmed" }, "auto-rematch-global", FV);
    assert.strictEqual(patch.guestName, "Benjamin Marin");
    assert.strictEqual(patch.guestCount, 2);
    assert.strictEqual(patch.emailMatchedBy, "auto-rematch-global");
  });

  test("placeholder を FieldValue/Timestamp に置換する", () => {
    const decision = {
      updates: {
        cancelledAt: { __placeholder: "serverTimestamp" },
        emailVerifiedAt: { __placeholder: "timestampFromMs", ms: 1700000000000 },
      },
    };
    const patch = buildRematchPatch({}, decision, { kind: "cancelled" }, "reevaluate", FV);
    assert.strictEqual(patch.cancelledAt, "SERVER_TS");
    assert.deepStrictEqual(patch.emailVerifiedAt, { __ts: 1700000000000 });
  });

  test("undefined の値は落とす", () => {
    const decision = { updates: { a: 1, b: undefined } };
    const patch = buildRematchPatch({}, decision, { kind: "confirmed" }, "reevaluate", FV);
    assert.strictEqual(patch.a, 1);
    assert.ok(!("b" in patch));
  });

  test("フィールド更新とフラグ降下は両立する", () => {
    const decision = { updates: { guestName: "X" } };
    const booking = { pendingApproval: true, unverified: true };
    const patch = buildRematchPatch(booking, decision, { kind: "confirmed" }, "reevaluate", FV);
    assert.strictEqual(patch.guestName, "X");
    assert.strictEqual(patch.pendingApproval, false);
    assert.strictEqual(patch.unverified, false);
  });

  test("booking が null でも落ちない", () => {
    const patch = buildRematchPatch(null, null, { kind: "confirmed" }, "reevaluate", FV);
    assert.deepStrictEqual(patch, {});
  });
});

describe("buildRematchPatch: フィールド削除プレースホルダ", () => {
  const fv = {
    serverTimestamp: () => "TS",
    timestampFromMillis: (ms) => `TS:${ms}`,
    delete: () => "DELETE",
  };

  test("__placeholder:delete を fv.delete() に解決する (キャンセル痕跡の除去)", () => {
    const decision = {
      updates: {
        status: "confirmed",
        cancelledAt: { __placeholder: "delete" },
        cancelReason: { __placeholder: "delete" },
        revivedAt: { __placeholder: "serverTimestamp" },
      },
    };
    const patch = buildRematchPatch({}, decision, { kind: "confirmed" }, "auto", fv);
    assert.strictEqual(patch.status, "confirmed");
    assert.strictEqual(patch.cancelledAt, "DELETE");
    assert.strictEqual(patch.cancelReason, "DELETE");
    assert.strictEqual(patch.revivedAt, "TS");
  });

  test("fv.delete() が無い場合は落ちずに無視する", () => {
    const fvNoDelete = { serverTimestamp: () => "TS", timestampFromMillis: (ms) => `TS:${ms}` };
    const decision = { updates: { cancelledAt: { __placeholder: "delete" } } };
    const patch = buildRematchPatch({}, decision, { kind: "confirmed" }, "auto", fvNoDelete);
    assert.ok(!("cancelledAt" in patch));
  });
});
