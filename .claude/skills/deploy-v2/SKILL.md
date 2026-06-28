---
name: deploy-v2
description: minpaku-v2 を正しい手順でデプロイする。アセット版数を自動同期(bump)してから relay(メイン・必須) と 本番(git push→GitHub Actions) の両系統へ反映する。public/ や firebase 設定を変更してデプロイ/反映したいとき、「v2をデプロイ」「relayに上げて」等のときに使う。
---

# minpaku-v2 デプロイ手順

minpaku-v2 のフロント(public/)変更を本番反映するときは、必ずこの手順で行う。
**手動で版数を書き換えない**こと（version.json を揃え忘れて無限リロードを起こす事故が過去複数回。必ず bump スクリプト経由）。

## 前提
- メイン本番 = `https://v2-5-relay.web.app`（relay）。`minpaku-v2.web.app` は GitHub Actions 経由。
- フロント変更は **relay と 本番の両方**に反映する。
- Functions/Firestore/Storage は両 site 共用。

## 手順

### 1. アセット版数を自動同期(bump)
```bash
node scripts/bump-version.mjs
```
- `public/index.html` の全 `?v=` クエリと版数バッジ、`public/version.json` を**1つの新トークン(vMMDDx)に自動で揃える**。
- これを飛ばして手動で `?v=` だけ変えると version.json と不一致になり**無限リロード**が起きる。必ずこのスクリプトを使う。
- JS/CSS を変更していないデプロイでも実行してよい（キャッシュ更新になるだけ）。

### 2. relay へデプロイ（メイン・必須）
```bash
npx firebase deploy --only hosting --config firebase.relay.json --project v2-5-relay
```

### 3. 本番へ push（GitHub Actions が hosting 自動デプロイ）
```bash
git add -A && git commit -m "<変更内容>" && git push origin main
```
- push 直前に **asset-version-guard フック**が版数整合を検査する。不整合なら deny されるので、その場合は手順1からやり直す。

### 4. GitHub Actions の完了を確認（success まで見届ける）
```bash
gh run list --repo yamasuke81-sys/minpaku-v2 --limit 1
```
- `completed / success` を確認。失敗(OAuth Premature close 等の一時失敗含む)なら `gh run rerun <id>` で success まで持っていく。

### 5. Functions/Firestore も変更した場合（必要時のみ）
```bash
# 例: 特定関数のみ
npx firebase deploy --only functions:<name> --project minpaku-v2
# Firestore index/rules
npx firebase deploy --only firestore --project minpaku-v2
```

## 反映後チェック
- スマホで崩れる場合は「サイトデータ削除」を最優先で試す。
- 版数は relay/本番とも index.html と version.json が一致していること（不一致＝無限リロード）。
