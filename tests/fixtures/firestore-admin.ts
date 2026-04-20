import * as admin from "firebase-admin";

// admin SDK グローバル初期化
let inited = false;

export function getDb(): admin.firestore.Firestore {
  if (!inited) {
    admin.initializeApp({
      projectId: "minpaku-v2",
      credential: admin.credential.applicationDefault(),
    });
    inited = true;
  }
  return admin.firestore();
}

export const FV = admin.firestore.FieldValue;

// E2E タグ
export const E2E_TAG = (createdBy: string) => ({
  _e2eTest: true,
  _createdBy: `playwright-${createdBy}`,
});

// クリーンアップ (テスト後に呼ぶ)
export async function cleanupE2E(): Promise<number> {
  const db = getDb();
  const COLS = [
    "staff",
    "recruitments",
    "shifts",
    "bookings",
    "guestRegistrations",
    "laundry",
    "invoices",
    "checklists",
    "bookingConflicts",
  ];
  let total = 0;
  for (const c of COLS) {
    const snap = await db.collection(c).where("_e2eTest", "==", true).get();
    for (const d of snap.docs) {
      await d.ref.delete();
      total++;
    }
  }
  return total;
}
