# 民泊管理v2 — アプリ設計書

## 概要
**BEDS24 + Firebase** ベースの民泊管理アプリ。
BEDS24を予約管理の中核に据え、清掃管理・スタッフ管理・請求書をFirebaseで自動化する。
**複数物件を管理** — 物件ごとにデータを分離し、比較・累計・統計を出せる構造。

### 物件管理の基本方針
- 全データに `propertyId` を付与 — 予約、シフト、ランドリー、請求書、チェックリスト全て
- 物件ごとの収支・稼働率・清掃回数・評価を集計可能な構造
- 物件種別（民泊/収益不動産）で将来的に統合管理
- 物件比較ダッシュボード（将来Phase）: 稼働率、売上、清掃コスト、利益率を横並び比較

## 技術スタック

| 層 | 技術 | 用途 |
|----|------|------|
| フロントエンド | Firebase Hosting + Bootstrap 5 + FullCalendar | UI配信（高速、コールドスタートなし） |
| バックエンド | Cloud Functions for Firebase (Node.js) | API、BEDS24連携、定期処理 |
| DB | Cloud Firestore | メインDB（高速読み書き） |
| 認証 | Firebase Authentication | オーナー/スタッフのログイン |
| ストレージ | Cloud Storage for Firebase | チェックリスト写真、請求書PDF |
| PMS連携 | BEDS24 API v2 | 予約データ同期 |
| 通知 | LINE Messaging API + Gmail API | アラート、ブリーフィング |
| ビュー用 | Google スプレッドシート（同期） | オーナーがデータを直接見たい時用 |

## アーキテクチャ

```
┌──────────────────────────────────────────────────────┐
│                  Firebase Hosting                     │
│            index.html + CSS + JS（静的配信）           │
│              → 一瞬で表示（GASの10倍速い）             │
└────────────────────┬─────────────────────────────────┘
                     │ fetch API（REST）
┌────────────────────┴─────────────────────────────────┐
│              Cloud Functions（バックエンド）            │
│                                                       │
│  /api/staff/*        スタッフ管理                      │
│  /api/shifts/*       シフト管理                       │
│  /api/bookings/*     予約管理（BEDS24経由）            │
│  /api/invoices/*     請求書                           │
│  /api/laundry/*      コインランドリー                  │
│  /api/checklist/*    チェックリスト                    │
│  /api/timee/*        タイミー募集                      │
│                                                       │
│  [定期実行]                                            │
│  syncBeds24()        BEDS24→Firestore同期（5分おき）   │
│  autoAssignShifts()  シフト自動割当（毎日21:00）       │
│  generateInvoices()  請求書生成（毎月末）              │
│  morningBriefing()   朝ブリーフィング（毎日6:00）      │
│  syncToSheets()      Firestore→スプレッドシート同期    │
└────────────────────┬─────────────────────────────────┘
                     │
        ┌────────────┼────────────────┐
        │            │                │
┌───────┴──────┐ ┌───┴────┐  ┌───────┴────────┐
│  Firestore   │ │BEDS24  │  │Cloud Storage   │
│  (メインDB)  │ │ API v2 │  │(写真/PDF)      │
│              │ │        │  │                │
│ staff/       │ │予約取得│  │checklist-photos│
│ shifts/      │ │空室管理│  │invoices/       │
│ bookings/    │ │料金管理│  │                │
│ invoices/    │ │        │  │                │
│ laundry/     │ │        │  │                │
│ checklists/  │ │        │  │                │
│ properties/  │ │        │  │                │
│ settings/    │ │        │  │                │
└──────────────┘ └────────┘  └────────────────┘
```

## BEDS24 API v2 連携設計

### 同期方針
- **BEDS24が予約のマスター** — 予約データはBEDS24が正（Airbnb/Booking.com→BEDS24→Firebase）
- **定期同期** — Cloud Functions scheduled で5分おきにBEDS24→Firestore同期
- **Webhook（可能なら）** — BEDS24のWebhookでリアルタイム同期

