# セッション記憶（2026-04-02 更新）

## 前回セッションの成果
- Firebase プロジェクト構築完了（minpaku-v2, Blaze, asia-northeast1）
- 自動デプロイ完了（GitHub Actions → Firebase Hosting）
- スタッフ管理画面動作確認（14名表示）
- 全データ移行完了（民泊メイン24シート + PDFリネーム8シート → Firestore）
- 募集管理・宿泊者名簿・ダッシュボード・定期報告を実装

## 今回セッション（2026-04-02）の成果
- **UIテーマ全面刷新（v0402a）**
  - トップバーナビ → サイドバーナビに変更（カテゴリ分け: メイン/予約・清掃/スタッフ・経理/物件・名簿/通知・レポート/システム）
  - プロフェッショナルなカラーテーマ（CSS変数化、ダークサイドバー + ライトコンテンツ）
  - レスポンシブ対応（モバイルでハンバーガーメニュー + オーバーレイ）
  - ログイン画面をモーダルから全画面デザインに変更
  - カード、テーブル、フォーム、モーダルのデザイン統一
- **シフト管理ページ新規実装（shifts.js）**
  - 月間シフト一覧テーブル（日付・物件・スタッフ・時間・ステータス）
  - シフト作成/編集モーダル（物件・スタッフ選択、時間設定）
  - ステータス管理（未割当→割当済→確定→完了）
  - 月切替・統計カード
- **請求書管理ページ新規実装（invoices.js）**
  - 月次請求書一覧（スタッフ別カード表示）
  - 自動生成機能（シフト実績+ランドリー費+交通費から自動計算）
  - 詳細モーダル（支払内訳・清掃明細・ランドリー明細・振込先情報）
  - 確定フロー
- **通知設定ページ新規実装（notifications.js）**
  - 13種類の通知チャンネル設定（メール/LINE/両方）
  - 通知ごとの有効/無効切替
  - LINE接続設定（チャネルアクセストークン・グループID・オーナーID）
  - オーナーメール設定
- **ランドリー管理ページ新規実装（laundry.js）**
  - コインランドリー使用記録の入力・一覧表示
  - 月間集計（利用回数・合計枚数・合計金額）
  - スタッフ紐付け
- **清掃チェックリストページ新規実装（checklist.js）**
  - テンプレート管理（物件別チェック項目定義）
  - デフォルト8項目プリセット
  - 項目ごとの必須/写真フラグ
  - 清掃記録一覧（進捗バー表示）
- **ダッシュボード改善**
  - guestRegistrationsコレクションの予約データをカレンダーに反映
  - migrated_民泊メイン_フォームの回答_1からも過去予約を補完
  - 重複排除（CI一致で既存優先）

## 現在の課題
1. migrated_* コレクションのデータが正式コレクションに未変換（staffのみ手動変換済み）
2. 旧サブコレクション形式の回答データが残っている場合がある（設定→移行ボタンで解消可能）
3. Firestoreルールのテストモード→本番への移行が未完了
4. BEDS24連携は未実装（アカウント未登録）

## 2026-04-03（セッション: AI秘書）の成果
- **AI秘書PWA Phase 1 完了（v0403a）**
  - Next.js 14 + Tailwind CSS + TypeScript プロジェクト新規作成
  - Firebase Hosting静的エクスポート（`output: 'export'` → `out/`）
  - Firebase Auth統合（既存認証と共有）
  - PWAマニフェスト + アイコン
  - モバイルファーストのアプリシェル（ヘッダー + Phase概要 + 接続状態）
  - GitHub Actionsワークフロー（ビルドステップ付き）
  - Bearer token付きAPI通信基盤

## 次にやること
1. **AI秘書 Phase 2**: CopilotKit統合 + チャットUI + Cloud Functions Runtime
2. **AI秘書 Phase 3**: Generative UI + HITL経理承認 + シフト管理
3. LINE Messaging API連携（通知の実送信機能）
4. 請求書PDF生成・メール送信
5. スタッフ向けポータル（マイシフト・チェックリスト入力・ランドリー入力）
6. BEDS24連携（API登録後）
7. チェックインアプリ・アラームアプリの機能移植

## 開発ルール
- コード変更 → git push → GitHub Actions が自動デプロイ（約40秒）
- ユーザーはブラウザで最終確認するだけ

### デプロイ必須手順（厳守）
**feature ブランチにpushしただけではデプロイされない。**
必ず `business-os/main` にマージしてからpushすること。
```
git checkout business-os/main
git merge <feature-branch> --no-edit
git push -u origin business-os/main
```
- GitHub Actionsのトリガー: `business-os/main` ブランチの `public/**` 変更時のみ

## 既存GASコード
- `Code.js`（13,102行、280+関数）がbusiness-os/mainブランチに存在
- 募集管理34機能、通知43機能、請求書30機能を含む
- 参照して新アプリに移植する

## 重要な設定値
- Firebase プロジェクトID: `minpaku-v2`
- Hosting URL: `https://minpaku-v2.web.app`
- APIキー: `FIREBASE_API_KEY_PLACEHOLDER`
- GitHub: `yamasuke81-sys/minpaku-fix` / `business-os/main`
- スプシID（民泊メイン）: `1Kk8VZrMQoJwmNk4OZKVQ9riufiCEcVPi_xmYHHnHgCs`

## 実装済みページ一覧
| ページ | ファイル | 状態 |
|--------|---------|------|
| ダッシュボード | dashboard.js | 完了（カレンダー+統計+アクション） |
| スタッフ管理 | staff.js | 完了（CRUD+口座情報+スキル） |
| 物件管理 | properties.js | 完了（CRUD+BEDS24 ID） |
| 募集管理 | recruitment.js | 完了（回答・選定・確定） |
| 宿泊者名簿 | guests.js | 完了（CRUD+同行者+フォームURL） |
| シフト管理 | shifts.js | 完了（月間一覧+作成/編集+ステータス） |
| 請求書 | invoices.js | 完了（自動生成+詳細+確定） |
| 通知設定 | notifications.js | 完了（13通知+LINE接続） |
| ランドリー | laundry.js | 完了（記録+月間集計） |
| チェックリスト | checklist.js | 完了（テンプレート+記録） |
| 定期報告 | reports.js | 完了（住宅宿泊事業法14条） |
| プロジェクト | projects.js | 完了（開発管理） |
| 設定 | settings.js | 完了（データ移行+重複削除） |

## AI秘書PWA（apps/ai-secretary/）
| ページ | ファイル | 状態 |
|--------|---------|------|
| ホーム（ログイン+シェル） | src/app/page.tsx | Phase 1完了 |
| チャットUI | — | Phase 2で実装 |

### 社長の事前設定（AI秘書デプロイに必要）
1. [ ] Firebase Console → Hosting → サイト追加 → `ai-secretary-minpaku-v2`
2. [ ] `firebase target:apply hosting ai-secretary ai-secretary-minpaku-v2`
3. [ ] GitHub Secrets → `FIREBASE_API_KEY` 追加
