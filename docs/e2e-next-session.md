# E2E 続行用プロンプト (次セッション自動実行)

作成日: 2026-04-19
対象: minpaku-v2 (`C:\Users\yamas\AI_Workspace\minpaku-v2`)
目的: 本日未検証の視点を自動で連続検証し、発見したバグを即修正する

---

## 次セッション開始時に貼るプロンプト

```
@docs/e2e-next-session.md に従って E2E 検証を続行してください。
本日 (2026-04-19) に検証済みの「ランドリー→請求書 連動」は OK。
未検証の視点を上から順に回し、発見バグは Sonnet agent に委託して即修正→再検証。
トークン節約方針 (admin script ファースト、Claude in Chrome 最小使用)、LINE 節約方針 (Bot#2 残 ~197 通、テスト送信は 1-2 通まで) を厳守。
```

---

## 検証原則 (節約最優先)

### トークン節約ルール
1. **admin script ファースト** — Firestore 直接 read/write で完結させ、ブラウザ操作は UI 固有バグの最終確認のみ
2. **Claude in Chrome を使う場合**:
   - `screenshot` ではなく `get_page_text` / `read_page` で DOM テキスト取得
   - `computer_batch` / `javascript_tool` で複数操作を1ラウンドに
   - find は必要時のみ、既に保存した ref_id を使い回す
3. **Sonnet agent に委託** — 大規模調査・修正は `run_in_background: true` で Opus (メイン) を解放
4. **5-10 件単位の検証は 1 node script で一括実行**

### LINE 節約ルール
- Bot#1: 4月上限到達 (0/200)、5月1日リセット
- Bot#2: 残 ~197/200 通 (2026-04-19 テスト送信後)
- **実送信は原則しない**。必要なら「dry-run: 通知発火条件が整ったか admin script で確認」まで
- テスト送信が必要な場合は最大 **1 通/シナリオ**、事前に残量確認

### クリーンアップ原則
- テストで作ったデータには必ず `{ _e2eTest: true, _createdBy: "e2e-session-<日付>" }` を付与
- 各シナリオ終了時に `functions/migration/cleanup-e2e.js` で一括削除
- Git コミットを除いて、Firestore / Storage 側はゼロに戻す

---

## 未検証シナリオ (優先度順)

### Scenario 1: フォーム項目管理 (Phase 1+2 結果検証)
**目的**: 管理画面タブ2 で設定した overrides が実フォームに反映されるか検証
**手順**:
1. `properties/tsZybhDMcPrxqgcRy7wp.formFieldConfig.overrides` を admin で書き込む
   - 例: `overrides.passportNumber = { hidden: true }`
   - 例: `overrides.guestName = { labelOverride: "ご予約代表者", requiredOverride: true }`
2. ゲストフォーム `https://minpaku-v2.web.app/form/?propertyId=tsZybhDMcPrxqgcRy7wp` の DOM を `get_page_text` で取得
3. 以下を検証:
   - 旅券番号フィールドが非表示か (hidden 適用)
   - 氏名ラベルが上書きされているか
   - `*` 必須マーク表示切替
   - 送信時に hidden フィールドがデータに含まれていないか
4. admin で overrides を元に戻す (全削除)

**Claude in Chrome 必要**: ✅ (フォーム側の DOM 検証のみ、`get_page_text` 中心)
**想定消費**: ~3,000 トークン (1シナリオ)

### Scenario 2: オーナー → スタッフ フロー (招待〜確定)
**目的**: スタッフ登録 → 招待リンク発行 → 募集確定 → 通知の連鎖を検証
**手順**:
1. admin で架空のテストスタッフを作成 (`staff/e2e_test_staff1`, `_e2eTest: true`)
2. 架空の recruitment を作成 (`recruitments/e2e_test_rec1`, `_e2eTest: true`, the Terrace 長浜)
3. admin で responses に ◎ 回答を追加 (`{ staffId: "e2e_test_staff1", response: "◎" }`)
4. `onRecruitmentChange` トリガーが発火 → LINE 通知ログ確認 (ただし実送信は skip されるよう事前に `channels.recruit_response.enabled = false` に一時設定、検証後に戻す)
5. admin で status = "スタッフ確定済み" + selectedStaffIds = ["e2e_test_staff1"] に更新
6. `shifts.e2e_test_rec1` が staffId 付きに更新されるか確認
7. admin でテストスタッフ・recruitment・shift を削除

**Claude in Chrome 必要**: ❌ (admin のみで完結)
**想定消費**: ~1,500 トークン

### Scenario 3: ゲスト → フォーム送信フロー (完全自動)
**目的**: 黄色カード → ミニゲーム → フォーム送信 → onGuestFormSubmit トリガー → editToken 発行 → 修正リンクメール の連鎖
**手順**:
1. admin で `guestRegistrations` に架空のゲスト登録を直接投入 (`source: "guest_form"`, `_e2eTest: true`, propertyId=the Terrace 長浜)
2. 10秒待って `onGuestFormSubmit` トリガー発火確認:
   - `editToken` / `editTokenExpiresAt` 付与されているか (152e24f)
   - `status: "submitted"` に変わっているか
   - メール送信ログ (bookings 照合・オーナー/ゲストメール) → admin 側 logs は見れないので `functions logs` で確認不要。実メールは yamasuke81@gmail.com に届く
3. `GET /api/guest-edit/:token` を fetch で叩いて編集フォームデータが返るか
4. `editTokenExpiresAt` を過去日に書き換えて再度 GET → 410 Gone が返るか
5. テストゲストを削除

**Claude in Chrome 必要**: ❌ (admin + curl/node-fetch で完結)
**想定消費**: ~2,000 トークン

