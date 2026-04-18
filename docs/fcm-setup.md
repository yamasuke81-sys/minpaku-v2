# FCM (Firebase Cloud Messaging) セットアップ手順

## 概要

Web Push通知をスタッフ・オーナーに送信できるようにする設定手順です。
LINE月間200通制限の補完として、FCM/メール/LINEの3チャネル併用が目的です。

---

## ステップ 1: VAPIDキーの生成

1. [Firebase Console](https://console.firebase.google.com/) → プロジェクト `minpaku-v2` を選択
2. 左メニュー「プロジェクトの設定」(歯車アイコン) → 「Cloud Messaging」タブ
3. 「ウェブ プッシュ証明書」セクションの「鍵ペアを生成」をクリック
4. 生成された **公開鍵 (Base64文字列)** をコピーする

---

## ステップ 2: VAPIDキーをアプリに設定

`public/js/fcm-client.js` の先頭部分を編集:

```js
VAPID_KEY: window.FCM_VAPID_KEY || "",
```

↓ 以下のように直接設定するか、`public/js/firebase-config.js` に追記:

**方法A: firebase-config.js に追記（推奨）**

```js
// firebase-config.js の末尾に追加
window.FCM_VAPID_KEY = "ここに生成した公開鍵を貼り付け";
```

**方法B: fcm-client.js に直接設定**

```js
VAPID_KEY: "ここに生成した公開鍵を貼り付け",
```

---

## ステップ 3: デプロイ

```bash
cd /c/Users/yamas/AI_Workspace/minpaku-v2
firebase deploy --only hosting
```

---

## ステップ 4: 動作確認

1. https://minpaku-v2.web.app にアクセス
2. ログイン後、マイページまたはダッシュボードで「通知をオンにする」バナーが表示されることを確認
3. 「通知をオンにする」をクリック → ブラウザの通知許可ダイアログで「許可」
4. FCMトークンがFirestoreに保存されることを確認（スタッフ: `staff/{id}.fcmTokens`, オーナー: `settings/fcmTokens.ownerTokens`）

---

## ステップ 5: テスト送信（cURLコマンド）

Firebase Admin SDKを使ってテスト通知を送る場合（Functions内から）:

```bash
# Cloud Functionsのエミュレータを起動
cd functions
npm run emu:start

# テスト送信（curlでAPIを叩く例）
curl -X POST http://localhost:5001/minpaku-v2/asia-northeast1/api/notifications/test-fcm \
  -H "Authorization: Bearer test-token" \
  -H "Content-Type: application/json" \
  -d '{"title":"テスト通知","body":"FCM動作確認"}'
```

---

## 通知チャネルの設定（Firestore）

通知設定画面（`#/notifications`）から、通知種別ごとに `fcmStaff` / `fcmOwner` フラグを設定できます。

Firestoreの `settings/notifications.channels` に以下のフラグが追加されています:

| フラグ名 | 説明 |
|---------|------|
| `fcmStaff` | 全アクティブスタッフにFCM送信 |
| `fcmOwner` | オーナーにFCM送信 |

---

## 注意事項

- VAPIDキーは **公開鍵なので秘密情報ではありません**。ソースコードに含めて問題ありません。
- iOS Safari (16.4以降) + ホーム画面追加済み の場合のみWeb Pushが動作します。
- Chromeデスクトップ・Androidは通常通り動作します。
- Service Worker (`/firebase-messaging-sw.js`) はHTTPS必須です（localhostは例外）。
