# iCal連携堅牢化 設計提案

作成日: 2026-04-19  
対象: `functions/scheduled/syncIcal.js` を中心とした iCal 同期フロー全体

---

## 1. 現状の脆弱性

### 1-1. Airbnb によるゲスト名削除（重大）

**事実**: Airbnb は 2019年12月1日 以降、iCal フィードからゲスト名・予約コードを除去。現在は全予約が `Reserved` として出力される。電話番号末尾4桁が description に含まれるのみ。

**現状コードへの影響**:
- `extractGuestName` は `予約済み - XXX` 形式のみゲスト名を抽出しようとするが、Airbnb は現在この形式を出力しない。実際のゲスト名は iCal からは得られない
- `_icalOriginalName` に保存される値は常に空または `Reserved` になる
- 手動で入力したゲスト名（`existData.guestName !== existData._icalOriginalName` 判定）は保持されるが、初回同期時点でゲスト名空欄のまま登録される

### 1-2. キャンセル検知の設計的欠陥（重大）

**現状**: `syncedIcalUids` セットが **関数実行ごとに初期化**される。つまり、iCal フィード取得が1件でもエラーになると、そのフィードの全予約が「消えた」と誤判定され、**全キャンセル処理が走るリスク**がある。

```js
// syncIcal.js L243 — UID はaddされるが、フィードエラー時はaddされない
syncedIcalUids.add(icalUid); // ← フィードが取れなければ空のまま
```

**加えて**: L243 に `icalUid` という未定義変数を参照しているバグが存在する（`uid` ではなく `icalUid`）。この変数は外側スコープに存在しないため、実際には `syncedIcalUids` が常に空になる可能性があり、**キャンセル検知が事実上機能していない疑いがある**。

### 1-3. 予約変更（日程変更）の検知漏れ（高）

**iCal の仕様**: RFC 5545 では VEVENT の更新は同一 UID + `SEQUENCE` 番号インクリメント + `DTSTAMP`/`LAST-MODIFIED` 更新で表現される。

**現状コード**: `syncIcal.js` は `event.dtstamp`・`event.sequence`・`event.lastmodified` を一切参照しない。`set({ merge: true })` で日付を上書きするだけ。

- `checkIn`/`checkOut` が変わった場合、Firestore の予約ドキュメントは新日付で上書きされる（一見OK）
- しかし `onBookingChange` トリガーが動くためには Firestore への書き込みが必要。`merge: true` の場合、変更フィールドだけ書き込まれるので **DTSTAMP 等の変化を Firestore 上で追えない**
- 変更前後の diff ログが存在しないため、「いつ・何が変わったか」の監査証跡がない

### 1-4. `icalUid` 未定義バグ（高・実装バグ）

`syncIcal.js` L243:
```js
syncedIcalUids.add(icalUid); // ← icalUid は未定義。正しくは uid
```

`for (const [uid, event] of Object.entries(events))` のスコープ変数は `uid` であり、`icalUid` はこの行では未定義（`bookingData.icalUid` としてオブジェクト内にあるが、変数として参照はできない）。ReferenceError は throw されず `undefined` が追加されるだけなので、キャンセル検知セットが機能しない。

### 1-5. iCal フィードエラー時のセーフティガード欠如（高）

現状: `try/catch` でフィード取得エラーを `continue` しているが、その後のキャンセル検知フェーズは **全フィードのエラー有無に関係なく実行される**。

フィード障害シナリオ:
1. Airbnb フィードが一時的に 503 を返す
2. `syncedIcalUids` が空のまま（バグもあるため）
3. Airbnb 由来の全将来予約が「iCal にない」と判定される
4. → 全キャンセル処理

### 1-6. `Reserved` ブロックと実予約の判別の曖昧さ（中）

```js
// L176-180
if (guestName && /^reserved$/i.test(guestName.trim())) {
  // スキップ
}
```

Airbnb の現行フォーマットでは全予約が `Reserved` として出力される。このフィルタにより、**Airbnb の実予約もスキップされている可能性がある**。