### BEDS24 API エンドポイント（使用予定）
| エンドポイント | 用途 |
|---------------|------|
| `GET /v2/bookings` | 予約一覧取得 |
| `GET /v2/bookings/{id}` | 予約詳細取得 |
| `GET /v2/properties` | 物件一覧取得 |
| `GET /v2/rooms` | 部屋一覧取得 |
| `GET /v2/inventory` | 空室状況取得 |
| `POST /v2/bookings` | 予約作成 |
| `PUT /v2/bookings/{id}` | 予約更新 |

### BEDS24認証
- API Token をFirebase環境変数（`functions.config()`）に保存
- トークンは BEDS24管理画面 → Settings → API で発行

### 予約→清掃スケジュール自動生成
```
BEDS24から予約同期
  ↓ チェックアウト日を検出
  ↓ 物件の清掃所要時間を参照
清掃スケジュール自動生成（Firestore shifts/ に書き込み）
  ↓ チェックアウト時刻 + 30分 = 清掃開始時刻（デフォルト）
  ↓ 次のチェックインまでに完了必要
シフト自動割当トリガー
```

## Firestore DB設計

### コレクション構造

```
firestore/
├── staff/                    # スタッフマスタ
│   └── {staffId}/
│       ├── name: string
│       ├── email: string
│       ├── phone: string
│       ├── skills: string[]
│       ├── availableDays: string[]       # ["月","火","水"]
│       ├── ratePerJob: number            # 円/回
│       ├── transportationFee: number     # 円/回
│       ├── bankName: string
│       ├── branchName: string
│       ├── accountType: string           # "普通" | "当座"
│       ├── accountNumber: string
│       ├── accountHolder: string
│       ├── contractStartDate: timestamp
│       ├── active: boolean
│       ├── displayOrder: number
│       ├── memo: string
│       ├── createdAt: timestamp
│       └── updatedAt: timestamp
│
├── properties/               # 物件マスタ（民泊+収益不動産を統合管理）
│   └── {propertyId}/
│       ├── name: string
│       ├── type: string                  # "minpaku" | "rental" | "other"
│       ├── beds24PropertyId: string      # BEDS24の物件ID（民泊のみ）
│       ├── address: string
│       ├── area: string                  # エリア（例: "大阪市中央区"）
│       ├── capacity: number              # 定員（民泊）or 戸数（賃貸）
│       ├── cleaningDuration: number      # 清掃所要時間（分）
│       ├── cleaningFee: number           # 清掃1回あたりの費用（円）
│       ├── requiredSkills: string[]
│       ├── checklistTemplateId: string
│       ├── monthlyFixedCost: number      # 月額固定費（管理費、ローン等）
│       ├── purchasePrice: number         # 取得価格（統計用）
│       ├── purchaseDate: timestamp       # 取得日
│       ├── notes: string
│       ├── active: boolean
│       ├── createdAt: timestamp
│       └── updatedAt: timestamp
│
├── bookings/                 # 予約（BEDS24から同期）
│   └── {bookingId}/
│       ├── beds24BookingId: string       # BEDS24の予約ID
│       ├── propertyId: string
│       ├── guestName: string
│       ├── guestCount: number
│       ├── checkIn: timestamp
│       ├── checkOut: timestamp
│       ├── source: string                # "Airbnb" | "Booking.com" | "Direct"
│       ├── status: string                # "confirmed" | "cancelled" | "completed"
│       ├── bbq: boolean
│       ├── parking: boolean
│       ├── notes: string
│       ├── syncedAt: timestamp           # BEDS24同期日時
│       └── cleaningShiftId: string       # 紐付くシフトID
│
├── shifts/                   # シフト（清掃スケジュール）
│   └── {shiftId}/
│       ├── date: timestamp
│       ├── propertyId: string
│       ├── bookingId: string             # 紐付く予約ID
│       ├── staffId: string | null
│       ├── staffName: string | null
│       ├── startTime: string             # "10:30"
│       ├── endTime: string | null
│       ├── status: string                # "unassigned"|"assigned"|"confirmed"|"completed"|"cancelled"
│       ├── assignMethod: string          # "auto" | "manual"
│       ├── checklistId: string | null
│       └── createdAt: timestamp
│
├── laundry/                  # コインランドリー記録
│   └── {recordId}/
│       ├── date: timestamp
│       ├── staffId: string
│       ├── propertyId: string
│       ├── amount: number                # 円
│       ├── sheets: number                # 枚数
│       └── memo: string
│
├── invoices/                 # 請求書
│   └── {invoiceId}/          # INV-202603-S001
│       ├── yearMonth: string             # "2026-03"
│       ├── staffId: string
│       ├── basePayment: number
│       ├── laundryFee: number
│       ├── transportationFee: number
│       ├── specialAllowance: number
│       ├── total: number
│       ├── status: string                # "draft"|"pending"|"confirmed"|"paid"
│       ├── pdfUrl: string | null
│       ├── confirmedAt: timestamp | null
│       └── details: {                    # 明細（サブコレクションでも可）
│             shifts: [{date, propertyName, amount}],
│             laundry: [{date, amount}]
│           }
│
├── checklists/               # チェックリスト記録
│   └── {checklistId}/
│       ├── shiftId: string
│       ├── propertyId: string
│       ├── staffId: string
│       ├── items: [{name, checked, note, photoUrl}]
│       ├── completedAt: timestamp | null
│       └── status: string                # "in_progress" | "completed"
│
├── checklistTemplates/       # チェックリストマスタ
│   └── {templateId}/
│       ├── propertyId: string
│       ├── items: [{name, required, photoRequired}]
│       └── updatedAt: timestamp
│
├── timeeRequests/            # タイミー募集
│   └── {requestId}/
│       ├── date: timestamp
│       ├── propertyId: string
│       ├── shiftId: string
│       ├── description: string           # 自動生成された募集文面
│       ├── status: string                # "draft"|"pending_approval"|"posted"|"filled"|"cancelled"
│       ├── approvedAt: timestamp | null
│       └── createdAt: timestamp
│
├── recruitments/             # スタッフ募集
│   └── {recruitmentId}/
│       ├── checkoutDate: string             # "2026-04-05"
│       ├── propertyId: string
│       ├── propertyName: string
│       ├── bookingId: string
│       ├── status: string                   # "募集中"|"選定済"|"スタッフ確定済み"
│       ├── selectedStaff: string            # カンマ区切り
│       ├── notifyMethod: string             # "メール"|"LINE"
│       ├── memo: string
│       ├── confirmedAt: timestamp | null
│       ├── createdAt: timestamp
│       ├── updatedAt: timestamp
│       └── responses/                       # サブコレクション
│           └── {responseId}/
│               ├── staffId: string
│               ├── staffName: string
│               ├── staffEmail: string
│               ├── response: string         # "◎"|"△"|"×"
│               ├── memo: string
│               └── respondedAt: timestamp
│
├── guestRegistrations/       # 宿泊者名簿（Googleフォーム連携）
│   └── {guestId}/
│       ├── guestName: string                # 代表者氏名
│       ├── nationality: string              # 国籍（デフォルト: 日本）
│       ├── address: string                  # 住所
│       ├── phone: string
│       ├── email: string
│       ├── passportNumber: string           # 旅券番号（外国籍）
│       ├── purpose: string                  # 旅の目的
│       ├── checkIn: string                  # "2026-04-05"
│       ├── checkOut: string
│       ├── guestCount: number
│       ├── guestCountInfants: number
│       ├── bookingSite: string              # "Airbnb" etc.
│       ├── bbq: string
│       ├── parking: string
│       ├── memo: string
│       ├── guests: [{                       # 同行者リスト（旅館業法）
│       │     name, age, nationality, address, passportNumber
│       │   }]
│       ├── propertyId: string               # 物件紐付け
│       ├── bookingId: string                # 予約紐付け（BEDS24連携後）
│       ├── beds24BookingId: string
│       ├── source: string                   # "google_form"|"beds24"|"manual"
│       ├── formResponseRow: number          # Googleフォーム行番号
│       ├── createdAt: timestamp
│       └── updatedAt: timestamp
│
└── settings/                 # アプリ設定
    ├── beds24/
    │   ├── apiToken: string（※環境変数推奨）
    │   ├── syncInterval: number          # 同期間隔（分）
    │   └── lastSyncAt: timestamp
    ├── notifications/
    │   ├── lineToken: string（※環境変数推奨）
    │   ├── briefingTime: string          # "06:00"
    │   └── alertChannels: string[]
    └── owner/
        ├── email: string
        ├── name: string
        └── taxAccountantEmail: string
```

