# タイミー清掃募集 自動投稿機能 Phase 1 設計ブリーフィング

調査基準日: 2026-05-20 / 対象ブランチ: `main` (HEAD `d9b31e8`)
本ドキュメントは `minpaku-v2` リポジトリの実コードを読んで判明した事実のみを記述する。
不明点はすべて末尾の「質問リスト」または各セクション末尾の「不明」項目にまとめた。
シークレット値はすべて `<MASKED>` / `<REDACTED>` で伏字化している。

---

## 1. リポジトリ概要

- 目的: 民泊 (the Terrace 長浜 / Pocket House WAKA-KUSA / YADO KOMACHI Hiroshima / UJINA Pocket House の 4 物件) の予約・清掃・スタッフ・請求書・宿泊者名簿を一元管理する Web アプリ
- 構成: モノレポではない単一リポ。`public/` (Firebase Hosting / バニラ JS + Bootstrap 5 + FullCalendar) と `functions/` (Cloud Functions Node.js 22) が並列
- TypeScript: 本体は使用していない (純 JS)。`tests/` のみ Playwright + TS
- モジュール形式: CommonJS (`require`/`module.exports`)
- Node.js: `functions/package.json` で `"engines": { "node": "22" }`、firebase.json で `"runtime": "nodejs22"`
- 主要依存 (`functions/package.json`):
  - `firebase-admin` ^13.0.0
  - `firebase-functions` ^6.3.0 (Gen2 API、`onRequest` / `onSchedule` / `onDocumentWritten`)
  - `googleapis` ^144.0.0 (Gmail API クライアント)
  - `node-ical` ^0.26.0 (iCal 同期)
  - `pdfkit` ^0.18.0
- ルートに `package.json` は **なし** (functions と tests それぞれが独自 package.json を持つ)
- firebase-tools のバージョン指定はリポジトリ内に見当たらず (`不明 — 要確認`)
- 認証/データ層: Firebase Authentication + Firestore + Cloud Storage、`projectId=minpaku-v2`

---

## 2. ディレクトリツリー (深さ 3、抜粋)

```
minpaku-v2/
├── CLAUDE.md                     # アプリ設計書 SSOT
├── MEMORY.md                     # 引継ぎメモ
├── firebase.json                 # Hosting + Functions + Firestore + Storage + emulators 設定
├── firestore.rules               # セキュリティルール (owner / sub_owner / staff 三層)
├── firestore.indexes.json        # 複合インデックス定義
├── storage.rules
├── storage-cors.json
├── docs/                         # 既存ドキュメント (10 本)
│   ├── e2e-next-session.md
│   ├── email-verification.md
│   ├── fcm-setup.md
│   ├── flow-verification-plan.md
│   ├── ical-integration-robustness.md
│   ├── invoice-generator-design.md
│   ├── liff-setup.md
│   ├── magic-link-setup.md
│   ├── pdf-iam-permission-fix.md
│   ├── per-property-line-setup.md
│   └── setup-guide.md
├── functions/                    # Cloud Functions (Gen2)
│   ├── index.js                  # 全 export エントリポイント
│   ├── package.json
│   ├── api/                      # Express ルータ群 (REST API)
│   ├── scheduled/                # onSchedule (cron) 群
│   ├── triggers/                 # onDocument* 群
│   ├── utils/                    # ヘルパー (LINE / Gmail / emailParser 等)
│   ├── migration/                # 一度きりのバックフィル/調査スクリプト多数 (180 本超)
│   ├── emulator/                 # Firestore エミュレータ用 seed
│   └── fonts/                    # PDF 用日本語フォント
├── public/                       # Firebase Hosting 配信
│   ├── index.html                # SPA エントリ
│   ├── invite.html               # スタッフ招待受諾
│   ├── guest-form.html           # ゲスト名簿フォーム (匿名アクセス)
│   ├── guest-guide.html
│   ├── guides/                   # 物件別 案内ページ (the-terrace-nagahama.html 等)
│   ├── manifest.json             # PWA
│   ├── firebase-messaging-sw.js  # FCM SW
│   ├── version.json              # cache-bust 用バージョン
│   └── js/
│       ├── app.js                # ハッシュルータ / 共通モーダル
│       ├── auth.js
│       ├── firebase-config.js
│       ├── pages/                # 機能別画面 (dashboard, recruitment, staff, properties, ...)
│       ├── components/
│       └── shared/               # notify-channel-editor 等
├── gas-scripts/
│   └── syncGuestFormToV2.gs      # GAS → v2 への名簿同期
├── scripts/                      # i18n 抽出/翻訳バッチ群 (Gemini 経由)
├── tests/
│   ├── playwright.config.ts
│   ├── e2e/ (owner-flow.spec.ts, staff-flow.spec.ts, guest-flow.spec.ts, ...)
│   ├── fixtures/
│   └── utils/
└── .github/workflows/
    ├── deploy.yml                # main push 時に Firebase Hosting 自動デプロイ
    └── e2e.yml                   # 不明 (要確認)
```

`.env.example` は **存在しない** (ルート / functions 共に未確認)。
ローカル `.env` は `.gitignore` で除外されている。

---

## 3. Cloud Functions 一覧

`functions/index.js` で `exports.*` されている関数を全列挙する。すべて region `asia-northeast1`、runtime `nodejs22`、TZ `Asia/Tokyo`。

### HTTP

| 名前 | パス | トリガ | 役割 |
|---|---|---|---|
| `api` | `functions/index.js` 内 Express | `onRequest` (`invoker: "public"`) | Hosting rewrite `/api/**` 経由で全 REST ルータ (`staff` / `properties` / `shifts` / `laundry` / `invoices` / `recruitment` / `guests` / `checklist` / `reports` / `scan-sorter` / `tax-docs` / `notifications` / `translate` / `sync` / `email-verification` / `timee` / `booking-timeline` / `keybox` / `auth` / `gmail-auth` / `public` / `guest-edit` / `helper-checklist`) |
| `lineWebhook` | `functions/api/line-webhook.js` | `onRequest` (`invoker: "public"`) | LINE Messaging API Webhook 受信 |

### Scheduled (cron)