「売り止め (`Not available`)」と「実予約 (`Reserved`)」は iCal レベルでは現在区別できないが、Airbnb は `DESCRIPTION` に `Reservation URL` を含めることで区別を可能にしている。現状コードはこの DESCRIPTION を活用していない。

### 1-7. 名簿（guestRegistrations）の照合ロジックの脆弱性（中）

`onGuestFormSubmit.js` の照合ロジック:
```js
.where("checkIn", "==", rosterCheckIn)
.where("status", "==", "confirmed")
.limit(1)
```

- `propertyId` でフィルタしていないため、複数物件で同日チェックインがある場合に誤照合する
- `limit(1)` で1件目を取るため、物件違いの予約に名簿が紐付く可能性がある

### 1-8. タイムゾーン処理の不安定性（中）

`toDateStr` 関数は以下の分岐を持つ:
- `d.dateOnly` フラグ付き → JST変換
- UTC 00:00 → UTC のまま使用
- それ以外 → JST変換

Airbnb/Booking.com の iCal は DATE 型（時刻なし）で DTSTART/DTEND を出力するケースがほとんどだが、`node-ical` が `dateOnly` フラグを付けるかどうかはバージョン依存。フラグなしで UTC 00:00 に解釈された場合、JST に変換すると「09:00 JST」= 同日として正しく扱われるが、条件分岐で UTC のままになる行（L77-78）に到達すると問題ない。ただし **3ルートが存在するため将来バグが生まれやすい**。

### 1-9. クロスプラットフォーム重複検出の粗さ（低）

```js
// L185-199
if (!guestName || /^(airbnb|booking|予約)$/i.test(guestName.trim())) {
  const dupSnap = await db.collection("bookings")
    .where("checkIn", "==", checkIn)
    .where("status", "==", "confirmed")
    .limit(1).get();
```

- `propertyId` で絞っていないため別物件の予約とも重複判定する可能性がある
- このチェックがループ内で毎 VEVENT 実行されるため、Firestore 読み取りコストが高い

### 1-10. 手動予約と iCal 予約が同日重複した場合の挙動未定義（低）

手動登録の予約（`syncSource: "manual"`）と iCal 予約が同一日程で存在した場合:
- iCal 側は上書きで `confirmed` のまま
- 手動側も `confirmed` のまま
- 清掃シフト・募集は両方が `onBookingChange` をトリガーして重複生成される可能性がある

---

## 2. 改善提案

### 優先度 A（緊急・Phase 1）

#### A-1. `icalUid` 未定義バグの修正

**何を**: `syncIcal.js` L243 の `syncedIcalUids.add(icalUid)` を `syncedIcalUids.add(uid)` に修正  
**なぜ**: キャンセル検知が完全に無効化されているバグ。修正なしで他の改善をしても意味がない  
**実装**: 1行修正  
**影響範囲**: `syncIcal.js` のみ

#### A-2. フィードエラー時のキャンセル検知ブロック

**何を**: いずれかのフィード取得でエラーが発生した場合、そのフィード由来の予約に対してはキャンセル判定を行わない  
**なぜ**: 一時的なネットワーク障害で全予約が誤キャンセルされるリスクを排除する  
**実装**:
```js
// 各 settingDoc の処理後
const erroredPlatforms = new Set(); // エラーになったフィードの platform を記録
// キャンセル検知フェーズで:
if (erroredPlatforms.has(data.source)) continue; // このフィードはスキップ
```
**影響範囲**: `syncIcal.js`

#### A-3. Airbnb の `Reserved` 実予約をDESCRIPTIONで判別

**何を**: Airbnb iCal の `DESCRIPTION` に `Reservation URL:` が含まれる場合は実予約として扱う  
**なぜ**: 現状は全 `Reserved` をスキップしており、Airbnb の実予約を見逃す可能性がある  
**実装**:
```js
// Airbnb の Reserved イベント判別
const isRealReservation = platform === "Airbnb" 
  && /reserved/i.test(summary)
  && /reservation url:/i.test(event.description || "");

if (/^reserved$/i.test(guestName.trim()) && !isRealReservation) {
  // ブロックとしてスキップ
}
```
**影響範囲**: `syncIcal.js` の `extractGuestName` および UID スキップ判定

