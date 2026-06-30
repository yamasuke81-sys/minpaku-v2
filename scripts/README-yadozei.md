# yadozei-listener セットアップ手順

`scripts/yadozei-listener.mjs` は **PC 常駐型 Playwright デーモン**で、
Firestore の `yadozeiQueue` を監視し、Airbnb / Booking.com のホスト管理画面から
予約 CSV を自動ダウンロードして Google Drive に保存する。

最終的には `Cloud Functions の yadozeiCsvDispatcher` が毎日 04:00 JST に
キューを投入し、このリスナーが実処理を担う。

## 構成イメージ

```
Cloud Functions (Cloud Scheduler) ─── yadozeiQueue.add ───┐
                                                          ▼
                                              [PC 常駐 yadozei-listener]
                                              ├ Playwright (Chromium)
                                              │   ├ Airbnb ホスト管理 → CSV DL
                                              │   └ Booking.com extranet → xlsx DL → CSV 変換
                                              └ Google Drive API
                                                  └ 民泊宿泊税CSV/物件名/YYYY-MM/*.csv
```

## 1. 依存インストール

```powershell
cd C:\Users\yamas\AI_Workspace\minpaku-v2\scripts
npm install
```

`firebase-admin`, `playwright`, `googleapis`, `xlsx` が入る。
Playwright のブラウザバイナリも初回は自動取得される（必要なら `npx playwright install chromium`）。

## 2. サービスアカウント JSON のパスを環境変数に

Firebase Admin SDK 認証用。サービスアカウントは `minpaku-v2` プロジェクトの
Firebase Console → プロジェクト設定 → サービスアカウント から発行する。

PowerShell（現セッション限定）:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\minpaku-v2-serviceAccount.json"
```

PowerShell（恒久的に保存）:

```powershell
[Environment]::SetEnvironmentVariable("GOOGLE_APPLICATION_CREDENTIALS", "C:\path\to\minpaku-v2-serviceAccount.json", "User")
```

> サービスアカウント JSON は絶対に Git にコミットしないこと。

## 3. 初回起動 (Chromium が立ち上がる)

```powershell
cd C:\Users\yamas\AI_Workspace\minpaku-v2
node scripts/yadozei-listener.mjs
```

初回は Playwright が `%USERPROFILE%\.yadozei-playwright-chrome` を
専用 user-data-dir として作成し、Chromium をヘッドフルで起動する。

> ヘッドレス運用にしたい場合は `$env:PLAYWRIGHT_HEADLESS = "1"` を設定。
> ただし**初回ログインだけはヘッドフルで実施**してください。

## 4. 初回 手動ログイン (1度だけ)

開いた Chromium で、以下の各サイトに**手動で1度ログイン**しておく:

| サイト | URL |
|---|---|
| Airbnb (ホスト) | https://www.airbnb.com/hosting/reservations |
| Booking.com (Extranet) | https://admin.booking.com/ |
| やどぜい (F3 で使用) | https://app.yadozei.com |

ログインすると Cookie が `~/.yadozei-playwright-chrome` に保存され、
以降は自動で同じセッションが維持される。

ログインしたら一度 `Ctrl+C` で listener を停止して構わない（heartbeat は止まる）。

## 5. 常駐化 (pm2 推奨)

Windows なら pm2-windows-startup と組み合わせて自動起動できる:

```powershell
npm install -g pm2 pm2-windows-startup
pm2-startup install
pm2 start scripts/yadozei-listener.mjs --name yadozei-listener
pm2 save
```

ログ確認:

```powershell
pm2 logs yadozei-listener --lines 200
```

停止 / 再起動:

```powershell
pm2 stop  yadozei-listener
pm2 restart yadozei-listener
```

## 6. heartbeat の確認

listener が起動していれば、`settings/yadozeiListener` ドキュメントが
60 秒以内に更新される。アプリの **設定 → やどぜい状態** からも
`lastSeenAt` を確認できる（Cloud Functions 側の `/api/yadozei/state` 経由）。

Firestore コンソールから直接見たい場合:

```
settings/yadozeiListener
  ├─ lastSeenAt: <60秒以内の serverTimestamp>
  ├─ hostName:   <この PC のホスト名>
  └─ version:    "0.1.0"
```

## 7. 手動実行テスト

Cloud Functions の `/api/yadozei/run-now` (Agent A 実装) を叩くか、
Firestore コンソールで `yadozeiQueue` に直接 1 件追加してテストできる:

```js
// yadozeiQueue/{auto-id}
{
  kind: "airbnb_csv_fetch",
  propertyId: "tsZybhDMcPrxqgcRy7wp",
  propertyName: "the Terrace 長浜",
  yearMonth: "2026-05",
  params: { listingId: "12345678" },
  status: "pending",
  result: null,
  createdBy: "manual:test",
  createdAt: <serverTimestamp>,
  startedAt: null,
  completedAt: null,
  error: null,
  retries: 0
}
```

リスナーが拾うと `status: "processing" → done"` と遷移し、
`result.driveFileId` / `driveLink` / `fileName` が書かれる。

## 8. 失敗時のデバッグ

- Firestore `yadozeiQueue/{id}.error` に日本語のエラーメッセージが入る。
- セレクタ不一致など UI 関連の失敗は
  `~/.yadozei-playwright-chrome/failures/{jobId}_{tag}_{ts}.png`
  にスクリーンショットが残る。
- Airbnb / Booking.com の UI 改定でセレクタが壊れた場合は
  `handleAirbnbCsv` / `handleBookingCsv` の候補セレクタを増やす。

## 9. 注意

- このスクリプトは **1 PC に 1 インスタンス**だけ動かすこと
  （Firestore のロックは `runTransaction` で取るが、重複処理は資源の無駄）。
- やどぜいアップロード (`yadozei_csv_upload`) と申告書 PDF 取得
  (`yadozei_pdf_fetch`) は本ファイル時点では **F3 で実装** として未対応エラーを返す。
- 物件の Drive サブフォルダ ID は初回作成時に
  `properties.{pid}.yadozei.driveFolderId` に永続化される。
  フォルダを Drive 上で手動移動した場合でも、ID 参照なので継続して使える
  （Trash 行きにすると次回再作成される）。
