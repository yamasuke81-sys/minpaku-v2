# 民泊管理v2 — アプリ設計書

## P3実装完了（2026-04-16）

### 実装済み機能(時系列要約)
- **チェックリスト編集画面**: GAS版マスタ(561項目/20エリア/4階層+要補充)を `checklistMaster/main` に投入、物件別テンプレ `checklistTemplates/{propertyId}`。L1タブ+L2〜L4アコーディオン、D&D並び替え(同一階層+アイテムは階層間移動可)、追加/編集/削除/コピー
- **スタッフ用チェックリスト画面**: `my-checklist.js` を置換。`onShiftCreated` トリガーで自動生成、onSnapshot でリアルタイム同期、複数スタッフ同時編集+editingBy presence
- **データ整理**: bookings 全件に propertyId (=the Terrace長浜) 補完、recruitments/shifts/checklists を再生成、キャンセル予約(Not available/Reservedブロック含む)と連動削除
- **スタッフ管理UI**: 稼働曜日・報酬単価フィールド削除、担当物件チェックボックス(`assignedPropertyIds`)、タイミーフラグ(`isTimee`)、手動並び替え(D&D, displayOrder)、オーナーをスタッフ化(`isOwner`)
- **物件管理UI**: selectionMethod(ownerConfirm/firstCome)、cleaningRequiredCount、inspection(enabled/requiredCount/periodStart-periodEnd/recurYearly)、propertyNumber(永続)、color
- **報酬単価ページ**(`#/rates`): 階段制(1名/2名/3名)、作業タイプ(cleaning_by_count/pre_inspection/other)、単価モード切替(共通/スタッフ別XOR)、特別加算料金(毎年繰り返し可、年跨ぎ対応)、タイミー時給(作業単位)、他物件からインポート
- **募集UI**: 「選択状態を保存」+案内ガイド+「スタッフ確定」2段、ネイティブconfirm→Bootstrapモーダル化、スタッフ選定で全アクティブスタッフ選択可、日付ソート(直近順)、回答+選定テーブル統合
- **通知設定**: 複数タイミング配列、都度(N日前HH:MM含む)/日付モード切替、customMessage 実動作化(主要3種で変数置換)、invoice_submitted通知追加、invoice系にproperty変数追加
- **横カレンダー改造** (my-recruitment): 連泊バー(名簿ドット)、凡例整理、回答取消、オーナー代理回答、物件セクション+番号色バッジ+表示ON/OFF、スタッフ行の担当物件フィルタ、セル物件バッジ、オーナー行最下固定、確定済セル→ポップアップ詳細(遷移なし)、sticky幅スライダー(190〜320px)
- **ダッシュボード**: FullCalendar イベントに `[清]/[直]` workTypeプレフィックス、募集モーダルで回答欄の二重表示削除、キャンセル予約除外
- **直前点検**: `workType: "pre_inspection"` で checkIn日に自動シフト+募集生成（同日他予約のcheckOutがあればスキップ）、毎年繰り返し対応
- **カレンダー整合性トリガー**: `onBookingChange` で予約キャンセル時に対応shift/recruitment/checklist自動削除

### 新規ファイル(P3)
- `functions/triggers/onShiftCreated.js` — シフト作成→checklistスナップショット生成
- `functions/api/checklist.js` 拡張 — ツリー構造版テンプレAPI
- `public/js/pages/property-checklist.js` — 物件別チェックリスト編集
- `public/js/pages/rates.js` — 報酬単価設定
- `functions/migration/*.js` — データクリーンアップ/再生成スクリプト群

### 未対応要件（次セッションで着手予定）

#### 優先度高(直近指摘)
- **4/16 予約と清掃募集の実態不整合** — 1件の確認要 (Airbnb Not availableの残存の可能性)
- **横カレンダー 宿泊イベントをバー高さ統一**: 現状のセル塗りつぶしではなく、清掃募集バーと同じ太さのバー形式に変更。バー内に宿泊人数、左端に名簿ドット(GAS版同等)
- **代理回答後の自動スクロール抑止**: 回答後 `renderCalendar()` で「今日」まで scrollLeft がリセットされる → 元のスクロール位置を保持
- **スタッフ回答マークが小さい** — 現状font-size 18px を更に大きく、またはアイコン化

