---
name: feedback-firestore-index
description: Firestore で複合クエリを書くたびに必ず firestore.indexes.json を同時更新する
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 378db26f-debc-4667-bb4e-d9a4959763b7
---

# Firestore 複合クエリには必ず index を同時に作る

新規 Firestore クエリを書く時は、複合インデックスが必要かどうかを必ずチェックし、
必要なら firestore.indexes.json を同時に更新して `firebase deploy --only firestore:indexes` する。

## Why
2026-05-23 minpaku-v2 で 2回連続で「index 不足」事故を起こした:
1. `processBatchNotificationQueue`: `{status, batchSlot, scheduledForDate}` の複合 → 関数が動かず通知放置
2. `staff-ical` (ICS フィード): `{selectedStaffIds array-contains, checkoutDate >=}` → API 500、 Google カレンダーに反映されない

どちらも「クエリを書いて関数追加」したのに `firestore.indexes.json` を更新し忘れ。
ユーザーから「届かない」報告で初めて気づくのは遅すぎる。

## How to apply

### 複合インデックスが必要な条件
以下の組み合わせは複合インデックスが必要:
- `.where()` を **2つ以上** 重ねる (フィールドが違う)
- `.where(... "==")` + `.orderBy(...)` で別フィールド
- `.where(... array-contains)` + `.where(... 比較演算子)` (`<`, `<=`, `>`, `>=`)
- `.where(... "in")` + 他の `.where(...)`

### 防止フロー
1. クエリを書いた瞬間に「`firestore.indexes.json` への追記が必要か」を判定
2. 必要なら同じコミットで indexes.json も追加
3. 必要なら `firebase deploy --only firestore:indexes` も同時に
4. インデックス構築は数分〜数十分。 急ぐなら `array-contains` のみ + JS 側フィルタで回避

### 緊急時の回避策
本番で 500 エラー再発時は、 index 待ちでなく **クエリを単純化** して JS 側フィルタする。
- where 1つだけにする (e.g. array-contains のみ)
- JS の `.filter()` で残りの条件を絞る
- 件数が少なければ性能差は無視できる

### チェックポイント
新規 Cloud Functions / migration スクリプト で Firestore クエリを書く時:
- [ ] `.where()` が 1つだけか?
- [ ] 2つ以上なら firestore.indexes.json に追加したか?
- [ ] `firebase deploy --only firestore:indexes` した? (Functions deploy だけでは index は反映されない)
