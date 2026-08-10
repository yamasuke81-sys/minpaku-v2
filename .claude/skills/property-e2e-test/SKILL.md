---
name: property-e2e-test
description: 新物件の開業前E2Eテスト。テスト予約→清掃募集→タイミー投稿→スタッフ確定→チェックリスト→請求書→後始末までを実走し、自動化の配線漏れを洗い出す。「宇品のE2Eテストして」「若草の一連の流れをテストして」等、物件名を添えて使う。
---

# 物件E2Eテスト（予約→清掃→請求書の一連実走）

新物件の開業時に、`.claude/rules/new-property-checklist.md`（配線チェックリストSSOT）の**実走版**として使う。
初回実走: 2026-08-10 宇品（全工程成功）。手順・落とし穴はその実測に基づく。

## 前提知識（コードマップの要点）

- 予約作成 → `onBookingChange` が **決定的ID `auto_{bookingId}_cleaning_{checkOut}`** で shift（unassigned・startTime=`cleaningStartTime`）と recruitment（募集中）を自動生成 → `onShiftCreated` が `checklistTemplates/{pid}_cleaning` のスナップショットで checklist を生成（`properties.checklistTemplateId` はデッドフィールド）
- スタッフ回答は **recruitments ドキュメント内の `responses` 配列**（サブコレクションではない。API `/respond` はサブコレ書きでトリガーが見ないので使わない）
- 確定は `PUT /api/recruitment/{id}/confirm`（事前に `selectedStaffIds` を入れておく。空だと400）→ shift が assigned に
- 報酬単価は確定時でなく**請求書計算時**に `propertyWorkItems/{pid}`（月次history）から解決。0円行は明細に出ないので **propertyWorkItems 未設定だと請求書が空になる**
- 請求書は `POST /invoices/my-submit`（owner は `asStaffId` で代理可）。必須=staff本体+`private/details` の口座情報。docId=`INV-{YYYYMM}-{staffId6}-{propertyId6}`
- 通知ゲート: 通知系=`channelOverrides[key].enabled`／メール系=トップレベル `formCompleteMail.enabled` 等。`recruit_start` は通常 `batch_morning_8`（即時には飛ばない→キュー掃除を忘れない）
- タイミー: `properties.timeeAutofill`（baseUrl=`.../clients/{clientId}/offers/{offerId}/offerings/new`）→ `POST /api/dispatch/timee {recruitmentId, visibility}` → dispatchQueue → **PM2 dispatch-listener** が debug Chrome(CDP:9222) で2段階公開。visibility は `group_limited` | `new_worker_for_client_limited` のみ
- API認証: `Bearer gas-{secret}`（`~/.claude/channels/discord/v2-gas-secret.txt`）= role owner。API=`https://api-5qrfx7ujcq-an.a.run.app`

## 手順

### 0. 前提点検（不足があれば先に埋める）
対象物件の properties doc を稼働物件（宇品 `ncUKeD4yQo0kfAoznITu`）と横並び比較し、以下を確認:
- `cleaningRequiredCount` / `cleaningStartTime` / `baseWorkTime` / `selectionMethod`
- `checklistTemplates/{pid}_cleaning` の存在
- `propertyWorkItems/{pid}` の存在（清掃単価。無いと請求書が0円）
- `private/secrets.lineChannels[]`（enabled+token+groupId）
- `timeeAutofill`（タイミー店舗のひな形が必要 → §3）
- staff（テストはやますけの分身 **西山スタッフ `lj4BVGCIRQT1olK8uTpN`** を使う。private/details に口座あり）

### 1. 実配信の確認（AskUserQuestion）
`staff_confirm`/`cleaning_done` は immediate + groupLine で**物件の清掃GグループLINEに実配信される**。やますけに「実配信してよいか／テスト中はグループOFFにするか」を必ず聞く。Timee を実公開する場合は「公開直前で止める／実公開して即取り消す」も選ばせる。

### 2. テスト予約→自動生成の検証
- `bookings` に docId `test_e2e_{物件slug}_{YYYYMMDD}` で作成。**checkOut は明日**（タイミー投稿の30日繰延を回避）。必須: propertyId/checkIn/checkOut(文字列YYYY-MM-DD)/status:"confirmed"/guestName/guestCount/pendingApproval:false
- ★日本語を含む書込は **JSONファイル+`curl --data-binary @file`**（インライン `-d` は cp932 化けする）
- 15秒待って検証: `shifts/auto_..._cleaning_{checkOut}`（unassigned）・`recruitments/同ID`（募集中）・`checklists`（shiftId一致・templateSnapshot入り）

