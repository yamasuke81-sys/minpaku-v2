# 4視点フロー確認 計画書

作成日: 2026-04-19
対象: the Terrace 長浜 (pid=tsZybhDMcPrxqgcRy7wp) を主軸に、全物件横断で確認
ベースURL: https://minpaku-v2.web.app

## 進行方針

- **順次実施**: 上から 1→2→3→4 の順で 1視点ずつ完了させる
- **並行不可**: 各視点完了ごとに問題点を「修正 commit」まで片付けてから次へ
- **検証対象**: 主に the Terrace 長浜。他物件影響は付随確認
- **テストデータ**: 本番DBを使う (test tenant なし)。破壊的変更禁止

---

## 視点1: オーナー → スタッフ

オーナー(やますけ)がスタッフをどう管理・指示・精算するかの全導線。

### 1-1. スタッフ管理
| 画面 | URL | チェック |
|---|---|---|
| スタッフ一覧 | [#/staff](https://minpaku-v2.web.app/#/staff) | 全active 14名が表示、displayOrder通りに並ぶ、担当物件チェックボックス動作 |
| スタッフ編集 | (一覧からモーダル) | email 未設定7名に一括入力できるか、lineUserId 表示、招待リンク発行、報酬単価インポート |
| 報酬単価 | [#/rates](https://minpaku-v2.web.app/#/rates) | 階段制(1/2/3名)、タイミー時給、特別加算、他物件インポート |

### 1-2. 募集 (オーナー → スタッフ指示)
| 画面 | URL | チェック |
|---|---|---|
| 募集一覧 | [#/recruitment](https://minpaku-v2.web.app/#/recruitment) | 9件全部表示、回答状況、workType区別 (pre_inspection vs cleaning_by_count) |
| 募集モーダル | (一覧からクリック) | 「スタッフを選定」→「スタッフ確定」2段動作、staff_confirm 通知 |
| 横カレンダー | [#/my-recruitment](https://minpaku-v2.web.app/#/my-recruitment) | 連泊バー、物件色バッジ、オーナー代理回答 |

### 1-3. 通知・連絡
| 画面 | URL | チェック |
|---|---|---|
| 通知設定 | [#/notifications](https://minpaku-v2.web.app/#/notifications) | **🔴 ownerLineChannels 未設定! Bot#1+Bot#2 登録必須** / 各イベントON/OFF初期化 |
| LINE Webhook | - | Bot#1 で group message が届くか、Bot#2 で fallback |

### 1-4. 請求書発行
| 画面 | URL | チェック |
|---|---|---|
| 請求書一覧 | [#/invoices](https://minpaku-v2.web.app/#/invoices) | 2件submitted、再計算ボタン、PDF/表示、送信先絞込 |
| 月次生成 | (一覧ボタン) | 「今月分を生成」で active 全員分のdraftを作成 |
| 請求書詳細 | (一覧から) | manualItems 追加/削除、markPaid、PDF再生成 |

### 想定問題点(視点1)
- [ ] 通知設定の ownerLineChannels が空配列 → LINE 通知が機能しない
- [ ] 実働スタッフ7名の email 未設定 → メール通知不可
- [ ] 実働スタッフ大半が LINE 紐付け未完了
- [ ] 請求書 INV-202604-ziTig6 の PDF 欠落

---

## 視点2: オーナー → ゲスト

オーナーがゲストに対して提供する導線 (URL配布、情報収集、案内) の設計。

### 2-1. 物件別フォームURL配布
| 画面 | URL | チェック |
|---|---|---|
| 宿泊者名簿 設定 | [#/guests](https://minpaku-v2.web.app/#/guests) → 設定 | 物件別URLカード、miniGameEnabled、showNoiseAgreement |
| 物件別URL例 | `https://minpaku-v2.web.app/form/?propertyId=tsZybhDMcPrxqgcRy7wp` | 物件判定、注意事項、ミニゲーム、フォーム描画 |

### 2-2. フォーム項目管理
| 画面 | URL | チェック |
|---|---|---|
| フォーム項目 | [#/guests](https://minpaku-v2.web.app/#/guests) → 設定 → タブ2 | customFormFields 物件別、必須/任意、表示順 |
| ミニゲーム ON/OFF 同期 | タブ1/タブ2 双方向 | 🆕 今日修正済 → 実機で両方同期するか |

### 2-3. 注意事項・規約
| 画面 | URL | チェック |
|---|---|---|
| 騒音ルール黄色カード | [#/properties](https://minpaku-v2.web.app/#/properties) 物件編集 | showNoiseAgreement ON/OFF、了承→キャンセル画面 |

### 2-4. 宿泊者名簿の閲覧
| 画面 | URL | チェック |
|---|---|---|
| 宿泊者一覧 | [#/guests](https://minpaku-v2.web.app/#/guests) | 全物件横断、物件フィルタ、同行者展開、提出済み/未提出バッジ |
| ダッシュボード | [#/](https://minpaku-v2.web.app/#/) | セルクリックで宿泊者詳細モーダル、緑●/赤● |

### 想定問題点(視点2)
- [ ] 物件別URLがまだ Airbnb/Booking.com に貼られていない (ユーザー作業待ち)
- [ ] ミニゲーム2箇所同期 (今日修正済) の本番動作確認

---

## 視点3: スタッフ視点 (一連の流れ)

LINEで招待された時点から、清掃完了→請求書送信までの実体験。

### 3-1. 初回ログイン
| 画面 | URL | チェック |
|---|---|---|
| 招待リンク | `/invite.html?token=xxx` | LINE Login → staffId 付与 → ダッシュボード |
| LIFF 経由 | `liff.line.me/<LIFF_ID>` | **🔴 LIFF ID 未設定 → 動作未確認** |

### 3-2. マイダッシュボード
| 画面 | URL | チェック |
|---|---|---|
| my-dashboard | [#/my-dashboard](https://minpaku-v2.web.app/#/my-dashboard) | 本日・明日のシフト、未回答募集、カード一覧 |

### 3-3. 募集回答
| 画面 | URL | チェック |
|---|---|---|
| my-recruitment | [#/my-recruitment](https://minpaku-v2.web.app/#/my-recruitment) | 横カレンダー (連泊バー)、◎△×回答、担当物件フィルタ |

### 3-4. 清掃チェックリスト
| 画面 | URL | チェック |
|---|---|---|
| my-checklist | [#/my-checklist](https://minpaku-v2.web.app/#/my-checklist) | L1タブ/L2-4アコーディオン、カード全体タップ、editingBy presence、複数スタッフ同時編集 |
| 完了ボタン | (同画面) | shift.status=completed、オーナーLINE通知、ランドリー促進 |

### 3-5. ランドリー記録
| 画面 | URL | チェック |
|---|---|---|
| my-checklist (ランドリーセクション) | [#/my-laundry](https://minpaku-v2.web.app/#/my-laundry) → 自動で [#/my-checklist](https://minpaku-v2.web.app/#/my-checklist) へ遷移 | ランドリーセクションへスクロール＆ハイライト |

> **実装メモ (2026-04-19)**: `my-laundry.js` は存在しない。ランドリー機能は `my-checklist.js` のフッターに統合済み（ランドリー3ボタン + プリカフロー）。`#/my-laundry` は `#/my-checklist` へのエイリアスとして実装し、`sessionStorage("pclScrollToLaundry")` フラグ経由でランドリーセクション(`#laundrySection`)へスクロール。

### 3-6. 請求書確認・送信
| 画面 | URL | チェック |
|---|---|---|
| 請求書一覧 (送信済み確認) | [#/my-invoice](https://minpaku-v2.web.app/#/my-invoice) | 自分の請求書一覧、status別バッジ、明細展開、PDFリンク、「新しい請求書を作成」ボタン |
| 請求書新規作成 | [#/my-invoice-create](https://minpaku-v2.web.app/#/my-invoice-create) | 月指定→シフト+ランドリー自動集計、追加明細、オーナーへ送信 |

> **実装メモ (2026-04-19)**: `my-invoice.js`（送信済み確認用）と `my-invoice-create.js`（新規作成用）の2ファイル構成。`my-invoice.js` は `GET /invoices` を呼び出し、バックエンドでスタッフは自分の分のみ返す（`req.user.staffId` で絞り込み済み）。draft は編集リンクのみ表示し読み取り専用、submitted以降は明細展開可。

### 想定問題点(視点3)
- [ ] LIFF_ID 未設定 → 新規スタッフが LIFF 経由でログインできない
- [ ] 実働スタッフ未招待 → そもそも3-1が未体験
- [ ] Phase2+ 機能（写真一括アップ）未実装
- [x] ~~my-laundry.js が存在しない~~ → `#/my-laundry` エイリアス実装済み (2026-04-19)
- [x] ~~my-invoice.js が存在しない~~ → 送信済み確認画面として新設 (2026-04-19)

---

## 視点4: ゲスト視点 (一連の流れ)

予約→チェックイン前→滞在中→退室までのゲスト体験。

### 4-1. 予約確認メールからアクセス
- Airbnb/Booking.com の自動メッセージに `form/?propertyId=xxx` URL が貼られる前提
- **🔴 現状ユーザー作業未実施**

### 4-2. 注意事項・騒音規約カード
| 画面 | URL | チェック |
|---|---|---|
| 黄色カード | `/form/?propertyId=xxx` 最初 | showNoiseAgreement=true時に表示、了承/キャンセルの2択 |
| キャンセル選択時 | (自動遷移) | キャンセル画面、連絡先表示 |

### 4-3. ミニゲーム (騒音確認)
| 画面 | URL | チェック |
|---|---|---|
| ミニゲーム | (規約通過後) | miniGameEnabled=true時に実施、合格後フォームへ |

### 4-4. 宿泊者名簿入力
| 画面 | URL | チェック |
|---|---|---|
| 動的フォーム | (ミニゲーム通過後) | 物件別customFormFields 描画、必須バリデーション、同行者追加 |
| 送信後 | (submit後) | editToken生成、修正リンクメール、完了画面 |

### 4-5. 送信後の案内
- キーボックスメール (チェックイン当日/前日)
- 修正リンクメール
- (将来) 多言語対応、Wi-Fi案内、観光情報

### 想定問題点(視点4)
- [ ] ゲストフロー全体が実データで通しで動くかまだ未検証
- [ ] 送信後の案内メール内容
- [ ] 多言語対応未実装

---

## 実施方法

各視点で:
1. **静的確認**: 画面表示・リスト描画を実際のURLで目視
2. **動的確認**: 操作（回答・確定・完了など）を1件実行してデータ反映確認
3. **問題洗い出し**: 想定外の挙動・欠落UI・通知漏れを記録
4. **修正**: Sonnet agent に委託して commit & push (自動 deploy)
5. **再確認**: 修正後に再度確認

## バックグラウンド継続中のタスク

- BG1: pre_inspection カレンダー表示対応 (Sonnet)
- BG2: onBookingChange shift重複判定修正 (Sonnet)
- BG3: iCal 連携強化 調査・設計提案 (Sonnet)

全て完了してから視点1 に着手。
