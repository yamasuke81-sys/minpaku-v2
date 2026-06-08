---
description: minpaku-v2 の稼働を外部から死活監視する（認証不要のHTTPスモークテスト）。毎朝の routine 想定
argument-hint: [補足コンテキスト 任意]
allowed-tools: Bash
---

# /health-check

relay(メイン)と本番の Hosting が正常に配信できているかを、外部からHTTPで確認する。
GCP認証不要。毎朝のクラウド routine から呼ぶ想定。

## 確認対象

- メイン: `https://v2-5-relay.web.app`
- 本番: `https://minpaku-v2.web.app`（Trust&Safety凍結の可能性あり。落ちていても想定内として扱う）

## 手順

### 1. 両URLのHTTPステータスと配信内容を確認

```bash
for url in https://v2-5-relay.web.app https://minpaku-v2.web.app; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 20 "$url")
  body=$(curl -s -m 20 "$url" | head -c 4000)
  # SPAが配信されているかの簡易判定（index.html の特徴文字列）
  if echo "$body" | grep -qi "<title"; then has_html="HTMLあり"; else has_html="HTMLなし"; fi
  echo "$url -> HTTP $code / $has_html"
done
```

### 2. 判定

- **メイン(relay)が 200 かつ HTMLあり** → 正常
- **メインが 200 以外 / HTMLなし** → ★異常。アプリが落ちている可能性。最優先で報告
- 本番(minpaku-v2)が 200 になった → 凍結解除の兆候（watchHostingRecovery と整合するか参考情報として報告）

## 出力

- 各URLの `HTTP コード / HTMLあり・なし` を1行ずつ
- **メインが異常な場合のみ**「★要対応」を明示し、考えられる原因（凍結/デプロイ事故/DNS等）を簡潔に
- 正常時は「メイン正常」を1行で（冗長な説明は不要）

## 注意

- このコマンドは**読み取り専用の死活監視**。コード変更・デプロイ・復旧操作は一切しない
- 深い原因調査が要る場合は `/notify-debug` や手動調査に引き継ぐ