### 3. タイミー（ひな形が無ければ作成 → 投稿 → 取り消し）
- 店舗ID: タイミー管理画面 `/companies/53875/clients` で確認（宇品=510988・若草=510989 登録済み）
- セッション失効時は `https://app-new.taimee.co.jp/login` を debug Chrome で前面に開いてやますけにログイン依頼
- ひな形作成は同梱 `scripts/timee-create-offer.mjs`（小町テンプレ準拠の全文入り・`--submit` で確定）。**業種/職種は MUI Select（ダミーinput）= 親要素をクリック**してから `[role=option]` を選ぶ
- `properties.timeeAutofill` を設定（wage 1100 / 10:00-12:00 / workers 1 / autoMsg true / baseUrl=新ひな形の `/offerings/new`）
- `POST /api/dispatch/timee {recruitmentId, visibility:"new_worker_for_client_limited"}` → dispatchQueue の status=done と `bookings.timeeStatus=posted` を確認
- 取り消し: 求人一覧→**リスト表示**→該当 offering →「cancel 求人を取り消す」→ダイアログ「取り消す」（※取り消した求人は再公開不可）→ `PUT /api/dispatch/timee-status {bookingId, status:"cancelled"}`

### 4. スタッフ確定
- `recruitments/{id}.responses` 配列に ◎ エントリを追記（staffId/staffName/staffEmail/response:"◎"/respondedAt ISO文字列/proxy:false）
- `selectedStaffIds:[staffId]` + `selectedStaff` を書いてから `PUT /api/recruitment/{id}/confirm`（gasトークン）
- 検証: recruitment=スタッフ確定済み / shift=assigned（同一docが更新される。別shiftが増えていないこと）
- 既知: 確定時のICS添付メールは未定義変数バグで常に失敗（warnのみ・実害なし）

### 5. チェックリスト完了
- checklist の templateSnapshot から項目IDを再帰収集（子キー: directItems/items/taskTypes/subCategories/subSubCategories）
- `itemStates.{id} = {checked:true, checkedBy, checkedAt}` 全項目 + `status:"completed"` + `completedAt` + `completedBy{uid,name}` + `cleanlinessRating` を1PATCHで書込
- 検証: `onChecklistComplete` → shift が completed / cleaning_done 通知の実着弾

### 6. 請求書
- `POST /invoices/my-submit`（gasトークン・body: yearMonth/propertyId/asStaffId/manualItems:[]）
- 検証: `invoices/INV-...` = submitted / total が単価マスタどおり（特別加算の自動適用も見る）/ pdfUrl あり / invoice_submitted 通知

### 7. 後始末（必ず全部やる）
1. **notificationQueue の pending を削除**（recruit_start のバッチ待ちが今夜/明朝に飛ぶのを防ぐ）
2. `bookings.status = "cancelled"` → 連鎖削除（shift/recruitment/checklist が404になるまで確認）
3. booking doc 削除 → invoice 削除 → dispatchQueue のジョブ削除
4. `staff.pendingRecruitmentIds` にテストIDが残っていないこと（連鎖で消える。残れば夜間 orphanCleanup が回収）
5. 消えないもの（許容）: Storage の請求書PDF孤児 / タイミーの取り消し済み求人履歴
6. LINE/メールの実着弾をやますけに確認してもらう

### 8. 公開・集客の点検（フェーズ3）
配線テストとは別軸で、以下も実物で確認する（詳細は new-property-checklist.md フェーズ3）:
- **直販サイト**: `https://{slug}.setouchi-stay.com` を実際に開き、空室カレンダー→予約リクエストフォーム→プラン/キャンセルポリシーが出ること
- **Googleマップ**: `google.com/maps/search/{宿名}+{住所}` で登録有無を確認。未登録なら business.google.com で作成（既存宿と同じアカウント・オーナー確認が必要=やますけ同席）。既存宿も電話番号・URL・写真の欠けを見る
- Instagram紹介投稿／Booking.com出品の要否／タイミーチェックインQR（timeeQrImageUrl）／Search Console／賠償保険

### 9. 報告
各工程の ✅/❌ と、発見した配線漏れ（→ new-property-checklist.md と memory に追記）を報告。
