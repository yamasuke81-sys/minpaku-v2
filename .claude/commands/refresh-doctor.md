---
description: 「古い画面が残る/反映されない」系の症状（コード未反映・新規スタッフ名が出ない・確定状態が古い）を切り分け、確実に直す
argument-hint: [症状の簡単な説明]
allowed-tools: Bash, Read, Edit, Grep
---

# /refresh-doctor

minpaku-v2 で繰り返し起きる「キャッシュ/反映」系トラブルを、原因別に切り分けて直すための playbook。
症状を聞いたら、まず下の「症状→原因マップ」で当たりをつけ、該当節の手順で確認・修正する。

## 大前提（このアプリのキャッシュ機構）

- **コード更新の自動反映**: `index.html` 内のバージョン自動チェック（10秒後/1分おき/タブ復帰/ハッシュ遷移）が
  `/version.json` の `version` と画面バッジ `#appVersionMobile` を比較し、不一致なら
  SWキャッシュ削除 + SW unregister + `?_cb` 付きで強制リロードする（`index.html` 末尾の IIFE）。
- **リフレッシュボタン**: 右上 `#btnReloadCacheTop` / サイドバー最下部 `#btnReloadCache` →
  `auth.js` の `reloadHandler`（caches削除 + SW unregister + `?_cb` + `location.replace`）。
- **データ（スタッフ等）はバージョンに連動しない**: スタッフ追加や確定状態の変更では `version.json` は変わらないので
  **コードの自動更新は発火しない**。データのstaleさはメモリキャッシュ/トークンの問題として別に潰す。

## 症状 → 原因マップ

| 症状 | 第一容疑 | 節 |
|---|---|---|
| 新規スタッフ本人の名前が自分の画面に出ない（LINEログイン直後） | IDトークンのカスタムクレーム未反映 | A |
| 他人が追加した新規スタッフが、開きっぱなしの画面に出ない | メモリキャッシュ `this.staffList` | B |
| コード修正が反映されない / 無限リロードする | `version.json` と `?v=`/バッジの不一致 | C |
| 「最新版に更新」を押しても直らない | SW/HTTPキャッシュ or 上記Aの混在 | D |

---

## A. 新規スタッフ本人の名前が出ない（最頻・最重要）

**原因**: LINE連携でサーバ側に付与したカスタムクレーム（`staffId`/`role`）は、クライアントのIDトークンが
更新されるまで乗らない。`auth.js` の `getIdTokenResult()` を**強制更新なし**で呼ぶと古いトークンを読み、
`Auth.currentUser.staffId = null` になる → `my-recruitment.js` の「自分は必ず表示」が発火せず本人行が消える。
リロード連打で偶然トークンが更新されて直る、という症状になる。

**確認**:
```bash
grep -n "getIdTokenResult" public/js/auth.js
```
`onAuthStateChanged` 内が `getIdTokenResult(true)`（強制更新）になっているか。なっていなければ下記に修正。

**修正**（`auth.js`、2026-06-09 適用済の正しい形）:
```js
user.getIdTokenResult(true)
  .catch(() => user.getIdTokenResult())   // オフライン等はキャッシュにフォールバック
  .then((result) => {
    this.currentUser.role = result.claims.role || "owner";
    this.currentUser.staffId = result.claims.staffId || null;
    this.currentUser.ownedPropertyIds = result.claims.ownedPropertyIds || [];
    App.onAuthReady();
  });
```
それでも稀に伝播ラグで出ない場合は、クレームを**付与する側**（招待受諾/LINE連携のバックエンド）が
custom token を発行する直前に `setCustomUserClaims` を完了させているか、`functions/api/auth.js` を確認。

## B. 他人が追加した新規スタッフが既存画面に出ない

**原因**: `API.staff.list()` は毎回 Firestore を引くが、各ページは結果を `this.staffList` にメモリ保持して
使い回す（`recruitment.js` / `my-recruitment.js`）。開きっぱなしだと再取得されない。
（Firestore の IndexedDB 永続化は**未有効**なので、フルリロードすればサーバ最新が取れる。）

**当座の対処**: 対象画面でリフレッシュボタン or 一度別ページへ遷移して戻る。

**恒久対処（任意・未実装）**: 回答/清掃モーダルを開くたびに `API.staff.list()` を呼び直す、
または `staff` コレクションに onSnapshot を張って自動再描画する。実装する際はユーザー確認の上で。

## C. コードが反映されない / 無限リロード

**原因**: `index.html` の `?v=` とバッジ `#appVersionMobile`、`public/version.json` の3つが**不一致**。
バッジ＞version.json なら反映されない、version.json＞バッジなら無限リロード（`43534aa`/`0f9d18a` で再発した罠）。

**確認**:
```bash
grep -o 'id="appVersionMobile">[^<]*' public/index.html
cat public/version.json
grep -c "$(grep -o 'id=\"appVersionMobile\">[^<]*' public/index.html | sed 's/.*>//')" public/index.html
```
バッジ値・version.json・`?v=` の出現数がすべて揃っているか。`/deploy-v2` の手順1が正しく実施されたか。

**修正**: `?v=`・バッジ・version.json をすべて同じ新バージョン（`v{MMDD}{連番}`）に揃えて再デプロイ。

## D. 「最新版に更新」を押しても直らない

1. まず **A** を疑う（クレーム問題はキャッシュ削除では直らない。トークン強制更新が要る）。
2. スマホは Safari/Chrome の「サイトデータ削除」を案内（Firebase Hosting デプロイ後の崩れはこれが最多）。
   操作依頼時は【スマホ】【PC】ラベルと該当 URL を必ず添える。
3. それでも駄目なら **C** のバージョン不一致を確認。

## 修正後

- JS/CSS を触ったら必ず `/deploy-v2`（`?v=`+バッジ+version.json を揃える → relay + 本番 + 必要なら functions）。
- 認証/クレーム周りを直したら、新規スタッフ1名で実機（iPhone LINEログイン）の初回表示を確認してもらう。
