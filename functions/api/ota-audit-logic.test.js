/**
 * ota-audit-logic 純粋関数の単体テスト
 * 実行: node --test functions/api/ota-audit-logic.test.js
 *
 * 副作用のない純粋関数のみを検証する。Firestore/通知APIに触らない。
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const {
  containsCodeCI,
  addDaysStr_,
  daysBetween_,
  reconcileOtaSnapshot,
  collectKeyboxFindings,
  collectRosterFindings,
  buildPropertyReport,
  selectResolvableConflicts,
  detectMissingOtaSources,
  selectSnapshotBacklogActions,
  filterBackfillFindings,
  dedupeNewFindings,
  evaluateGuestCount,
  selectGuestCountIssueActions,
} = require("./ota-audit-logic");

const PID = "propA";

describe("containsCodeCI", () => {
  test("大文字小文字を無視して部分一致", () => {
    assert.strictEqual(containsCodeCI("メモ: HMABC123 予約", "hmabc123"), true);
    assert.strictEqual(containsCodeCI("ical-uid-HMXYZ@airbnb.com", "hmxyz"), true);
  });
  test("含まれない/空はfalse", () => {
    assert.strictEqual(containsCodeCI("メモ: 何もなし", "HMABC123"), false);
    assert.strictEqual(containsCodeCI("", "HMABC123"), false);
    assert.strictEqual(containsCodeCI("メモ", ""), false);
    assert.strictEqual(containsCodeCI(null, "code"), false);
  });
});

describe("addDaysStr_ / daysBetween_", () => {
  test("日付加算", () => {
    assert.strictEqual(addDaysStr_("2026-07-18", 3), "2026-07-21");
    assert.strictEqual(addDaysStr_("2026-07-30", 3), "2026-08-02");
  });
  test("日数差", () => {
    assert.strictEqual(daysBetween_("2026-07-18", "2026-07-21"), 3);
    assert.strictEqual(daysBetween_("2026-07-18", "2026-07-18"), 0);
  });
});

describe("reconcileOtaSnapshot", () => {
  function otaRow(overrides) {
    return {
      ota: "airbnb", propertyId: PID, propertyName: "テスト物件",
      code: "", status: "accepted", cancelled: false,
      guestName: "山田太郎", checkIn: "2026-07-20", checkOut: "2026-07-22",
      adults: 2, children: 0, infants: 0, guests: 2,
      ...overrides,
    };
  }
  function booking(overrides) {
    return {
      id: "bk1", propertyId: PID, propertyName: "テスト物件",
      source: "Airbnb", status: "confirmed",
      checkIn: "2026-07-20", checkOut: "2026-07-22",
      guestName: "山田太郎", notes: "", icalUid: "", guestCount: 2,
      pendingApproval: false, unverified: false,
      ...overrides,
    };
  }

  test("missing_in_v2: cancelled=falseのOTA予約がv2に無ければ検出", () => {
    const r = reconcileOtaSnapshot({ reservations: [otaRow({})], bookings: [], registrations: [] });
    assert.strictEqual(r.findings.length, 1);
    assert.strictEqual(r.findings[0].type, "missing_in_v2");
    assert.strictEqual(r.findings[0].propertyId, PID);
  });

  test("missing_in_v2: cancelled=trueなら未マッチでも検出しない(OTA側で既にキャンセル済み)", () => {
    const r = reconcileOtaSnapshot({ reservations: [otaRow({ cancelled: true })], bookings: [], registrations: [] });
    assert.strictEqual(r.findings.filter(f => f.type === "missing_in_v2").length, 0);
  });

  test("missing_in_v2: CIがtodayより前の滞在中OTA行(現在ホスティング中)は未マッチでも検出しない", () => {
    // Airbnbの期間フィルタは滞在が窓に重なる予約を返すため、CI過去の滞在中予約がスナップショットに載る。
    // bookingsクエリ範囲(today−7日〜)に入らない長期滞在でも誤検知しないこと
    const r = reconcileOtaSnapshot({
      reservations: [otaRow({ status: "現在ホスティング中", checkIn: "2026-07-16", checkOut: "2026-07-21" })],
      bookings: [],
      registrations: [],
      todayStr: "2026-07-18",
    });
    assert.strictEqual(r.findings.filter(f => f.type === "missing_in_v2").length, 0);
  });

  test("missing_in_v2: CIがちょうどtoday(境界)なら検出する", () => {
    const r = reconcileOtaSnapshot({
      reservations: [otaRow({ checkIn: "2026-07-18", checkOut: "2026-07-20" })],
      bookings: [],
      registrations: [],
      todayStr: "2026-07-18",
    });
    assert.strictEqual(r.findings.filter(f => f.type === "missing_in_v2").length, 1);
  });

  test("滞在中OTA行(CI過去)もマッチング・cancelled_in_ota・guest_count_mismatchには使う", () => {
    // CI過去の滞在中予約でも、コード一致でv2予約と対応付き、
    // OTAキャンセル済み/人数不一致は通常どおり検出されること
    const rCancel = reconcileOtaSnapshot({
      reservations: [otaRow({ code: "HMPAST1", cancelled: true, checkIn: "2026-07-16", checkOut: "2026-07-21" })],
      bookings: [booking({ notes: "HMPAST1", checkIn: "2026-07-16", checkOut: "2026-07-21" })],
      registrations: [],
      todayStr: "2026-07-18",
    });
    assert.strictEqual(rCancel.findings.filter(f => f.type === "cancelled_in_ota").length, 1);

    const rGuests = reconcileOtaSnapshot({
      reservations: [otaRow({ code: "HMPAST2", guests: 3, checkIn: "2026-07-16", checkOut: "2026-07-21" })],
      bookings: [booking({ notes: "HMPAST2", checkIn: "2026-07-16", checkOut: "2026-07-21" })],
      registrations: [{ id: "g1", bookingId: "bk1", propertyId: PID, guestCount: 5, guestCountInfants: 1, status: "submitted" }],
      todayStr: "2026-07-18",
    });
    assert.strictEqual(rGuests.findings.filter(f => f.type === "guest_count_mismatch").length, 1);
    // マッチ済みなので missing_in_v2 は出ない
    assert.strictEqual(rGuests.findings.filter(f => f.type === "missing_in_v2").length, 0);
  });

  test("コード一致でmissing_in_v2を回避できる", () => {
    const r = reconcileOtaSnapshot({
      reservations: [otaRow({ code: "HMABC123", checkOut: "2026-07-23" })], // 日付は微妙にズレさせる
      bookings: [booking({ notes: "予約コード: HMABC123" })],
      registrations: [],
    });
    assert.strictEqual(r.findings.filter(f => f.type === "missing_in_v2").length, 0);
    // 日付不一致は別途 date_mismatch で検出される
    assert.ok(r.findings.some(f => f.type === "date_mismatch"));
  });

  test("cancelled_in_ota: コード一致 かつ OTAキャンセル済み かつ v2がconfirmedのまま", () => {
    const r = reconcileOtaSnapshot({
      reservations: [otaRow({ code: "HMABC123", cancelled: true })],
      bookings: [booking({ notes: "HMABC123" })],
      registrations: [],
    });
    assert.strictEqual(r.findings.length, 1);
    assert.strictEqual(r.findings[0].type, "cancelled_in_ota");
  });

  test("cancelled_in_ota: 日付一致(コード一致でない)では発火しない", () => {
    const r = reconcileOtaSnapshot({
      reservations: [otaRow({ cancelled: true })], // codeなし→日付一致のみでマッチ
      bookings: [booking({})],
      registrations: [],
    });
    assert.strictEqual(r.findings.filter(f => f.type === "cancelled_in_ota").length, 0);
  });

  test("date_mismatch: コード一致だがcheckOutが不一致", () => {
    const r = reconcileOtaSnapshot({
      reservations: [otaRow({ code: "HMABC123", checkOut: "2026-07-25" })],
      bookings: [booking({ notes: "HMABC123", checkOut: "2026-07-22" })],
      registrations: [],
    });
    const f = r.findings.find(x => x.type === "date_mismatch");
    assert.ok(f);
    assert.strictEqual(f.detail.otaCheckOut, "2026-07-25");
    assert.strictEqual(f.detail.v2CheckOut, "2026-07-22");
  });

  test("日付完全一致なら date_mismatch は出ない", () => {
    const r = reconcileOtaSnapshot({
      reservations: [otaRow({})],
      bookings: [booking({})],
      registrations: [],
    });
    assert.strictEqual(r.findings.length, 0);
  });

  test("guest_count_mismatch: OTA人数と名簿人数(乳幼児除く)が食い違う", () => {
    const r = reconcileOtaSnapshot({
      reservations: [otaRow({ guests: 3 })],
      bookings: [booking({})],
      registrations: [{ id: "g1", bookingId: "bk1", propertyId: PID, guestCount: 5, guestCountInfants: 1, status: "submitted" }],
    });
    // guestCount はフォーム仕様で乳幼児除きの値。5 ≠ ota.guests3 (乳幼児の再減算はしない)
    const f = r.findings.find(x => x.type === "guest_count_mismatch");
    assert.ok(f);
    assert.strictEqual(f.detail.otaGuests, 3);
    assert.strictEqual(f.detail.rosterGuests, 5);
    assert.strictEqual(f.detail.rosterInfants, 1);
  });

  test("guest_count_mismatch: guestCount(乳幼児除き入力)がOTA人数と一致すれば検出しない", () => {
    const r = reconcileOtaSnapshot({
      reservations: [otaRow({ guests: 4 })],
      bookings: [booking({})],
      registrations: [{ id: "g1", bookingId: "bk1", propertyId: PID, guestCount: 4, guestCountInfants: 1, status: "submitted" }],
    });
    assert.strictEqual(r.findings.filter(f => f.type === "guest_count_mismatch").length, 0);
  });

  test("guest_count_mismatch: 対応する名簿が無ければ検出しない", () => {
    const r = reconcileOtaSnapshot({
      reservations: [otaRow({ guests: 3 })],
      bookings: [booking({})],
      registrations: [],
    });
    assert.strictEqual(r.findings.filter(f => f.type === "guest_count_mismatch").length, 0);
  });

  test("missing_in_ota: auditedTargetsに含まれるペアで、confirmedのv2予約がOTA一覧に無ければ検出", () => {
    const r = reconcileOtaSnapshot({
      reservations: [],
      bookings: [booking({})],
      registrations: [],
      auditedTargets: [{ propertyId: PID, ota: "airbnb" }],
    });
    assert.strictEqual(r.findings.length, 1);
    assert.strictEqual(r.findings[0].type, "missing_in_ota");
  });

  test("missing_in_ota: auditedTargetsに明示的に含まれないペアはスキップ(誤検知防止)", () => {
    const r = reconcileOtaSnapshot({
      reservations: [],
      bookings: [booking({})],
      registrations: [],
      auditedTargets: [], // 何も監査できなかった(全滅)扱い
    });
    assert.strictEqual(r.findings.filter(f => f.type === "missing_in_ota").length, 0);
  });

  test("missing_in_ota: auditedTargets省略時はreservationsに登場したペアへフォールバック", () => {
    // このpropertyId×otaの別予約がreservationsに存在する→「監査された」とみなしてmissing_in_otaが働く
    const r = reconcileOtaSnapshot({
      reservations: [otaRow({ guestName: "別ゲスト" })], // bk1とは別予約なのでbk1はマッチしないまま残る
      bookings: [booking({ id: "bk2", checkIn: "2026-08-01", checkOut: "2026-08-03" })],
      registrations: [],
    });
    assert.ok(r.findings.some(f => f.type === "missing_in_ota" && f.detail.bookingId === "bk2"));
  });

  test("missing_in_ota: auditedTargets省略 かつ reservationsに該当ペアの行が無ければ対象外(おのみちホテル等の別アカウント運用物件対策)", () => {
    const r = reconcileOtaSnapshot({
      reservations: [], // このproperty×otaのOTA予約は1件もスナップショットに現れない
      bookings: [booking({})],
      registrations: [],
      // auditedTargets省略 → フォールバックはreservationsから導出されるが、空なので対象外
    });
    assert.strictEqual(r.findings.filter(f => f.type === "missing_in_ota").length, 0);
  });

  test("missing_in_ota: pendingApproval===true はスキップ", () => {
    const r = reconcileOtaSnapshot({
      reservations: [],
      bookings: [booking({ pendingApproval: true })],
      registrations: [],
      auditedTargets: [{ propertyId: PID, ota: "airbnb" }],
    });
    assert.strictEqual(r.findings.filter(f => f.type === "missing_in_ota").length, 0);
  });

  test("missing_in_ota: unverified===true はスキップ", () => {
    const r = reconcileOtaSnapshot({
      reservations: [],
      bookings: [booking({ unverified: true })],
      registrations: [],
      auditedTargets: [{ propertyId: PID, ota: "airbnb" }],
    });
    assert.strictEqual(r.findings.filter(f => f.type === "missing_in_ota").length, 0);
  });

  test("missing_in_ota: statusがconfirmedでなければ対象外", () => {
    const r = reconcileOtaSnapshot({
      reservations: [],
      bookings: [booking({ status: "cancelled" })],
      registrations: [],
      auditedTargets: [{ propertyId: PID, ota: "airbnb" }],
    });
    assert.strictEqual(r.findings.filter(f => f.type === "missing_in_ota").length, 0);
  });

  test("missing_in_ota: CIがtodayより前のv2予約(滞在中/終了済み)は対象外(クエリ拡大分はマッチング専用)", () => {
    // 終了済み滞在はOTAスナップショット窓(today〜+30日)に重ならず載らないため、誤検知になる
    const r = reconcileOtaSnapshot({
      reservations: [],
      bookings: [booking({ checkIn: "2026-07-12", checkOut: "2026-07-15" })],
      registrations: [],
      auditedTargets: [{ propertyId: PID, ota: "airbnb" }],
      todayStr: "2026-07-18",
    });
    assert.strictEqual(r.findings.filter(f => f.type === "missing_in_ota").length, 0);
  });

  test("source=direct の予約はOTA突合の対象外(missing_in_otaにならない)", () => {
    const r = reconcileOtaSnapshot({
      reservations: [],
      bookings: [booking({ source: "direct" })],
      registrations: [],
    });
    assert.strictEqual(r.findings.length, 0);
  });

  test("parse_error: checkInが空のOTA行は物件単位でまとめて1件のfindingになる", () => {
    const r = reconcileOtaSnapshot({
      reservations: [
        otaRow({ checkIn: "", guestName: "A" }),
        otaRow({ checkIn: "", guestName: "B" }),
      ],
      bookings: [],
      registrations: [],
    });
    const errs = r.findings.filter(f => f.type === "parse_error");
    assert.strictEqual(errs.length, 1);
    assert.strictEqual(errs[0].detail.count, 2);
  });

  test("コード一致が最優先で確定してから日付一致が割り当てられる", () => {
    // OTA行A: コードでbooking2と一致するが、日付だけならbooking1とも一致してしまう
    const resA = otaRow({ code: "HMCODE2", guestName: "A", checkIn: "2026-07-20", checkOut: "2026-07-22" });
    const resB = otaRow({ code: "", guestName: "B", checkIn: "2026-07-20", checkOut: "2026-07-22" });
    const bk1 = booking({ id: "bk1", guestName: "X", notes: "", checkIn: "2026-07-20", checkOut: "2026-07-22" });
    const bk2 = booking({ id: "bk2", guestName: "Y", notes: "HMCODE2", checkIn: "2026-07-20", checkOut: "2026-07-22" });

    const r = reconcileOtaSnapshot({ reservations: [resA, resB], bookings: [bk1, bk2], registrations: [] });
    // コード一致でresA↔bk2が確定 → resBは残ったbk1と日付一致 → 突合差分なし
    assert.strictEqual(r.findings.length, 0);
  });

  test("複数物件・複数プラットフォームが混在しても物件×OTAごとに独立して突合される", () => {
    const otherPid = "propB";
    const r = reconcileOtaSnapshot({
      reservations: [
        otaRow({ propertyId: PID, ota: "airbnb" }),
        otaRow({ propertyId: otherPid, ota: "booking", propertyName: "別物件" }),
      ],
      bookings: [
        booking({ id: "bk1", propertyId: PID, source: "Airbnb" }),
        // propBのBooking予約はv2に無い→missing_in_v2
      ],
      registrations: [],
    });
    assert.strictEqual(r.findings.length, 1);
    assert.strictEqual(r.findings[0].propertyId, otherPid);
    assert.strictEqual(r.findings[0].type, "missing_in_v2");
  });
});

describe("collectKeyboxFindings", () => {
  const TODAY = "2026-07-18";
  function reg(overrides) {
    return {
      id: "g1", propertyId: PID, guestName: "山田太郎", checkIn: TODAY,
      email: "a@example.com", keyboxSentAt: null, keyboxConfirmedAt: null,
      bookingId: "bk1", status: "submitted",
      ...overrides,
    };
  }
  const propEnabled = { id: PID, name: "テスト物件", keyboxSend: { enabled: true } };
  const bkLive = { id: "bk1", status: "confirmed" };

  test("当日CIでkeyboxSentAt未設定なら検出", () => {
    const r = collectKeyboxFindings({ registrations: [reg({})], bookings: [bkLive], properties: [propEnabled], todayStr: TODAY });
    assert.strictEqual(r.findings.length, 1);
    assert.strictEqual(r.findings[0].type, "keybox_unsent");
  });

  test("keyboxSentAt設定済みなら検出しない", () => {
    const r = collectKeyboxFindings({ registrations: [reg({ keyboxSentAt: new Date() })], bookings: [bkLive], properties: [propEnabled], todayStr: TODAY });
    assert.strictEqual(r.findings.length, 0);
  });

  test("物件のkeyboxSend.enabledがtrueでなければスキップ", () => {
    const propDisabled = { id: PID, name: "テスト物件", keyboxSend: { enabled: false } };
    const r = collectKeyboxFindings({ registrations: [reg({})], bookings: [bkLive], properties: [propDisabled], todayStr: TODAY });
    assert.strictEqual(r.findings.length, 0);
  });

  test("物件のkeyboxSend未設定でもスキップ", () => {
    const propNoKeybox = { id: PID, name: "テスト物件" };
    const r = collectKeyboxFindings({ registrations: [reg({})], bookings: [bkLive], properties: [propNoKeybox], todayStr: TODAY });
    assert.strictEqual(r.findings.length, 0);
  });

  test("孤児名簿ガード: bookingIdがbookingsに存在しなければスキップ", () => {
    const r = collectKeyboxFindings({ registrations: [reg({ bookingId: "missing" })], bookings: [bkLive], properties: [propEnabled], todayStr: TODAY });
    assert.strictEqual(r.findings.length, 0);
  });

  test("孤児名簿ガード: bookingがcancelledならスキップ", () => {
    const r = collectKeyboxFindings({ registrations: [reg({})], bookings: [{ id: "bk1", status: "cancelled" }], properties: [propEnabled], todayStr: TODAY });
    assert.strictEqual(r.findings.length, 0);
  });

  test("bookingId無しの名簿は孤児ガードをスキップして通常判定", () => {
    const r = collectKeyboxFindings({ registrations: [reg({ bookingId: null })], bookings: [], properties: [propEnabled], todayStr: TODAY });
    assert.strictEqual(r.findings.length, 1);
  });

  test("メッセージはOKボタン押下有無で書き分ける", () => {
    const r1 = collectKeyboxFindings({ registrations: [reg({ keyboxConfirmedAt: new Date() })], bookings: [bkLive], properties: [propEnabled], todayStr: TODAY });
    assert.match(r1.findings[0].message, /OKボタン押下済み/);
    const r2 = collectKeyboxFindings({ registrations: [reg({})], bookings: [bkLive], properties: [propEnabled], todayStr: TODAY });
    assert.match(r2.findings[0].message, /OKボタン未押下/);
  });

  test("チェックインが当日でなければ対象外", () => {
    const r = collectKeyboxFindings({ registrations: [reg({ checkIn: "2026-07-19" })], bookings: [bkLive], properties: [propEnabled], todayStr: TODAY });
    assert.strictEqual(r.findings.length, 0);
  });

  test("statusがsubmitted/confirmed以外は対象外", () => {
    const r = collectKeyboxFindings({ registrations: [reg({ status: "draft" })], bookings: [bkLive], properties: [propEnabled], todayStr: TODAY });
    assert.strictEqual(r.findings.length, 0);
  });
});

describe("collectRosterFindings", () => {
  const TODAY = "2026-07-18";
  function bk(overrides) {
    return {
      id: "bk1", propertyId: PID, propertyName: "テスト物件",
      status: "confirmed", checkIn: "2026-07-20", checkOut: "2026-07-22",
      guestName: "山田太郎", rosterStatus: "", pendingApproval: false, unverified: false,
      ...overrides,
    };
  }
  // roster_remind 有効物件 (the Terrace / YADO KOMACHI 等を想定)
  const rosterEnabledProps = [{ id: PID, channelOverrides: { roster_remind: { enabled: true } } }];

  test("3日以内・名簿未提出のconfirmed予約を検出", () => {
    const r = collectRosterFindings({ bookings: [bk({})], properties: rosterEnabledProps, todayStr: TODAY });
    assert.strictEqual(r.findings.length, 1);
    assert.strictEqual(r.findings[0].type, "roster_missing");
    assert.strictEqual(r.findings[0].detail.daysUntil, 2);
  });

  test("roster_remind が無効な物件はスキップ(おのみちホテル/Hotel Zen等の名簿運用なし物件対策)", () => {
    const disabledProps = [{ id: PID, channelOverrides: { roster_remind: { enabled: false } } }];
    const r = collectRosterFindings({ bookings: [bk({})], properties: disabledProps, todayStr: TODAY });
    assert.strictEqual(r.findings.length, 0);
  });

  test("roster_remind の channelOverrides自体が未設定の物件もスキップ", () => {
    const noOverrideProps = [{ id: PID }];
    const r = collectRosterFindings({ bookings: [bk({})], properties: noOverrideProps, todayStr: TODAY });
    assert.strictEqual(r.findings.length, 0);
  });

  test("properties未指定(空)なら誰も対象にならない", () => {
    const r = collectRosterFindings({ bookings: [bk({})], todayStr: TODAY });
    assert.strictEqual(r.findings.length, 0);
  });

  test("warnDaysの境界(ちょうどN日後)は含む", () => {
    const r = collectRosterFindings({ bookings: [bk({ checkIn: "2026-07-21" })], properties: rosterEnabledProps, todayStr: TODAY, warnDays: 3 });
    assert.strictEqual(r.findings.length, 1);
  });

  test("warnDaysを超えるチェックインは対象外", () => {
    const r = collectRosterFindings({ bookings: [bk({ checkIn: "2026-07-22" })], properties: rosterEnabledProps, todayStr: TODAY, warnDays: 3 });
    assert.strictEqual(r.findings.length, 0);
  });

  test("rosterStatus===submittedなら対象外", () => {
    const r = collectRosterFindings({ bookings: [bk({ rosterStatus: "submitted" })], properties: rosterEnabledProps, todayStr: TODAY });
    assert.strictEqual(r.findings.length, 0);
  });

  test("pendingApproval===trueなら対象外", () => {
    const r = collectRosterFindings({ bookings: [bk({ pendingApproval: true })], properties: rosterEnabledProps, todayStr: TODAY });
    assert.strictEqual(r.findings.length, 0);
  });

  test("unverified===trueなら対象外", () => {
    const r = collectRosterFindings({ bookings: [bk({ unverified: true })], properties: rosterEnabledProps, todayStr: TODAY });
    assert.strictEqual(r.findings.length, 0);
  });

  test("statusがconfirmedでなければ対象外", () => {
    const r = collectRosterFindings({ bookings: [bk({ status: "pending" })], properties: rosterEnabledProps, todayStr: TODAY });
    assert.strictEqual(r.findings.length, 0);
  });

  test("チェックインが過去日(todayより前)は対象外", () => {
    const r = collectRosterFindings({ bookings: [bk({ checkIn: "2026-07-17" })], properties: rosterEnabledProps, todayStr: TODAY });
    assert.strictEqual(r.findings.length, 0);
  });
});

describe("buildPropertyReport", () => {
  test("🚨 → ⚠️ → その他 の順にグループ化される", () => {
    const findings = [
      { type: "roster_missing", message: "⚠️ 名簿未提出です" },
      { type: "missing_in_v2", message: "🚨 OTAにあるがv2に無い" },
      { type: "parse_error", message: "ℹ️ 日付解析エラー" },
    ];
    const text = buildPropertyReport("テスト物件", findings, "2026-07-18");
    const idxCritical = text.indexOf("突合差分");
    const idxWarning = text.indexOf("要確認");
    const idxOther = text.indexOf("その他");
    assert.ok(idxCritical > -1 && idxWarning > -1 && idxOther > -1);
    assert.ok(idxCritical < idxWarning);
    assert.ok(idxWarning < idxOther);
    assert.ok(text.includes("OTAにあるがv2に無い"));
    assert.ok(text.includes("名簿未提出です"));
  });

  test("物件名と日付が見出しに入る", () => {
    const text = buildPropertyReport("テスト物件", [{ type: "roster_missing", message: "test" }], "2026-07-18");
    assert.ok(text.includes("テスト物件"));
    assert.ok(text.includes("2026-07-18"));
  });

  test("findingsが空でも例外にならない", () => {
    const text = buildPropertyReport("テスト物件", [], "2026-07-18");
    assert.ok(typeof text === "string");
  });
});

describe("finding.url (ディープリンク付与)", () => {
  const APP = "https://v2-5-relay.web.app";

  test("roster_missing: 予約詳細モーダルのディープリンク", () => {
    const props = [{ id: PID, channelOverrides: { roster_remind: { enabled: true } } }];
    const bookings = [{ id: "bk1", propertyId: PID, propertyName: "宿A", status: "confirmed", checkIn: "2026-07-19" }];
    const { findings } = collectRosterFindings({ bookings, properties: props, todayStr: "2026-07-18", appUrl: APP });
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].url, `${APP}/#/schedule?bookingId=bk1`);
  });

  test("keybox_unsent: 名簿詳細 (#/guests?id=) のリンク", () => {
    const props = [{ id: PID, name: "宿A", keyboxSend: { enabled: true } }];
    const regs = [{ id: "g1", propertyId: PID, guestName: "ゲスト", checkIn: "2026-07-18", status: "submitted" }];
    const { findings } = collectKeyboxFindings({ registrations: regs, bookings: [], properties: props, todayStr: "2026-07-18", appUrl: APP });
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].url, `${APP}/#/guests?id=g1`);
  });

  test("guest_count_mismatch: 名簿リンク優先 / missing_in_ota: 予約リンク / missing_in_v2: scheduleリンク", () => {
    const reservations = [
      { ota: "airbnb", propertyId: PID, propertyName: "宿A", code: "HMAAA", cancelled: false, checkIn: "2026-07-20", checkOut: "2026-07-22", guests: 5 },
      { ota: "airbnb", propertyId: PID, propertyName: "宿A", code: "HMBBB", cancelled: false, checkIn: "2026-07-25", checkOut: "2026-07-26", guests: 2 },
    ];
    const bookings = [
      { id: "bk1", propertyId: PID, source: "Airbnb", status: "confirmed", checkIn: "2026-07-20", checkOut: "2026-07-22", notes: "HMAAA" },
      { id: "bk2", propertyId: PID, source: "Airbnb", status: "confirmed", checkIn: "2026-07-28", checkOut: "2026-07-29", notes: "" },
    ];
    const regs = [{ id: "g9", bookingId: "bk1", propertyId: PID, status: "submitted", guestCount: 4, guestCountInfants: 0 }];
    const { findings } = reconcileOtaSnapshot({
      reservations, bookings, registrations: regs,
      auditedTargets: [{ propertyId: PID, ota: "airbnb" }],
      todayStr: "2026-07-18", appUrl: APP,
    });
    const gc = findings.find((f) => f.type === "guest_count_mismatch");
    assert.ok(gc);
    assert.strictEqual(gc.url, `${APP}/#/guests?id=g9`);
    const mo = findings.find((f) => f.type === "missing_in_ota");
    assert.ok(mo);
    assert.strictEqual(mo.url, `${APP}/#/schedule?bookingId=bk2`);
    const mv = findings.find((f) => f.type === "missing_in_v2");
    assert.ok(mv);
    assert.strictEqual(mv.url, `${APP}/#/schedule`);
  });

  test("appUrl 未指定なら url は null (後方互換)", () => {
    const props = [{ id: PID, channelOverrides: { roster_remind: { enabled: true } } }];
    const bookings = [{ id: "bk1", propertyId: PID, status: "confirmed", checkIn: "2026-07-19" }];
    const { findings } = collectRosterFindings({ bookings, properties: props, todayStr: "2026-07-18" });
    assert.strictEqual(findings[0].url, null);
  });

  test("buildPropertyReport: url がある項目の直下に 🔗 行が入る", () => {
    const report = buildPropertyReport("宿A", [
      { type: "roster_missing", message: "⚠️ テスト様: 名簿未提出", url: `${APP}/#/schedule?bookingId=bk1` },
      { type: "parse_error", message: "ℹ️ 解析エラー", url: null },
    ], "2026-07-18");
    assert.ok(report.includes("・⚠️ テスト様: 名簿未提出\n　🔗 https://v2-5-relay.web.app/#/schedule?bookingId=bk1"));
    assert.ok(!report.includes("🔗 null"));
  });
});

describe("selectResolvableConflicts", () => {
  const TODAY = "2026-08-16";
  const bk = (id, checkIn, checkOut, status = "confirmed") =>
    [id, { propertyId: PID, checkIn, checkOut, status }];

  test("滞在が全て過去なら expired で閉じる", () => {
    const bookingsById = new Map([
      bk("a", "2026-05-10", "2026-05-12"),
      bk("b", "2026-05-11", "2026-05-13"),
    ]);
    const { resolvable } = selectResolvableConflicts({
      conflicts: [{ id: "a__b", bookingIds: ["a", "b"] }], bookingsById, todayStr: TODAY,
    });
    assert.deepStrictEqual(resolvable, [{ id: "a__b", reason: "expired" }]);
  });

  test("片方でも滞在が今日以降なら現行として触らない", () => {
    const bookingsById = new Map([
      bk("a", "2026-08-10", "2026-08-16"), // checkOut === today
      bk("b", "2026-08-11", "2026-08-13"),
    ]);
    const { resolvable } = selectResolvableConflicts({
      conflicts: [{ id: "a__b", bookingIds: ["a", "b"] }], bookingsById, todayStr: TODAY,
    });
    assert.deepStrictEqual(resolvable, []);
  });

  test("未来の滞在でも片方がキャンセル済みなら cancelled で閉じる", () => {
    const bookingsById = new Map([
      bk("a", "2026-09-01", "2026-09-03"),
      bk("b", "2026-09-02", "2026-09-04", "cancelled"),
    ]);
    const { resolvable } = selectResolvableConflicts({
      conflicts: [{ id: "a__b", bookingIds: ["a", "b"] }], bookingsById, todayStr: TODAY,
    });
    assert.deepStrictEqual(resolvable, [{ id: "a__b", reason: "cancelled" }]);
  });

  test("日本語の『キャンセル済み』も判定する", () => {
    const bookingsById = new Map([
      bk("a", "2026-09-01", "2026-09-03"),
      bk("b", "2026-09-02", "2026-09-04", "キャンセル済み"),
    ]);
    const { resolvable } = selectResolvableConflicts({
      conflicts: [{ id: "a__b", bookingIds: ["a", "b"] }], bookingsById, todayStr: TODAY,
    });
    assert.strictEqual(resolvable[0].reason, "cancelled");
  });

  test("予約が消えていれば bookings_missing で閉じる", () => {
    const both = selectResolvableConflicts({
      conflicts: [{ id: "a__b", bookingIds: ["a", "b"] }], bookingsById: new Map(), todayStr: TODAY,
    });
    assert.deepStrictEqual(both.resolvable, [{ id: "a__b", reason: "bookings_missing" }]);

    // 片方だけ消えた場合も衝突相手が居ないので閉じる
    const one = selectResolvableConflicts({
      conflicts: [{ id: "a__b", bookingIds: ["a", "b"] }],
      bookingsById: new Map([bk("a", "2026-09-01", "2026-09-03")]),
      todayStr: TODAY,
    });
    assert.deepStrictEqual(one.resolvable, [{ id: "a__b", reason: "bookings_missing" }]);
  });

  test("bookingIds が空/壊れているドキュメントは触らない", () => {
    const { resolvable } = selectResolvableConflicts({
      conflicts: [{ id: "x", bookingIds: [] }, { id: "y" }],
      bookingsById: new Map(), todayStr: TODAY,
    });
    assert.deepStrictEqual(resolvable, []);
  });

  test("現行と残骸が混在しても残骸だけ返す", () => {
    const bookingsById = new Map([
      bk("a", "2026-05-10", "2026-05-12"),
      bk("b", "2026-05-11", "2026-05-13"),
      bk("c", "2026-08-20", "2026-08-22"),
      bk("d", "2026-08-21", "2026-08-23"),
    ]);
    const { resolvable } = selectResolvableConflicts({
      conflicts: [
        { id: "a__b", bookingIds: ["a", "b"] },
        { id: "c__d", bookingIds: ["c", "d"] },
      ],
      bookingsById, todayStr: TODAY,
    });
    assert.deepStrictEqual(resolvable, [{ id: "a__b", reason: "expired" }]);
  });
});

describe("detectMissingOtaSources", () => {
  // 実データ (2026-08-17 の障害時) を模した物件マスタ
  const terrace = {
    id: "tsZybhDMcPrxqgcRy7wp",
    name: "the Terrace 長浜",
    yadozei: {
      airbnb: { enabled: true, listingName: "瀬戸内海ビュー大テラス" },
      booking: { enabled: true, propertyId: "14868587" },
    },
  };
  const komachi = {
    id: "RZV9IwtQgMAsvrdM3j8J",
    name: "YADO KOMACHI Hiroshima",
    yadozei: {
      airbnb: { enabled: true, auditListingNames: ["【YADO KOMACHI】…", "挽きたて珈琲"] },
    },
  };
  // 開業前物件: enabled=false / 設定が空 → 期待ターゲットにしない
  const wakakusa = {
    id: "ZXW6wdpnBFk1azQ87KXQ",
    name: "Pocket House WAKA-KUSA",
    yadozei: { airbnb: { enabled: false }, booking: { enabled: false, propertyId: "" } },
  };

  test("Booking.comが auditedTargets から丸ごと落ちていれば未取得として検出(2026-08-17 実障害)", () => {
    const { missing } = detectMissingOtaSources({
      properties: [terrace, komachi, wakakusa],
      auditedTargets: [
        { propertyId: komachi.id, ota: "airbnb" },
        { propertyId: terrace.id, ota: "airbnb" },
      ],
    });
    assert.deepStrictEqual(missing, [
      { propertyId: terrace.id, propertyName: "the Terrace 長浜", ota: "booking", otaLabel: "Booking.com" },
    ]);
  });

  test("全ソースが揃っていれば missing は空(前日8/16の正常時)", () => {
    const { missing, expected } = detectMissingOtaSources({
      properties: [terrace, komachi, wakakusa],
      auditedTargets: [
        { propertyId: komachi.id, ota: "airbnb" },
        { propertyId: terrace.id, ota: "airbnb" },
        { propertyId: terrace.id, ota: "booking" },
      ],
    });
    assert.deepStrictEqual(missing, []);
    assert.strictEqual(expected.length, 3);
  });

  test("設定が空/無効な物件は期待ターゲットにしない(開業前物件で誤報を出さない)", () => {
    const { expected } = detectMissingOtaSources({ properties: [wakakusa], auditedTargets: [] });
    assert.deepStrictEqual(expected, []);
  });

  test("enabled でも listingId/施設IDが空なら期待しない(listener が取得しようがない)", () => {
    const half = {
      id: "p1", name: "設定途中",
      yadozei: { airbnb: { enabled: true, listingName: "  " }, booking: { enabled: true, propertyId: "" } },
    };
    const { expected, missing } = detectMissingOtaSources({ properties: [half], auditedTargets: [] });
    assert.deepStrictEqual(expected, []);
    assert.deepStrictEqual(missing, []);
  });

  test("auditedTargets が無い古い形式のスナップショットでは判定しない", () => {
    const { missing } = detectMissingOtaSources({ properties: [terrace] });
    assert.deepStrictEqual(missing, []);
  });

  test("auditedTargets が空配列(全滅)なら期待ターゲット全件を未取得として返す", () => {
    const { missing } = detectMissingOtaSources({ properties: [terrace], auditedTargets: [] });
    assert.deepStrictEqual(missing.map((m) => m.ota), ["airbnb", "booking"]);
    assert.deepStrictEqual(missing.map((m) => m.otaLabel), ["Airbnb", "Booking.com"]);
  });
});

describe("selectSnapshotBacklogActions / filterBackfillFindings / dedupeNewFindings", () => {
  const TODAY = "2026-08-09";

  test("7日以内の欠損日は遡り対象、それより古いものは破棄", () => {
    const { retry, expired } = selectSnapshotBacklogActions({
      entries: [
        { date: "2026-08-02" }, // 7日前 → 対象
        { date: "2026-08-01" }, // 8日前 → 破棄
        { date: "2026-08-08" },
      ],
      todayStr: TODAY,
    });
    assert.deepStrictEqual(retry.map((r) => r.date), ["2026-08-02", "2026-08-08"]);
    assert.deepStrictEqual(expired.map((r) => r.date), ["2026-08-01"]);
  });

  test("当日分・未来日・重複は対象外(当日分は本編で扱う)", () => {
    const { retry, expired } = selectSnapshotBacklogActions({
      entries: [{ date: TODAY }, { date: "2026-08-20" }, { date: "2026-08-08" }, { date: "2026-08-08" }],
      todayStr: TODAY,
    });
    assert.deepStrictEqual(retry.map((r) => r.date), ["2026-08-08"]);
    assert.deepStrictEqual(expired, []);
  });

  test("遡り分はチェックインが今日より前のものだけ残す(当日突合と二重に出さない/後から入った予約の誤検知を避ける)", () => {
    const findings = [
      { type: "missing_in_v2", detail: { checkIn: "2026-08-03" } },      // 過去 → 残す
      { type: "missing_in_ota", detail: { checkIn: "2026-08-25" } },     // 未来 → 当日分が見るので落とす
      { type: "date_mismatch", detail: { otaCheckIn: "2026-08-05" } },   // 過去 → 残す
      { type: "parse_error", detail: { count: 2 } },                     // 日付なし → 落とす
    ];
    const out = filterBackfillFindings({ findings, todayStr: TODAY });
    assert.deepStrictEqual(out.map((f) => f.type), ["missing_in_v2", "date_mismatch"]);
  });

  test("dedupeNewFindings: 当日分と同じ指摘は遡り分から落とす", () => {
    const today = [{ type: "missing_in_v2", propertyId: PID, ota: "booking", detail: { code: "X1", checkIn: "2026-08-05", guestName: "山田" } }];
    const back = [
      { type: "missing_in_v2", propertyId: PID, ota: "booking", detail: { code: "X1", checkIn: "2026-08-05", guestName: "山田" } }, // 重複
      { type: "missing_in_v2", propertyId: PID, ota: "booking", detail: { code: "X2", checkIn: "2026-08-06", guestName: "鈴木" } }, // 新規
    ];
    const out = dedupeNewFindings(today, back);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].detail.code, "X2");
  });

  test("dedupeNewFindings: incoming 同士の重複も落とす", () => {
    const f = { type: "guest_count_mismatch", propertyId: PID, ota: "airbnb", detail: { bookingId: "bk1" } };
    assert.strictEqual(dedupeNewFindings([], [f, { ...f }]).length, 1);
  });
});

describe("selectGuestCountIssueActions (人数不一致の持ち越し)", () => {
  const TODAY = "2026-08-17";
  const mismatchFinding = {
    type: "guest_count_mismatch", propertyId: PID, propertyName: "テラス", ota: "booking",
    detail: {
      bookingId: "bk1", guestId: "g1", guestName: "木谷",
      checkIn: "2026-08-15", checkOut: "2026-08-16",
      otaGuests: 4, rosterGuests: 2, rosterInfants: 0,
    },
  };

  test("今朝も検出された分は upsert され、持ち越しには出ない", () => {
    const r = selectGuestCountIssueActions({
      issues: [{ id: "bk1", bookingId: "bk1", otaGuests: 4 }],
      todayFindings: [mismatchFinding], todayStr: TODAY,
    });
    assert.strictEqual(r.upserts.length, 1);
    assert.strictEqual(r.upserts[0].id, "bk1");
    assert.strictEqual(r.upserts[0].data.otaGuests, 4);
    assert.strictEqual(r.upserts[0].data.resolved, false);
    assert.deepStrictEqual(r.closes, []);
    assert.deepStrictEqual(r.carryOver, []);
  });

  test("★滞在が終わって OTA から消えても、未解消なら findings に残す(要精算・要申告訂正)", () => {
    const r = selectGuestCountIssueActions({
      issues: [{
        id: "bk1", bookingId: "bk1", guestId: "g1", guestName: "木谷", propertyId: PID, propertyName: "テラス",
        checkIn: "2026-08-15", checkOut: "2026-08-16", otaGuests: 4, rosterGuests: 2, resolved: false,
      }],
      todayFindings: [], guestCountChecked: [],
      bookingsById: new Map([["bk1", { checkIn: "2026-08-15", checkOut: "2026-08-16", status: "confirmed" }]]),
      registrationsByBookingId: new Map([["bk1", { id: "g1", guestCount: 2, status: "confirmed" }]]),
      todayStr: TODAY,
    });
    assert.deepStrictEqual(r.closes, []);
    assert.strictEqual(r.carryOver.length, 1);
    assert.strictEqual(r.carryOver[0].type, "guest_count_unresolved");
    assert.strictEqual(r.carryOver[0].detail.stayEnded, true);
    assert.match(r.carryOver[0].message, /申告訂正/);
  });

  test("名簿が直っていれば matched で閉じる(持ち越さない)", () => {
    const r = selectGuestCountIssueActions({
      issues: [{ id: "bk1", bookingId: "bk1", otaGuests: 4, checkOut: "2026-08-16" }],
      todayFindings: [],
      bookingsById: new Map([["bk1", { status: "confirmed", checkOut: "2026-08-16" }]]),
      registrationsByBookingId: new Map([["bk1", { id: "g1", guestCount: 4, status: "confirmed" }]]),
      todayStr: TODAY,
    });
    assert.deepStrictEqual(r.closes, [{ id: "bk1", reason: "matched" }]);
    assert.deepStrictEqual(r.carryOver, []);
  });

  test("今朝照合できたのに finding が出ていない = OTA側修正でも解消とみなす", () => {
    const r = selectGuestCountIssueActions({
      issues: [{ id: "bk1", bookingId: "bk1", otaGuests: 4 }],
      todayFindings: [], guestCountChecked: ["bk1"], todayStr: TODAY,
    });
    assert.deepStrictEqual(r.closes, [{ id: "bk1", reason: "matched" }]);
    assert.deepStrictEqual(r.carryOver, []);
  });

  test("キャンセル/予約消失は追わずに閉じる", () => {
    const r = selectGuestCountIssueActions({
      issues: [
        { id: "bk1", bookingId: "bk1", otaGuests: 4 },
        { id: "bk2", bookingId: "bk2", otaGuests: 3 },
      ],
      todayFindings: [],
      bookingsById: new Map([["bk1", { status: "cancelled" }]]), // bk2 は存在しない
      todayStr: TODAY,
    });
    assert.deepStrictEqual(
      r.closes.sort((a, b) => a.id.localeCompare(b.id)),
      [{ id: "bk1", reason: "cancelled" }, { id: "bk2", reason: "booking_missing" }]
    );
  });

  test("スナップショット欠損日(照合ゼロ)でも未解消分は消えない", () => {
    const r = selectGuestCountIssueActions({
      issues: [{ id: "bk1", bookingId: "bk1", otaGuests: 4, checkOut: "2026-08-31" }],
      todayFindings: [], guestCountChecked: [],
      bookingsById: new Map([["bk1", { status: "confirmed", checkIn: "2026-08-30", checkOut: "2026-08-31" }]]),
      registrationsByBookingId: new Map([["bk1", { guestCount: 2, status: "confirmed" }]]),
      todayStr: TODAY,
    });
    assert.strictEqual(r.carryOver.length, 1);
    assert.strictEqual(r.carryOver[0].detail.stayEnded, false); // 滞在はこれから
  });

  test("reconcileOtaSnapshot は人数を照合できた bookingId を返す(一致・不一致とも)", () => {
    const reservations = [
      { propertyId: PID, ota: "airbnb", code: "H1", checkIn: "2026-08-20", checkOut: "2026-08-21", guests: 4 },
      { propertyId: PID, ota: "airbnb", code: "H2", checkIn: "2026-08-22", checkOut: "2026-08-23", guests: 2 },
    ];
    const bookings = [
      { id: "bk1", propertyId: PID, source: "Airbnb", checkIn: "2026-08-20", checkOut: "2026-08-21", status: "confirmed", notes: "H1" },
      { id: "bk2", propertyId: PID, source: "Airbnb", checkIn: "2026-08-22", checkOut: "2026-08-23", status: "confirmed", notes: "H2" },
    ];
    const registrations = [
      { id: "g1", bookingId: "bk1", status: "confirmed", guestCount: 2 }, // 不一致
      { id: "g2", bookingId: "bk2", status: "confirmed", guestCount: 2 }, // 一致
    ];
    const r = reconcileOtaSnapshot({ reservations, bookings, registrations, todayStr: TODAY });
    assert.deepStrictEqual(r.guestCountChecked.sort(), ["bk1", "bk2"]);
    assert.strictEqual(r.findings.filter((f) => f.type === "guest_count_mismatch").length, 1);
  });

  test("evaluateGuestCount: 乳幼児は名簿側で二重控除しない", () => {
    assert.strictEqual(evaluateGuestCount({ ota: { guests: 4 }, reg: { guestCount: 4, guestCountInfants: 2 } }).mismatch, false);
    assert.strictEqual(evaluateGuestCount({ ota: { guests: 4 }, reg: { guestCount: 2 } }).mismatch, true);
  });
});
