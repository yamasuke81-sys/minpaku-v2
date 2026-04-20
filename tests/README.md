# minpaku-v2 E2E テスト (Playwright)

層③ Playwright CLI による黄金パス E2E テスト基盤。

## ディレクトリ構成

```
tests/
├── package.json
├── playwright.config.ts      # タイムアウト・プロジェクト設定
├── tsconfig.json
├── fixtures/
│   ├── auth.ts               # オーナー/スタッフトークン発行ヘルパ
│   ├── firestore-admin.ts    # admin SDK 初期化 + cleanupE2E()
│   └── e2e-tag.ts            # _e2eTest: true タグ定義
├── e2e/
│   ├── owner-flow.spec.ts    # オーナーペルソナ (TC-O1〜O3)
│   ├── staff-flow.spec.ts    # スタッフペルソナ (TC-S1〜S3)
│   └── guest-flow.spec.ts    # 宿泊者ペルソナ (TC-G1〜G4)
└── utils/
    └── helpers.ts            # polling / API ヘルパ
```

## セットアップ

### 前提条件

- Node.js 22+
- Google Cloud ADC 認証済み (`gcloud auth application-default login`)
- Firebase プロジェクト `minpaku-v2` への Firestore 読み書き権限

### ローカル初回セットアップ

```bash
cd tests
npm install
npx playwright install chromium
```

### ADC 認証

```bash
gcloud auth application-default login
# または サービスアカウントキーファイルを使う場合:
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json
```

## ローカル実行

```bash
cd tests

# 全テスト実行
npm test

# ペルソナ別
npm run test:owner
npm run test:staff
npm run test:guest

# モバイルプロジェクトのみ
npm run test:mobile

# Playwright UI モード (デバッグ向け)
npm run test:ui

# レポート表示
npm run report
```

## テストシナリオ概要

### オーナー (owner-flow.spec.ts)

| TC | 概要 |
|---|---|
| TC-O1 | 名簿手動登録で booking が作成され shift/checklist が自動生成される |
| TC-O2 | 予約フロー構成画面がオーナー認証で表示される |
| TC-O3 | compute-preview API が shiftCount / laundryAmount / total を正しく返す |

### スタッフ (staff-flow.spec.ts)

| TC | 概要 |
|---|---|
| TC-S1 | firstCome モードで◎回答すると shift.staffId が自動更新される |
| TC-S2 | checklist status=completed が shift.status=completed に同期される |
| TC-S3/3b | 清掃フロー画面がモバイル/デスクトップで正常表示される |

### 宿泊者 (guest-flow.spec.ts)

| TC | 概要 |
|---|---|
| TC-G1 | showNoiseAgreement=true のとき黄色カードが表示される |
| TC-G2 | guestRegistration 投入で onGuestFormSubmit が editToken を付与する |
| TC-G3 | 有効トークンで 200、期限切れトークンで 410 Gone が返る |
| TC-G4 | overrides passportNumber=hidden がフォーム DOM に反映される |

## シナリオ追加方法

1. `e2e/` 配下に `xxx-flow.spec.ts` を作成
2. テストデータには必ず `E2E_TAG("テスト名")` を付けること
3. `afterEach` / `finally` で `cleanupE2E()` または個別 `ref.delete()` を呼ぶこと

### 新テスト雛形

```typescript
import { test, expect } from "@playwright/test";
import { getDb, E2E_TAG } from "../fixtures/firestore-admin";

test("TC-XX: テスト説明", async () => {
  const db = getDb();
  const TAG = E2E_TAG("test-xx");

  // 1. seed データ投入
  const ref = db.collection("xxx").doc();
  await ref.set({ ...yourData, ...TAG });

  try {
    // 2. 検証
    expect(true).toBe(true);
  } finally {
    // 3. 必ずクリーンアップ
    await ref.delete();
  }
});
```

## 既存 migration スクリプトとの関係

`functions/migration/kawakami-*.js` および `e2e-s*.js` は **admin SDK ベースの手動実行スクリプト**。
本 Playwright テストはそれらのロジックを **Playwright テストフレームワークに移植**し、CI で繰り返し実行できるようにしたもの。

- 既存スクリプトは `node` で直接実行する使い方 (一回限りの手動検証)
- Playwright テストは `npm test` で自動・繰り返し実行可能
- 両者は独立しており、どちらかを削除する必要はない

## CI (GitHub Actions)

`.github/workflows/e2e.yml` が PR 時に自動実行される。

### 必要な GitHub Secrets

| Secret 名 | 内容 |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Firestore 書き込み権限を持つサービスアカウント JSON |

**設定手順:**
1. Firebase コンソール → プロジェクト設定 → サービスアカウント → 新しい秘密鍵を生成
2. GitHub リポジトリ → Settings → Secrets and variables → Actions → New repository secret
3. Name: `FIREBASE_SERVICE_ACCOUNT`, Value: JSON ファイルの中身を貼り付け

## 注意事項

- テストは本番 Firestore (`minpaku-v2`) に対して実行される
- `_e2eTest: true` タグを付けたドキュメントのみ操作するため、本番データへの影響は最小限
- `functions/` や `public/` の既存コードは本テストでは変更しない
- LINE / メールの実送信はテスト中に発生しないよう通知設定を一時無効化している
