# 新物件オンボーディング・チェックリスト（自動化の配線一覧SSOT）

**物件を追加・開業するときは必ずこのファイルを上から順に消化する。**
背景: 2026-08-10、宇品（8/7予約開始）で自動化の配線漏れが **9件** 見つかった（宿泊税CSV/申告PDF/納付リマインド・ダブルブッキング監査・料金5%OFF追随・キーボックス送信・PnL取込・入金突合・直販リクエスト通知）。個々の自動化が「対象物件」を Firestore のフラグやコード内ロスターで持っているため、物件を作っただけでは何も対象にならない。

点検のやり方: 稼働済み物件（the Terrace `tsZybhDMcPrxqgcRy7wp` / 宇品 `ncUKeD4yQo0kfAoznITu`）と新物件の properties ドキュメントを Firestore REST で取得して横並び比較する（フィールド欠落＝配線漏れ）。
**実走テスト**: 配線後は **`/property-e2e-test` スキル**（`.claude/skills/property-e2e-test/`）で予約→募集→タイミー→確定→チェックリスト→請求書→後始末まで通しで検証する（2026-08-10 宇品で全工程成功）。

---

## フェーズ0: 物件レコード作成時（リスティング未開設でも設定できる）

| 項目 | 場所 | 依存する自動化 | 備考 |
|---|---|---|---|
| `businessLicense` | properties | 14条定期報告の対象判定 | `minpaku_act` or `hotel_business`。**未設定=民泊新法扱い**で定期報告タブに出てしまう |
| `formCompleteMail` / `formUpdateMail` | properties | 名簿完了/修正メール | 汎用テンプレ（プレースホルダ駆動）を既存物件からコピー。**ゲートはトップレベルの `enabled`** |
| `keyboxSend`（テンプレのみ） | properties | チェックイン情報メール | テンプレは入れるが **`enabled=false` のまま**（フェーズ2参照） |
| `channelOverrides.direct_request` | properties | 直販予約リクエスト通知 | **通知系のSSOTは `channelOverrides[key]`**（reservationFlow ではない）。propertyEmail は物件メール未設定なら false |
| `yadozei` 骨組み | properties | （フェーズ1で本配線） | schedule.enabled=true / airbnb・booking・yadozeiUpload は false |
| `driveReceiptsFolderId`（60 消耗品・経費レシート） | properties | PnL レシート取込 | M0XX 物件フォルダ配下 |
| `driveUtilitiesFolderId`（007_光熱・インフラ） | properties | PnL 光熱費取込 | 同上 |
| `driveOtaCsvFolderId`（OTAのcsv） | properties | 宿泊税CSV保存・入金突合(verify-airbnb-payout) | 同上 |
| `driveInvoiceFolderId` | properties | 清掃請求書保存 | 同上 |
| ガイドページ | `functions/utils/guideMap.js` **と** `public/js/guide-map.js` の GUIDE_MAP | keybox メールの {{guideUrl}} | **2ファイル同時更新**（dual update） |
| 直販サイト設定 | `setouchi-stay-sites/config/properties/{slug}.json` | 宿公式サイト | published は開業まで false |

## フェーズ1: Airbnb リスティング開設時