| 名前 | パス | cron | 役割 |
|---|---|---|---|
| `morningBriefing` | `scheduled/morningBriefing.js` | `0 6 * * *` | 朝 6:00 JST に CO/CI/未確定アラート/承認待ち/エラー/税理士資料を集約して `notifyByKey("morning_briefing", ...)` で送信。1 日 1 回ガード (`settings/briefingState.lastSentDate`) |
| `alertUnconfirmed` | `scheduled/alertUnconfirmed.js` | `0 * * * *` | 当日・翌日 CO で `recruitments.status="募集中"` のものを即時 LINE。`notifications` collection の `type=alert` ログで日次重複防止 |
| `collectTaxDocs` | `scheduled/collectTaxDocs.js` | `0 9 3 * *` | 毎月 3 日 9:00 税理士資料 Gmail 収集 |
| `processMfInbox` | `scheduled/collectTaxDocs.js` (`processMfInbox` named export) | `0 9 * * 1` | MF 受信 BOX 監視 (週次) |
| `checkTaxDocsDrive` | `scheduled/checkTaxDocsDrive.js` | `0 7 * * *` | 税理士資料 Drive フォルダ日次監視 (timeout 300s) |
| `recruitReminder` | `scheduled/recruitReminder.js` | `0 * * * *` | 物件別 `channelOverrides.recruit_remind.timings[]` に従って未回答スタッフへリマインド (重複防止キー `recruitRemindSentKeys`) |
| `sendParkingInvoice` | `scheduled/sendParkingInvoice.js` | `0 8 * * *` | 駐車場請求・催促メール (毎朝 8:00) |
| `sendKeyboxScheduled` | `scheduled/sendKeyboxScheduled.js` | `0 * * * *` | キーボックス情報スケジュール送信 |
| `syncTimeeEmails` | `scheduled/syncTimeeEmails.js` | `every 10 minutes` | **Timee 受信メール (supporter@timee.co.jp) を Gmail から取り込み `timeeMatches/{messageId}` に保存、`recruitments` と紐付け** |
| `syncIcal` | `scheduled/syncIcal.js` | `every 5 minutes` | Airbnb / Booking.com の iCal を取り込み `bookings/{id}` を upsert |
| `oauthReminder` | `scheduled/oauthReminder.js` (内部で `onSchedule` 定義) | 毎日 9:00 JST (内部定義) | OAuth リフレッシュトークン 6 日経過リマインド |
| `runGasComparisonHourly` | `scheduled/compareGasReservations.js` | `0 * * * *` | 旧 GAS 版予約データとの差分比較 |
| `orphanCleanup` | `scheduled/orphanCleanup.js` (内部定義) | 毎日 2:00 JST | 孤児データクリーンアップ |
| `photoCleanup` | `scheduled/photoCleanup.js` (内部定義) | 毎日 3:00 JST | チェックリスト写真 30 日超過削除 |
| `generateInvoices` | `scheduled/generateInvoices.js` (内部定義) | 毎月 1 日 2:00 JST | 前月分請求書を全 active スタッフ (`isTimee !== true`) について自動生成 |
| `rosterRemind` | `scheduled/rosterRemind.js` | `0 * * * *` | 名簿未入力リマインド |
| `staffUndecidedRemind` | `scheduled/staffUndecidedRemind.js` | `0 * * * *` | **「清掃スタッフ未確定」リマインド本体**。物件別 `channelOverrides.staff_undecided.timings[]` に従い特定日数前の同時刻に発火、後方互換で毎朝 11:00 一括通知も残す |
| `sendInspectionReminder` | `scheduled/sendInspectionReminder.js` | `0 * * * *` | 直前点検リマインド |
| `scheduledEmailVerification` | `scheduled/emailVerification.js` (`scheduled` named export) | 内部定義 (10 分おき) | OTA 予約確認メール照合 |
| `testGasComparison` | `index.js` | `onCall` | フロントから手動実行 (owner 権限チェック付) |

`syncBeds24` / `autoAssignShifts` / `watchGmail` は **コメントアウトされており未稼働**。

### Firestore Triggers

| 名前 | パス | ドキュメント | 役割 |
|---|---|---|---|
| `onRecruitmentChange` | `triggers/onRecruitmentChange.js` | `recruitments/{id}` write | 回答変更通知 |
| `onGuestFormSubmit` | `triggers/onGuestFormSubmit.js` | `guestRegistrations/{id}` create | 名簿受信通知 |
| `onGuestFormUpdate` | `triggers/onGuestFormUpdate.js` | `guestRegistrations/{id}` update | 名簿修正完了メール |
| `onGuestRegistrationToGas` | `triggers/onGuestRegistrationToGas.js` | `guestRegistrations/{id}` create | GAS 版スプシへ転記 |
| `onBookingChange` | `triggers/onBookingChange.js` | `bookings/{id}` write | **新規/変更時に清掃 shift + recruitment 自動生成、`timee_posting` 通知、直前点検生成** |
| `onShiftCreated` | `triggers/onShiftCreated.js` | `shifts/{id}` create | 物件テンプレからチェックリストスナップショット生成 |
| `onChecklistTemplateUpdate` | `triggers/onChecklistTemplateUpdate.js` | `checklistTemplates/{pid}` update | 未着手 checklist へ反映 |
| `onChecklistComplete` | `triggers/onChecklistComplete.js` | `checklists/{id}` update | シフト完了+通知 |
| `onChecklistLaundryChange` | `triggers/onChecklistLaundryChange.js` | `checklists/{id}` update | ランドリー関連通知 |
| `onErrorLogCreated` | `triggers/onErrorLogCreated.js` | `error_logs/{id}` create | AI 翻訳 + LINE 通知 |
| `onBookingConfirmMail` | `triggers/onBookingConfirmMail.js` | `bookings/{id}` create | ゲストへ名簿フォーム URL 送信 |
| `onInvoiceStatusChange` | `triggers/onInvoiceStatusChange.js` | `invoices/{id}` update | submitted 遷移時 PDF 自動生成 |
| `onBookingEmailCheck` | `triggers/onBookingEmailCheck.js` | (内部定義) | iCal 同期で新予約検出直後の即時 Gmail 巡回 |

### 「清掃スタッフ未確定アラート」生成ロジックの詳細

主体は **`scheduled/staffUndecidedRemind.js`** と **`scheduled/alertUnconfirmed.js`**、加えて朝の `morningBriefing.js` で同じ情報をブリーフィングに含める。
判定は **タイミー側を読みに行っていない**。すべて Firestore `recruitments` の `status` を見ているだけ。

```js
// staffUndecidedRemind.js (抜粋)
const recSnap = await db.collection("recruitments")
  .where("propertyId", "==", tgt.propertyId)
  .where("checkoutDate", "==", tgt.targetCheckoutDate)
  .where("status", "==", "募集中")
  .get();
// → status="募集中" のまま残っていれば「未確定」と見做して通知
```