### Scenario 4: ダブルブッキング検知 (D-1)
**目的**: 2つの confirmed 予約が同日同物件に存在する時、onBookingChange が conflictWithIds を付与するか
**手順**:
1. admin で架空の booking A (`propertyId: the Terrace 長浜, checkIn: 2026-07-01, checkOut: 2026-07-03, status: confirmed, _e2eTest: true`)
2. admin で架空の booking B (同期間、`_e2eTest: true`)
3. トリガー発火 8秒待機
4. 両 booking に `conflictWithIds: [相手のid]` が付与されているか確認
5. `bookingConflicts/{合成ID}` に `resolved: false` のドキュメントが生成されているか
6. A の status を `cancelled` に → `resolved: true` に変わるか
7. 両 booking 削除

**Claude in Chrome 必要**: ❌
**想定消費**: ~1,500 トークン

### Scenario 5: 通知設定の完全フロー
**目的**: 今日切替えた Bot#2 経由が各イベントで正しく発火するか
**手順**:
1. `channels.*.enabled = true, groupLine = true` は既に設定済
2. admin で「架空の checklist 完了」シミュレート (checklists.status = "completed" への update)
3. `onChecklistComplete` トリガー発火確認
4. LINE 実送信は **行わない** (Bot#2 残量を使わない)
5. 代わりに「通知ログ」コレクションがあればそこで送信試行ログを確認
6. 実送信なしなら skip、 `notifications` のログで enabled/ownerLine/groupLine の解決が正しいか確認

**Claude in Chrome 必要**: ❌
**想定消費**: ~1,000 トークン

### Scenario 6: 請求書 compute-preview API 動作確認
**目的**: `POST /api/invoices/compute-preview` が正しい集計値を返すか
**手順**:
1. admin で the Terrace 長浜 の 4月分の shifts + laundry を集計期待値として算出
2. オーナーの認証トークンで `POST /api/invoices/compute-preview { staffId, yearMonth: "2026-04" }`
3. 期待値と一致するか検証 (shifts件数、基本報酬、ランドリー立替、交通費、合計)
4. 階段制適用の確認 (複数人数分のシフトがあれば)

**Claude in Chrome 必要**: ❌ (オーナーの ID トークンを一度 UI で取得して環境変数保存、以降は curl)
**想定消費**: ~1,500 トークン

---

## 視点別の未検証項目 (過去セッションから)

- `onBookingChange` の trigger region が `us-central1` (プロジェクト標準は `asia-northeast1`) — region 変更はトリガー再作成のため、専用セッションで慎重に
- サブオーナー Phase 1 (`.claude/rules/sub-owner-v2.md` 参照)
- assignedPropertyIds > 10 件の分割取得
- guestRegistrations PII の Functions 経由への移行 (`/api/guest-summary`)
- OAuth drive.file scope + Gmail 再接続 + PDF添付
- Phase2+ 清掃画面 (写真一括アップロード、30日削除ジョブ)

---

## 実行順推奨

1. Scenario 4 (ダブルブッキング、admin のみ、ロジック検証には最適)
2. Scenario 2 (スタッフ確定、admin のみ)
3. Scenario 3 (ゲストフォーム、admin のみ)
4. Scenario 6 (請求書 preview、curl のみ)
5. Scenario 1 (フォーム項目管理、Chrome 必要、最後)
6. Scenario 5 (通知、実送信なしなら最後にまとめて)

→ 1〜4 は admin/curl ベースで節約、5-6 は必要に応じて。

---

## クリーンアップスクリプト (Scenario 完了ごとに実行)

```bash
cd C:/Users/yamas/AI_Workspace/minpaku-v2/functions
node migration/cleanup-e2e.js --dry-run
# 確認後
node migration/cleanup-e2e.js --execute
```

※ `functions/migration/cleanup-e2e.js` は次セッションで作成。`_e2eTest: true` フラグを持つ全ドキュメントを走査して削除。対象コレクション:
- staff, recruitments, shifts, bookings, guestRegistrations, laundry, invoices, checklists, bookingConflicts

---

## LINE 節約状況 (2026-04-19 終了時点)

- Bot#1: 0/200 (上限到達、5/1 リセット)
- Bot#2: ~197/200 (テスト送信 1通で 3消費)
- settings/notifications: **Bot#2 グループ通知** に切替済 (backup: `settings/notifications_backup_20260419`)
- 5月1日になったら Bot#1 へ戻すか、ownerLineChannels fallback に両 Bot 登録するか検討

---

## 本日の成果 (参考)

- 約 60 コミット完了 (視点1〜4 + フォーム項目管理 Phase1+2 + ランドリー連動修正 + 別件多数)
- E2E 実施でバグ 4件発見→全修正 (最大のもの: ランドリー→請求書の連動不全)
- settings/notifications Bot#2 切替完了、テスト送信1通で実配信確認

---

## 絶対に後退させないコミット SHA (累計)

```
e51e870 8b9cebf 4715395 2ef8efd d5821ca 96c7458
af66187 1de2393 1c51d90 7d62ef1 928af3e 3ccfe8c
a608a07 9b0ed8e 4b172c8 bd75e54 890ff35 fe7e97f
c2a690b 98d535f aa09ed5 c7ef98c c841e80 9b40e8d
5873d7d 152e24f 501b0b5 6c2708c 466db01 6541364
dbd44c6 165b055 e5f388f ea36b0a 1c8914d 7b8162d
446a3cf ee10578 53627e3 6093553 aa7153a e0f0c4b
99ec547 66691b3 2e4b7d1 45957fd 9e42df4 6742e32
08ac842 b1e1974 741753e e7628d5 c8fd51f 3656a7c
```
