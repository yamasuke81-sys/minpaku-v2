# 民泊管理v2（minpaku-v2）

民泊管理アプリ。Firebase Hosting + Cloud Functions Gen2 + Firestore + Storage、フロントは Vanilla JS + Bootstrap 5 の SPA。本番稼働中のメイン。
予約（iCal 同期: Airbnb + Booking.com）→ 清掃募集 → シフト → チェックリスト → 請求書 → 通知（LINE/メール/Discord）を自動化。

## 🚩 本番メインは v2-5-relay（恒久・2026-06-08 ユーザー決定）

- **本番メイン = `https://v2-5-relay.web.app`**。`minpaku-v2.web.app` は使わない（T&S 凍結中。解除後も relay をメインとする）
- フロント変更は**両方にデプロイ**（relay 優先・必須）:
  - relay: `firebase deploy --only hosting --config firebase.relay.json --project v2-5-relay`
  - 本番: `git push origin main`（GitHub Actions が minpaku-v2 hosting へ自動デプロイ）
- Functions/Firestore/Storage/Auth は両 site 共用（`firebase deploy --only functions:<name> --project minpaku-v2`）
- `settings/notifications.appUrl` は **relay 固定**。`watchHostingRecovery` は復活検知しても戻さない（通知のみ）
- `docs/RELAY_ROLLBACK.md` の手順は**実行しない**。Storage CORS に v2-5-relay.web.app 追加済

## 重要 ID・定数

- プロジェクト: `minpaku-v2` / region: `asia-northeast1`（**全関数必須**）/ API: `https://api-5qrfx7ujcq-an.a.run.app`
- オーナー（やますけ）: UID `rwHczfRz8DfnWCrQ7yeAYnsd8in2` / staffId `ziTig6tefnj5NvkgN4fG` / LINE `Udbab64896647a69a7ad87a1baf1253dc`
- LINE Login チャネル: `2009790221` / Bot#1 Group `Cf18500a95f7b71b786fc0c45684ac1bb` / Bot#2 `@485vxmym`（長浜清掃G通知#2）
- 宿泊者名簿スプシ: `1Kk8VZrMQoJwmNk4OZKVQ9riufiCEcVPi_xmYHHnHgCs`
- 物件 ID（物理物件ごとに別レコード。全 active）:
  - #1 YADO KOMACHI Hiroshima: `ncUKeD4yQo0kfAoznITu`
  - #2 Pocket House WAKA-KUSA: `RZV9IwtQgMAsvrdM3j8J`
  - #3 UJINA Pocket House: `ZXW6wdpnBFk1azQ87KXQ`
  - #4 the Terrace 長浜: `tsZybhDMcPrxqgcRy7wp`
- Gmail 2系統: `81hassac@gmail.com`＝民泊事業用・OTA 通知（メール照合の巡回対象）/ `yamasuke81@gmail.com`＝個人・税理士資料用（対象外）

## 絶対ルール（事故防止）

### ロールバック禁止コミット（再実装でも後退させない・ユーザー明示）
- `e51e870` /api prefix 剥がし（全 API の要）
- `8b9cebf` 請求書ロジック刷新（階段制/特別加算等）
- `4715395` 請求書 PDF フォント/送信先/保存修正
- `2ef8efd` guest-form 動的描画
- `d5821ca` 騒音同意の物件別化
- `96c7458` LINE Bot fallback + recruit_response
- `776ced2` ランドリー重複解消 + paymentMethod 分岐
- `23784b8` 請求書除外機能 + 物件別化
- `eb00bf5` PDF プレビュー
- `61a0611` 宛名オーナー化 + 除外反映
- `1c7f9a7` 複数名義 billingProfiles
- 2026-04-23群（ラベル詳細は memory `project_minpaku_v2_context.md`）:
  - `8720f5c` 代理閲覧フィルタ / `cdff733` 物件完全削除 / `a7ab420` 様·御中切替 / `3f17b12` 物件並び替え
  - `ecff2dd` 名簿 propertyId 推論 / `0b347ea` PasswordCredential / `307e4ff` `74cf9ca` フォーム項目管理
  - `63ec3b6` チェックリスト管理画面 / `d7ae2b7` 重複 shifts 清掃 / `d29fc9d` `1c7915f` 横カレンダー修正
  - `c0bc74b` `4ca0287` `296966f` モーダル大改修 / `2e3c40c` `ea86e42` #/schedule 統合

### 変更禁止ファイル
- **`gas-scripts/syncGuestFormToV2.gs`** — 105 列対応版。ユーザーが Apps Script へ貼り替え運用。明示指示なしで触らない

### コーディング・運用ルール
- JS/CSS 変更時は **`node scripts/bump-version.mjs`** で index.html の `?v=`・バッジ・version.json を自動同期（手動置換禁止。不整合は asset-version-guard フックが push/deploy をブロック）
- ネイティブ confirm/alert/prompt 禁止 → `app.js` の showConfirm/showAlert/showPrompt を使う
- v2 URL を出力する箇所は `openExternalBrowser=1` 必須（lineNotify / withExternalBrowser で自動付与）
- チェックリスト UI は **3 面**（my-checklist.js / property-checklist.js / guest-checklist.html）を同時に揃える
- Firestore 複合クエリ追加時は firestore.indexes.json を同コミットで更新
- 通知の部分不達はまず OOM を疑う
- その他の詳細ルールは `.claude/rules/`（自動ロード）と memory を参照

## デプロイ

- 正規手順は **`/deploy-v2` スキル**（bump → relay デプロイ → git push → Actions success 確認）。手順省略禁止
- バージョン形式: `v{MMDD}{連番アルファベット}`（例 v0702a）
- push 後は GitHub Actions が success になるまで確認（一時失敗は `gh run rerun`）

## 宿泊税 CSV 自動化（yadozei・開発中）

- worktree **`../minpaku-v2-yadozei`**（`feature/yadozei-csv`、未マージ）で開発。F1+F2 完成、F3（やどぜいアップロード+申告 PDF）未実装
- 構成: `yadozeiCsvDispatcher`（毎日 04:00 JST）が `yadozeiQueue` に投入 → PC 常駐 **PM2 `yadozei-listener`**（Playwright）が Airbnb/Booking の予約 CSV を DL → Drive `民泊宿泊税CSV/物件名/YYYY-MM/` へ保存
- listener は **1 PC 1 インスタンス**。heartbeat = Firestore `settings/yadozeiListener`（60 秒毎）
- セットアップ・初回ログイン・デバッグ手順は **`scripts/README-yadozei.md`**

## ドキュメント（必要時に読む）

- [docs/design/architecture.md](docs/design/architecture.md) — 当初設計（機能一覧/UI/BEDS24 構想 ※実装は iCal 同期）
- [docs/design/db-schema.md](docs/design/db-schema.md) — Firestore 当初スキーマ（実フィールドはコードで裏取り）
- [docs/history/implementation-log.md](docs/history/implementation-log.md) — P0〜P3 実装完了記録（2026-04）
- docs/*.md — 機能別セットアップ（setup-guide / liff-setup 等）
- 実装済み機能一覧・ユーザー作業待ち・既知の制約は memory `project_minpaku_v2_context.md`
