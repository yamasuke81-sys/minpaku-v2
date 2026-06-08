---
description: 通知不達（LINE/メールが届かない）の原因を、過去の知見に沿った正しい順序で調査する
argument-hint: <症状の説明 例: 請求書提出のLINEだけ届かない>
allowed-tools: Bash, Read, Grep, Glob
---

# /notify-debug

通知が届かない問題を、**過去に実際に踏んだ落とし穴の順**で調査する。
憶測で別方向に走らず、確率の高い順に裏取りすること。

## 入力

- 引数: 症状の自由記述（例: `請求書提出のLINEだけ届かない` / `メールは来るがLINEが来ない`）

## 調査順序（この順で潰す）

### 1. OOM（メモリ不足）を最優先で疑う ★まずこれ

「メールは届くが LINE は届かない」等の**部分不達は Cloud Functions の OOM が原因のことが多い**。
他を調べる前に必ずログを確認する。

```bash
gcloud logging read 'resource.type="cloud_function" AND (textPayload:"Memory limit" OR textPayload:"exceeded memory")' --project minpaku-v2 --limit 30 --freshness 2d --format 'table(timestamp, resource.labels.function_name, textPayload)'
```

Memory limit / exceeded memory が出ていれば → 該当 Functions のメモリ割当を上げる方向で対処。

### 2. notifyByKey の分岐とパラメータ

`functions/` 内で `notifyByKey` の呼び出し元を確認する。

```bash
cd C:/Users/yamas/AI_Workspace/minpaku-v2/functions
```

チェックポイント（過去のバグ）:
- **batch 分岐**: 物件設定の `batch_morning_8` / `batch_morning_20` に該当するキーは
  enqueue されるだけで**即時送信されない**。手動「即時送信」させたい用途なら
  呼び出し側で `_fromBatchQueue: true` を渡して分岐をスキップする。
- **propertyId 未指定**: `notifyByKey` に `propertyId` を渡し忘れると
  通知先解決が allOff 扱いになり、**無言で未送信**になる（請求書提出通知で実際に発生）。
- **staffEmail 空配列の誤解釈**: 空配列を「全員」と誤解釈して送られないケースがあった。

### 3. メール送信元（物件起点メール）

物件を起点とするメールは `property.senderGmail` を `fromEmail` に渡しているか確認。
未設定/誤りだと送信失敗または迷惑メール判定。

### 4. 通知先設定そのもの（allOff チェック）

`settings/notifications` と物件別設定で、該当通知種別の宛先（オーナーLINE / グループLINE /
スタッフ個別LINE / メール）が全部 OFF になっていないか。Console 側で機能が無効化されていないかも確認。

## 出力

- 1〜4 のどこで原因が見つかったかを明記
- 見つからなければ「OOM なし・呼び出し正常・宛先設定あり」を確認した旨を報告し、次の仮説を提示
- 修正案は提示のみ。コード変更・デプロイは別途ユーザー承認を得てから