## 機能一覧

### 1. スタッフ管理
- スタッフのCRUD（Firestore staff/ コレクション）
- スキル管理、稼働可能曜日設定
- 業務委託契約情報（報酬単価、銀行情報）
- 有効/無効切替
- **画面**: スタッフ一覧テーブル + 登録/編集モーダル

### 2. 物件管理
- 物件のCRUD（BEDS24の物件IDと紐付け）
- 清掃所要時間、必要スキル設定
- チェックリストテンプレート紐付け
- **画面**: 物件一覧カード + 登録/編集モーダル

### 3. 予約管理（BEDS24連携）
- BEDS24 APIから予約を定期同期
- カレンダー表示（FullCalendar）
- 予約詳細表示（ゲスト名、人数、チェックイン/アウト、ソース）
- 予約→清掃スケジュール自動生成
- **画面**: カレンダー（月/週/リスト）+ 予約詳細モーダル

### 4. シフト自動割当
- 予約のチェックアウト日から清掃スケジュール自動生成
- スタッフの稼働可能日×スキル×公平性で自動割当
- オーナーにLINE通知→承認 or 修正
- **割当ロジック**:
  1. 対象日に稼働可能なスタッフを抽出
  2. 物件の必要スキルでフィルタ
  3. 月間割当回数が少ない順にソート（公平性）
  4. 割当→スタッフに通知

