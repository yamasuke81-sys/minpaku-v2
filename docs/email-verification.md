# メール照合機能 運用ガイド

Gmail に届く OTA (Airbnb / Booking.com) の予約通知メールを巡回し、iCal 同期で
作成された `bookings/` ドキュメントと突合して、ゲスト名・人数・キャンセル状態を
自動的に反映する機能。

## 背景

iCal フィードだけでは得られない情報をメールから補完する:

- Booking.com iCal は実予約でも `CLOSED - Not available` しか返さない (プライバシー保護)
- Airbnb iCal も `Reserved` + URL 程度でゲスト名は取れない
- メールなら予約番号・ゲスト名・人数・料金・キャンセル状態まで取得可能

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────┐
│                    Gmail (81hassac@gmail.com)                    │
│   Airbnb automated@airbnb.com / Booking.com noreply@booking.com  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ Gmail API v1 (OAuth 2.0)
                           │ context=emailVerification で分離保存
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Cloud Functions (asia-northeast1)                               │
│                                                                  │
│  scheduledEmailVerification  — 10 分おき                         │
│  onBookingEmailCheck         — bookings 新規作成即時             │
│  POST /api/email-verification/run — 手動巡回                     │
│                          │                                       │
│                          ▼                                       │
│  emailVerificationCore (functions/scheduled/emailVerification.js)│
│    1. properties.verificationEmails[] を収集                     │
│    2. Gmail API で未処理メール検索 (label exclude)               │
│    3. parseEmail() で構造化データ抽出                            │
│    4. findBookingMatch() で bookings 突合                        │
│    5. decideBookingUpdate() で保守的に bookings 更新             │
│    6. emailVerifications/{messageId} に結果保存                  │
│    7. Gmail に処理済みラベル付与                                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Firestore                                                       │
│                                                                  │
│  bookings/{id}                                                   │
│    .emailVerifiedAt    ← 照合成功時刻                            │
│    .emailMessageId     ← Gmail message.id (UI が深層リンク生成)  │
│    .status=cancelled   ← cancelled メール + manualOverride!=true │
│    .guestName          ← generic な iCal 値のみ上書き            │
│                                                                  │
│  emailVerifications/{messageId} (新規)                           │
│    .extractedInfo      ← パース結果                              │
│    .matchStatus        ← matched/unmatched/cancelled/...         │
│    .matchedBookingId   ← 突合先 bookings ID                      │
│    .rawBodyText/Html   ← 生メール (50KB/100KB 上限)              │
│                                                                  │
│  settings/gmailOAuthEmailVerification/tokens/{email_normalized}  │
│    ← refresh_token (税理士資料フローとは別保存)                  │
└─────────────────────────────────────────────────────────────────┘
```

## 初期セットアップ (初回デプロイ後に 1 度だけ)

### 1. Gmail OAuth 連携

事業用 Gmail (例: `81hassac@gmail.com`) でログインした状態で、ブラウザから:

```
https://api-5qrfx7ujcq-an.a.run.app/gmail-auth/start?email=81hassac@gmail.com&context=emailVerification
```

同意画面で `gmail.readonly` と `gmail.send` を許可。完了後に
`settings/gmailOAuthEmailVerification/tokens/81hassac_gmail_com` に
refresh_token が保存される。

> 複数アカウントを連携したい場合は、別アカウントにログイン状態を切り替えてから
> 同じ URL に再アクセス。

### 2. 物件に検証用メアドを登録

物件詳細モーダル → 「検証用メールアドレス β」セクションで、OTA に登録している
宛先メアドを追加:

- 例: Airbnb 用に `81hassac+airbnb@gmail.com`
- 例: Booking.com 用に `81hassac+booking@gmail.com`
- 普通のアドレス `81hassac@gmail.com` でも可 (plus addressing なしでもマッチする)

### 3. 初回動作確認

1. `#/email-verification` を開く
2. 「今すぐ巡回」ボタンをクリック
3. 処理結果に `newlySaved` > 0 が出れば成功
4. 一覧に最近のメールが表示されるか確認

## 運用フロー

### 通常時 (自動)

1. OTA から予約メール到着
2. 10 分以内に定期 scheduled が巡回、または bookings 作成時のトリガーで即時巡回
3. 突合成功なら bookings に emailVerifiedAt / emailMessageId が自動書込
4. 旧セッション実装済の「募集詳細モーダル 情報履歴」に Gmail リンクが自動表示