#### A-4. 名簿照合での `propertyId` フィルタ追加

**何を**: `onGuestFormSubmit.js` の booking 照合クエリに `propertyId` 条件を追加  
**なぜ**: 複数物件で同日チェックインがある場合の誤照合を防ぐ  
**実装**:
```js
let bookingsQuery = db.collection("bookings")
  .where("checkIn", "==", rosterCheckIn)
  .where("status", "==", "confirmed");
if (data.propertyId) {
  bookingsQuery = bookingsQuery.where("propertyId", "==", data.propertyId);
}
const bookingsSnap = await bookingsQuery.limit(1).get();
```
**影響範囲**: `triggers/onGuestFormSubmit.js`

#### A-5. `toDateStr` の簡略化・テスト追加

**何を**: 3分岐を2分岐（`dateOnly` または `dateOnly` でない）に整理し、JST 変換を統一する  
**なぜ**: タイムゾーンバグは発見が困難で影響が大きい。単純化でリスク低減  
**実装**: `d.dateOnly || (date.getUTCHours() === 0 && date.getUTCMinutes() === 0)` の場合は UTC の日付を使用、それ以外は JST 変換  
**影響範囲**: `syncIcal.js`

---

### 🆕 ダブルブッキング検知（Phase 1 に含める）

**背景**: iCal 同期ラグ中に Airbnb と Booking.com が同日を同時に予約する / 手動登録と iCal が日程重複する / オーナーが売り止めを忘れる、等で**ダブルブッキング (2組のゲストが同日来訪)** が発生する。民泊では致命的なので専用検知を入れる。

#### D-1. リアルタイム検知（onBookingChange 拡張）

**何を**: 新規予約作成 or 日程変更時に、同 propertyId の active 予約との日程重複を検出
**重複条件**: `(new.checkIn < existing.checkOut) && (existing.checkIn < new.checkOut)` (自分自身は除外)
**なぜ**: 発生した瞬間にオーナーに警告することで、当日までに片方をキャンセル/調整できる

