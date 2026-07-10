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

## 過去分バックフィル（2026-07-09 完了）
- **CSV自動取得(scheduler)は未稼働**(scheduler由来0、次8/2)。→ 過去分は手動フェッチ(`scratchpad/backfill-fetch.cjs`)で完了。やどぜいUpload連鎖はフェッチ中のみ停止し**復帰済**(両物件true)。
- **Airbnb**: the Terrace 2025-09〜2026-06 + 宿小町 5-6月、全pnl取込済。売上: 宿小町5月201,769/6月171,062。the Terrace 25/09=288,963・10=397,797・11=194,000・12=235,710・26/01=157,140・**02=0**・03=631,664・04=169,229・05=335,785・06=358,460。
- **Booking**(the Terraceのみ): 25/09=gross335,600・10=62,986・**11=0**・03=332,884・04=**0**・06=286,528 をpnl取込。**2025-12/2026-01/2026-02はBooking予約0**(DLボタン出ず=空月、データ損失なし)。
- **the Terrace 2026-02 は Airbnb・Booking とも予約0**(閉鎖or低季)。宿小町Booking無し。
- 残: 今後分は8/2以降scheduler自動 or アプリ「OTA CSV取込」ボタン。

## DONE（2026-07-09 第2弾・本番 v0709e / commit 1455c18）
- **【#1 宿泊税B自動取込 完成】** `POST /settlement/:pid/:ym/import-tax`。やどぜい**申告書**PDF(税額明記)をGeminiで読み `taxWithholding` に自動セット。宿小町5月=**800円**(4泊×200円/広島県)実証。※月計表は課税泊数のみで税額なし→申告書優先。帳票モーダルに「月計表(申告書)から宿泊税取込」ボタン。
- **【#3 費目マスタ初期投入 完成】** `POST /pnl/expense-categories/seed-defaults`＋費目設定に「推奨費目を一括作成」ボタン。本番に11費目投入済(家賃/水道光熱費/消耗品費/リネン・クリーニング/Wi-Fi・通信費/システム利用料/広告宣伝費/小修繕費/ゴミ処理費/害虫駆除費/固定電話。全て金額0=手入力or#2で充当)。

## DONE（2026-07-09 第3弾・本番 v0709f / commit 6d67742）
- **【#2 領収書/経費の費目自動計上 完成】** `POST /pnl/:pid/:ym/import-receipts`＋帳票モーダル「この月の領収書を取込」ボタン。物件 `driveReceiptsFolderId`(+直下サブフォルダ1階層)のレシートPDFを収集→ファイル名YYMMDDで対象月抽出→費目はファイル名(例「(広長浜_消耗品)」)から推定(guessCategoryFromName_のキーワード表)→金額はGeminiで抽出→月×費目でexpensesに加算(手動overridden保護、receiptsIndexで二重計上防止)。the Terrace 2026-05実データ検証OK(消耗品費7,395/小修繕費297、電球→小修繕費も正判定)。the Terrace `driveReceiptsFolderId=1eD5DRCMO6spahGEE27zXmyCamTFOAQFo` 設定済。

## 領収書フォルダ体系（2026-07-09 確定・整備済）
- Drive体系: `Yamasuke Family Office/500_不動産/520_物件/{物件フォルダ}/008_民泊運用/…`。物件フォルダ内は 001_取得・契約〜008_民泊運用。008内は番号付き(33旅館業/57ごみ/58清掃/59タイミー等)。
- **各民泊物件の 008_民泊運用 配下に `60 消耗品・経費レシート` を新設**(月次の消耗品/備品/クリーニング/電球等のレシート置き場。pnlの領収書取込= `driveReceiptsFolderId` がここを読む)。ごみ処理(57)・清掃請求書(58)は別区分でそのまま。物件購入費・敷金等は対象外(001_取得・契約へ)。
- **the Terrace の散乱レシート29件は 60 へ移動済**。008直下は整理済。
- 6物件の Firestore `driveReceiptsFolderId` 設定済(物件フォルダ=Drive):
  - 宿小町(RZV9…)=M001_エクセリア小町 → 60=`1omSG_PZEX8Z3vETLjYXxw__9rSFN9CkS`
  - the Terrace(tsZy…)=014_広長浜 → 60=`1GaQFwg2bBUQfuYbrcnykkTq-XFeQP4ku`
  - 若草(ZXW6…)=M002 → `1Y3_-7EtmbnQM4fXYSD7IMJE8_tVpHGLs` / 宇品(ncUK…)=M003 → `1s1wOUVp8pZLZ-PjNqAOFdK_dA41rnwss`
  - 安芸津(nM5J…)=025 → `1eP_xSNXx2L2WaPim6CwOihgCYRwmfC3p` / 竹原(uzGp…)=026 → `17ywM1VvWRdkgFBs0Bf_hg6WmJJhfyRHY`
