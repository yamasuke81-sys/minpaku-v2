---
name: feedback_notifybykey_batch_bypass
description: notifyByKey は物件設定の batch_morning_8/batch_evening_20 でバッチenqueue化する。手動「即時送信」用途では _fromBatchQueue:true を渡してバッチ分岐をスキップする
metadata: 
  node_type: memory
  type: feedback
  originSessionId: df6d53fe-cddb-4a81-86f9-91b16e8685d7
---

minpaku-v2 の `functions/utils/lineNotify.js` `notifyByKey()` は、物件 `channelOverrides[notifyKey].timings` に `batch_morning_8` / `batch_evening_20` が含まれていると、即時送信せず `notificationQueue` にenqueueして次の08:00/20:00スロットで一括送信する。

**Why:** 通常の予約由来トリガー (onBookingChange など) はバッチ運用が前提だが、ユーザーが手動で押す「募集通知」「再送」ボタンは即時送信が期待されるため、バッチ分岐をバイパスする必要がある。

**How to apply:** 手動即時送信エンドポイントでは `notifyByKey(db, key, { ..., _fromBatchQueue: true })` を渡す。このフラグは本来バッチハンドラからの再入用だが、結果的に「バッチenqueueをスキップして即時送信のみ実行」するため流用できる。コメントで意図を明記すること。

関連: [[project_minpaku_v2_context.md]]
