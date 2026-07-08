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
- **【2026-07-09 #4+#5 完成・本番反映 v0709d / commit 82ffc69】帳票のアプリ内自動生成と手数料表示を実装・デプロイ・実データ検証済:**
  - `functions/api/ota-csv-logic.js`(新・テスト済): yadozei保存の予約CSVを集計。Airbnb=収入合計(キャンセル除外)、Booking=料金gross/コミッション/手取りnet。精算計算=売上高(入金額A−宿泊税B)×料率+消費税。宿小町5月=**201,769** 実データ一致をユニットテストで固定。
  - `functions/api/pnl.js`: `POST /pnl/:pid/:ym/import-ota-csv`追加(OTAcsvフォルダから対象月CSVをDL集計→revenueへ)。Drive認証は yamasuke81 OAuthトークン方式(resolveOtaDrive_)。**set(merge)のドット記法バグ修正**(revenue/manualOverrides を必ずネストで書く。既存 applyParsedToPnl_/patchMonth も修正)。
  - `functions/api/settlement.js`(新, `/settlement`にマウント): 月次業務報告書/精算書兼請求書のPDF生成(pdfkit・invoices.jsと同フォント/Storage署名URL)。八朔インボイス未登録=登録番号欄なし。振込先=楽天第三営業支店 普通7044309。**settlementMode="self"(the Terrace)は精算書を出さず報告書のみ**。宿泊税預りBは帳票モーダルで手入力→pnl docに保存(#2で自動化予定)。
  - `public/js/pages/pnl.js`+`api.js`: 「OTA CSV取込」ボタン、「代行手数料(売上×料率)」列、帳票生成モーダル(報告書/精算書PDFをその場生成→新タブ表示)。
  - **5月pnlデータを本番投入済**(宿小町=201,769 / the Terrace=airbnb335,785+booking net285,260、settlementMode=self設定済)。デプロイ後すぐ画面で確認可能。
  - PDF実物2種を宿小町5月データで生成・目視確認済(請求額税込110,974、1ページ収まり、日本語OK)。

## 進行中（2026-07-09 バックフィル）— ★要フォロー
- **CSV自動取得(scheduler)は未稼働**(yadozeiQueue全94件はadmin-tool/listener-chain由来、scheduler由来0。次に自動で回るのは8/2)。Driveの実在CSVは2026-05のみ(取込済)。
- **過去分フェッチ実施中(ユーザー指示: フェッチのみ・やどぜい送信は止める)**: `scratchpad/backfill-fetch.cjs` で **`disable`(やどぜいUpload停止)済** → **Airbnb 9件投入**(the Terrace 2025-09〜2026-04,06 / 宿小町 2026-06、createdBy=backfill-tool)。Airbnb過去月フェッチは疎通OK(2026-04テストdone)。listenerがPM2で順次処理中。
- **★Booking.com は未ログインで失敗**(2026-04テストで判明)。→ **ユーザーが `node scripts/yadozei-listener.mjs --login` でBooking extranet再ログイン後**、`backfill-fetch.cjs full-booking` を投入する。
- **★★やどぜいUpload を全物件で false に停止中**。バックフィル完了後 **必ず `backfill-fetch.cjs enable` で復帰**(元は両物件true)。忘れると8/2のやどぜい自動申告が止まる。
- フェッチ済CSVの pnl 取込: `POST /pnl/:pid/:ym/import-ota-csv`(アプリの「OTA CSV取込」ボタン)or `scratchpad/prepopulate-may.cjs` 相当を各月に。

## NEXT（順序・ここから再開）
1. **宿泊税額Bの自動取込(#2)**: OTAcsvフォルダの `yadozei_月計表_YYYY-MM.pdf`(宿小町5月=`1-NJUCD_2FEHfqaWecgv8EK2Kgbx8iUnD`) / 申告書PDFを Gemini でパースし、pnl doc の `taxWithholding` に自動セット(現状は帳票モーダルで手入力)。精算書のBが実額になる。
2. **修繕費の取込(#3)**: Drive領収書PDF(the Terrace `008_民泊運用`=1eD5DRCMO6spahGEE27zXmyCamTFOAQFo 直下にニトリ/ダイソー等レシート多数。宿小町側も領収書あり)を Gemini でパース→費目/清掃費に計上。
3. **費目の初期投入**: expenseCategories が本番で空。宿小町の家賃/水道光熱費/消耗品/清掃費等をマスタ登録(契約の費用負担区分に沿う)。これで報告書・pnlの利益が実態に。
4. 過去分バックフィル(6月分): 帳票モーダル/「OTA CSV取込」ボタンで宿小町・the Terraceの他月を取込(6月CSVが取得済なら)。※やどぜい実送信を伴う連鎖には注意(下記落とし穴)。
5. **完全自動バッチ**: 毎月OTA CSV取込→宿泊税/修繕費取込→帳票下書き生成 を自動化(最終ゴール)。

## 主要ID/設定
- 宿小町 `RZV9IwtQgMAsvrdM3j8J`: OTAcsv=`1qt5WG7nLqpnqSFILHUCA9otBUJrBmbSk` / listingName=「【YADO KOMACHI】広島中心部…」
- the Terrace `tsZybhDMcPrxqgcRy7wp`: OTAcsv=`1due9iHy9fDo3tNyPaR0zzlDAfVrUC_RZ`(新・統一済／旧宿泊税=`1yN4K39...`) / Booking施設ID=`14868587` / listingName=「瀬戸内海ビュー大テラス…」 / 008_民泊運用=`1eD5DRCMO6spahGEE27zXmyCamTFOAQFo`
- OTA CSV金額列: Airbnb「収入」/ Booking「料金」「コミッション額」。ステータスでキャンセル判別。

## 落とし穴
- dispatcher は毎日04:00起動だが**実取得は毎月2日(dayOfMonth)・前月分のみ**。
- listener は PC常駐 PM2(Hassac01)。dispatcher修正だけで回る（listener修正不要=listingName使用）。
- **listener の連鎖**: `airbnb_csv_fetch`/`booking_csv_fetch` 完了後、`yadozeiUpload.enabled=true` の物件は自動で `yadozei_csv_upload`(=やどぜい税申告サイトへ**実インポート**, dryRunではない)→`yadozei_pdf_fetch` まで連鎖する(yadozei-listener.mjs L1441-1450)。6月バックフィルを `yadozei-admin enqueue` で投入すると6月分をやどぜいへ実送信するので注意(不可逆・対外)。**pnlの売上取込だけなら listener を経由せず、アプリの「OTA CSV取込」ボタン(既存Drive CSVを読むだけ)を使えば実送信は起きない**。
- **Firestore `set(..., {merge:true})` はドット記法キーをネストパスにしない**(リテラルfield化)。`revenue.airbnb` 等のネスト更新は必ずネストオブジェクトで書く(computePnl はネスト前提)。2026-07-09にこのバグを発見・全書込修正済。
- デプロイ: フロントは `/deploy-v2`(bump必須)、functions は `firebase deploy --only functions:api`(APIは単一関数api)。
- 本番Firestore読取/書込は admin SDK + ADC。scratchpad script は `NODE_PATH=../minpaku-v2-yadozei/scripts/node_modules`(firebase-admin+googleapis入り)で実行。yadozei-admin catfile/lsfolder は sender に `yamasuke81@gmail.com` を渡す(OTAcsvは同氏Drive)。

## 継続方法（ユーザー操作）
- **続けるとき**: minpaku-v2 で `claude --resume`（このセッションを選択）or `--continue`。冒頭で「pnl自動化の続き」と言う。
- **区切るとき**: 「チェックポイント」と言えば、このファイル＋memoryを最新化してから終える。
- **新チャットでも**このファイルは自動ロードされるので、"NEXT" の先頭から再開できる。
