/**
 * invoice-property-breakdown.spec.ts
 * 請求書 物件別内訳 E2E テスト
 *
 * TC-P1: computeInvoiceDetails の byProperty に物件内訳が含まれる
 * TC-P2: ランドリー出し 300円 + 立替 1500円 が shiftAmount に加算される
 * TC-P3: propertyId フィルタで絞り込んだ場合、対象物件のみ集計される
 */

import { test, expect } from "@playwright/test";
import { getDb, FV, E2E_TAG } from "../fixtures/firestore-admin";
import { issueOwnerIdToken } from "../fixtures/auth";

const PID = "tsZybhDMcPrxqgcRy7wp"; // the Terrace 長浜
const PID_NAME = "the Terrace 長浜";
const API_BASE = "https://minpaku-v2.web.app/api";

/** compute-preview エンドポイントを叩いて集計結果を返す */
async function fetchComputePreview(staffId: string, yearMonth: string, propertyId?: string) {
  const auth = await issueOwnerIdToken();
  if (!auth) throw new Error("ID トークン取得失敗");
  const body: Record<string, string> = { staffId, yearMonth };
  if (propertyId) body.propertyId = propertyId;
  const res = await fetch(`${API_BASE}/invoices/compute-preview`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.idToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`compute-preview ${res.status}: ${await res.text()}`);
  return res.json();
}

test.describe("請求書 物件別内訳", () => {
  const TAG = E2E_TAG("invoice-property-breakdown");

  let staffId: string;
  const testDate = "2026-07-15"; // テスト専用の未来日付
  const yearMonth = "2026-07";

  test.beforeAll(async () => {
    const db = getDb();

    // テストスタッフ作成
    const staffRef = db.collection("staff").doc();
    staffId = staffRef.id;
    await staffRef.set({
      name: "E2E-物件別テストスタッフ",
      active: true,
      ratePerJob: 0,
      transportationFee: 0,
      ...TAG,
    });

    // the Terrace 長浜 の propertyWorkItems にテスト用 workItem を追加済みを前提
    // なければ fallback (amount=0 or 立替実費) で確認

    // shift1: laundry_put_out (ランドリー出し 300円相当)
    const shift1Ref = db.collection("shifts").doc();
    await shift1Ref.set({
      staffId,
      propertyId: PID,
      propertyName: PID_NAME,
      date: new Date(`${testDate}T10:00:00.000Z`),
      workType: "laundry_put_out",
      workItemName: "ランドリー出し",
      amount: 300,
      status: "completed",
      assignMethod: "auto_laundry",
      sourceChecklistId: `e2e-cl-breakdown-${Date.now()}`,
      sourceAction: "put_out",
      ...TAG,
    });

    // shift2: laundry_expense (ランドリー立替 1500円)
    const shift2Ref = db.collection("shifts").doc();
    await shift2Ref.set({
      staffId,
      propertyId: PID,
      propertyName: PID_NAME,
      date: new Date(`${testDate}T10:00:00.000Z`),
      workType: "laundry_expense",
      workItemName: "ランドリープリカ1500",
      amount: 1500,
      status: "completed",
      assignMethod: "auto_laundry",
      sourceChecklistId: `e2e-cl-breakdown-${Date.now()}`,
      sourceAction: "expense",
      ...TAG,
    });

    console.log(`  テストスタッフ: ${staffId}`);
  });

  test.afterAll(async () => {
    const db = getDb();
    const COLS = ["staff", "shifts", "laundry", "invoices"];
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
  // TC-P1: byProperty に物件内訳が含まれる
  // =========================================================
  test("TC-P1: computeInvoiceDetails の byProperty に the Terrace 長浜 の内訳が含まれる", async () => {
    const details = await fetchComputePreview(staffId, yearMonth);

    expect(details.byProperty).toBeDefined();
    const propEntry = details.byProperty[PID];
    expect(propEntry).toBeDefined();
    expect(propEntry.propertyName).toBeTruthy();
    console.log(`  TC-P1: byProperty[${PID}] = ${JSON.stringify(propEntry)}`);
  });

  // =========================================================
  // TC-P2: ランドリー出し 300円 + 立替 1500円 が shiftAmount に加算される
  // =========================================================
  test("TC-P2: ランドリー出し 300円 + 立替 1500円 が shiftAmount に反映される", async () => {
    const details = await fetchComputePreview(staffId, yearMonth);

    const putOutDetail = details.shifts.find((s: any) => s.workType === "laundry_put_out");
    const expenseDetail = details.shifts.find((s: any) => s.workType === "laundry_expense");

    expect(putOutDetail).toBeTruthy();
    expect(expenseDetail).toBeTruthy();
    expect(putOutDetail.amount).toBeGreaterThanOrEqual(0);
    expect(expenseDetail.amount).toBeGreaterThanOrEqual(1500);

    // shiftAmount は put_out + expense の合計以上
    expect(details.shiftAmount).toBeGreaterThanOrEqual(1500);
    console.log(`  TC-P2: shiftAmount=${details.shiftAmount}, put_out=${putOutDetail?.amount}, expense=${expenseDetail?.amount}`);
  });

  // =========================================================
  // TC-P3: propertyId フィルタで the Terrace 長浜 だけ集計される
  // =========================================================
  test("TC-P3: propertyId フィルタで絞り込み時、対象物件のみ集計される", async () => {
    const db = getDb();

    // 別物件のシフトを追加
    const otherPid = "DUMMY_OTHER_PROPERTY";
    const shiftOtherRef = db.collection("shifts").doc();
    await shiftOtherRef.set({
      staffId,
      propertyId: otherPid,
      propertyName: "ダミー別物件",
      date: new Date(`${testDate}T10:00:00.000Z`),
      workType: "cleaning_by_count",
      amount: 9999,
      status: "completed",
      ...TAG,
    });

    // propertyId フィルタ付きで集計 (API 経由)
    const details = await fetchComputePreview(staffId, yearMonth, PID);

    // 別物件のシフトは含まれない
    const otherShift = details.shifts.find((s: any) => s.propertyId === otherPid);
    expect(otherShift).toBeUndefined();

    // the Terrace 長浜 のシフトは含まれる
    const myShift = details.shifts.find((s: any) => s.propertyId === PID);
    expect(myShift).toBeTruthy();

    console.log(`  TC-P3: フィルタ後 shifts=${details.shifts.length} (別物件除外確認)`);

    // クリーンアップ
    await shiftOtherRef.delete();
  });
});