### 5. スタッフ間出勤時間調整
- 同日複数スタッフの開始時間調整
- アプリ内で希望時間入力→自動調整
- 確定通知

### 6. 清掃チェックリスト
- 物件別テンプレート
- モバイル最適化UI（Galaxy対応）
- 写真撮影→Cloud Storageにアップロード
- 完了報告自動送信

### 7. コインランドリー管理
- 使用記録入力（日付、金額、枚数）
- 月間集計
- 請求書に自動連携

### 8. 請求書自動生成
- 月末にシフト実績 + ランドリー + 交通費を自動集計
- スタッフにメール（確認ページURL付き）
- スタッフが確認→編集→送信
- PDF生成→オーナーに送付

### 9. タイミー募集自動化
- スタッフ不足を自動検知
- 募集文面を自動生成
- オーナーにLINE通知（GOサイン待ち）
- GOサイン後に募集投稿 or テキスト出力

## UI設計

### ページ構成
| ページ | URL | 用途 | ユーザー |
|--------|-----|------|----------|
| ダッシュボード | `/` | カレンダー + 今日の概要 | オーナー |
| スタッフ管理 | `/staff` | 一覧・登録・編集 | オーナー |
| 物件管理 | `/properties` | 一覧・登録・編集 | オーナー |
| シフト管理 | `/shifts` | シフト表・割当 | オーナー |
| 請求書 | `/invoices` | 月次一覧・詳細 | オーナー |
| 設定 | `/settings` | BEDS24連携・通知設定 | オーナー |
| マイシフト | `/my/shifts` | 自分のシフト確認 | スタッフ |
| チェックリスト | `/my/checklist/{id}` | 清掃チェック入力 | スタッフ |
| 請求書確認 | `/my/invoice/{id}` | 請求書確認・送信 | スタッフ |
| ランドリー入力 | `/my/laundry` | ランドリー記録入力 | スタッフ |

### SPA構成
- シングルページアプリケーション（SPA）
- URL ルーティングは簡易ハッシュルーター（`#/staff`, `#/shifts` 等）
- ページ遷移はJS内で切替（サーバー不要）

### UI方針
- Bootstrap 5 ベース
- モバイルファースト（スタッフはGalaxyスマホ）
- オーナー画面: PC/タブレット最適化、サイドバーナビ
- スタッフ画面: スマホ最適化、ボトムナビ
- ダークモード: なし（業務アプリなのでライトのみ）

## ファイル構成

