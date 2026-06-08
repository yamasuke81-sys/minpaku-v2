---
description: 募集（recruitment）まわりを触った後、重複・誤発火・繰延の既知の落とし穴を点検する
argument-hint: [変更した内容や気になる症状]
allowed-tools: Read, Grep, Glob, Bash
---

# /recruit-check

予約→募集の自動生成まわりは過去に**重複**と**毎日の誤発火**を起こした。
募集ロジックを触った後、または「募集がおかしい」時にこれで点検する。

## 入力

- 引数（任意）: 変更内容や症状（例: `onBookingChange を修正した` / `募集が毎日2件来る`）

## 点検項目（過去に踏んだ落とし穴）

### 1. 募集の重複（race condition）

`functions/triggers/onBookingChange.js` を確認。
- 募集ドキュメントは**決定的な docId + `create()`** で冪等化されているか
  （ランダムIDや `add()` だと同時実行で重複生成される）

```bash
cd C:/Users/yamas/AI_Workspace/minpaku-v2/functions
```

### 2. 売り止めブロックによる毎日の誤発火 ★重要

Airbnb のローリング売り止めが Booking.com 経由で**毎日日付がズレて流入**し、
`booking_change` が毎日誤発火する問題があった。

- `onBookingChange` に**プレースホルダ名ベースのガード**があるか確認
  （`guestName === "Booking.com予約"` 等の仮名予約は通知抑制）
- **cancel 系・change 系の両方**にガードが入っているか（片方だけだと抜ける）
- 注意: 「未確定(unverified)判定で抑制」は**実名予約まで誤って抑制する**ので使わない

### 3. 30日繰延の動作

- `deferUntil30Days` トグルが有効な物件で、募集が即時ではなく繰延キューに入るか
- 日次バッチ `dispatchDeferredRecruits` が繰延分を正しく発火しているか
  （ログで発火実績を確認）

```bash
gcloud logging read 'resource.type="cloud_function" AND resource.labels.function_name="dispatchDeferredRecruits"' --project minpaku-v2 --limit 10 --freshness 3d --format 'table(timestamp, textPayload)'
```

### 4. キャンセル連動

予約キャンセル時に対応する shift / recruitment / checklist が
`onBookingChange` で自動削除されているか（孤児レコードが残っていないか）。

## 出力

- 1〜4 の各項目を「OK / 要修正」で判定
- 要修正があれば該当ファイル・行と修正方針を提示（変更・デプロイは別途承認後）
