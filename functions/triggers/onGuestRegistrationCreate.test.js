/**
 * inferPropertyId 単体テスト (node --test)
 */
const { test, describe } = require("node:test");
const assert = require("node:assert");
const { inferPropertyId } = require("./onGuestRegistrationCreate");

describe("inferPropertyId", () => {
  const PID_A = "prop_A";
  const PID_B = "prop_B";

  test("レベル A: CI/CO 完全一致 単一ヒット", () => {
    const guest = { checkIn: "2026-04-20", checkOut: "2026-04-22" };
    const bookings = [
      { id: "b1", checkIn: "2026-04-20", checkOut: "2026-04-22", propertyId: PID_A, source: "Airbnb" },
      { id: "b2", checkIn: "2026-05-01", checkOut: "2026-05-03", propertyId: PID_B, source: "Airbnb" },
    ];
    const r = inferPropertyId(guest, bookings);
    assert.strictEqual(r.propertyId, PID_A);
    assert.strictEqual(r.level, "A");
  });

  test("レベル B: CI のみ一致 単一ヒット", () => {
    const guest = { checkIn: "2026-04-20", checkOut: "2026-04-23" };
    const bookings = [
      { id: "b1", checkIn: "2026-04-20", checkOut: "2026-04-22", propertyId: PID_A, source: "Airbnb" },
    ];
    const r = inferPropertyId(guest, bookings);
    assert.strictEqual(r.propertyId, PID_A);
    assert.strictEqual(r.level, "B");
  });

  test("レベル C: 日程オーバーラップ 単一ヒット", () => {
    const guest = { checkIn: "2026-04-21", checkOut: "2026-04-23" };
    const bookings = [
      { id: "b1", checkIn: "2026-04-20", checkOut: "2026-04-22", propertyId: PID_A, source: "Airbnb" },
      { id: "b2", checkIn: "2026-05-01", checkOut: "2026-05-03", propertyId: PID_B, source: "Airbnb" },
    ];
    const r = inferPropertyId(guest, bookings);
    assert.strictEqual(r.propertyId, PID_A);
    assert.ok(r.level.startsWith("C"));
  });

  test("ヒットなし → null", () => {
    const guest = { checkIn: "2030-01-01", checkOut: "2030-01-03" };
    const bookings = [
      { id: "b1", checkIn: "2026-04-20", checkOut: "2026-04-22", propertyId: PID_A, source: "Airbnb" },
    ];
    const r = inferPropertyId(guest, bookings);
    assert.strictEqual(r, null);
  });

  test("複数ヒット (異 property) で source ヒントにより絞り込み成功", () => {
    const guest = { checkIn: "2026-04-20", checkOut: "2026-04-22", bookingSite: "Airbnb" };
    const bookings = [
      { id: "b1", checkIn: "2026-04-20", checkOut: "2026-04-22", propertyId: PID_A, source: "Airbnb" },
      { id: "b2", checkIn: "2026-04-20", checkOut: "2026-04-22", propertyId: PID_B, source: "Booking.com" },
    ];
    const r = inferPropertyId(guest, bookings);
    assert.strictEqual(r.propertyId, PID_A);
    assert.ok(r.level.includes("source"));
  });

  test("複数ヒット (異 property) で source ヒントでも絞れない → null", () => {
    const guest = { checkIn: "2026-04-20", checkOut: "2026-04-22" };
    const bookings = [
      { id: "b1", checkIn: "2026-04-20", checkOut: "2026-04-22", propertyId: PID_A, source: "Airbnb" },
      { id: "b2", checkIn: "2026-04-20", checkOut: "2026-04-22", propertyId: PID_B, source: "Booking.com" },
    ];
    const r = inferPropertyId(guest, bookings);
    assert.strictEqual(r, null);
  });

  test("複数ヒットでも全て同一 propertyId なら確定 (uniqProperty)", () => {
    const guest = { checkIn: "2026-04-20", checkOut: "2026-04-22" };
    const bookings = [
      { id: "b1", checkIn: "2026-04-20", checkOut: "2026-04-22", propertyId: PID_A, source: "Airbnb" },
      { id: "b2", checkIn: "2026-04-20", checkOut: "2026-04-22", propertyId: PID_A, source: "Booking.com" },
    ];
    const r = inferPropertyId(guest, bookings);
    assert.strictEqual(r.propertyId, PID_A);
  });

  test("checkIn 未設定 → null", () => {
    const guest = { checkOut: "2026-04-22" };
    const bookings = [
      { id: "b1", checkIn: "2026-04-20", checkOut: "2026-04-22", propertyId: PID_A },
    ];
    const r = inferPropertyId(guest, bookings);
    assert.strictEqual(r, null);
  });
});