| 項目 | 場所 | 依存する自動化 | 備考 |
|---|---|---|---|
| `yadozei.airbnb` {enabled, listingId, listingName} | properties | **宿泊税CSV月次取得**（毎月2日）・**夜間カレンダー監査**（ダブルブッキング検知） | **listingName は Airbnb 実ページのタイトルと完全一致必須**（CSV絞り込み・監査行の割当キー）。1宿複数リスティングは `auditListingNames[]` |
| `yadozei.airbnb.pricingSync` {enabled, listingId} | properties | **直販料金の Airbnb 5%OFF 自動追随**（毎晩3:00） | **pricingSync.listingId は airbnb.listingId と別枠**（小町は別リスティングを指す実例あり） |
| `yadozei.yadozeiUpload.enabled=true` | properties | やどぜい自動取込＋申告書PDF＋**納付リマインド**（毎日8:35） | |
| `yadozei.startYm` = 初宿泊の月 | properties | 納付リマインドの誤警報防止 | 2026-08-10導入。これより前の月は「PDF未生成」警告を出さない |
| iCal 取込 | `syncSettings` コレクション | 予約同期（15分毎） | Airbnb カレンダーの iCal URL |
| iCal 書き出し | `icalFeeds` コレクション＋**Airbnb側にURL登録** | 直販→OTA 自動ブロック | Airbnb「別のカレンダーと連携」。登録手順は memory `project_ujina_booking_launch` |
| `reservationFlow.ical_sync.enabled=true` | properties | 同期異常の通知 | |
| 名簿フォーム `formSectionConfig.parkingMode` | properties | ゲスト名簿 | **既定 terrace**＝有料駐車場5台割当が漏れ出るので必ず設定 |

## フェーズ2: 予約受付開始〜開業

| 項目 | 場所 | 依存する自動化 | 備考 |
|---|---|---|---|
| `keyboxCode`（+`keyboxLocation`）→ `keyboxSend.enabled=true` | properties | チェックイン情報メール | コードは `keyboxCode \|\| keyboxNumber`。**空のまま有効化すると暗証番号が空欄のメールが飛ぶ** |
| `wifiSSID` / wifiPassword | properties | ガイド・メールの変数 | |
| `pnlBatchEnabled=true` + `pnlStartMonth` | properties | **月次収支バッチ**（毎月6日5:00） | 会計方針: **開業月＝初回宿泊の月**（それより前は取り込まない） |
| `operationMode` + `managementFeeRate` | properties | 精算書・代行手数料 | 宇品=agency_hassac 5% / 若草=agency_hassac 70% |
| **mf-booking-monitor.mjs に物件追加（コード修正）** | `minpaku-v2/scripts/mf-booking-monitor.mjs` | OTA入金の自動突合 | `PROP_NAMES` と `fallbacks` に追加。**入金口座が楽天第3/ハープ以外の場合は口座スキャン自体の追加が必要** |
| LINE 清掃G | LINE Developers（Messaging API化）→ `lineBotInfo` + `properties/{pid}/private/secrets.lineChannels[]` | 清掃募集・シフト通知 | OA作成だけでは飛ばない。リネームは「公開」まで押す（memory `project_line_oa_ujina_wakakusa`） |
| `timeeAutofill` | properties | タイミー自動投稿 | Timee 側で求人テンプレ作成後に baseUrl/groupIds 等 |
| 届出番号（民泊新法のみ） | `settings/owner.todokideNumbers[pid]` | **14条定期報告の自動生成** | 登録した時点で自動対象化（実績0でも0報告）。旅館業物件は対象外 |
| `checklistTemplateId` ほか清掃系 | properties | チェックリスト・清掃フロー | |
| 直販サイト予約開通 | setouchi-stay-sites（published/Stripe） | 直販予約 | |
| 楽天でんき（該当時） | `minpaku-v2/scripts/rakuten-denki-monthly.mjs` の CONTRACTS + startYm | 電気代の月次計上 | |

## フェーズ3: 公開・集客（予約受付開始と同時〜直後）

