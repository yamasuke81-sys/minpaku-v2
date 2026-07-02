# 実装完了履歴（P0〜P3）— 2026-04-14〜16

> 旧 CLAUDE.md（2026-07-02 ダイエット）から無損失で移設した実装完了記録。
> 以降の日別作業ログは git log と memory（project_minpaku_v2_context.md ほか）を参照。

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

#### 解消済み（2026-04-16 追加対応）
- ~~4/16 予約と清掃募集の実態不整合~~: `syncIcal.js` の `extractGuestName` が "Airbnb (Not available)" 形式を弾けず再ingestしていた → 正規表現を `/not available/i` に修正。既存ブロックは `cancel-not-available.js` + `delete-orphan-recruitments.js` で除去
- ~~横カレンダー 宿泊イベントをバー高さ統一~~: 予約セルを `flex` バー (height:22px, border-radius:11px) に変更、バー内に名簿ドット+宿泊人数表示
- ~~代理回答後の自動スクロール抑止~~: `_initialScrollDone` フラグで初回のみ「今日」へスクロール、再描画時は `prevScrollLeft` を維持
- ~~スタッフ回答マークが小さい~~: font-size 18px → 28px、シンボルも ●/▲/✖ → ◎/△/× に変更

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
