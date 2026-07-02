---
name: minpaku-v2 全 URL に openExternalBrowser=1 を付与
description: minpaku-v2 アプリの URL は LINE 経由でも OS デフォルトブラウザで開かせる
type: feedback
originSessionId: 24c745bf-a6d1-4c4d-99cd-70a192bb5958
---
# v2 アプリの URL は openExternalBrowser=1 を必ず付与

minpaku-v2 アプリの URL を新規に出力する箇所 (LINE/メール/Discord 通知本文、
URL コピー、LINE 共有ボタン、フォーム URL 自動生成など) を作る時は、
`openExternalBrowser=1` を付与する。

**Why:** スタッフが LINE 内蔵ブラウザで v2 アプリを開くと、初期画面の読み込みが
永久に終わらないなど機能不全が起きるため (LIFF 導入済みでも完全には解消せず)。
LINE 公式仕様で URL に `openExternalBrowser=1` を付けると LINE 内蔵ブラウザを
バイパスして OS デフォルトブラウザで開く。

**How to apply:**
- バックエンド (Cloud Functions): `functions/utils/lineNotify.js` の
  `appendOpenExternalBrowser(text)` を `sendLineMessage` / `sendDiscord_` /
  `sendNotificationEmail_` で自動適用済み。本文に v2 URL を含めれば自動付与される。
- フロントエンド: `public/js/utils.js` の `window.withExternalBrowser(url)` を
  使う。新規の URL コピー / LINE 共有 / `window.open()` 等で必ずラップする。
- ヘルパーは v2 ドメイン (`minpaku-v2.web.app` / `firebaseapp.com`) のみを変換し、
  既に `openExternalBrowser=` がある URL はスキップ。フラグメント (`#/...`) より
  前に挿入する。
- 静的 HTML や別ドメイン URL は対象外 (LINE 内蔵ブラウザでも問題ない場合が多い)。
