---
name: feedback-check-oom-logs-first
description: Cloud Functions の通知が一部届かない場合、まず OOM ログを最優先で確認する
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 363467e8-8696-4790-a5d7-88d219015fcc
---

# 通知不達は OOM を最優先で疑う (2026-05-25)

## 原則
Cloud Functions / Firestore Trigger で「メールは届くが LINE は届かない」のような部分的不達が起きたら、コードや設定を疑う**前に必ず** Cloud Logging で OOM ログを確認する。

## 確認コマンド
```bash
gcloud logging read 'resource.type="cloud_run_revision" AND textPayload=~"Memory limit"' \
  --project=PROJECT --freshness=7d \
  --format='value(resource.labels.service_name)' | sort | uniq -c | sort -rn
```

## 経緯 (2026-05-25)
minpaku-v2 で iCal 予約後の LINE 通知が届かない問題で、Bot 設定/友達追加/フォールバックロジック等を何度も修正したが直らなかった。最終的にログ確認したら `onBookingChange` が 256MiB → 258MiB で OOM クラッシュしていた (24h で 30回以上、7d で 1812回)。

シーケンス：
1. 募集生成 (軽い) → 成功
2. notifyByKey 呼び出し (重い) → OOM で関数死亡
3. 結果: 募集は作られているが LINE 通知発火前に終了 → メール (別関数 onBookingConfirmMail) だけ届く

## 対策
- onBookingChange: 256 → 512 MiB
- orphanCleanup, photoCleanup も同様に増量

## 再発防止
「メールは来るが LINE は来ない」のように **チャネル別に不達がある場合は OOM** を最優先で疑う。Bot 設定変更や送信ロジック改修より先にログ確認すべき。

関連: [[feedback_user_hypothesis_first]] [[feedback_deploy]]
