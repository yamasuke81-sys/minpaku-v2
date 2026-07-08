# minpaku-v2 収支自動化プロジェクト — 進行計画（複数セッション継続用SSOT）

このファイルは複数チャットにまたがる開発を「途切れさせない」ためのSSOT。**毎チェックポイントで更新する**。
`.claude/rules/` 配下なので**毎セッション自動ロードされる**＝新チャットでも状態が失われない。
背景の詳細は auto-memory の `minpaku-v2-pnl-automation.md` を参照。

## ゴール
各物件の月次収支を自動計算し、運営代行手数料の自動算出＋月次業務報告書＋精算書兼請求書をアプリから自動生成する（完全自動バッチまで）。

## 対象と方針（確定）
- 対象2物件のみ: **宿小町(Airbnbのみ)** / **the Terrace 長浜(Airbnb+Booking)**。若草/宇品/秋津/竹原は開業前=対象外。
- 収支は**物件単位の総合収支**。手数料は別掲。
- 料率は物件マスタ `managementFeeRate`（既定50%、可変）。
- 八朔は**インボイス未登録**→精算書の登録番号欄は出さない。
- 宿泊税は「**宿税(やどぜい)**」の月計表/申告書PDFから取り込む。
- 修繕費はDriveの領収書PDFから拾う。
- 八朔振込先: 楽天 第三営業支店 普通 7044309 ド）ハッサク。

## DONE
- 契約書一式＋別紙(料率覚書)＋付属書類 作成・送付。
- 宿小町2026年5月の報告書兼精算書を実データで作成（テスト成功、売上201,769=Excel一致）。
- 物件マスタに `managementFeeRate` 追加＋デプロイ（本番反映 v0708b / commit f50e4d4）。
- `yadozeiCsvDispatcher` の listingId→listingName 門番バグ修正＋デプロイ（commit 373a5ab、本番反映）。
- 両物件のyadozei設定点検: schedule有効/毎月2日/airbnb有効/listingName設定済。→**次回8/2から自動取得が回る見込み**。
- **the Terrace の保存先を新規「008_民泊運用/OTAcsv」(`1due9iHy9fDo3tNyPaR0zzlDAfVrUC_RZ`)に統一**（driveOtaCsvFolderId更新済、宿小町は既にOTAcsv）→両物件とも保存先統一完了。

## NEXT（順序・ここから再開）
1. 過去分バックフィル: 6月分を手動投入で取得（`scripts/yadozei-admin.mjs` enqueue、listener PM2が処理）。7月分は8/2に自動。宿小町=airbnb / the Terrace=airbnb+booking。
2. 宿泊税額の取り込み（宿税の月計表/申告書PDFから、精算書のB）。
3. 修繕費の取り込み（Drive領収書PDF。the Terrace `008_民泊運用`(1eD5DRCMO6spahGEE27zXmyCamTFOAQFo)直下にニトリ/ダイソー等のレシートPDF多数。宿小町側も同様に領収書あり）。
4. **報告書・精算書のアプリ内自動生成**（テスト済ロジックを組込。scratchpad/gen-komachi-may.js が実装参考）。
5. 収支ページ(pnl)で「売上×料率」の手数料を表示。

## 主要ID/設定
- 宿小町 `RZV9IwtQgMAsvrdM3j8J`: OTAcsv=`1qt5WG7nLqpnqSFILHUCA9otBUJrBmbSk` / listingName=「【YADO KOMACHI】広島中心部…」
- the Terrace `tsZybhDMcPrxqgcRy7wp`: OTAcsv=`1due9iHy9fDo3tNyPaR0zzlDAfVrUC_RZ`(新・統一済／旧宿泊税=`1yN4K39...`) / Booking施設ID=`14868587` / listingName=「瀬戸内海ビュー大テラス…」 / 008_民泊運用=`1eD5DRCMO6spahGEE27zXmyCamTFOAQFo`
- OTA CSV金額列: Airbnb「収入」/ Booking「料金」「コミッション額」。ステータスでキャンセル判別。

## 落とし穴
- dispatcher は毎日04:00起動だが**実取得は毎月2日(dayOfMonth)・前月分のみ**。
- listener は PC常駐 PM2(Hassac01)。dispatcher修正だけで回る（listener修正不要=listingName使用）。
- デプロイ: フロントは `/deploy-v2`(bump必須)、functions は `firebase deploy --only functions:<name>`。
- 本番Firestore読取は `scratchpad/read-properties.js` の ADC方式（.get のみ）。

## 継続方法（ユーザー操作）
- **続けるとき**: minpaku-v2 で `claude --resume`（このセッションを選択）or `--continue`。冒頭で「pnl自動化の続き」と言う。
- **区切るとき**: 「チェックポイント」と言えば、このファイル＋memoryを最新化してから終える。
- **新チャットでも**このファイルは自動ロードされるので、"NEXT" の先頭から再開できる。
