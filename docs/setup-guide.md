# セットアップガイド

## 初回セットアップ

```bash
# 1. Firebase CLI インストール（未インストールの場合）
npm install -g firebase-tools

# 2. Firebase ログイン
firebase login

# 3. 依存パッケージインストール
cd functions && npm install
```

---

## Firebase Emulator Suite 起動手順

ローカル開発では本番 Firebase に接続せず Emulator を使う。

### 1. Emulator 起動

```bash
cd functions
npm run emu:start
```

起動後、以下のポートが利用可能になる:

| サービス | URL |
|---|---|
| アプリ (Hosting) | http://127.0.0.1:5000 |
| Emulator UI | http://127.0.0.1:4000 |
| Firestore | 127.0.0.1:8080 |
| Auth | 127.0.0.1:9099 |
| Functions | 127.0.0.1:5001 |

### 2. テストデータ投入（別ターミナル）

Emulator が完全に起動してから実行する。

```bash
cd functions
npm run emu:seed
```

seed 完了後にコンソールへ件数サマリーが出力される。

### 3. アプリを開く

http://127.0.0.1:5000 をブラウザで開く。

`localhost` または `127.0.0.1` でアクセスすると自動的に Emulator に接続される（`firebase-config.js` の `USE_EMULATOR` 判定）。

### 4. Emulator UI でデータ確認

http://127.0.0.1:4000 → Firestore タブでシードデータを確認できる。

### Emulator データのリセット

```bash
cd functions
npm run emu:reset   # .emulator-data/ を削除
npm run emu:start   # 再起動してクリーンな状態から始める
```

---

## 既知の制約

| 機能 | Emulator 上の動作 |
|---|---|
| LINE Login | 動作しない（LINE 側のコールバック URL が本番向けのため） |
| LINE/Discord 実送信 | スキップされ、コンソールに `[EMULATOR] would send ...` と出力される |
| Gmail 送信 | スキップされ、コンソールにログ出力される |
| BEDS24 API 同期 | 本番 API に接続するため、テスト用シードデータで代替する |

---

## 本番デプロイ

```bash
# Hosting + Functions を一括デプロイ
firebase deploy

# Hosting のみ
firebase deploy --only hosting

# Functions のみ
firebase deploy --only functions
```

main ブランチへの push で GitHub Actions が自動デプロイを実行する（`.github/workflows/deploy.yml` 参照）。
