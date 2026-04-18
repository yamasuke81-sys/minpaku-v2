# PDF署名権限エラー 解決手順

## 現象

請求書PDF生成時に以下のエラーが発生する:

```
Permission 'iam.serviceAccounts.signBlob' denied on resource
(or it may not exist): projects/-/serviceAccounts/418111574543-compute@developer.gserviceaccount.com
```

Cloud Storage の署名付きURL発行 (`getSignedUrl`) に、デフォルトのコンピュートサービスアカウントが必要な権限を持っていないことが原因。

## 解決手順

### Google Cloud コンソールから設定する場合

1. [Google Cloud コンソール → IAM と管理 → IAM](https://console.cloud.google.com/iam-admin/iam?project=minpaku-v2) を開く
2. 「プリンシパルを追加」または既存エントリを編集
3. サービスアカウント `418111574543-compute@developer.gserviceaccount.com` を対象に選択
4. 「ロール」に **Service Account Token Creator** (`roles/iam.serviceAccountTokenCreator`) を追加
5. 保存

### gcloud CLI から設定する場合

```bash
gcloud projects add-iam-policy-binding minpaku-v2 \
  --member="serviceAccount:418111574543-compute@developer.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

## 反映確認

権限追加後、請求書PDF生成 (GET /api/invoices/{id}/pdf) を再試行して、署名付きURLが正常に発行されることを確認する。

## 補足

- この権限は Cloud Functions のデフォルトサービスアカウントに付与する
- Firebase Functions は内部的に `{PROJECT_NUMBER}-compute@developer.gserviceaccount.com` を使用している
- `getSignedUrl` は `@google-cloud/storage` の `signBlob` を内部で呼び出すため、この権限が必要
