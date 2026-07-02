# Firestore DB スキーマ（2026-04 初版設計）

> 旧 CLAUDE.md（2026-07-02 ダイエット）から無損失で移設した当初の DB 設計。
> 注意: 実データはその後拡張されている（例: workType 実値2系統、checkoutDate/date の文字列/Timestamp 混在、billingProfiles、channelOverrides 等）。
> 実フィールドはコードと memory（project_minpaku_v2_worktype_normalize / project_minpaku_v2_date_type_mismatch 等）で裏取りすること。

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
