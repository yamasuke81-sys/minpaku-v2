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

## 進行中（2026-07-09 バックフィル）— ★Bookingだけ残
- **CSV自動取得(scheduler)は未稼働**(yadozeiQueue由来のscheduler=0。次に自動で回るのは8/2)。→ 過去分は手動フェッチした。
- **【完了】Airbnb過去分フェッチ＋pnl取込**: `scratchpad/backfill-fetch.cjs full-airbnb` で全11件done → `/tmp/importbf.cjs`相当でpnl投入済。
  - 宿小町: 5月201,769 / 6月171,062。the Terrace(Airbnb売上): 25/09=288,963・10=397,797・11=194,000・12=235,710・26/01=157,140・**02=0(Airbnb予約0件・要確認)**・03=631,664・04=169,229・05=335,785・06=358,460。
- **【要ユーザー操作】Booking.com が未ログインで全失敗**。→ ユーザーが **`cd C:\Users\yamas\AI_Workspace\minpaku-v2 & node scripts/yadozei-listener.mjs --login`** でBooking extranet再ログイン。その後こちらで **`backfill-fetch.cjs disable`→`full-booking`→(取込)→`enable`** を実行(the Terrace 2025-09〜2026-06のBooking、05以外)。宿小町はBooking無し。
- **やどぜいUpload は enable で復帰済**(両物件true)。※Bookingバックフィル実行時だけ再度 disable→実行→enable すること(過去月のやどぜい実登録を避けるため)。

## DONE（2026-07-09 第2弾・本番 v0709e / commit 1455c18）
- **【#1 宿泊税B自動取込 完成】** `POST /settlement/:pid/:ym/import-tax`。やどぜい**申告書**PDF(税額明記)をGeminiで読み `taxWithholding` に自動セット。宿小町5月=**800円**(4泊×200円/広島県)実証。※月計表は課税泊数のみで税額なし→申告書優先。帳票モーダルに「月計表(申告書)から宿泊税取込」ボタン。
- **【#3 費目マスタ初期投入 完成】** `POST /pnl/expense-categories/seed-defaults`＋費目設定に「推奨費目を一括作成」ボタン。本番に11費目投入済(家賃/水道光熱費/消耗品費/リネン・クリーニング/Wi-Fi・通信費/システム利用料/広告宣伝費/小修繕費/ゴミ処理費/害虫駆除費/固定電話。全て金額0=手入力or#2で充当)。

## NEXT（順序・ここから再開）
1. **【#2 残】修繕費/経費レシートの取込**: Drive領収書PDF→費目に自動計上。the Terrace `008_民泊運用`(=`1eD5DRCMO6spahGEE27zXmyCamTFOAQFo`)直下＋サブフォルダ「57 巣だち(ごみ処理)」等に37件。**ファイル名が構造化**(例「260125 ﾚｼｰﾄ(広長浜_消耗品)ニトリ.pdf」= 日付YYMMDD+費目+店名)。→ファイル名で日付・費目を取り、Geminiで金額抽出、月×費目で集計してpnl expensesへ(source=receipts, overriddenは尊重)。物件ごとの領収書フォルダIDを物件docに持たせる想定(`driveReceiptsFolderId`)。宿小町側の領収書フォルダは要特定。
2. **Bookingバックフィル**(上記・要ユーザー再ログイン)。
3. **清掃費の取込**: 清掃スタッフ請求書 or shifts から cleaningCosts へ(既存Gemini import併用可)。
4. **完全自動バッチ**: 毎月 OTA CSV取込→宿泊税/修繕費取込→帳票下書き生成 を自動化(最終ゴール)。

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
