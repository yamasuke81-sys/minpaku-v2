---
name: ネイティブ confirm/alert/prompt を使わない
description: Web 画面で window.confirm()/alert()/prompt() を避け、Bootstrap モーダルベースの showConfirm/showAlert/showPrompt を使う。
type: feedback
originSessionId: e43653b9-a405-4974-b12b-371226fe20dd
---
ブラウザ標準の確認ダイアログ (例: 「minpaku-v2.web.app の内容: … [OK][キャンセル]」) は**今後使わない**。

**Why:** やますけが 2026-04-17 にスクショ付きで「この表示方法、今後は全部やめて」と明示。意匠がブラウザ依存で統一感がなく、モバイルでの操作性も悪い。

**How to apply:**
- minpaku-v2 では `public/js/app.js` に `showConfirm(message, opts)` / `showAlert(message, opts)` / `showPrompt(message, opts)` の3ユーティリティを用意済み。いずれも Bootstrap モーダルベース、Promise を返す。
- 新規コードで確認/入力が必要なときは必ずこれらを使う。`window.confirm()` / `alert()` / `prompt()` は禁止。
- 既存コード内の `confirm()` / `prompt()` は段階的に置換 (2026-04-17 時点で 30 箇所弱残存)。「これ直して」と指示された箇所から優先対応。
- 他プロジェクトでも同様の方針を取るのが望ましい (統一感 + モバイル操作性)。

使用例:
```js
// confirm の置換
const ok = await showConfirm("本当に削除しますか？", { okLabel: "削除する", okClass: "btn-danger" });
if (!ok) return;

// alert の置換
await showAlert("保存しました");

// prompt の置換
const name = await showPrompt("名前を入力してください", { defaultValue: "匿名" });
if (name == null) return; // キャンセル
```