```js
// morningBriefing.js (抜粋)
db.collection("recruitments").where("status", "==", "募集中").get(),
db.collection("recruitments").where("status", "==", "選定済").get(),
// ↓ checkoutDate <= 3日後 を未確定 / 選定済未確定として分類
const unconfirmed = recruitSnap.docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .filter((r) => r.checkoutDate && r.checkoutDate <= threeDaysLater);
```

→ Phase 1 設計上の含意: **「未確定」は recruitment status だけで決まる**。社内スタッフが回答せずタイミー外注が確定していれば、推定では `recruitments.status` を「スタッフ確定済み」に切り替える運用、もしくは別途 `isTimee` フラグ付きスタッフを `selectedStaffIds` に入れて確定させる流れで `status` を抜く構造になっている (要確認)。

---

## 4. Firestore スキーマ

`CLAUDE.md` の設計と実際の `firestore.rules` / `index.js` / コード読みから判明した実コレクションを統合する。
※ 設計書と実コードで差異がある場合は実コード側を優先記載した。

### 主要コレクション

#### `properties/{propertyId}`
- `name: string` (例: "the Terrace 長浜")
- `propertyNumber: number` (#1〜#4 永続)
- `active: boolean`
- `type: "minpaku" | "rental" | "other"`
- `selectionMethod: "ownerConfirm" | "firstCome"`
- `cleaningRequiredCount: number` (清掃に必要なスタッフ数)
- `inspection: { enabled, requiredCount, periodStart, periodEnd, recurYearly, recurStart, recurEnd }`
- `assignedPropertyIds` 等は staff 側
- `channelOverrides: { [notifyType]: { enabled, ownerLine, groupLine, staffLine, subOwnerLine, ownerEmail, staffEmail, propertyEmail, subOwnerEmail, discordOwner, discordSubOwner, fcmStaff, fcmOwner, customMessage, timings: [{ mode, timing, beforeDays, beforeTime }] } }`
  - `notifyType` 値: `recruit_start` / `recruit_remind` / `staff_undecided` / `morning_briefing` / `alert` / `recruit_confirm` / `roster_received` / `roster_updated` / `roster_remind` / `urgent_remind` / `keybox_remind` / `keybox_send` / `timee_posting` / `invoice_submitted` / `laundry_put_out` / `laundry_collected` / `laundry_stored` 他
- `lineChannels: [{ token: <MASKED>, groupId: <MASKED>, name, enabled }]` (物件別 LINE Bot)
- `lineDeliveryMode: "single" | "rotate" | "fallback"` (旧 `lineChannelStrategy="roundrobin"` を `"rotate"` にマップ)
- `lineLastChannelIdx: number` (rotate 用)
- `senderGmail: string` (物件起点メールの from に使う Gmail アドレス、`<MASKED>`)
- `keyboxSend: { mode, scheduleType, customDaysBefore, ... }`
- 物件 ID 実値: the Terrace 長浜 = `tsZybhDMcPrxqgcRy7wp` (#4)。他 3 物件 ID は不明 (要確認)
- サンプル: 略 (個人情報含むため省略)

#### `staff/{staffId}`
- `name, email, phone, address` 等
- `active: boolean`
- `displayOrder: number`
- `assignedPropertyIds: string[]` (担当物件)
- `isOwner: boolean` (オーナーをスタッフ化)
- `isSubOwner: boolean`, `ownedPropertyIds: string[]` (サブオーナー機能 v2)
- `isTimee: boolean` ← **タイミー外注スタッフ識別フラグ**
- `lineUserId: <MASKED>` (LINE Login User ID)
- `authUid: <MASKED>` (Firebase Auth uid)
- `subOwnerLineUserId`, `subOwnerEmail`, `subOwnerDiscordWebhookUrl` (サブオーナー専用通知先)
- `staffId` (Firestore docId と同一、カスタムクレームでも保持)

#### `recruitments/{recruitmentId}`
- `propertyId: string`, `propertyName: string`
- `checkoutDate: "YYYY-MM-DD"` (string、Timestamp ではない)
- `bookingId: string | null`
- `workType: "cleaning" | "pre_inspection"` (default cleaning)
- `status: "募集中" | "選定済" | "スタッフ確定済み"`
- `selectedStaffIds: string[]` (確定 / 選定済スタッフ)
- `selectedStaff: string` (カンマ区切り名前、旧フィールド互換)
- `responses: [{ staffId, staffName, response: "◎"|"△"|"×", memo, respondedAt }]` (配列 + サブコレ `responses/{id}` の両方を持つ場合あり)
- `timeeOverrideNames: { [staffId]: string }` ← **タイミー実名 (オーナー入力)**
- `staffUndecidedSentKeys: string[]` (重複防止)
- `recruitRemindSentKeys: string[]`
- `confirmedAt: timestamp | null`
- `createdAt, updatedAt`

#### `bookings/{bookingId}`
- `propertyId, guestName, guestCount, checkIn, checkOut, source ("Airbnb"|"Booking.com"|"Direct"), status, syncedAt, cleaningShiftId, beds24BookingId`
- `status` キャンセル判定: 文字列に "cancel" を含むか、"キャンセル" / "キャンセル済み"
- `timeeNotifySentAt: timestamp` ← **`timee_posting` 通知重複防止フラグ**
- `emailVerifiedAt, emailMessageId` (OTA メール照合)
- `checkIn / checkOut` は "YYYY-MM-DD" 文字列

#### `shifts/{shiftId}`
- `date: Timestamp (UTC midnight)`, `propertyId, bookingId, staffId, staffIds[], staffName, startTime ("HH:MM"), endTime, status ("unassigned"|"assigned"|"confirmed"|"completed"|"cancelled"), assignMethod, workType, checklistId`

#### `timeeMatches/{messageId}` (Gmail messageId 一致 docId)
Cloud Functions Admin SDK のみ書き込み可 (rules: `allow write: if false;`)
- `messageId, threadId, subject, from, dateHeader, receivedAt: Timestamp, bodySnippet (2000 文字まで)`
- `eventType: "matched"|"summary"|"cancelled"|"fix_request"|"closed"|"unknown"`
- `propertyName: string` (subject から `【タイミー XXX】` の XXX を抽出)
- `propertyId: string | null` (`properties.name` と部分一致照合で解決)
- `workDate: "YYYY-MM-DD" | null`
- `workStartTime, workEndTime: "HH:MM"`
- `jobTitle, offeringId (タイミー求人 ID), capacity: { filled, total }`
- `workers: [{ name, nameKana, age, gender }]`
- `linkedRecruitmentId: string | null` (`propertyId + workDate` で `recruitments` を引いて単一なら確定、複数なら `cleaning` 優先)
- `linkedAt, createdAt`

#### `settings/*` (主要なものだけ)
- `settings/notifications`: `lineChannelToken <MASKED>`, `lineOwnerUserId <MASKED>`, `lineGroupId <MASKED>`, `enableLine`, `enableEmail`, `notifyEmails[]`, `appUrl`, `ownerLineChannels: [{token, userId, name}]`, `ownerLineChannelStrategy: "fallback"|"roundrobin"`, `discordOwnerWebhookUrl <MASKED>`
- `settings/gmailOAuth`: `{ clientId: <MASKED>, clientSecret: <MASKED> }` (税理士資料コンテキスト用)
  - サブコレクション `tokens/{*}`: `{ email, refreshToken: <MASKED>, expiry, ... }`
- `settings/gmailOAuthEmailVerification`: 同上 (メール照合コンテキスト用、Timee も同じトークンサブコレを使う)
  - 81hassac@gmail.com (※ 公開メールではないが本ドキュメントでは `<MASKED-EMAIL>` として扱う) のトークンが Timee 巡回に必要
- `settings/gmailEmailVerification`: `userEmails[]` 等の集約ドキュメント
- `settings/lineLogin`: LINE Login チャネル ID `<MASKED>` (CLAUDE.md より、コードでは値を直接持たない)
- `settings/briefingState`: `lastSentDate, lastSentAt`
- `settings/taxDocs`: `gasSecret: <MASKED>` (GAS 認証用)
- `settings/gasComparison`: 旧 GAS 版差分比較設定
- `settings/owner`: `email, name, taxAccountantEmail`

#### その他
- `checklists/{checklistId}` / `checklistTemplates/{propertyId}` / `checklistMaster/{docId}` / `propertyWorkItems/{propertyId}` (`items: [{id, name, sortOrder, commonRate, timeeHourlyRate, staffRates}]`)
- `guestRegistrations/{guestId}` (名簿)
- `invoices/{invoiceId}` (`isTimee` スタッフの行は明細 memo に「タイミー HH:MM〜HH:MM (Xh) × ¥Y/h」を付与)
- `invoiceExclusions/{yearMonth_staffId_propertyId?}`
- `notifications/{id}` (通知ログ)
- `error_logs/{id}` / `parse_errors/{messageId}` / `syncHealth/{jobName}` / `notification_locks/{lockKey}`
- `emailVerifications/{messageId}` (OTA 予約確認メール)
- `secretary/approvals/items/{approvalId}` (GO サイン待ち承認)
- `staffInvites/{token}`, `syncSettings/{settingId}`, `bookingConflicts/{id}`, `todos/{todoId}`, `tasks/{taskId}`, `projects/{projectId}`, `calendar_events/{eventId}`, `taxDocsChecklist/{yearMonth}/entities/{entityId}`, `entities/{entityId}`, `taxDocs/{docId}`, `client_errors/{id}`, `sessions/{sessionId}`, `userNotificationStatus/{uid}`, `timeeRequests/{requestId}` (※ rules 上は存在、コード内では未使用に見える — 要確認)

### firestore.rules 抜粋 (タイミー関連)

```
// タイミー募集 (旧設計の予約コレクション、未使用の可能性)
match /timeeRequests/{requestId} {
  allow read, write: if isOwner();
}

// Timee メール照合 — オーナー全件、サブオーナー所有物件のみ read
match /timeeMatches/{messageId} {
  allow read: if isOwner()
    || (isSubOwner() && resource.data.propertyId in request.auth.token.ownedPropertyIds);
  allow write: if false;  // Cloud Functions (Admin SDK) のみ
}
```

複合インデックス (Phase 1 で参考になりそうなもの):
- `shifts`: `(date asc, propertyId asc)`, `(staffId asc, date asc)`
- `bookings`: `(propertyId asc, checkIn asc)`, `(status asc, checkIn asc)`, `(source, checkIn, checkOut)`
- (recruitments 用の複合インデックスは indexes.json の冒頭範囲では確認できず — 要確認: `(propertyId, checkoutDate)` か `(status, checkoutDate)` が必要)

---

## 5. Gmail 取り込み

タイミーを含む Gmail 取り込みは Cloud Functions が `googleapis` 経由で行う。

- 関数所在:
  - `functions/scheduled/syncTimeeEmails.js` (Timee 専用、10 分おき)
  - `functions/scheduled/emailVerification.js` (OTA 予約確認、10 分おき)
  - `functions/scheduled/collectTaxDocs.js` (税理士資料、月次)
  - `functions/scheduled/watchGmail.js` (汎用、現在 **未稼働 / コメントアウト**)
- 認証方式: OAuth2 リフレッシュトークン。`googleapis` の `google.auth.OAuth2(clientId, clientSecret)` に `setCredentials({ refresh_token })`
- 認証情報保管 (すべて Firestore):
  - クライアント認証情報: `settings/gmailOAuth.{clientId,clientSecret}` (税理士資料用) と `settings/gmailOAuthEmailVerification.{clientId,clientSecret}` (メール照合 + 物件 + Timee 用、ただし `clientId/clientSecret` は実際には片方しか参照されない実装)
    - **実装上の事実**: `syncTimeeEmails.js` は `settings/gmailOAuth` の `clientId/clientSecret` を読む (税理士資料側のクライアント認証情報を再利用)
  - リフレッシュトークン: `settings/gmailOAuth/tokens/{*}` または `settings/gmailOAuthEmailVerification/tokens/{*}` のサブコレクションに `{ email, refreshToken: <MASKED>, ... }` 形式で 1 トークン 1 ドキュメント
- 環境変数: Gmail 関連で `process.env.*` を読んでいるのは `FUNCTIONS_EMULATOR` 程度。**API キーは全部 Firestore 経由**。
- 検索クエリ (Timee):
  ```js
  const TARGET_EMAIL = "<MASKED-EMAIL>";  // 81hassac 系 Gmail
  const SCAN_NEWER_THAN = "90d";
  const q = `from:supporter@timee.co.jp newer_than:${SCAN_NEWER_THAN}`;
  // maxResults 100/page, 1 巡回あたり処理上限 50 件
  ```
- 検索クエリ (OTA メール照合):
  ```js
  // emailVerification.js
  const PROCESSED_LABEL_NAME = "minpaku-v2-email-verified";
  const KNOWN_OTA_SENDERS = [
    "automated@airbnb.com","no-reply@airbnb.jp","no-reply@airbnb.com",
    "noreply@airbnb.com","express@airbnb.com",
    "customer.service@booking.com","customer.service@mail.booking.com",
    "noreply@booking.com",
  ];
  // (to:<verificationEmails の OR>) (from:<OTA senders の OR>) -label:<PROCESSED_LABEL>
  ```
- OTA 別パーサ: `functions/utils/emailParser/`
  - `airbnb.js` / `booking.js` / `index.js` (`parseEmail()` ファサード) / `emailParser.test.js`
  - `__constants__/parserVersion.js`
  - Timee は `functions/utils/timeeParser.js` 単独。`parseTimeeEmail({subject, body})` で `eventType / propertyName / workDate / workStartTime / workEndTime / jobTitle / workers / offeringId / capacity` を抽出
- 書き込み先: `timeeMatches/{Gmail-messageId}` / `emailVerifications/{Gmail-messageId}` / `taxDocs/{...}` / `parse_errors/{messageId}`
- idempotency キー: **Gmail message ID をそのまま Firestore docId に使う**。`syncTimeeEmails.js` は処理前に `db.collection("timeeMatches").doc(ref.id).get()` で existence チェックしてスキップ。

---

## 6. LINE 通知

- 関数所在: `functions/utils/lineNotify.js` (約 1450 行の本体)、各通知元 (`scheduled/*.js`、`triggers/*.js`、`api/recruitment.js` 等) から呼び出す
- 主要 export:
  - `sendLineMessage(token, userId, text)` - Push API 1 通
  - `sendLineMessageForProperty(db, propertyId, text, logExtra)` - 物件別 LINE Bot に送信、`lineDeliveryMode: "single"|"rotate"|"fallback"` 戦略
  - `notifyByKey(db, notifyKey, { title, body, vars, propertyId, staffIds, extraEmailFooter })` ← **統合送信のエントリ**
  - `notifyOwner / notifyStaff / notifyGroup / notifySubOwners`
  - `sendApprovalRequest` (GO サイン Flex)
  - `buildRecruitmentFlex`
  - `verifySignature(channelSecret, sig, body)` (Webhook 署名検証)
  - `sendNotificationEmail_` (Gmail OAuth で送信)
  - `sendDiscord_` (Discord Webhook 送信)
- 送信先環境変数: なし。**全部 Firestore (`settings/notifications` + `properties/{id}.{lineChannels, channelOverrides}`)**
- 形式: テキストは 5000 文字まで、Flex メッセージは bubble 1 つ
- LINE 内蔵ブラウザ回避: `appendOpenExternalBrowser(text)` で `https://minpaku-v2.web.app/...` URL に `?openExternalBrowser=1` を自動付与 (`feedback_open_external_browser`)
- 朝のブリーフィング整形コード抜粋 (`morningBriefing.js` の中核 30 行):

```js
let text = "━━━ 朝のブリーフィング ━━━\n\n";
text += "■ 民泊（今日）\n";
text += checkouts.length > 0
  ? `- CO: ${checkouts.length}件\n` + checkouts.map(co => `  ${co.guestName || "名前不明"} (${co.guestCount || "?"}名)\n`).join("")
  : "- CO: なし\n";
text += checkins.length > 0
  ? `- CI: ${checkins.length}件\n` + checkins.map(ci => `  ${ci.guestName || "名前不明"} (${ci.guestCount || "?"}名)\n`).join("")
  : "- CI: なし\n";
if (unconfirmed.length > 0 || pendingConfirm.length > 0) {
  text += "\n■ アラート\n";
  for (const r of unconfirmed) {
    const daysUntil = daysDiff(today, r.checkoutDate);
    const icon = daysUntil <= 1 ? "🔴" : "🟡";
    text += `${icon} ${r.checkoutDate} 清掃スタッフ未確定`;
    if (r.propertyName) text += `（${r.propertyName}）`;
    const responseCount = (r.responses || []).filter(x => x.response === "◎" || x.response === "△").length;
    text += ` 回答${responseCount}件\n`;
  }
  for (const r of pendingConfirm) {
    text += `🟡 ${r.checkoutDate} 選定済み・未確定（${r.selectedStaff || "?"}）\n`;
  }
}
// 経理 / TODO / 承認待ち / エラー / 税理士資料 / 今月実績を続けて連結
```

- 絵文字慣習: 🔴 (緊急/当日)、🟡 (注意/翌日以降)、🟢 / ✅ (完了)、🏢 (法人)、👤 (個人)、📋 / 📝 (TODO)、🤵 (黒子)、🕐 (タイミー募集依頼)、🧹 (清掃)、🔑 (キーボックス)、◎ / △ / × (旧スタッフ回答)、◎ / △ / × → ◎/△/× は font 28px 表示

---

## 7. シークレット・環境変数

ソース・GitHub Actions・Firestore 経由のシークレットを統合してリスト化する。値はすべて `<MASKED>` 扱い。

### コード内で参照される環境変数 (`process.env.*`)

| 変数名 | 用途 | 設定箇所 |
|---|---|---|
| `FUNCTIONS_EMULATOR` | "true" のときエミュ動作 (LINE/メール/Discord 送信スタブ) | 自動 |
| `ALLOW_TEST_TOKEN` | "true" のとき `Bearer test-token` を owner として受理 | functions runtime |
| `APP_BASE_URL` | フォールバックの app URL | 任意 |

→ ハードコードされた `https://minpaku-v2.web.app` がほとんどの fallback として埋まっている。

### Firestore に格納される秘密値 (すべて `<MASKED>`)

- `settings/notifications`
  - `lineChannelToken` / `lineOwnerUserId` / `lineGroupId`
  - `ownerLineChannels[].token`, `ownerLineChannels[].userId`
  - `discordOwnerWebhookUrl`, `discordWebhookUrl`
- `settings/gmailOAuth`: `clientId`, `clientSecret`
- `settings/gmailOAuthEmailVerification`: `clientId`, `clientSecret`
- `settings/gmailOAuth/tokens/*` および `settings/gmailOAuthEmailVerification/tokens/*`: `email`, `refreshToken`
- `settings/taxDocs.gasSecret` (GAS → v2 認証用)
- `properties/{id}.lineChannels[].token`, `properties/{id}.lineChannels[].groupId`
- `properties/{id}.senderGmail` (実名 Gmail アドレス)
- `staff/{id}.lineUserId`, `staff/{id}.subOwnerLineUserId`, `staff/{id}.subOwnerEmail`, `staff/{id}.subOwnerDiscordWebhookUrl`, `staff/{id}.authUid`
- `syncSettings/{id}` (iCal URL: Airbnb/Booking.com → 秘密扱い)
- LINE Webhook 署名検証用 channel secret: コード上 `verifySignature(channelSecret, ...)` が定義済だが、どの doc から読むかは要確認 (`不明 — 要確認`)

### GitHub Secrets (Actions)

- `FIREBASE_SERVICE_ACCOUNT` (deploy.yml で `FirebaseExtended/action-hosting-deploy@v0` に渡す)
- `GITHUB_TOKEN` (自動付与)

### ローカル差し替え

- `.env` は `.gitignore` で除外、ただし **`.env.example` は存在せず**。シークレットは Firestore 経由で運用されており、`.env` を使う必要があるのは `firebase emulators` 実行時のごく一部 (`FUNCTIONS_EMULATOR=true` 等)。
- エミュレータ seed は `functions/emulator/seed.js`。

---

## 8. デプロイ・運用

- 自動デプロイ: GitHub Actions `.github/workflows/deploy.yml` が `main` への push (paths: `public/**` または `firebase.json`) で発火。`workflow_dispatch` で手動実行可。
- 内容:
  ```yaml
  - Auto cache-bust: VER="$(date -u +%Y%m%d)-${GITHUB_SHA::7}" を public/version.json と index.html(#appVersionMobile) と全 HTML の `?v=` クエリに反映
  - FirebaseExtended/action-hosting-deploy@v0 で channelId=live、projectId=minpaku-v2
  ```
- **Cloud Functions は GitHub Actions では自動デプロイされない**。`functions/package.json` の `deploy` スクリプトに `firebase deploy --only functions` がある (手動運用)。
- E2E ワークフロー `.github/workflows/e2e.yml` が存在 (内容未確認、要確認)。
- ブランチ戦略: `main` 単一トランク、feature/* で作業 (例: `feature/email-verification`)。MEMORY によると minpaku-v2 のメイン作業ディレクトリは AI_Workspace 配下にクローン。

---

## 9. テスト・ローカル開発

- 単体テスト: `node --test`
  - `functions/package.json` の `test` スクリプト: `node --test api/*.test.js scheduled/*.test.js triggers/*.test.js utils/*.test.js utils/emailParser/*.test.js`
  - 実存テスト: `api/gmail-auth.test.js`, `scheduled/emailVerification.test.js`, `triggers/onGuestRegistrationCreate.test.js`, `utils/emailMatcher.test.js`, `utils/emailParser/emailParser.test.js`
  - **Timee 関連のユニットテストは未確認** (`utils/timeeParser.test.js` は存在しない)
- E2E: `tests/` 配下に Playwright (`playwright.config.ts`, `e2e/owner-flow.spec.ts` 他)。`tests/package.json` で `playwright test` 実行
- Emulator: firebase.json に auth(9099)/functions(5001)/firestore(8080)/hosting(5000)/storage(9199)/ui(4000) を定義
  - `npm --prefix functions run emu:start` で `--import=../.emulator-data --export-on-exit`
  - seed: `functions/emulator/seed.js` (`isTimee: true/false` のサンプルスタッフを seed する)
- Playwright report dir: `tests/playwright-report/`, `tests/test-results/` (.gitignored)

---

## 10. コーディング規約

- ESLint / Prettier 設定: ルート / functions 内に config 見当たらず (`不明 — 要確認`)
- 命名: JS = camelCase / Firestore docId は基本英数 (例: `tsZybhDMcPrxqgcRy7wp`)、コレクション名は複数形小文字、コード内コメントは **日本語**
- ファイル命名: kebab-case (`my-checklist.js`、`my-recruitment.js`)、ただし関数モジュールは camelCase (`onBookingChange.js`)
- CommonJS のみ、Top-level `await` なし

### TODO / FIXME / HACK grep 結果 (max 20)

```
functions/api/line-webhook.js:217  // 特定のキーワードでTODO追加やステータス確認を実行
functions/api/line-webhook.js:232  text.startsWith("タスク:") || text.startsWith("タスク：") || text.startsWith("TODO:")
functions/api/line-webhook.js:250  // LINEからのTODO追加
functions/api/line-webhook.js:254  text.replace(/^(タスク[:：]|TODO:)\s*/, "")
functions/api/line-webhook.js:265  notifyOwner(db, "todo_added", "TODO追加", `📝 TODO追加: ${content}`)
functions/scheduled/morningBriefing.js:6  // - TODO: 未完了タスク
functions/scheduled/morningBriefing.js:50  // TODO
functions/scheduled/morningBriefing.js:119  // ■ TODO
functions/scheduled/morningBriefing.js:121  text += `\n■ TODO（未完了: ${todosSnap.size}件）\n`;
functions/scheduled/watchGmail.js:3  // 未読メールをチェックし、内容を分類してTODO/予定を自動抽出
functions/scheduled/watchGmail.js:132  if (todosAdded > 0) text += `- TODO追加: ${todosAdded}件\n`;
functions/scheduled/watchGmail.js:172  // TODO・依頼系
```

→ いずれも「ユーザータスク管理機能」「黒子の watchGmail」関連であり、**コード品質上の TODO/FIXME/HACK は本リポジトリ内ではほぼ皆無**。負債は migration/ 配下のスクリプト散乱で吸収されている形。

---

## 11. タイミー関連の既存資産 (重要)

### 11-1. 既存ヒット箇所 (実コード)

| ファイル | 機能 |
|---|---|
| `functions/scheduled/syncTimeeEmails.js` | **supporter@timee.co.jp からの受信メールを 10 分おきに巡回し `timeeMatches/{messageId}` に保存。`recruitments` と紐付け** |
| `functions/utils/timeeParser.js` | Timee メールの件名/本文パーサ (matched / cancelled / summary / fix_request / closed / unknown を分類) |
| `functions/api/timee.js` | REST: `GET /api/timee/by-recruitment/:recruitmentId` と `POST /api/timee/run` (オーナーのみ手動巡回) |
| `functions/migration/run-timee-backfill.js` | 巡回を 1 回手動実行する CLI |
| `functions/migration/inspect-timee-mails.js`, `inspect-timee-mails2.js`, `check-timee-qr.js` | 調査用ワンショット |
| `functions/triggers/onBookingChange.js` (l.816-855) | 新規予約検知時に `timee_posting` 通知を物件オーナーへ送出 (重複防止: `bookings.timeeNotifySentAt`) |
| `functions/api/invoices.js` | `staff.isTimee && timeeDetail` の請求書明細生成 ("タイミー HH:MM〜HH:MM (Xh) × ¥Y/h") |
| `functions/scheduled/generateInvoices.js` | `if (staff.isTimee) continue;` でタイミースタッフは月次自動生成対象外 |
| `functions/scheduled/alertUnconfirmed.js` (l.53) | 回答ゼロ時に「タイミーなどの外部手配を検討してください」と本文に追記 |
| `functions/emulator/seed.js` | `isTimee: true/false` のスタッフを seed |
| `public/js/pages/recruitment.js` | タイミー実名入力 UI (`timeeOverrideNames[staffId]`) + 受信タイミーメール照合履歴の折りたたみ表示 + 求人ページリンク (`https://app-new.taimee.co.jp/clients/508795/offerings/{offeringId}`) |
| `public/js/pages/staff.js` | スタッフ管理モーダルに `isTimee` チェックボックス + 一覧 "T" バッジ |
| `public/js/pages/reservation-flow.js` (l.436-452) | `timee_posting` カードの通知設定 UI、「タイミーを開く」外部リンク `https://app-new.taimee.co.jp/account` |
| `public/js/shared/notify-channel-editor.js` (l.192-195) | `timee_posting` 通知テンプレートの default 文言 ("🕐 タイミー募集依頼\n\nタイミー募集が必要な予約が入りました。...") |
| `public/js/pages/my-checklist.js` (l.819-1067) | 物件別「タイミー用 QR (CI/CO)」画像を `properties/{id}.timeeQrImageUrl` に Cloud Storage `timee-qr/{pid}.{ext}` 経由でアップ/差替/削除 |
| `public/js/pages/rates.js` | `propertyWorkItems/{pid}.items[].timeeHourlyRate` の編集 UI (タイミー時給) |
| `public/js/pages/my-invoice-create.js` | 請求書計算で「階段制単価・workType別・タイミー時給・特別加算」を考慮 |
| `tests/e2e/owner-flow.spec.ts` | スタッフ seed の `isTimee: false` を確認 |
| `firestore.rules` | `timeeMatches` / `timeeRequests` のアクセス制御 |

### 11-2. 「未確定」判定のソース (Phase 1 で重要)

**現状は `recruitments.status === "募集中"` だけで判定しており、Timee 側の状態 (求人があるか / マッチ済か / キャンセルか) は判定に影響していない。**

ただし Timee 受信メールから `timeeMatches` を作成し、これを `recruitments` と `propertyId + workDate` で紐付ける機構 (`linkedRecruitmentId`) はすでに動いている。Phase 1 では `timeeMatches.eventType==="matched"` を見れば「タイミーで人が決まっている」と判定可能。

### 11-3. 既存の自動投稿スクリプト・API クライアント

- **タイミーへの「投稿」を自動化するコードは存在しない**。Phase 1 に向けた API クライアント・Playwright/Puppeteer 試作は確認できず (search hit ゼロ)。
- 既存は (a) Gmail からの **受信メール解析** (b) 「タイミーを開く」**外部リンク誘導** (c) 物件オーナーへの通知文 (`timee_posting`) どまり。
- 該当する `taimee.co.jp` / `app-new.taimee.co.jp` のリンク先:
  - `https://app-new.taimee.co.jp/account` (アカウント TOP)
  - `https://app-new.taimee.co.jp/clients/508795/offerings/{offeringId}` (求人ページ、508795 はクライアント ID で公開情報相当だがコード上は数値リテラル)

### 11-4. Timee メール構造 (timeeParser から判明)

- 受信元: `supporter@timee.co.jp`
- 件名パターン:
  - `【タイミー (XXX)】...がマッチングしました` → matched
  - `【タイミー XXX】...マッチング状況` → summary
  - `【タイミー XXX】...キャンセル` → cancelled
  - `【タイミー XXX】...修正依頼` → fix_request
  - `【タイミー XXX】...募集が終了|応募締切` → closed
- 本文の日時パターン: `YYYY年MM月DD日(曜)HH:MM 〜 (YYYY年MM月DD日)HH:MM`
- 求人 ID 抽出: 本文中の `offerings/(\d+)`
- 募集人数: `N人 / M人`
- ワーカー抽出: `◆名前 / ◆年齢 / ◆性別` (単数) または `・氏名 (カナ) さん / N歳 / 性別` (複数 summary)

---

## 12. 新規実装の妥協ポイント・既存制約

### 直近 20 コミットサマリ (`git log -20 --oneline`)

```
d9b31e8 fix(dashboard): キーボックス送信予約ボタンの誤エラー表示を修正
2ef01d4 feat(cache): A) GitHub Actions 自動 cache-bust + D) トップバーに更新ボタン
cf22e51 fix(cache): JS/CSS を no-cache に変更 + 新版検知時の強制リロードモーダル
548fc08 feat(modal): 宿泊者情報詳細を予約詳細モーダルに統合
5a25167 feat(guest-detail): 宿泊者情報詳細モーダルに物件・予約元・修正履歴を追加
582dc4a feat(timee): タイミーメール照合機能を追加         ← Timee 連携の本流
1b82fba fix(contacts): 連絡先マスタの読込を権限不足に対して耐性化
41ca1f8 fix(notifications): テスト送信エンドポイントも物件別 Bot を使うように修正
7d489dd fix(line-notify): サブオーナー通知を物件別 Bot から送るように修正
943c506 fix(ical-panel): サブオーナーでも iCal 同期パネルが動くように修正
78a71b2 fix(i18n): 5言語ボタンとヘッダータイトルの重なりを修正
2a8032c feat(i18n): 繁體中文 (台湾華語) を追加
3f073bb feat(i18n): ゲスト案内 + 宿泊者名簿 に韓国語・中国語を追加
2918f53 fix(keybox): customDaysBefore=0 が 3 に化ける || フォールバックを修正
af5193c fix(my-checklist): スマホ戻るボタンでアプリ終了する問題を修正
8efbef4 fix: 清掃日手動移動後に旧日付の募集が復活する問題を修正
558114a fix: 物件起点メールを property.senderGmail から送るよう全面修正
363e5e2 fix: guestRegistrations の status+checkIn 複合 index を追加
ce84cf9 refactor: GAS版スタッフ回答データ取込を 新旧cal比較タブに移動
a683196 fix: 既確定 recruitment でも responses 配列を補完する
```

### 制約・触ってはいけない領域

1. **`onBookingChange.js` の予約キャンセル時連動削除ロジック**: shifts / recruitments / checklists のカスケード削除と同日他予約チェックがあり、副作用の連鎖が大きい (`cancelCleaningForDate_`)
2. **`syncIcal.js` の `extractGuestName`**: "Airbnb (Not available)" を弾く正規表現修正は ロールバック禁止 (MEMORY「ロールバック禁止 commit」)
3. **物件起点メールは `property.senderGmail` を fromEmail に渡す**: `558114a` 修正済、後退禁止
4. **物件別 Bot 経由でサブオーナー / Webアプリ管理者通知**: `7d489dd` / `41ca1f8` で「物件別 Bot を優先試行し失敗ならグローバル」のフォールバック実装済、変えないこと
5. **`recruitments.responses` は配列 + サブコレ `responses/{id}` の両形式が並存**: `a683196` で配列補完を入れている (GAS インポート互換)
6. **キャッシュ戦略**: `cf22e51` で JS/CSS が `no-cache, must-revalidate` に変更済。古いビルドの強制リロードモーダルあり
7. **`firestore.rules` のサブオーナー権限**: `staff` ドキュメントの `isSubOwner/ownedPropertyIds/role/authUid` 等は **権限昇格防止のためサブオーナー自身からは更新不可**
8. **タイミー外注スタッフ (`isTimee=true`) は月次請求書自動生成から除外**: `generateInvoices.js` で `if (staff.isTimee) continue;`。Phase 1 で「タイミー稼働分も自動生成」したいなら別建てが必要
9. **`timeeMatches` への書込は Cloud Functions Admin SDK のみ** (rules で `allow write: if false;`)
10. **`syncTimeeEmails` の clientId/clientSecret は `settings/gmailOAuth` を流用** している (税理士資料コンテキスト)。`gmailOAuthEmailVerification` 側ではない点に注意

### 既存負債

- `functions/migration/` 配下に 180+ ファイルのワンショット調査スクリプトが堆積。整理されていない
- `functions/index.js` 末尾に `syncBeds24` / `autoAssignShifts` / `watchGmail` がコメントアウトのまま残置 (Beds24 未導入)
- `recruitments.responses` の配列 vs サブコレ二重持ち
- `lineDeliveryMode` と旧 `lineChannelStrategy` (`"roundrobin"`) の値マッピングが一部コードにのみ存在 (新規には統一推奨)
- `.env.example` 不存在、設定値はすべて Firestore 経由 — Phase 1 で OAuth スコープを増やす場合、設定セットアップ手順を `docs/` に追記する必要あり

---

## 13. 質問リスト (Phase 1 計画に必要な仕様判断、10 項目)

1. **「自動投稿」のゴール定義**: タイミー求人を (a) 完全に Web スクレイピング/API で投稿、(b) 投稿フォームを開いた状態で Pre-fill (URL クエリ / クリップボード)、(c) 文面を生成してオーナーが手動コピペ、のどれを Phase 1 のターゲットとするか? (現状 (c) のみ実装済 = `timee_posting` 通知文)
2. **タイミー側の公式 API / クライアント認証**: タイミーには公式の事業者向け API 提供があるか? 無ければ Playwright で headed/headless 自動操作する前提か?
3. **未確定判定の精緻化**: 現在は `recruitments.status==="募集中"` のみで判定。`timeeMatches.linkedRecruitmentId` を見て「タイミーで matched/closed なら未確定アラート抑制」とすべきか?
4. **求人投稿のトリガー条件**: (a) `onBookingChange` で予約確定即時 (b) スタッフ回答が 0 件で清掃日 N 日前 (`recruit_remind` 系のタイミング再利用) (c) オーナーが手動 GO サイン後 ── どれを採用?
5. **オーナー承認 (GO サイン) の要否**: 既存の `secretary/approvals/items` + Flex メッセージ機構 (`sendApprovalRequest`) を再利用して、自動投稿前に必ず承認ステップを挟むか?
6. **募集文面テンプレート**: 物件別 (`properties/{id}.timeeTemplate` 等の新フィールド) か、共通 (`settings/timee.template`) か、`channelOverrides.timee_posting.customMessage` 流用か?
7. **時給・募集人数の決定ロジック**: `propertyWorkItems/{pid}.items[].timeeHourlyRate` + `properties.cleaningRequiredCount` から自動算出してよいか? 募集人数は予約人数によって変えるか?
8. **タイミー認証情報の保管場所**: ログイン credential / cookie / session を Firestore に置く場合、`settings/timeeAuth.{cookie/refreshToken/...}` 等の構造は? (既存の Gmail OAuth と同じく Admin SDK only read?)
9. **重複投稿防止**: `bookings.timeeNotifySentAt` 相当の `bookings.timeePostedAt` を新設するか、あるいは `recruitments.{timeeOfferingId, timeePostedAt}` で管理するか?
10. **失敗時のフォールバック / 通知**: 自動投稿失敗時は (a) リトライ (b) オーナーに `notifyByKey("timee_posting", ...)` で従来通り通知 (c) `error_logs` に記録 + LINE — どれを採用するか? また Cloud Functions タイムアウト (60s default) を超える可能性がある場合は Pub/Sub 経由の別関数化が必要か?

---

## 付録 A: ファイル別行数の目安

- `functions/utils/lineNotify.js`: 1454 行
- `functions/triggers/onBookingChange.js`: 900+ 行 (一部のみ読了)
- `functions/scheduled/syncTimeeEmails.js`: 181 行
- `functions/utils/timeeParser.js`: 144 行
- `functions/api/timee.js`: 72 行
- `functions/api/recruitment.js`: 1000 行超 (全文未読)
- `functions/index.js`: 450 行
- `firestore.rules`: 366 行

## 付録 B: 不明 / 要確認 サマリ

- firebase-tools のバージョン
- ESLint / Prettier 設定の有無
- `.env.example` を Phase 1 で作成すべきか
- `.github/workflows/e2e.yml` の中身
- LINE Webhook の channel secret 保管場所 (`settings/lineLogin.channelSecret` か別か)
- `timeeRequests` コレクションの現在の使用状況 (rules には存在、コード内では未使用)
- 4 物件の Firestore docId (the Terrace 長浜 = `tsZybhDMcPrxqgcRy7wp` のみ確認済)
- タイミー求人 API の公式提供有無
- `recruitments` の `propertyId + checkoutDate + status` 複合インデックス定義の有無 (indexes.json 全体未確認)