| 項目 | 場所/方法 | 備考 |
|---|---|---|
| 直販サイト公開・予約開通 | setouchi-stay-sites（`bookingEnabled` / site.json `published`・`comingSoon`・`dnsUnreadySlugs`）＋DNS | 公開後に実機で「空室カレンダー→リクエストフォーム→プラン・キャンセルポリシー表示」を確認 |
| **Googleビジネスプロフィール（Googleマップ）** | business.google.com（**管理は yamasuke81@gmail.com に集約**・2026-08-11確定） | カテゴリ=旅館/ホテル・住所・**電話**・直販URL・写真・チェックイン時刻。**オーナー確認（動画のみ提示の場合あり。「後で確認」でプロフィール保存可）**。登録後はクチコミ導線（ガイド/現地QR）も検討 |
| 宿の公開電話番号の決定 | GBP・タイミー緊急連絡先・ガイドで共用 | **方針（2026-08-11やますけ決定）: テラス・小町・若草=070-8488-7966／宇品=080-3892-0532（営業者tomi企画・富永）**。運営主体が八朔/恭介以外の宿は営業者の番号にする |
| ゲスト案内ガイドの内容確定 | guides/{slug}.html（guest-checkin-link経由） | フェーズ0のslug登録だけでなく**中身の確定**（Wi-Fi・キーボックス・ゴミ出し・緊急連絡先）。若草は2026-08時点で未確定 |
| Instagram（@setouchistay.jp） | 新宿の紹介投稿＋ハイライト | 投稿は3の倍数ずつ（プロフィールグリッド維持） |
| Booking.com 出品の要否 | 経営判断 | テラスのみ出品中。出品するなら yadozei.booking／iCal双方向／mf-booking-monitor のBooking側も配線 |
| タイミー チェックインQR | Timee店舗管理→`properties.timeeQrImageUrl` | E2Eの残タスクになりがち |
| Google Search Console | サイトのインデックス登録状況 | published切替（noindex解除）後に確認 |
| 施設賠償・旅館賠償責任保険 | 運営主体ごと | 運営者が八朔以外（宇品=tomi企画）の場合は特に要確認 |

## 二層構造の罠（2026-08-10 実測で確定）

- **通知系**（direct_request / roster_remind / urgent_remind / ical_sync 等）: ゲートは **`channelOverrides[key].enabled`**。`reservationFlow.{key}.enabled` は propertyField を持たないステップ用の表示トグルで、通知の実体判定には使われない
- **メール系**（formCompleteMail / formUpdateMail / keyboxSend）: ゲートは **トップレベルフィールドの `enabled`**（予約フロー画面の propertyField 同期対象）
- 迷ったら `functions/utils/lineNotify.js` の notifyByKey（SSOT=channelOverrides）と `public/js/pages/reservation-flow.js` の propertyField 定義を見る

## 対象条件の早見表（この自動化は何を見て対象を決めるか）

| 自動化 | 対象条件 |
|---|---|
| 宿泊税CSV取得（yadozeiCsvDispatcher 毎日4:00） | `active` + `yadozei.schedule.enabled` + 各OTA `enabled` |
| カレンダー監査（listener 2:30 → morningOtaAudit 7:00） | `yadozei.airbnb.auditListingNames \|\| listingName` |
| 料金5%OFF追随（listener pricing_sync 3:00） | `active` + `yadozei.airbnb.pricingSync.enabled` + `pricingSync.listingId` |
| 納付リマインド（毎日8:35） | `yadozei.yadozeiUpload.enabled`（`yadozei.startYm` 以降の月のみ） |
| 月次収支バッチ（毎月6日5:00） | `pnlBatchEnabled` + `pnlStartMonth` 以降 |
| 14条定期報告（偶数月8:40） | `type=minpaku` + 民泊新法 + `todokideNumbers[pid]` 登録済み |
| OTA入金突合（毎朝 mf-import-chain） | **コード内ロスター**（mf-booking-monitor.mjs） |
| キーボックス送信 | `keyboxSend.enabled` + コード設定 |
| 名簿リマインド等の通知 | `channelOverrides[key].enabled` |

## 進捗（2026-08-10 時点）

- **宇品**: フェーズ0〜2 配線済み。keyboxCode=設定済（private/secrets）・keyboxSend 有効化済・宿泊税は 2026-08 分から0申告（startYm=2026-08）。残 = ①LINE Messaging API化＋lineBotInfo ②timeeAutofill（Timee側の求人テンプレ待ち）
- **若草・安芸津・竹原**: フェーズ0 完了（2026-08-10 一括投入: メールテンプレ・keyboxSendテンプレ・direct_request・yadozei骨組み）。リスティング開設時にフェーズ1へ
