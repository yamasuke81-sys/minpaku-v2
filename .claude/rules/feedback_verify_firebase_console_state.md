---
name: Firebase Console 設定の事前確認
description: Firebase 機能 (Anonymous Auth/Storage Rules/etc) を使う実装をする時は Console の有効化状態を事前確認する
type: feedback
originSessionId: 24c745bf-a6d1-4c4d-99cd-70a192bb5958
---
# Firebase 機能を使う実装は Console の有効化状態を事前確認

storage.rules / firestore.rules で「非認証許可」と書いてあっても、Firebase
Web SDK 経由のリクエストでは何らかの auth (Anonymous でも OK) が無いと
`storage/unauthorized` エラーになるケースがある。Console 側で機能が有効化
されていることが前提のため、コードを書いた時点で「動くはず」と判断しない。

**Why:** 2026-05-15 minpaku-v2 で signInAnonymously() を guest-form.html に
追加してデプロイしたが、Firebase Console で Anonymous プロバイダが
無効だったため `auth/admin-restricted-operation` で失敗。やますけに
Console 側の有効化作業を依頼する必要があった。事前に Console 状態を
確認していれば一手で済んだ。

**How to apply:**
- 新規に Firebase 機能 (Anonymous Auth / Phone Auth / Storage / Functions の
  特定リージョン / Secret Manager 等) を使う実装をする時は、デプロイ前に
  該当 Console URL をユーザーに送って有効化状態を聞く OR `gcloud` /
  `firebase` CLI で状態取得して確認
- 「ルール上は許可」と「Console で有効」は別レイヤ — rules ファイルだけ
  読んで OK と判断しない
- agent の診断結果も鵜呑みにせず、不可逆なデプロイ前に**裏取り**する
  (CLAUDE.md ルール 2: わからないことは推測せず正直に)
