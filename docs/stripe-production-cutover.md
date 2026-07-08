# Stripe 本番切替チェックリスト (2アカウント対応版)

Plan B (承認後 Checkout Session 自動生成 + Webhook + 返金 API) を **本番課金**で稼働させるまでの手順。

前提: テストモード検証がすべて成功していること (`project_setouchi_stripe_payment_plan` 参照)。

## ★ 2アカウント体制 (2026-07-08〜)

物件によって Stripe アカウントを 2 つに振り分ける。運営者(=売上帰属)が違うため。

| accountKind | 事業者 | Stripe アカウント ID | 入金先口座 | 対象物件 |
|-------------|--------|---------------------|------------|----------|
| individual  | 西山恭介 (個人事業主) | `acct_1Tqet7AoOutkYY4H` | 楽天ハープ222 普通 5008119 | YADO KOMACHI (`RZV9IwtQgMAsvrdM3j8J`) / WAKA-KUSA (`ZXW6wdpnBFk1azQ87KXQ`) |
| corporate   | 合同会社八朔 (法人)  | `acct_1TIZYiIpGeRzVeLg` | 楽天 第三営業支店 普通 7044309 | the Terrace 長浜 (`tsZybhDMcPrxqgcRy7wp`) / UJINA (`ncUKeD4yQo0kfAoznITu`) |

- 振り分けは `functions/utils/stripe.js` の `PROPERTY_TO_STRIPE_ACCOUNT` マップで定義。将来 Firestore へ外出しする余地は残す。
- 未マップの物件 (秋津 / 竹原 / 音戸など将来物件) は `corporate` にフォールバック。当面は宿サイト側で決済フォームを出さない運用のため実害は出ない。

## ★ Secrets 4本

| Secret 名 | 用途 |
|-----------|------|
| `STRIPE_SECRET_KEY` | corporate(=八朔) の Stripe 秘密鍵 |
| `STRIPE_WEBHOOK_SECRET` | corporate 用 Webhook 署名シークレット |
| `STRIPE_SECRET_KEY_INDIVIDUAL` | individual(=恭介個人) の Stripe 秘密鍵 |
| `STRIPE_WEBHOOK_SECRET_INDIVIDUAL` | individual 用 Webhook 署名シークレット |

- **どちらか片方だけの設定でも動作する** (段階切替可能)。未設定側の accountKind は
  `isEnabled:false` となり、対応する物件の承認は決済リンク無しモード(暫定文面)にフォールバック。
- 「先に個人だけ本番化」も可能: 個人だけ本番投入 → 法人は未設定のまま置くと、
  法人物件は「決済無しモード or allowTestCheckout ガードによる暫定文面」で運用継続する。

## ★前提: テスト鍵での E2E 継続には allowTestCheckout フラグが必要

テストモード (`sk_test_` キー) のまま承認→Checkout の通し検証を続ける場合、
Firestore `settings/directBooking` に **`allowTestCheckout: true`** を投入しておく必要がある。

- ガードは accountKind ごとに独立に評価される。個人=テスト鍵 / 法人=本番鍵 の混在状態でも、
  個人物件だけ allowTestCheckout ガードが働き、法人物件は通常どおり本番決済リンクを生成する。
- 投入方法: Firebase Console → Firestore → `settings/directBooking` に
  `allowTestCheckout` (boolean) = `true` を追加。
- **本番切替 (`sk_live_` 鍵) 後はこのフラグは無視される** (本番鍵は `isLive=true` で自動有効化)。
  両アカウントとも本番化した後の後始末で削除する (下記「確認ポイント」参照)。

## ★やますけが実施する手順

### 1. Stripe 事業者情報の入力 (両アカウントで実施)

各アカウント (法人=八朔 / 個人=恭介個人事業) で:

1. https://dashboard.stripe.com/settings/account を開く (アカウント切替に注意)
2. 事業形態: **法人** または **個人事業主** を選択
3. 事業内容: **宿泊業 (民泊)**
4. 事業所住所: 広島県安芸郡海田町上市4-23-12
5. 代表者情報: 西山恭介
6. **入金先の銀行口座**を登録
   - individual: 楽天ハープ222 普通 5008119
   - corporate: 楽天 第三営業支店 普通 7044309
