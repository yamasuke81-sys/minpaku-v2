# 同梱スクリプト（2026-08-10 宇品E2Eの実走版）

いずれも debug Chrome(CDP:9222) 前提・`playwright-core` は `C:/Users/yamas/.claude/scripts/node_modules` から解決。
**物件を変えて使うときは clientId(510988)・タイトル・住所・本文ファイルを書き換える**（本文=ujina_content.txt / ujina_notes.txt / komachi_automsg.txt を物件版に差し替え）。

- `timee-create-offer.mjs` — 求人ひな形の新規作成（小町テンプレ準拠）。引数なし=入力+スクショのみ、`--submit` で確定。業種/職種は MUI Select なので親要素クリック→`[role=option]` 選択
- `timee-cancel-offering.mjs` — 求人一覧(リスト表示)→最初の offering を開いて取消。`--do` で実行
- `komachi_automsg.txt` — マッチング時自動送信メッセージ（全物件共通で使い回せる文面）
- `timee-grab-qr.mjs <clientId> <out.png>` — チェックイン/アウト管理画面のQR(canvas)をPNG保存
- `upload_qr2.py` — QRを Firebase Storage `timee-qr/{pid}.png` へアップ(GCS JSON API・ダウンロードトークン付与)→ `properties.timeeQrImageUrl` 設定。★Firebase Storage v0 のmultipart直POSTは400になる=GCS API経由が正