- **宿小町の経費書類は実は整理済だった**(当初「無し」は誤り): `007_光熱・インフラ`配下に **52 ガス/53 電気/54 水道/55 インターネット/56 固定電話**(番号は物件でバラバラ=名前判定必須。the Terraceは 52プロパンガス/54電気/55水道/56インターネット)。清掃=`008/58`, タイミー=`008/71`。消耗品レシート1件(DCM)は_未分類→60へ移動済。宿小町は開業新しく消耗品少・光熱費/通信費が経費主体。
- **光熱・インフラフォルダ `driveUtilitiesFolderId` 設定済**: 宿小町=`18PJ4o8XwN5hiwJ4j3m82pjvcjKc-5AKa` / the Terrace=`1WTvS-DxutcTBBjKs7x_vL8rR42AMbDFi`。

## DONE（2026-07-09 第4弾・本番 v0709g / commit 2362393）
- **【光熱費・通信費の自動取込 完成】** `POST /pnl/:pid/:ym/import-utilities`＋帳票モーダル「光熱費・通信費を取込」ボタン。物件`driveUtilitiesFolderId`(007_光熱・インフラ)配下のサブフォルダを**名前で費目マッピング**(ガス/電気/水道→水道光熱費、インターネット→Wi-Fi・通信費、固定電話→固定電話)、請求書ファイル名の「N月分/N-M月分」で対象月判定(**範囲は月割**)、金額はGeminiで抽出→expensesに計上(overridden保護/utilitiesIndexで二重計上防止)。宿小町5月実証(ガス2,890+水道1,089[4-6月分÷3]=水道光熱費3,979)。

## DONE（2026-07-09 第5弾・本番 v0709h / commit ecd8a6b）
- **【清掃費の自動取込 完成】** `POST /pnl/:pid/:ym/import-cleaning`＋帳票モーダル「清掃費を取込」。アプリ生成の清掃スタッフ請求書(invoicesコレクション)を集計→cleaningCostsへ。同一スタッフ×月は最上位ステータス(paid>confirmed>submitted、draft除外)採用で重複防止、sourceInvoiceIdで冪等、既存の除外フラグ保持。the Terrace 2026-05実証(dedup後70,600円)。
- **【固定費: 家賃】** 宿小町の家賃を賃貸借契約書(Gemini)から取得＝**64,000+共益費4,000=68,000円/月**。2026-05/06の家賃費目に設定済(source=lease)。
- **固定費の実態判明**:
  - **Wi-Fi/固定電話**は光熱費取込(007/インターネット・固定電話)で既にカバー。宿小町の55インターネットは空(別途Wi-Fi契約無し?)。
  - **「システム利用料」=Anthropic(このAI基盤)の請求書**＝**会社全体のシステム経費**で物件タグ無し。特定物件pnlへの自動計上は不適切→配賦方針は要ユーザー判断(全社費用として物件按分するか/pnl対象外か)。
  - **the Terrace は収益物件(所有系)**で家賃無し→固定費はローン利息/固定資産税/減価償却(別テーマ、未対応)。

## ユーザー決定（2026-07-09/10 確定）
- **システム利用料(Anthropic)＝P&L対象外**（会社全体経費、物件按分しない）→ 費目「システム利用料」を**active=false 無効化済**。有効費目=広告宣伝費/消耗品費/リネン・クリーニング/家賃/ゴミ処理費/水道光熱費/Wi-Fi・通信費/害虫駆除費/小修繕費/固定電話 の10件。
- **the Terraceの固定費＝当面は運営経費のみ**（所有物件だがローン利息/固定資産税/減価償却はpnl計上しない）。
- **宿小町の家賃＝68,000円/月で確定**（家賃64,000+共益費4,000、2026-05/06設定済）。