### unmatched 発生時 (手動介入)

`#/email-verification` ページの「未突合」フィルタで対象を確認:

1. 件名/確認コードが合ってそうな場合 → 「紐付け」ボタン → 候補予約から選択
2. 明らかに無関係 (迷惑メール等) → 「無視」ボタン

### cancelled-unmatched 発生時

キャンセルメールは届いたが対応 bookings が見つからない場合:

1. 「キャンセル」ボタン → 候補予約から該当を選択
2. 確定後、該当 bookings.status が cancelled に更新
3. manualOverride=true 予約は保護 (409 エラーで拒否)

## データモデル

### properties.verificationEmails[] (既存 UI スケルトン)

```
{ platform: "Airbnb" | "Booking.com" | "その他", email: string, createdAt: Timestamp }
```

### emailVerifications/{messageId} (新規)

```
{
  messageId:    string,                    // Gmail message.id (= doc ID)
  threadId:     string | null,
  gmailAccount: string,                    // どのアカウントで取得したか
  propertyId:   string | null,             // 検証メアド宛先から推定
  platform:     "Airbnb" | "Booking.com" | "Unknown",
  subject:      string,
  fromHeader:   string,
  toHeader:     string,
  dateHeader:   string,
  receivedAt:   Timestamp,
  rawBodyText:  string (max 50KB),
  rawBodyHtml:  string (max 100KB),

  extractedInfo: {
    platform, kind,                        // kind: confirmed | cancelled | change-approved | change-request | request | unknown
    reservationCode,                        // HM... (Airbnb) or 10桁数字 (Booking.com)
    guestName, guestFirstName,
    checkIn:  { date: "YYYY-MM-DD", time: "HH:MM" | null } | null,
    checkOut: { date: "YYYY-MM-DD", time: "HH:MM" | null } | null,
    guestCount: { adults, children, infants, total } | null,
    totalAmount: number | null,
    listingId: string | null,              // Airbnb のみ
    propertyName: string | null,           // Booking.com のみ
    hotelId: string | null,                // Booking.com のみ
  } | null,

  matchStatus:       "matched" | "unmatched" | "cancelled" | "cancelled-unmatched"
                     | "changed" | "ignored" | "pending",
  matchedBookingId:  string | null,
  bookingUpdates:    string[] | null,      // 書き込んだフィールド名 (デバッグ用)

  matchedBy:         "auto" | "manual" | undefined,
  matchedAt:         Timestamp,

  triggeredBy: { kind: "schedule" | "booking", bookingId?: string },
  createdAt:   Timestamp,
}
```

### bookings 追加フィールド (Step 4 で書込)

```
emailVerifiedAt: Timestamp
emailMessageId:  string
emailMatchedBy:  "auto" | "manual" | undefined
```

→ 旧セッション (main commit f534e46) 実装済の UI で Gmail 深層リンクを自動生成:
`https://mail.google.com/mail/u/0/#all/{encodeURIComponent(emailMessageId)}`

## Gmail ラベル

`minpaku-v2-email-verified` を自動作成し、処理済みメールに付与。再巡回時の除外条件として
`-label:minpaku-v2-email-verified` を検索クエリに含めるため、**ユーザーが手動でこのラベルを
外すと再処理対象になる**。

## セキュリティ

- OAuth クライアントは Google Cloud Console の既存 minpaku-v2 プロジェクトのものを流用
- refresh_token は `settings/gmailOAuthEmailVerification/tokens/*` に保存 (オーナーのみ read/write)
- `emailVerifications/*` もオーナーのみ (firestore.rules に明示)
- スタッフ・サブオーナーはアクセス不可

## トラブルシューティング

### 巡回対象メアド 0 件と表示される

→ どの物件にも verificationEmails[] が登録されていない。物件詳細モーダルから追加。

### 認証済 Gmail なし と表示される

→ `/gmail-auth/start?context=emailVerification` での初期セットアップが未実施。

### unmatched が増えていく

→ iCal 同期のタイミングラグや propertyId 判定ミスの可能性。`extractedInfo` を確認し、
候補予約の CI 日付が ±3 日範囲に入るか確認。範囲を広げたい場合は
`functions/api/email-verification.js:GET /candidates` の 3 日を調整。

### manualOverride=true なのにキャンセルしたい

→ まず bookings を手動で manualOverride=false に戻してから、照合ページの
「キャンセル」ボタンを押す (または bookings を手動で status=cancelled に)。
