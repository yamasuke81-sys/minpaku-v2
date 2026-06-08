---
description: minpaku-v2 のフロント変更を「退避先 relay + 本番」両方にデプロイし、アセットバージョン更新と commit/push まで一貫して行う
argument-hint: [コミットメッセージ]
allowed-tools: Bash, Read, Edit
---

# /deploy-v2

フロント変更を**現運用（メイン = v2-5-relay）**に沿ってデプロイする。
relay と本番の**両方**に反映しないと不整合になる点に注意。

## 前提（2026-06-08 ユーザー決定 / CLAUDE.md ヘッダ準拠）

- 本番メイン = `https://v2-5-relay.web.app`（minpaku-v2 は Trust&Safety 凍結中、解除後も relay メイン）
- フロント変更は relay 優先・必須、本番 minpaku-v2 も同時に反映
- Functions/Firestore/Storage/Auth は両 site 共用
- `settings/notifications.appUrl` は **relay 固定**（戻さない）

## 手順

### 1. アセットバージョン更新（★忘れると配信されない）

JS/CSS を変更した場合、`public/index.html` の `?v=` クエリと画面のバージョンバッジを
**全置換で更新**する。これをしないとブラウザキャッシュで旧版が配信される。

- バージョン形式: `v{MMDD}{連番アルファベット}`（例: `v0608a`）
- `?v=` を持つ全アセット参照と、バッジ表示箇所をまとめて更新
- **★ public/version.json の `version` も同じ値に必ず揃える**
  （index.html の `?v=` と version.json が不一致だと**無限リロード**が発生。`43534aa`/`0f9d18a` で2回再発した既知の罠）

### 2. relay へデプロイ（必須・優先）

```bash
cd C:/Users/yamas/AI_Workspace/minpaku-v2
firebase deploy --only hosting --config firebase.relay.json --project v2-5-relay
```

### 3. 本番 minpaku-v2 へ反映（git push → GitHub Actions 自動デプロイ）

```bash
cd C:/Users/yamas/AI_Workspace/minpaku-v2
git add -A
git commit -m "$ARGUMENTS"
git push origin main
```

（コミットメッセージ未指定なら変更内容から端的に生成する）

### 4. Functions 変更を含む場合のみ

```bash
firebase deploy --only functions:<関数名> --project minpaku-v2
```

関数名を指定し、全関数の一括デプロイは避ける。

## デプロイ後の確認

- relay の URL を開いてバージョンバッジが更新後の値になっているか確認
- **スマホで表示が崩れたら、まずサイトデータ削除（キャッシュ）を案内**する
  （Firebase Hosting デプロイ後の崩れはキャッシュ起因が最多）
- 操作をユーザーに頼む場合は【スマホ】【PC】の端末ラベルと該当 URL を必ず添える

## 注意

- `docs/RELAY_ROLLBACK.md` のロールバック手順は**実行しない**（relay 恒久メイン方針）
- 確認モーダルが必要な箇所はネイティブ confirm ではなく showConfirm 等を使う（アプリ側ルール）
