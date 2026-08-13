/**
 * recruitmentArchive 単体テスト (node --test)
 * 実行: npm test
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const { buildArchiveEntry, isWorthArchiving } = require("./recruitmentArchive");

describe("isWorthArchiving: 人の入力があるものだけ退避する", () => {
  test("回答がある募集は退避する", () => {
    assert.strictEqual(isWorthArchiving("recruitment", { responses: [{ staffId: "s1", response: "◎" }] }), true);
  });

  test("確定スタッフがいる募集は退避する (回答が空でも)", () => {
    assert.strictEqual(isWorthArchiving("recruitment", { responses: [], selectedStaffIds: ["s1"] }), true);
  });

  test("誰も触っていない募集は退避しない (ゴミを溜めない)", () => {
    assert.strictEqual(isWorthArchiving("recruitment", { responses: [], selectedStaffIds: [] }), false);
    assert.strictEqual(isWorthArchiving("recruitment", {}), false);
  });

  test("スタッフが入ったシフトは退避する", () => {
    assert.strictEqual(isWorthArchiving("shift", { staffIds: ["s1", "s2"] }), true);
    assert.strictEqual(isWorthArchiving("shift", { staffId: "s1", staffIds: [] }), true);
  });

  test("未割当のシフトは退避しない", () => {
    assert.strictEqual(isWorthArchiving("shift", { staffIds: [], staffId: null }), false);
  });

  test("未知の kind は退避しない", () => {
    assert.strictEqual(isWorthArchiving("checklist", { foo: 1 }), false);
  });
});

describe("buildArchiveEntry: 原本と要約を保存する", () => {
  const rec = {
    bookingId: "ical_x@booking.com",
    propertyId: "P1",
    workType: "pre_inspection",
    checkoutDate: "2026-08-26",
    status: "スタッフ確定済み",
    selectedStaff: "橋元優奈",
    selectedStaffIds: ["mjNoSlT3S8QhVSd30Ujv"],
    responses: [
      { staffId: "mjNoSlT3S8QhVSd30Ujv", staffName: "橋元優奈", response: "◎" },
      { staffId: "x", staffName: "誰か", response: "×" },
    ],
  };

  test("要約フィールドを埋める", () => {
    const e = buildArchiveEntry("recruitment", "rec1", rec, { reason: "cancel" });
    assert.strictEqual(e.kind, "recruitment");
    assert.strictEqual(e.sourceCollection, "recruitments");
    assert.strictEqual(e.sourceId, "rec1");
    assert.strictEqual(e.bookingId, "ical_x@booking.com");
    assert.strictEqual(e.propertyId, "P1");
    assert.strictEqual(e.workType, "pre_inspection");
    assert.strictEqual(e.checkoutDate, "2026-08-26");
    assert.strictEqual(e.responseCount, 2);
    assert.deepStrictEqual(e.selectedStaffIds, ["mjNoSlT3S8QhVSd30Ujv"]);
    assert.strictEqual(e.reason, "cancel");
  });

  test("原本をまるごと保持する (復元できることが目的)", () => {
    const e = buildArchiveEntry("recruitment", "rec1", rec, { reason: "cancel" });
    assert.deepStrictEqual(e.data, rec);
    assert.strictEqual(e.data.responses[1].response, "×");
  });

  test("シフトは staffIds を要約に載せる", () => {
    const shift = { bookingId: "b1", propertyId: "P1", workType: "cleaning_by_count", staffIds: ["a", "b"], staffName: "橋元優奈" };
    const e = buildArchiveEntry("shift", "sh1", shift, { reason: "switch_to_cleaning" });
    assert.strictEqual(e.sourceCollection, "shifts");
    assert.deepStrictEqual(e.selectedStaffIds, ["a", "b"]);
    assert.strictEqual(e.selectedStaff, "橋元優奈");
    assert.strictEqual(e.reason, "switch_to_cleaning");
  });

  test("bookingId/propertyId が原本に無ければ ctx で補う", () => {
    const e = buildArchiveEntry("recruitment", "r", { responses: [] }, { bookingId: "b9", propertyId: "P9", reason: "cancel" });
    assert.strictEqual(e.bookingId, "b9");
    assert.strictEqual(e.propertyId, "P9");
  });

  test("reason 未指定は unknown", () => {
    const e = buildArchiveEntry("recruitment", "r", {}, {});
    assert.strictEqual(e.reason, "unknown");
  });
});

// ======================================================
// archiveAndDelete: 退避できなければ削除しない (Codexレビュー指摘 P1)
// ======================================================

const { archiveAndDelete } = require("./recruitmentArchive");

function makeDb(setImpl) {
  const calls = { set: 0 };
  return {
    calls,
    collection() {
      return {
        doc() {
          return {
            async set(entry) { calls.set++; return setImpl(entry, calls.set); },
          };
        },
      };
    },
  };
}
function makeDoc(id, data) {
  const state = { deleted: 0 };
  return {
    id,
    data: () => data,
    state,
    ref: { async delete() { state.deleted++; } },
  };
}

describe("archiveAndDelete", () => {
  const withResponses = { responses: [{ staffId: "s1", staffName: "橋元優奈", response: "◎" }], bookingId: "b1", propertyId: "P1" };

  test("退避に成功したら削除する", async () => {
    const db = makeDb(async () => {});
    const doc = makeDoc("rec1", withResponses);
    const ok = await archiveAndDelete(db, doc, "recruitment", { reason: "cancel" });
    assert.strictEqual(ok, true);
    assert.strictEqual(doc.state.deleted, 1);
    assert.strictEqual(db.calls.set, 1);
  });

  test("★退避に失敗したら削除しない (回答を失わない)", async () => {
    const db = makeDb(async () => { throw new Error("permission denied"); });
    const doc = makeDoc("rec1", withResponses);
    const ok = await archiveAndDelete(db, doc, "recruitment", { reason: "cancel" });
    assert.strictEqual(ok, false);
    assert.strictEqual(doc.state.deleted, 0, "退避できていないのに削除してはいけない");
  });

  test("1回失敗しても再試行で成功すれば削除する", async () => {
    const db = makeDb(async (_e, n) => { if (n === 1) throw new Error("transient"); });
    const doc = makeDoc("rec1", withResponses);
    const ok = await archiveAndDelete(db, doc, "recruitment", { reason: "cancel" });
    assert.strictEqual(ok, true);
    assert.strictEqual(db.calls.set, 2);
    assert.strictEqual(doc.state.deleted, 1);
  });

  test("退避不要なもの(空の募集)は退避せずそのまま削除する", async () => {
    const db = makeDb(async () => { throw new Error("呼ばれないはず"); });
    const doc = makeDoc("rec2", { responses: [], selectedStaffIds: [] });
    const ok = await archiveAndDelete(db, doc, "recruitment", { reason: "cancel" });
    assert.strictEqual(ok, true);
    assert.strictEqual(db.calls.set, 0);
    assert.strictEqual(doc.state.deleted, 1);
  });

  test("スタッフ入りシフトも退避失敗なら削除しない", async () => {
    const db = makeDb(async () => { throw new Error("boom"); });
    const doc = makeDoc("sh1", { staffIds: ["a"], bookingId: "b1" });
    const ok = await archiveAndDelete(db, doc, "shift", { reason: "cancel" });
    assert.strictEqual(ok, false);
    assert.strictEqual(doc.state.deleted, 0);
  });
});

describe("orphanCleanup 経由でも回答が守られること", () => {
  test("孤児掃除の reason でも退避失敗なら削除しない", async () => {
    const db = makeDb(async () => { throw new Error("boom"); });
    const doc = makeDoc("rec9", { responses: [{ staffId: "s1", response: "◎" }], bookingId: "b1" });
    const ok = await archiveAndDelete(db, doc, "recruitment", { reason: "orphan_cleanup", bookingId: "b1" });
    assert.strictEqual(ok, false);
    assert.strictEqual(doc.state.deleted, 0);
  });

  test("孤児掃除でも回答があれば退避してから消す", async () => {
    const saved = [];
    const db = makeDb(async (entry) => { saved.push(entry); });
    const doc = makeDoc("rec9", { responses: [{ staffId: "s1", response: "◎" }], bookingId: "b1" });
    const ok = await archiveAndDelete(db, doc, "recruitment", { reason: "orphan_cleanup", bookingId: "b1" });
    assert.strictEqual(ok, true);
    assert.strictEqual(doc.state.deleted, 1);
    assert.strictEqual(saved[0].reason, "orphan_cleanup");
    assert.strictEqual(saved[0].responseCount, 1);
  });
});
