import type { Page } from "@playwright/test";

const API_BASE = "https://minpaku-v2.web.app/api";

// polling ヘルパー: 条件が true になるまで最大 maxMs 待つ
export async function waitFor<T>(
  fn: () => Promise<T | undefined | null>,
  check: (v: T) => boolean,
  maxMs = 40_000,
  intervalMs = 2_000
): Promise<T> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v && check(v)) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor タイムアウト (${maxMs}ms)`);
}

// API リクエストヘルパー (ID トークン付き)
export async function apiGet(
  path: string,
  idToken?: string
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (idToken) headers["Authorization"] = `Bearer ${idToken}`;
  return fetch(`${API_BASE}${path}`, { headers });
}

export async function apiPost(
  path: string,
  body: unknown,
  idToken?: string
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (idToken) headers["Authorization"] = `Bearer ${idToken}`;
  return fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// ページ上の特定セレクタが表示されるまで待つ (タイムアウト付き)
export async function waitForSelector(
  page: Page,
  selector: string,
  timeoutMs = 15_000
): Promise<void> {
  await page.waitForSelector(selector, { state: "visible", timeout: timeoutMs });
}

export { API_BASE };