## DONE（2026-07-10 出典/監査・本番 v0710b / commit c0ff6ab）
- **【取込元の出典リンク・内訳確認 完成】** `GET /pnl/:pid/:ym/sources`＋帳票モーダル「出典・内訳を確認」ボタン。売上CSV/宿泊税PDF/光熱費/領収書/清掃費の各取込元を**ファイル名・金額・Drive閲覧リンク付き**で一覧表示。リンクは `https://drive.google.com/file/d/{fileId}/view` をfileIdから決定的生成(Drive API不要)。utilitiesIndexにfileName保存、import-taxにtaxWithholdingFileId保存、各取込itemにlink付与。→ **自動抽出した金額と出典が正しいかクリックで検算可能**(誤りは費目セル手修正で上書き保護)。宿小町5月で売上¥201,769→出典CSVリンク一致を実証。

## DONE（2026-07-10 月次自動取込バッチ・本番 v0710c / commit b103603）
- **【月次自動取込バッチ 完成・稼働中】** スケジュール関数 `pnlMonthlyImport`（Cloud Scheduler `firebase-schedule-pnlMonthlyImport` = **毎月6日5:00 JST・ENABLED**）。`pnlBatchEnabled=true` 物件の前月分を 売上/宿泊税/光熱費/領収書/清掃費 自動取込→報告書・精算書の**下書きPDF生成**→`pnlBatchRuns`に記録。冪等。
  - 実装: `functions/scheduled/pnlMonthlyImport.js` の `run(db, ym)`。既存APIハンドラを `router.cores` に参照保持し **fake req/res で呼ぶ**(ロジック二重化なし)。手動実行=`POST /pnl/run-monthly-import {yearMonth?}`＋収支ツールバー「月次一括取込」ボタン。api の timeoutSeconds=300。
  - `pnlBatchEnabled=true`: 宿小町 / the Terrace のみ(開業前物件は対象外)。増やすときは物件docに設定。
  - 2026-05実データでバッチ検証: 宿小町 利益129,810(売上201,769/家賃68,000/水道光熱費3,959/宿泊税800) / the Terrace 利益498,611(売上671,385/清掃70,600/水道光熱費44,142/消耗品7,395)。

## 現状の自動化度（帳票に必要な情報）
- **取込(pnl化)は全自動**（月次バッチ）。**取得(Driveへ)**: 売上CSV/宿泊税/清掃は自動(listener/アプリ)、**光熱費・領収書はスキャン/撮影の一手だけ人手**(物理・原理的に無人化不可、scan-sorterが仕分けは自動)。
- 稼働前提: ①OTA自動取得スケジューラ(8/2〜) ②Bookingの定期再ログイン(cookie失効時)。
- **未実装(任意)**: バッチ完了のオーナー通知(下書きURL付き)。現状は pnlBatchRuns / 画面で確認。

## NEXT（次セッションで着手・やますけ要望 2026-07-10）
0. **★代行手数料(managementFeeRate)のちぐはぐ解消＋体系整理**（次の新セッションで最優先）: 月別収支ページの「代行手数料 売上×50%」が**固定化**して見え、物件詳細で `managementFeeRate` を 0% にしても月別収支に反映されない。要望3点:
   - (1) パーセントを変更でき、それが月別収支に即反映されるように
   - (2) 現状の**一方向同期の不整合を解消**（物件詳細→月別収支は反映されるが、月別収支側の変更は物件詳細に戻らない、等のちぐはぐ）。SSOTを一本化し双方向 or 単一入口に
   - (3) より分かりやすい体系に再構成
   調査起点: 月別収支の料率参照が `properties.managementFeeRate` を都度読んでいるか／スナップショット固定(`propertyMonthlyPnL` の history や締め済み月固定 [[project_minpaku_v2_rate_month_snapshot]] の思想)か／pnl.js(front)とpnl.js(functions)のどちらで50%既定を当てているか。managementFeeRate の入力UIが物件詳細と収支ページで二重にあるなら統合。
1. バッチ完了通知（LINE/メールで下書きPDFリンク→承認→送信の導線）。
2. 各月の実運用: バッチ or 各取込→「出典・内訳を確認」で検算→帳票PDF確定。

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
