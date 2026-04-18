# マジックリンク認証 (Email Link Sign-in) セットアップ手順

## 概要

スタッフがLINEアカウントなしでもメールアドレスだけでログインできる認証方法の設定手順です。
既存のLINEログインと併設され、スタッフが選択できます。

---

## ステップ 1: Firebase Console で Email Link Sign-in を有効化

1. [Firebase Console](https://console.firebase.google.com/) → プロジェクト `minpaku-v2` を選択
2. 左メニュー「Authentication」→「Sign-in method」タブ
3. 「メール/パスワード」をクリック → 展開されたオプションで **「メールリンク（パスワードなしのログイン）」** を有効にする
4. 「保存」をクリック

---

## ステップ 2: 承認済みドメインを確認

1. 「Authentication」→「Settings」→「承認済みドメイン」
2. 以下のドメインが含まれていることを確認（通常は自動追加済み）:
   - `minpaku-v2.web.app`
   - `minpaku-v2.firebaseapp.com`
   - `localhost`（開発用）

含まれていない場合は「ドメインを追加」から追加してください。

---

## ステップ 3: デプロイ

```bash
cd /c/Users/yamas/AI_Workspace/minpaku-v2
firebase deploy --only hosting,functions
```

---

## ステップ 4: 動作確認

### スタッフログインフロー
1. https://minpaku-v2.web.app にアクセス
2. ログイン画面で「メールでログイン（スタッフ用）」ボタンをクリック
3. メールアドレスを入力して「送信」
4. メール受信 → リンクをクリック → `/email-signin.html` にリダイレクト
5. 自動ログイン → マイページへ遷移

### 招待リンク経由のフロー
1. オーナーがスタッフ管理画面から「招待リンク発行」
2. スタッフが `/invite.html?token=xxx` を開く
3. 「メールで参加する」ボタンをクリック → メールアドレス入力 → 送信
4. メール受信 → リンクをクリック → `/email-signin.html?inviteToken=xxx` にリダイレクト
5. 招待受諾API (`POST /api/auth/accept-invite-email`) が実行され、role:staff + staffId クレームが付与される
6. マイページへ遷移

---

## 注意事項

- メールリンクの有効期限はFirebaseのデフォルト（**1時間**）です
- 同一デバイスで送信・受信する場合はlocalStorageのメールアドレスが自動使用されます
- **別デバイスで受信した場合**（例: PCで送信→スマホで受信）はメールアドレス入力画面が表示されます
- LINEログインを廃止する必要はありません。両方併用できます

---

## トラブルシューティング

| エラー | 原因 | 対処 |
|--------|------|------|
| `auth/operation-not-allowed` | Email Link Sign-inが無効 | ステップ1を実施 |
| `auth/invalid-action-code` | リンク期限切れ or 使用済み | 再度ログインメール送信 |
| ログイン後にstaffページに遷移しない | カスタムクレームが未設定 | 招待トークン経由での登録を使用 |