7. 本人確認書類 (代表者の運転免許証等) をアップロード

### 2. 特商法・宿泊約款の支払方法の記載を確定

現状の暫定文面 (「お支払い方法および時期は承認時にご案内」) を、
確定した文面に差し替える:

- `setouchi-stay-sites/config/legal.json` の該当箇所を編集
- 例: 「クレジットカード決済 (Visa / Mastercard / JCB / American Express)。予約承認後72時間以内のオンライン決済」

### 3. 本番用 API キーの取得と投入 (アカウント別)

**Stripe ダッシュボードで対象アカウントに切り替えてから**キーを発行する。両アカウントとも実施する場合は交互に。

#### 3-a. 法人 (corporate) = 八朔

1. Stripe ダッシュボード左上のアカウント切替で「合同会社八朔」を選択
2. https://dashboard.stripe.com/apikeys で本番モード (テストトグルオフ)
3. **本番用シークレットキー** (`sk_live_...`) を発行してコピー
4. Firebase Functions Secrets へ投入:

```bash
cd /c/Users/yamas/AI_Workspace/minpaku-v2/functions
# Claude には見せずに、やますけ自身が実行すること
printf '%s' '<法人 sk_live_...>' | firebase functions:secrets:set STRIPE_SECRET_KEY --data-file=- --project minpaku-v2 --force
```

#### 3-b. 個人事業 (individual) = 恭介

1. Stripe ダッシュボード左上のアカウント切替で「西山恭介 個人事業」を選択
2. https://dashboard.stripe.com/apikeys で本番モード (テストトグルオフ)
3. **本番用シークレットキー** (`sk_live_...`) を発行してコピー
4. Firebase Functions Secrets へ投入:

```bash
printf '%s' '<個人 sk_live_...>' | firebase functions:secrets:set STRIPE_SECRET_KEY_INDIVIDUAL --data-file=- --project minpaku-v2 --force
```

### 4. 本番用 Webhook エンドポイント登録 (両アカウントとも同じ URL を登録)

Webhook エンドポイントは **両アカウントとも同じ URL** を登録する。それぞれ別の署名シークレットが払い出されるので、両方を Secrets に投入する。
`functions/stripeWebhook.js` は両シークレットで順に `constructEvent` を試行し、成功した方の accountKind でイベントを処理する。

#### 4-a. 法人 (corporate)

1. アカウント切替で「合同会社八朔」を選択
2. https://dashboard.stripe.com/webhooks (本番モード) を開く
3. 「エンドポイントを追加」
4. エンドポイント URL: `https://asia-northeast1-minpaku-v2.cloudfunctions.net/stripeWebhook`
5. リッスンするイベント (5つ):
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.expired`
   - `checkout.session.async_payment_failed`
   - `charge.refunded`
6. 追加後、エンドポイント詳細画面の「署名シークレット」(`whsec_...`) をコピー
7. Firebase Functions Secrets に投入:

```bash
printf '%s' '<法人 whsec_...>' | firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --data-file=- --project minpaku-v2 --force
```

#### 4-b. 個人事業 (individual)

1. アカウント切替で「西山恭介 個人事業」を選択
2. https://dashboard.stripe.com/webhooks (本番モード) を開く
3. **同じ URL** (`https://asia-northeast1-minpaku-v2.cloudfunctions.net/stripeWebhook`) を追加
4. 同じ 5 イベントをリッスン
5. 発行された署名シークレット (`whsec_...`) をコピー
6. Firebase Functions Secrets に投入:

```bash
printf '%s' '<個人 whsec_...>' | firebase functions:secrets:set STRIPE_WEBHOOK_SECRET_INDIVIDUAL --data-file=- --project minpaku-v2 --force
```

### 5. Functions 再デプロイ (新しい secrets を適用)

```bash
cd /c/Users/yamas/AI_Workspace/minpaku-v2
firebase deploy --only functions:api,functions:stripeWebhook --project minpaku-v2
```

- `functions:api` は承認/返金 API 用に corporate + individual の Secret を両方バインド済み。
- `functions:stripeWebhook` は 4 本すべての Secret をバインドし、両アカウントの署名を検証する。

### 6. Firestore の paymentReturnBase を本番URLに設定 (任意)

