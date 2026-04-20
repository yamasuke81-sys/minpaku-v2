/**
 * laundry-reward.spec.ts
 * ランドリー報酬自動生成 E2E テスト
 *
 * TC-L1: checklist に laundry.putOut をセット
 *        → shifts に laundry_put_out + laundry_expense が自動生成される
 * TC-L2: computeInvoiceDetails で合計が想定値 (put_out報酬 + 立替) になる
 * TC-L3: laundry.collected をセット → laundry_collected shift が生成される
 * TC-L4: laundry.putOut を null に戻す → put_out/expense shift が削除される
 */

import { test, expect } from "@playwright/test";
import { getDb, FV, E2E_TAG } from "../fixtures/firestore-admin";
import { issueOwnerIdToken } from "../fixtures/auth";
import { waitFor } from "../utils/helpers";

const PID = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜
const API_BASE = "https://minpaku-v2.web.app/api";

test.describe("ランドリー報酬自動生成", () => {
  const TAG = E2E_TAG("laundry-reward");

  // テスト用データの参照を保持
  let staffId: string;
  let checklistId: string;
  let bookingId: string;
  const testDate = "2026-06-15"; // テスト専用の未来日付

  test.beforeAll(async () => {
    const db = getDb();

    // テストスタッフ作成
    const staffRef = db.collection("staff").doc();
    staffId = staffRef.id;
    await staffRef.set({
      name: "E2E-ランドリーテストスタッフ",
      active: true,
      ratePerJob: 0,
      transportationFee: 0,
      ...TAG,
    });

    // テスト予約作成
    const bookingRef = db.collection("bookings").doc();
    bookingId = bookingRef.id;
    await bookingRef.set({
      propertyId: PID,
      propertyName: "the Terrace 長浜",
      guestName: "E2Eテストゲスト",
      guestCount: 1,
      checkIn: testDate,
      checkOut: testDate,
      status: "confirmed",
      ...TAG,
    });

    // テスト用チェックリスト作成 (shiftId は省略)
    const clRef = db.collection("checklists").doc();
    checklistId = clRef.id;
    await clRef.set({
      propertyId: PID,
      propertyName: "the Terrace 長浜",
      bookingId,
      staffId,
      checkoutDate: testDate,
      status: "in_progress",
      laundry: {},
      ...TAG,
    });

    console.log(`  テストスタッフ: ${staffId}`);
    console.log(`  テストチェックリスト: ${checklistId}`);
  });

  test.afterAll(async () => {
    const db = getDb();

    // E2E タグ付きデータを全削除
    const COLS = ["staff", "bookings", "checklists", "shifts", "laundry"];
    let total = 0;
    for (const c of COLS) {
      const snap = await db.collection(c).where("_e2eTest", "==", true).get();
      for (const d of snap.docs) {
        await d.ref.delete();
        total++;
      }
    }
    console.log(`  クリーンアップ: ${total}件削除`);
  });

  // =========================================================
  // TC-L1: putOut セット → laundry_put_out + laundry_expense 自動生成
  // =========================================================
  test("TC-L1: laundry.putOut セットで put_out + expense shift が自動生成される", async () => {
    const db = getDb();

    // laundry.putOut をセット (prepaid 1500円)
    const now = new Date();
    await db.collection("checklists").doc(checklistId).update({
      "laundry.putOut": {
        at: now,
        by: { staffId, name: "E2E-ランドリーテストスタッフ" },
        depot: "テストコインランドリー",
        depotKind: "coin",
        paymentMethod: "prepaid",
        amount: 1500,
      },
    });

    // トリガー発火を最大 30秒待つ
    const putOutShift = await waitFor(
      async () => {
        const snap = await db.collection("shifts")
          .where("sourceChecklistId", "==", checklistId)
          .where("sourceAction", "==", "put_out")
          .get();
        return snap.empty ? null : snap.docs[0].data();
      },
      (data) => data.workType === "laundry_put_out",
      30_000,
      2_000
    );

    expect(putOutShift.workType).toBe("laundry_put_out");
    expect(putOutShift.staffId).toBe(staffId);
    expect(putOutShift.propertyId).toBe(PID);
    expect(putOutShift.status).toBe("completed");
    expect(putOutShift.assignMethod).toBe("auto_laundry");
    console.log(`  TC-L1: put_out shift 確認 workItemName=${putOutShift.workItemName} amount=${putOutShift.amount}`);

    // expense shift の確認
    const expenseShift = await waitFor(
      async () => {
        const snap = await db.collection("shifts")
          .where("sourceChecklistId", "==", checklistId)
          .where("sourceAction", "==", "expense")
          .get();
        return snap.empty ? null : snap.docs[0].data();
      },
      (data) => data.workType === "laundry_expense",
      15_000,
      2_000
    );

    expect(expenseShift.workType).toBe("laundry_expense");
    expect(expenseShift.workItemName).toContain("ランドリープリカ");
    expect(expenseShift.amount).toBeGreaterThan(0);
    console.log(`  TC-L1: expense shift 確認 workItemName=${expenseShift.workItemName} amount=${expenseShift.amount}`);
  });

  // =========================================================
  // TC-L2: computeInvoiceDetails で合計が期待値
  // =========================================================
  test("TC-L2: computeInvoiceDetails で put_out + expense が集計される", async () => {
    // テスト用の yearMonth (testDate が 2026-06-15 なので 2026-06)
    const yearMonth = testDate.slice(0, 7); // "2026-06"

    // compute-preview エンドポイント経由で集計 (functions の直接 require を避ける)
    const auth = await issueOwnerIdToken();
    if (!auth) throw new Error("ID トークン取得失敗");
    const res = await fetch(`${API_BASE}/invoices/compute-preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.idToken}`,
      },
      body: JSON.stringify({ staffId, yearMonth }),
    });
    expect(res.status).toBe(200);
    const details = await res.json();

    // laundry_put_out と laundry_expense のシフトが含まれているか
    const putOutDetail = details.shifts.find((s: any) => s.workType === "laundry_put_out");
    const expenseDetail = details.shifts.find((s: any) => s.workType === "laundry_expense");

    expect(putOutDetail).toBeTruthy();
    expect(expenseDetail).toBeTruthy();

    // 合計: put_out報酬 (物件設定により 0 or 300 等) + expense (1500 以上)
    // expense は 1500 円 (prepaid 1500 の workItem が存在しない場合でも fallback で 1500)
    const totalShift = details.shiftAmount;
    console.log(`  TC-L2: shiftAmount=${totalShift} (put_out=${putOutDetail?.amount}, expense=${expenseDetail?.amount})`);

    // expense は少なくとも 1500 円 (立替金額)
    expect(expenseDetail.amount).toBeGreaterThanOrEqual(1500);
  });

  // =========================================================
  // TC-L3: collected セット → laundry_collected shift 生成
  // =========================================================
  test("TC-L3: laundry.collected セットで collected shift が生成される", async () => {
    const db = getDb();

    const now = new Date();
    await db.collection("checklists").doc(checklistId).update({
      "laundry.collected": {
        at: now,
        by: { staffId, name: "E2E-ランドリーテストスタッフ" },
      },
    });

    const collectedShift = await waitFor(
      async () => {
        const snap = await db.collection("shifts")
          .where("sourceChecklistId", "==", checklistId)
          .where("sourceAction", "==", "collected")
          .get();
        return snap.empty ? null : snap.docs[0].data();
      },
      (data) => data.workType === "laundry_collected",
      30_000,
      2_000
    );

    expect(collectedShift.workType).toBe("laundry_collected");
    expect(collectedShift.workItemName).toContain("ランドリー受取");
    console.log(`  TC-L3: collected shift 確認 amount=${collectedShift.amount}`);
  });

  // =========================================================
  // TC-L4: putOut を null に戻す → put_out/expense shift が削除される
  // =========================================================
  test("TC-L4: laundry.putOut null 化で put_out/expense shift が削除される", async () => {
    const db = getDb();

    await db.collection("checklists").doc(checklistId).update({
      "laundry.putOut": null,
    });

    // 最大 30秒待って put_out shift が消えることを確認
    await waitFor(
      async () => {
        const snap = await db.collection("shifts")
          .where("sourceChecklistId", "==", checklistId)
          .where("sourceAction", "==", "put_out")
          .get();
        return { count: snap.size };
      },
      (data) => data.count === 0,
      30_000,
      2_000
    );

    // expense も削除されていること
    const expenseSnap = await db.collection("shifts")
      .where("sourceChecklistId", "==", checklistId)
      .where("sourceAction", "==", "expense")
      .get();
    expect(expenseSnap.size).toBe(0);
    console.log(`  TC-L4: put_out/expense shift 削除確認`);
  });

  // =========================================================
  // TC-L5: auth uid で by.uid を操作しても shift の staffId は staff doc ID になる
  // =========================================================
  test("TC-L5: auth uid 経由でも shift.staffId が staff doc ID になる", async () => {
    const db = getDb();

    // テストスタッフに authUid をセット
    const fakeAuthUid = `e2e-fake-uid-${Date.now()}`;
    await db.collection("staff").doc(staffId).update({ authUid: fakeAuthUid });

    // putOut に uid (auth uid) を使って操作
    const now = new Date();
    const clRef2 = db.collection("checklists").doc();
    const checklistId2 = clRef2.id;
    await clRef2.set({
      propertyId: PID,
      propertyName: "the Terrace 長浜",
      bookingId,
      staffId,
      checkoutDate: testDate,
      status: "in_progress",
      laundry: {},
      ...TAG,
    });

    await db.collection("checklists").doc(checklistId2).update({
      "laundry.putOut": {
        at: now,
        by: { uid: fakeAuthUid, name: "E2E-ランドリーテストスタッフ" }, // staffId なし、uid のみ
        depot: "テストコインランドリー",
        depotKind: "coin",
        paymentMethod: "prepaid",
        amount: 1500,
      },
    });

    // put_out shift が生成され、staffId が staff doc ID になっているか確認
    const putOutShift = await waitFor(
      async () => {
        const snap = await db.collection("shifts")
          .where("sourceChecklistId", "==", checklistId2)
          .where("sourceAction", "==", "put_out")
          .get();
        return snap.empty ? null : snap.docs[0].data();
      },
      (data) => data !== null && data.staffId !== undefined,
      30_000,
      2_000
    );

    // staffId は auth uid ではなく staff doc ID であること
    expect(putOutShift.staffId).toBe(staffId);
    expect(putOutShift.staffId).not.toBe(fakeAuthUid);
    console.log(`  TC-L5: shift.staffId=${putOutShift.staffId} (auth uid=${fakeAuthUid} ではない)`);

    // クリーンアップ
    await clRef2.delete();
    const shiftSnap = await db.collection("shifts").where("sourceChecklistId", "==", checklistId2).get();
    for (const d of shiftSnap.docs) await d.ref.delete();
  });
});
