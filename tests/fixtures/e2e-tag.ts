// E2E テスト識別タグ定義
// このタグが付いたドキュメントは cleanupE2E() で一括削除される

export const E2E_TEST_MARKER = { _e2eTest: true } as const;

export function makeTag(testName: string): Record<string, unknown> {
  return {
    _e2eTest: true,
    _createdBy: `playwright-${testName}`,
    _createdAt: new Date().toISOString(),
  };
}