戻り先ページは既定で `https://www.setouchi-stay.com` を使う。
別ドメインに変えたい場合のみ Firebase Console から `settings/directBooking` に
`paymentReturnBase: "https://<ドメイン>"` を設定。

### 7. 動作確認 (物件別に少額実予約1件ずつ、合計2件)

**両アカウントを本番化した場合、各アカウントで最低1件ずつ通し検証する:**

1. **individual 検証**: 小町 または 若草 の1泊分など少額日程で予約リクエスト送信 → 承認 → 実カードで少額決済
   - 実際の入金は個人事業口座 (楽天ハープ222 普通 5008119) に着金することを Stripe ダッシュボード「個人事業」で確認
   - `bookings/direct-*.paymentSession.accountKind === "individual"` を Firestore で確認
2. **corporate 検証**: the Terrace 長浜 または UJINA の1泊分など少額日程で予約リクエスト送信 → 承認 → 実カードで少額決済
   - 実際の入金は法人口座 (楽天 第三営業支店 普通 7044309) に着金することを Stripe ダッシュボード「合同会社八朔」で確認
   - `bookings/direct-*.paymentSession.accountKind === "corporate"` を Firestore で確認
3. 両物件とも webhook が正しく届き `paymentStatus: "paid"` に遷移することを確認
4. 全額返金して原状復帰 (返金 API も accountKind から自動でアカウントを選択する)

## ★確認ポイント (すべて OK になってから本番開始)

- [ ] 事業者情報入力・本人確認書類承認済み (両アカウントとも Stripe から確認メール)
- [ ] `charges_enabled: true` (両アカウントの Stripe ダッシュボード「本番環境」に緑チェック)
- [ ] 本番 API キー投入完了 (`STRIPE_SECRET_KEY` / `STRIPE_SECRET_KEY_INDIVIDUAL`)
- [ ] Webhook エンドポイント登録済み・両アカウントの署名シークレット投入完了 (`STRIPE_WEBHOOK_SECRET` / `STRIPE_WEBHOOK_SECRET_INDIVIDUAL`)
- [ ] `functions:api` `functions:stripeWebhook` が新 secrets 版でデプロイ済み
- [ ] 特商法・宿泊約款の記載が最新
- [ ] individual 物件 (小町 or 若草) で少額実予約1件通し検証完了
- [ ] corporate 物件 (テラス or 宇品) で少額実予約1件通し検証完了
- [ ] **本番切替後の後始末**: Firestore `settings/directBooking` の `allowTestCheckout` フィールドを削除
      (本番鍵では無視されるが、将来テスト鍵を誤って投入したときにガードを効かせるため。
      Firebase Console → Firestore → `settings/directBooking` → `allowTestCheckout` を削除)

## ★段階切替 (片方だけ先に本番化する場合)

たとえば「先に個人事業だけ本番化してテラスは後回し」というケースは以下で回せる:

- individual 用 Secrets 2本 (`STRIPE_SECRET_KEY_INDIVIDUAL` + `STRIPE_WEBHOOK_SECRET_INDIVIDUAL`) だけ本番投入
- corporate 用 Secrets は未設定 or テスト鍵のまま
- 挙動:
  - 小町/若草 の承認 → 本番 Checkout Session 生成 → 実カード決済 OK
  - テラス/宇品 の承認 → corporate 側が未設定 or テスト鍵のため決済リンク無し暫定文面
    (Firestore `settings/directBooking.allowTestCheckout = true` を設定すればテスト決済リンクは出る)
  - Webhook: 個人アカウントからのイベントは individual 側で verify 成功 / 法人側は skip される

その後 corporate を本番化するときは、法人分の 2 Secrets を投入して同じ手順で切替。

## 参考 (Plan A に戻したいとき)

`STRIPE_SECRET_KEY` を空にする or 削除すると、該当アカウント側は決済無しモードにフォールバックし、
確定メールは暫定文面に戻る。手動 Invoice 運用に戻せる。

```bash
# 例: 個人事業側だけ Plan A に戻す
firebase functions:secrets:destroy STRIPE_SECRET_KEY_INDIVIDUAL --project minpaku-v2
firebase deploy --only functions:api --project minpaku-v2
```