```
minpaku-v2/
├── CLAUDE.md                    # この設計書
├── firebase.json                # Firebase設定
├── firestore.rules              # Firestoreセキュリティルール
├── firestore.indexes.json       # Firestoreインデックス
├── .firebaserc                  # Firebaseプロジェクト設定
│
├── public/                      # フロントエンド（Firebase Hosting）
│   ├── index.html               # SPA エントリポイント
│   ├── css/
│   │   └── style.css            # カスタムCSS
│   └── js/
│       ├── app.js               # メインアプリ（ルーター、初期化）
│       ├── firebase-config.js   # Firebase初期化設定
│       ├── auth.js              # 認証
│       ├── pages/
│       │   ├── dashboard.js     # ダッシュボード
│       │   ├── staff.js         # スタッフ管理
│       │   ├── properties.js    # 物件管理
│       │   ├── shifts.js        # シフト管理
│       │   ├── invoices.js      # 請求書
│       │   ├── settings.js      # 設定
│       │   └── my/
│       │       ├── my-shifts.js     # スタッフ用シフト
│       │       ├── my-checklist.js  # チェックリスト
│       │       ├── my-invoice.js    # 請求書確認
│       │       └── my-laundry.js    # ランドリー入力
│       └── components/
│           ├── navbar.js        # ナビバー
│           ├── calendar.js      # カレンダーコンポーネント
│           └── modal.js         # モーダルユーティリティ
│
├── functions/                   # バックエンド（Cloud Functions）
│   ├── package.json
│   ├── index.js                 # エントリポイント（全エクスポート）
│   ├── api/
│   │   ├── staff.js             # スタッフAPI
│   │   ├── shifts.js            # シフトAPI
│   │   ├── bookings.js          # 予約API
│   │   ├── invoices.js          # 請求書API
│   │   ├── laundry.js           # ランドリーAPI
│   │   └── checklist.js         # チェックリストAPI
│   ├── scheduled/
│   │   ├── syncBeds24.js        # BEDS24同期（定期実行）
│   │   ├── autoAssignShifts.js  # シフト自動割当
│   │   ├── generateInvoices.js  # 請求書生成
│   │   ├── morningBriefing.js   # 朝ブリーフィング
│   │   └── syncToSheets.js      # スプレッドシート同期
│   ├── triggers/
│   │   ├── onBookingChange.js   # 予約変更→清掃スケジュール生成
│   │   └── onShiftChange.js     # シフト変更→通知
│   └── utils/
│       ├── beds24Client.js      # BEDS24 APIクライアント
│       ├── lineNotify.js        # LINE通知
│       ├── emailSender.js       # メール送信
│       └── pdfGenerator.js      # PDF生成
│
└── docs/
    ├── beds24-api.md            # BEDS24 API仕様メモ
    └── setup-guide.md           # セットアップ手順
```

## セットアップ手順（初回）

1. Firebase プロジェクト作成（Firebase Console）
2. `firebase login` → `firebase init`（Hosting + Functions + Firestore）
3. Firestore セキュリティルール設定
4. Firebase Authentication 有効化（メール/パスワード）
5. 環境変数設定（BEDS24 APIトークン、LINE トークン等）
6. `firebase deploy` でデプロイ
7. BEDS24 管理画面で API トークン発行→環境変数に設定

## バージョン管理
- フォーマット: `v{MMDD}{連番アルファベット}`
- `index.html` 内にバージョン表示

## デプロイ

### 自動デプロイの仕組み
- **GitHub Actions** が `main` ブランチへのpush時に Firebase Hosting へ自動デプロイ
- トリガー条件: `.github/workflows/deploy.yml` 参照
  - ブランチ: `main` のみ
  - パス: `public/**` または `firebase.json`
- 手動実行: GitHub Actions の `workflow_dispatch` から実行可能

### 開発→デプロイの手順
1. `main` ブランチに変更をコミット＆push → 自動デプロイ
2. デプロイ先: https://minpaku-v2.web.app

### 関連リポジトリ
| リポジトリ | 内容 |
|---|---|
| minpaku-v2 | 民泊管理アプリ v2（このリポ） |
| scan-sorter | スキャン仕分けツール |
| biz-dashboard | 事業ダッシュボード |
| biz-hq | 事業本部管理 |
| property-radar | 物件レーダー |
| ai-secretary | AI秘書 |

