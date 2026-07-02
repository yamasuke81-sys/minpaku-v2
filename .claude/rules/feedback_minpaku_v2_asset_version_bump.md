---
name: minpaku-v2-asset-version-bump
description: minpaku-v2 で JS/CSS を変更したら、デプロイ前に必ず index.html のバージョン文字列(?v= と appVersion バッジ)と public/version.json を3点セットで揃える。version.json 忘れは無限リロード事故になる(2026-06-01, 2026-06-07 と2回発生)
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0f15a900-f816-4a2e-b6c7-e0618fd47780
---

minpaku-v2 で public/js/*.js や css を変更したら、**必ず index.html のアセットバージョン文字列を更新してからデプロイする**。

- index.html の全 script/link が `?v=vMMDD連番` でキャッシュバスティングしている（例 `js/api.js?v=v0531e`）。約49箇所が同一文字列で統一され、画面右上の `id="appVersionMobile"` バッジも同じ値
- 更新は `replace_all` で旧バージョン文字列 → 新バージョン（フォーマット `vMMDD連番`、例 v0601a）に一括置換
- ブラウザは URL(クエリ含む)単位でキャッシュするため、`?v=` が同じだと JS の中身を変えても**古いキャッシュが使われ続け、変更が一切配信されない**
- **`public/version.json` も必ず同じ値に更新する**。index.html の checkVersion() が version.json の `version` と画面内 CURRENT(=appVersionMobileバッジ) を10秒/60秒毎に比較し、不一致だと「新しいバージョンに自動更新します」→forceReload を**無限ループ**する。2026-06-01、index.html を v0601a に上げたが version.json を v0531e のまま放置し、数秒おきに画面がリフレッシュし続ける事故が発生

**Why:** 2026-06-01、api.js と my-checklist.js を修正してデプロイしたのにバージョン文字列を更新せず、ユーザーのブラウザが古い JS を使い続けて「直っていない」状態が2回続いた。GitHub Actions のデプロイ成功＝配信完了ではない。

**How to apply:** minpaku-v2 で JS/CSS を変更する全タスクで、commit に index.html のバージョン更新を必ず含める。SPA なのでユーザー側はページ再読込が必要。反映確認はバージョンバッジの値で行う。関連: [[feedback-deploy]] [[feedback-mobile-cache-clear-after-deploy]]

**2026-06-13 重要度アップ:** JS/CSS の Cache-Control を `max-age=1年, immutable` に変更した（起動高速化）。以前は no-cache 再検証だったため ?v= 更新忘れでも次のアクセスで新内容が届いたが、**今後は更新忘れ＝同一URLのキャッシュが最大1年固定され、変更が永久に配信されない**。バンプは絶対に省略不可。index.html 以外の HTML (guest-form/invite/email-signin 等) のローカル JS 参照にも全て ?v= が付いている — 新しい script タグを書くときは必ず ?v= を付けること（付け忘れた URL は一度配信されると更新不能になる）。

**2026-06-28 自動化＋ブロック導入（今後はこれを使う）:** version.json 揃え忘れ無限リロードが**3回目**再発（index v0628b / version.json v0626n のまま）。手動 sed は事故の元なので廃止し、機械的に強制する仕組みを実装:
- **`node scripts/bump-version.mjs`** … index.html の全 ?v=・版数バッジ・version.json を1つの新トークン(vMMDDx)に**自動同期**。版数更新は今後これ一本（手動置換しない）。
- **`.claude/hooks/asset-version-guard.mjs`**（PreToolUse/Bash, settings.json登録済）… `git push`/`firebase deploy` 直前に index.html↔version.json の版数不整合を検知したら **deny でブロック**。整合なら素通り（実証済）。
- **`/deploy-v2` スキル**（.claude/skills/deploy-v2）… bump→relay必須→本番git push→Actions確認 の正規手順。デプロイはこれを使う。
- 教訓: リマインダー(PostToolUseでテキスト表示)やスキル/メモリは「情報を出すだけ」で忘却を防げない（現にリマインダーフックがあったのに見落とした）。**忘却を確実に防ぐのはハーネスが強制実行する仕組み = 自動化スクリプト＋ブロッキングフック**。
