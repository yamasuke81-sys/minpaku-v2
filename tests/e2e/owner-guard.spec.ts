/**
 * owner-guard.spec.ts
 * オーナー uid がスタッフ/サブオーナーに降格されないことを検証
 *
 * TC-OG1: POST /auth/set-role でオーナー uid に role=staff を設定しようとすると 400
 * TC-OG2: TC-OG1 後もオーナーのカスタムクレームが変わっていないことを確認
 * TC-OG3: POST /auth/set-sub-owner でオーナー staffDoc を対象にすると 400
 */

import { test, expect } from "@playwright/test";
import { getDb } from "../fixtures/firestore-admin";
import * as admin from "firebase-admin";

// オーナーの固定値（CLAUDE.md 記載）
const OWNER_UID = "rwHczfRz8DfnWCrQ7yeAYnsd8in2";
const OWNER_STAFF_ID = "ziTig6tefnj5NvkgN4fG";
const API_BASE = "https://minpaku-v2.web.app/api";

// オーナーの ID トークン取得（テスト用: 本番オーナーアカウントの Service Account 経由カスタムトークン）
async function getOwnerIdToken(): Promise<string> {
  // admin SDK でカスタムトークンを発行 → ID トークン交換
  const customToken = await admin.auth().createCustomToken(OWNER_UID, { role: "owner" });

  // Firebase Auth REST API でカスタムトークン → ID トークン変換
  const res = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=AIzaSyBDyAqH7Y--87Vt3IuJx-rlF4Ni9nZCvnc",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    }
  );
  if (!res.ok) {
    throw new Error(`ID トークン取得失敗: ${res.status} ${await res.text()}`);
  }
  const json = await res.json() as { idToken: string };
  return json.idToken;
}

// =========================================================
// TC-OG1: set-role でオーナー uid を staff に降格しようとすると 400
// =========================================================
test("TC-OG1: オーナー uid に role=staff を設定すると 400 が返る", async () => {
  const db = getDb();

  const idToken = await getOwnerIdToken();

  const res = await fetch(`${API_BASE}/auth/set-role`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      uid: OWNER_UID,
      role: "staff",
      staffId: OWNER_STAFF_ID,
    }),
  });

  console.log(`TC-OG1: status=${res.status}`);
  expect(res.status).toBe(400);

  const body = await res.json() as { error: string };
  console.log(`TC-OG1: error="${body.error}"`);
  expect(body.error).toMatch(/オーナー/);
});

// =========================================================
// TC-OG2: TC-OG1 後もオーナーのカスタムクレームが変わっていないこと
// =========================================================
test("TC-OG2: オーナーのカスタムクレームが owner のまま維持されている", async () => {
  const db = getDb();

  const userRecord = await admin.auth().getUser(OWNER_UID);
  const claims = userRecord.customClaims as Record<string, unknown> | undefined;

  console.log(`TC-OG2: customClaims=${JSON.stringify(claims)}`);
  // role が owner (またはクレーム未設定=オーナー互換) であること
  const role = claims?.role;
  expect(role === "owner" || role === undefined).toBe(true);

  // staff / sub_owner になっていないこと
  expect(role).not.toBe("staff");
  expect(role).not.toBe("sub_owner");
});

// =========================================================
// TC-OG3: set-sub-owner でオーナー staffDoc を対象にすると 400
// =========================================================
test("TC-OG3: オーナー staffId を set-sub-owner のターゲットにすると 400 が返る", async () => {
  const db = getDb();

  const idToken = await getOwnerIdToken();

  const res = await fetch(`${API_BASE}/auth/set-sub-owner`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      staffId: OWNER_STAFF_ID,
      isSubOwner: true,
      ownedPropertyIds: [],
    }),
  });

  console.log(`TC-OG3: status=${res.status}`);
  expect(res.status).toBe(400);

  const body = await res.json() as { error: string };
  console.log(`TC-OG3: error="${body.error}"`);
  expect(body.error).toMatch(/オーナー/);
});
