# LIFF セットアップ手順

スタッフが LINE アプリから直接アプリを開いて自動ログインできるようにするための設定手順です。

## 前提条件

- LINE Developers Console にアクセスできること
- 民泊管理v2 スタッフログイン用の LINE Login チャネル (チャネルID: 2009790221) が存在すること

---

## 1. LIFF アプリを追加する

1. [LINE Developers Console](https://developers.line.biz/console/) を開いてログイン
2. プロバイダー「長浜清掃G通知」をクリック
3. **「民泊管理v2 スタッフログイン」チャネル** (チャネルID: 2009790221) をクリック
4. 上部タブの「**LIFF**」をクリック
5. 「**追加**」ボタンをクリック
6. 以下の設定を入力:

| 項目 | 値 |
|------|-----|
| LIFF 名 | 民泊管理v2 スタッフ |
| サイズ | **Full** |
| エンドポイントURL | `https://minpaku-v2.web.app/` |
| Scope | `profile` と `openid` の両方をチェック |
| ボットリンク機能 | On (Aggressive) |

7. 「追加」ボタンで保存
8. 追加完了後、一覧に LIFF アプリが表示される
9. **LIFF URL** (`https://liff.line.me/XXXXX-YYYYY`) と **LIFF ID** (`XXXXX-YYYYY`) を控えておく

---

## 2. LIFF ID をアプリに設定する

`public/js/firebase-config.js` を開き、末尾の `window.LIFF_ID` に LIFF ID を設定します:

```js
// 変更前
window.LIFF_ID = "";

// 変更後（例）
window.LIFF_ID = "2009790221-AbCdEfGh";
```

---

## 3. 再デプロイ

```bash
firebase deploy --only hosting
```

または Functions も含めてデプロイ:

```bash
firebase deploy --only functions,hosting
```

---

## 4. スタッフに LIFF URL を案内する

スタッフに以下を伝えてください:

> LINE アプリで以下の URL をタップしてください。LINE内ブラウザで自動ログインできます。
> `https://liff.line.me/XXXXX-YYYYY`

LINEグループに投稿するか、招待メッセージに含めてください。

---

## 動作の仕組み

| アクセス方法 | 動作 |
|-------------|------|
| LIFF URL から LINE アプリで開く | LINE 内蔵ブラウザで起動 → 自動ログイン（新タブ不要・再ログイン不要） |
| ブックマーク / ブラウザから直接開く | 従来通り（LINEログインボタン or メール/パスワード） |

---

## 注意事項

- LIFF を使うには、スタッフの `lineUserId` が Firestore の staff コレクションに登録されている必要があります
- `lineUserId` 未登録のスタッフは、まず既存の招待リンクフロー（invite.html）で登録してください
- LIFF_ID が空文字の場合、LIFF 初期化は完全にスキップされます（従来動作に影響なし）
