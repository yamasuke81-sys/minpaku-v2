# Stripe 本番切替チェックリスト

Plan B (承認後 Checkout Session 自動生成 + Webhook + 返金 API) を **本番課金**で稼働させるまでの手順。

前提: テストモード検証がすべて成功していること (`project_setouchi_stripe_payment_plan` 参照)。

## ★やますけが実施する手順

### 1. Stripe 事業者情報の入力 (本番の入金に必要)

1. https://dashboard.stripe.com/settings/account を開く
2. 事業形態: **法人 (合同会社八朔)** を選択
3. 事業内容: **宿泊業 (民泊)**
4. 事業所住所: 広島県安芸郡海田町上市4-23-12
5. 代表者情報: 西山恭介
6. **入金先の銀行口座**を登録 (合同会社八朔名義の口座)
7. 本人確認書類 (代表者の運転免許証等) をアップロード

**★税務・法務の要確認事項 (実行前に必ず確認):**
決済アカウントが **合同会社八朔名義** だが、物件ごとに運営者が違う:

- YADO KOMACHI / WAKA-KUSA = **西山恭介 (個人)** 名義の許認可
- the Terrace 長浜 / UJINA = **合同会社八朔 (法人)** 名義の許認可

「個人名義の宿の宿泊料金を法人口座で受けてよいか」を **税理士 or 行政書士に必ず確認** すること。
必要なら物件別に別 Stripe アカウントを作る (Connect の Custom Account 相当) か、
個人事業主として別途 Stripe アカウントを作る対応が要る。

### 2. 特商法・宿泊約款の支払方法の記載を確定

現状の暫定文面 (「お支払い方法および時期は承認時にご案内」) を、
確定した文面に差し替える:

- `setouchi-stay-sites/config/legal.json` の該当箇所を編集
- 例: 「クレジットカード決済 (Visa / Mastercard / JCB / American Express)。予約承認後72時間以内のオンライン決済」

### 3. 本番用 API キーの取得と投入

1. https://dashboard.stripe.com/apikeys でテスト環境トグルを**オフ** (本番環境に切替)
2. **本番用シークレットキー** (`sk_live_...`) を発行してコピー
3. ターミナルで Firebase Functions Secrets に投入:

```bash
cd /c/Users/yamas/AI_Workspace/minpaku-v2/functions
# Claude には見せずに、やますけ自身が実行すること
# (STRIPE_SECRET_KEY は既存の versions/1 がテストキー → 新 version を作って上書き)
printf '%s' '<本番sk_live_キー>' | firebase functions:secrets:set STRIPE_SECRET_KEY --data-file=- --project minpaku-v2 --force
```

### 4. 本番用 Webhook エンドポイント登録

1. https://dashboard.stripe.com/webhooks (本番モード) を開く
2. 「エンドポイントを追加」
3. エンドポイント URL: `https://asia-northeast1-minpaku-v2.cloudfunctions.net/stripeWebhook`
4. リッスンするイベント (4つ):
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `checkout.session.async_payment_failed`
   - `charge.refunded`
5. 追加後、エンドポイント詳細画面の「署名シークレット」(`whsec_...`) をコピー
6. Firebase Functions Secrets に投入:

```bash
printf '%s' '<本番whsec_>' | firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --data-file=- --project minpaku-v2 --force
```

### 5. Functions 再デプロイ (新しい secrets を適用)

```bash
cd /c/Users/yamas/AI_Workspace/minpaku-v2
firebase deploy --only functions:api,functions:stripeWebhook --project minpaku-v2
```

### 6. Firestore の paymentReturnBase を本番URLに設定 (任意)

戻り先ページは既定で `https://www.setouchi-stay.com` を使う。
別ドメインに変えたい場合のみ Firebase Console から `settings/directBooking` に
`paymentReturnBase: "https://<ドメイン>"` を設定。

### 7. 動作確認 (少額の実予約1件)

1. 予約サイトから自分自身でリクエスト送信 (安全のため小町の1泊分など少額日程)
2. app.setouchi-stay.com で承認
3. 承認確定メールに本番 Payment Link が来ることを確認
4. 実際のカードで少額決済
5. Firestore の `bookings/direct-*.paymentStatus` が `paid` になることを確認
6. Stripe ダッシュボードで入金予定を確認
7. 全額返金して原状復帰

## ★確認ポイント (すべて OK になってから本番開始)

- [ ] 事業者情報入力・本人確認書類承認済み (Stripe から確認メール)
- [ ] `charges_enabled: true` (Stripe ダッシュボード「本番環境」に緑チェック)
- [ ] 本番 API キー投入完了
- [ ] Webhook エンドポイント登録済み・署名シークレット投入完了
- [ ] `functions:api` `functions:stripeWebhook` が新 secrets 版でデプロイ済み
- [ ] 特商法・宿泊約款の記載が最新
- [ ] 少額実予約1件で通し検証完了
- [ ] 個人名義宿と法人口座の受領可否について税理士確認済み

## 参考 (Plan A に戻したいとき)

`STRIPE_SECRET_KEY` を空にする or 削除すると、承認 API は決済無しモードにフォールバックし、
確定メールは暫定文面に戻る。手動 Invoice 運用に戻せる。

```bash
firebase functions:secrets:destroy STRIPE_SECRET_KEY --project minpaku-v2
firebase deploy --only functions:api --project minpaku-v2
```
