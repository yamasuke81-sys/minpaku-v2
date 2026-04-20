import * as admin from "firebase-admin";
import { getDb } from "./firestore-admin";

const API_KEY = "AIzaSyDU4ZkCNDzvGpT9BaBlum8bCK5P20Cu-Fs";
const OWNER_UID = "rwHczfRz8DfnWCrQ7yeAYnsd8in2";
const OWNER_STAFF_ID = "ziTig6tefnj5NvkgN4fG";

// admin 初期化が済んでいることを保証
function ensureAdminInit() {
  getDb(); // getDb() が initializeApp を担う
}

// カスタムトークン → ID トークン交換
async function exchangeCustomToken(customToken: string): Promise<{ idToken: string; uid: string }> {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    }
  );
  if (!res.ok) {
    throw new Error(`ID トークン交換失敗: ${await res.text()}`);
  }
  const { idToken, localId } = (await res.json()) as { idToken: string; localId: string };
  return { idToken, uid: localId };
}

// createCustomToken は SA の iam.serviceAccounts.signBlob 権限が必要。
// ADC (gcloud auth application-default login) では使えないため、
// 失敗した場合は null を返す。CI では SA キーを使うこと。
export async function issueOwnerIdToken(): Promise<{ idToken: string; uid: string } | null> {
  ensureAdminInit();
  try {
    const customToken = await admin
      .auth()
      .createCustomToken(OWNER_UID, { role: "owner", staffId: OWNER_STAFF_ID });
    return exchangeCustomToken(customToken);
  } catch (e) {
    console.warn(
      "  ⚠ createCustomToken 失敗 (SA 権限不足 or ADC 未設定)。UI 認証テストをスキップします。",
      (e as Error).message
    );
    return null;
  }
}

export async function issueStaffIdToken(staffUid: string): Promise<{ idToken: string; uid: string } | null> {
  ensureAdminInit();
  try {
    const customToken = await admin
      .auth()
      .createCustomToken(staffUid, { role: "staff" });
    return exchangeCustomToken(customToken);
  } catch (e) {
    console.warn("  ⚠ createCustomToken 失敗:", (e as Error).message);
    return null;
  }
}

// Firebase Web SDK の localStorage に認証情報を注入 (UI ログイン不要)
export async function applyAuthStateToPage(
  page: import("@playwright/test").Page,
  idToken: string,
  uid: string
): Promise<void> {
  await page.addInitScript(
    ([token, userId, key]) => {
      const authUser = {
        uid: userId,
        apiKey: key,
        stsTokenManager: {
          accessToken: token,
          expirationTime: Date.now() + 3600 * 1000,
          refreshToken: "",
        },
      };
      localStorage.setItem(
        `firebase:authUser:${key}:[DEFAULT]`,
        JSON.stringify(authUser)
      );
    },
    [idToken, uid, API_KEY] as [string, string, string]
  );
}