**実装**:
```js
// onBookingChange.js の末尾に追加
async function detectDoubleBooking(db, bookingId, after) {
  if (!after.propertyId || !after.checkIn || !after.checkOut) return;
  if (isCancelled(after.status)) return;
  const snap = await db.collection("bookings")
    .where("propertyId", "==", after.propertyId).get();
  const conflicts = snap.docs.filter(d => {
    if (d.id === bookingId) return false;
    const x = d.data();
    if (isCancelled(x.status)) return false;
    // 日程重複判定 (文字列 YYYY-MM-DD 比較で OK)
    return after.checkIn < x.checkOut && x.checkIn < after.checkOut;
  });
  if (conflicts.length === 0) return;

  // 両予約に conflictWithIds を設定
  const conflictIds = conflicts.map(d => d.id);
  await db.collection("bookings").doc(bookingId).update({
    conflictWithIds: conflictIds,
    conflictDetectedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  for (const c of conflicts) {
    const existing = c.data().conflictWithIds || [];
    const merged = Array.from(new Set([...existing, bookingId]));
    await c.ref.update({ conflictWithIds: merged,
      conflictDetectedAt: admin.firestore.FieldValue.serverTimestamp() });
  }
  // bookingConflicts コレクションに記録
  for (const c of conflicts) {
    const confId = [bookingId, c.id].sort().join("__");
    await db.collection("bookingConflicts").doc(confId).set({
      bookingIds: [bookingId, c.id].sort(),
      propertyId: after.propertyId,
      propertyName: after.propertyName || "",
      detectedAt: admin.firestore.FieldValue.serverTimestamp(),
      detectedBy: "realtime",
      resolved: false,
    }, { merge: true });
  }
  // LINE 緊急通知
  await notifyOwner(db, "double_booking",
    `⚠️ ダブルブッキング検出: ${after.checkIn}〜${after.checkOut}`,
    `【⚠️ ダブルブッキング警告】\n物件: ${after.propertyName}\n日程: ${after.checkIn} 〜 ${after.checkOut}\n衝突件数: ${conflicts.length}件\n\n確認: https://minpaku-v2.web.app/#/dashboard`);
}
```

#### D-2. 解決検知（cancelled 化時）

**何を**: 予約が cancelled になったとき、その予約の `conflictWithIds` に含まれる相手の conflict を解決扱いに
**実装**: onBookingChange のキャンセルブロック内で `bookingConflicts` の `resolved: true` を設定し、相手 booking の `conflictWithIds` から自分を除去

#### D-3. 通知イベント追加

**何を**: `settings/notifications.events.double_booking` を追加。`lineNotify.js` の通知種別に `double_booking` を追加
**デフォルト値**: `enabled: true, ownerLine: true, groupLine: true, staffLine: false, email: false`

#### D-4. Firestore スキーマ追加

- **bookings** (既存拡張):
  - `conflictWithIds: string[]` (衝突相手の bookingId 配列)
  - `conflictDetectedAt: Timestamp`
- **bookingConflicts** (新規):
  - `{bookingIdA__bookingIdB}` の合成ID (sorted join)
  - `bookingIds: [string, string]`
  - `propertyId, propertyName`
  - `detectedAt, detectedBy: "realtime" | "reconcile"`
  - `resolved: boolean, resolvedAt: Timestamp`

#### D-5. Firestore Rules

- `bookingConflicts`: オーナーのみ読み書き可 (`isOwner` 判定)

### 優先度 B（中期・Phase 2）

#### B-1. `DTSTAMP`/`SEQUENCE`/`LAST-MODIFIED` を Firestore に保存

**何を**: iCal VEVENT から `event.dtstamp`・`event.sequence`・`event.lastmodified` を取得し、bookings ドキュメントに保存  
**なぜ**: 予約変更の検知・監査ログに必要。変更があった場合のみ Firestore に書き込む最適化にも使える  
**実装**:
```js
bookingData.icalDtstamp = event.dtstamp ? event.dtstamp.toISOString() : null;
bookingData.icalSequence = event.sequence != null ? Number(event.sequence) : 0;
bookingData.icalLastModified = event.lastmodified ? event.lastmodified.toISOString() : null;
```
既存ドキュメントと比較: `if (existData.icalDtstamp === bookingData.icalDtstamp) continue;` で不変時は書き込みスキップ  
**影響範囲**: `syncIcal.js`、bookings スキーマ

#### B-2. 変更前後 diff の監査ログ記録

**何を**: 予約が変更された場合、`bookingChangeLogs` コレクションに before/after を記録  
**なぜ**: 「いつ・誰の・何が変わったか」が追跡できないと障害対応が困難  
**実装**:
```js
// syncIcal.js — 既存ドキュメントのset前
if (existing.exists) {
  const prev = existing.data();
  if (prev.checkIn !== bookingData.checkIn || prev.checkOut !== bookingData.checkOut) {
    await db.collection("bookingChangeLogs").add({
      bookingId: docId,
      changedBy: "syncIcal",
      before: { checkIn: prev.checkIn, checkOut: prev.checkOut, guestName: prev.guestName },
      after: { checkIn: bookingData.checkIn, checkOut: bookingData.checkOut },
      changedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}
```
**影響範囲**: `syncIcal.js`、新規 `bookingChangeLogs` コレクション

#### B-3. 定期 reconcile cron の実装

**何を**: 毎日 3:00 JST に `syncSource=ical` の全予約と各フィードを照合し、drift を検出してアラート  
**なぜ**: 5分同期の漏れや誤キャンセルを翌朝に検出して修正できる  
**実装**: `functions/scheduled/reconcileIcal.js` として新規作成。以下を確認:
1. Firestore の confirmed 予約が iCal にも存在するか
2. iCal にある予約が Firestore に存在するか
3. 差異があればオーナーに LINE 通知

**影響範囲**: 新規 scheduled function、`firebase.json` の cron 設定追加

#### B-4. キャンセル済み予約のソフトデリート保護（Hard Delete 禁止）

**何を**: `syncIcal.js` L299-320 のキャンセル済み重複 hard delete を廃止し、`_deletedBy: "reconcile"` フラグに変更。30日経過後に別クロンで削除  
**なぜ**: iCal→Firestore間の一時的なズレで正常予約が削除されるリスクを排除  
**影響範囲**: `syncIcal.js`

#### B-5. クロスプラットフォーム重複検出に `propertyId` フィルタ追加

**何を**: L185-199 のクロス重複検出クエリに `propertyId` を追加  
**なぜ**: 別物件の予約と誤判定するリスクの解消  
**影響範囲**: `syncIcal.js`

---

### 優先度 C（将来・Phase 3）

#### C-1. Beds24 API への完全移行

**何を**: iCal 同期を廃止し Beds24 API v2 をマスターとして使用（CLAUDE.md の設計方針通り）  
**なぜ**: iCal の構造的な限界（ゲスト名なし・遅延・変更情報なし）を根本解決できる  
**備考**: `syncBeds24.js` の実装が完成した段階で `syncSettings.active = false` で iCal を無効化

#### C-2. iCal フィード取得の冪等性担保

**何を**: フィード取得前にハッシュ値（URL + 内容）を比較し、変化がない場合は処理をスキップ  
**なぜ**: Firestore 書き込みコストの削減と意図しない上書きを防ぐ  
**影響範囲**: `syncIcal.js`

#### C-3. Booking.com 予約番号の抽出

**何を**: Booking.com の DESCRIPTION から予約番号（`BOOKING COM:XXXXXXXXX` 形式）を抽出し、`icalBookingRef` フィールドに保存  
**なぜ**: 手動対応時や顧客からの問い合わせ時に予約番号が即座に参照できる  
**影響範囲**: `syncIcal.js`、bookings スキーマ

---

## 3. 3軸マージ戦略

### 3軸の役割定義

| 軸 | コレクション | 役割 | 優先度 |
|---|---|---|---|
| iCal | `bookings` (`syncSource=ical`) | 予約存在の確認・日程の取得 | 最低（情報量が少ない） |
| 手動登録 | `bookings` (`syncSource=manual`) | オーナーが確認した正確な情報 | 最高 |
| 名簿フォーム | `guestRegistrations` | ゲスト詳細情報の取得・補完 | iCal より上 |

### 上書きルール

```
手動入力 > 名簿フォーム > iCal
```

具体的には:
1. **guestName**: 手動 > 名簿フォーム (`guestFormId` 参照) > iCal (`_icalOriginalName`)
   - 現在 `_icalOriginalName` を使った保護ロジックは正しい方向だが、名簿フォームの上書きを優先する判定が存在しない
2. **checkIn/checkOut**: iCal が最新情報源（日程変更時）。ただし変更前後を `bookingChangeLogs` に記録
3. **guestCount/nationality/phone**: 名簿フォーム優先（`onGuestFormSubmit` が booking を `update` するのは正しい）

### フィールドごとの書き込み権限マトリクス

| フィールド | iCal書き込み可 | 名簿フォーム書き込み可 | 手動書き込み可 |
|---|---|---|---|
| checkIn / checkOut | ○ (日程変更として記録) | △ (警告のみ) | ○ |
| guestName | △ (名前が空の時のみ) | ○ | ○ |
| guestCount | × | ○ | ○ |
| nationality | × | ○ | ○ |
| status | ○ (confirmed/cancelled) | × | ○ |
| propertyId | △ (新規のみ) | × | ○ |

### 名簿フォームと予約の紐付け改善

現状: `checkIn` 日付一致 + `status=confirmed` の1件目  
改善: `checkIn` + `propertyId` + `source` (Airbnb/Booking.com) の三点一致

---

## 4. 実装フェーズ分割

### Phase 1: 緊急修正（iCalバグ + ダブルブッキング検知）

| 項目 | ファイル | 内容 |
|---|---|---|
| A-1 | `syncIcal.js` | `icalUid` → `uid` バグ修正 (1行) |
| A-2 | `syncIcal.js` | フィードエラー時のキャンセル検知ブロック |
| A-3 | `syncIcal.js` | Airbnb `Reserved` を DESCRIPTION で判別 |
| A-4 | `onGuestFormSubmit.js` | 名簿照合に `propertyId` フィルタ追加 |
| A-5 | `syncIcal.js` | `toDateStr` 分岐の整理 |
| D-1 | `onBookingChange.js` | ダブルブッキング リアルタイム検知 |
| D-2 | `onBookingChange.js` | cancelled 化時の conflict 解決 |
| D-3 | `lineNotify.js` | `double_booking` イベント通知追加 |
| D-4 | (スキーマ) | `bookings.conflictWithIds`, `bookingConflicts` コレクション |
| D-5 | `firestore.rules` | `bookingConflicts` 読み書きルール |

### Phase 2: 堅牢化（1〜2週間）

| 項目 | ファイル | 内容 |
|---|---|---|
| B-1 | `syncIcal.js` | DTSTAMP/SEQUENCE を Firestore に保存 |
| B-2 | `syncIcal.js` + 新規 | 変更差分の監査ログ (`bookingChangeLogs`) |
| B-3 | 新規 `reconcileIcal.js` | 毎日 3:00 JST の定期整合性チェック |
| B-4 | `syncIcal.js` | キャンセル済み hard delete の廃止 |
| B-5 | `syncIcal.js` | クロス重複検出への `propertyId` 追加 |

### Phase 3: 将来（Beds24 移行完了後）

| 項目 | 内容 |
|---|---|
| C-1 | Beds24 API 移行後に iCal 同期を無効化 |
| C-2 | iCal フィード変化検出（コスト最適化） |
| C-3 | Booking.com 予約番号抽出 |

---

## 5. 現状コードの評価まとめ

### 良い点
- ソフトデリート（`status: "cancelled"`）でキャンセルを記録している（hard delete でない）
- `_icalOriginalName` で手動変更保護を実装している
- `syncSource` フィールドでデータ出所を管理している
- フィードエラーを `continue` でスキップして他フィードに影響させない設計

### 悪い点
- `icalUid` バグによりキャンセル検知が機能していない（最重要）
- フィードエラー発生後でもキャンセル検知フェーズが走る
- Airbnb `Reserved` の扱いが過剰スキップ（実予約も落としている可能性）
- SEQUENCE/DTSTAMP 非参照のため変更追跡ができない
- 監査ログが一切存在しない

---

## 6. 参考資料

- [Airbnb iCal ゲスト名削除の影響 - Uplisting Blog](https://www.uplisting.io/blog/how-the-airbnb-icalendar-ical-changes-will-affect-you-and-how-to-avoid-disruption)
- [Airbnb Community: ゲスト名が iCal に表示されない](https://community.withairbnb.com/t5/Help/No-Guest-Names-on-ICal-seriously/td-p/1129637)
- [OwnerRez: Airbnb iCal 変更の詳細](https://www.ownerrez.com/blog/airbnb-bookings-no-longer-showing-guest-name-phone-and-email)
- [Airbnb iCal ガイド - OwnerRez](https://www.ownerrez.com/support/articles/channel-management-calendar-import-export-airbnb)
- [Booking.com カレンダー同期 - Smoobu Blog](https://www.smoobu.com/en/blog/how-to-sync-airbnb-booking-com-calendars-to-avoid-double-bookings/)
- [iCal vs Channel Manager - Roomzy PMS](https://roomzy.gr/en-us/post/ical-vs-channel-manager-80)
- [Rentals United: iCal calendar sync](https://rentalsunited.com/blog/airbnb-calendar-sync/)
- [RFC 5545 iCalendar 仕様](https://datatracker.ietf.org/doc/html/rfc5545)
- [iCalendar.org: VEVENT コンポーネント](https://icalendar.org/iCalendar-RFC-5545/3-6-1-event-component.html)
- [node-ical npm パッケージ](https://www.npmjs.com/package/node-ical)
- [Hostfully: iCal 同期のしくみ](https://help.hostfully.com/en/articles/3032151-synchronize-using-icals)
- [Operto: Airbnb iCal フィードの解説](https://help-teams.operto.com/article/367-how-do-ical-feeds-import-bookings-blocks-and-guest-information)