#### 優先度中
- **直前点検の表示対応** (workType=pre_inspection のシフト/募集もカレンダーに出す)
- **H2 通知スケジュール実行バックエンド** — 現状 UI 保存のみ。Cloud Scheduler + runScheduledNotifications 関数追加で実送信(dry-runモード推奨)
- **請求書生成ロジックの階段制対応** — 現状フラット単価のまま。`workType` × スタッフ人数 × 単価モード × 特別加算料金で計算
- **Phase2+ 清掃画面機能** — 本日のシフトカード(my-dashboard)、写真一括アップロード(before/after, 30日保持), ランドリー出し/回収/収納ボタン、完了フロー、30日超過自動削除ジョブ

#### 将来構想(memory保存済)
- タイミー連携ボタン(スタッフ不足時の自動発注) → `memory/project_minpaku_timee.md`

### データ運用上の前提
- 民泊物件: the Terrace 長浜(`tsZybhDMcPrxqgcRy7wp`, #4) / Pocket House WAKA-KUSA(#2) / YADO KOMACHI Hiroshima(#1) / UJINA Pocket House(#3) — 全 active=true
- オーナー: 西山恭介 (uid=rwHczfRz8DfnWCrQ7yeAYnsd8in2, staffId=ziTig6tefnj5NvkgN4fG, isOwner=true, displayOrder=0)
- iCal 同期は Airbnb + Booking.com、全て the Terrace 長浜 の予約

## P1実装完了（2026-04-15）

### 実装済み機能
- **予約→シフト+募集自動生成**: onBookingChangeトリガー（bookings作成/更新時にcheckOut日のシフト+募集を自動生成、LINE通知）
- **チェックリスト完了→シフト完了+ランドリー促進**: onChecklistCompleteトリガー（完了時にシフトstatus更新、オーナーLINE通知、スタッフにランドリー入力リマインド）
- **selectedStaff配列化**: selectedStaffIds[]配列 + 名前フォールバック（ID照合優先）
- **請求書明細手動追加**: POST /:id/items、DELETE /:id/items/:index、manualItems配列管理、合計再計算
- **請求書markPaid/delete**: PUT /:id/markPaid、DELETE /:id（draftのみ）
- **請求書PDF生成**: GET /:id/pdf（pdfkit + Cloud Storage + 日本語フォント自動検出）
- **通知設定**: システム定義変数（通知種別ごとに利用可能変数）、メッセージテンプレート編集、プレビュー、テスト送信
- **オーナーのスタッフ画面操作**: オーナーがスタッフとして募集回答・チェックリスト操作可能

### 新規ファイル
- `functions/triggers/onBookingChange.js` — 予約→シフト+募集自動生成
- `functions/triggers/onChecklistComplete.js` — チェックリスト完了→シフト完了+通知
- `functions/api/notifications.js` — テスト送信API

### 残タスク
- P2: 請求書PDF送信（LINE/メール）、備品管理、交通費申請、ゲスト多言語対応

## P0実装完了（2026-04-14）

### 実装済み機能
- **スタッフ認証分離**: LINEログイン + 招待リンク（マジックリンク）+ カスタムクレーム（role: staff, staffId）
- **Firestoreセキュリティルール**: `request.auth.token.staffId` ベースの照合に全面修正
- **スタッフ用マイページ**: マイダッシュボード（#/my-dashboard）、募集回答（#/my-recruitment）、チェックリスト入力（#/my-checklist）
- **LINE実送信**: 募集作成時・確定時のグループ+個別通知、毎日18時リマインド
- **通知設定**: 4択チェックボックス（オーナーLINE / グループLINE / スタッフ個別LINE / メール）
- **スタッフ管理UI拡張**: 招待リンク発行・LINE User ID紐付け・認証状態表示・LINE共有ボタン
- **Firebase Storage**: CORS設定済み、Storage Rules デプロイ済み

### 新規ファイル
- `functions/api/auth.js` — 認証API（LINEログイン、招待、ロール管理）
- `functions/scheduled/recruitReminder.js` — 募集リマインド（毎日18:00 JST）
- `public/invite.html` — スタッフ招待受諾ページ
- `public/js/pages/my-dashboard.js` — スタッフ用マイダッシュボード
- `public/js/pages/my-recruitment.js` — スタッフ用募集回答画面
- `public/js/pages/my-checklist.js` — スタッフ用チェックリスト入力

### LINE設定
- LINE Login チャネルID: 2009790221（プロバイダー: 長浜清掃G通知）
- Messaging API チャネル: 長浜清掃G通知（既存）
- Callback URL: `https://minpaku-v2.web.app/index.html`
- Firestore設定: `settings/lineLogin`, `settings/notifications`

### 残タスク
- LINE Webhook URL を Cloud Functions URL に変更（現在GAS向き）
- 各スタッフに lineUserId を紐付け
- P1: 予約→シフト自動生成、チェックリスト→ランドリー連携、請求書完成

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

