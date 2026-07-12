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

## 会計方針（2026-07-12 ユーザー確定）
- **宿小町の開業月＝2026-05**（初回宿泊予約=2026-05-02）。**2026-04以前の pnl は対象外**。開業前(2025-09〜2026-04)に自動計上された光熱費/固定電話/消耗品費(例: 2026-04 消耗品¥13,396・固定電話¥6,188・水道光熱¥7,126 等)は、**月次損益(pnl)からは除外**する扱い(開業準備費は取得・契約フォルダ側の別管理)。開業前 pnl doc は削除しない(触らない=帳票は各月生成可能なまま)が、**帳票を確定・送付するのは開業月以降のみ**。バッチ対象月も2026-05以降とする運用。
- **the Terrace 過去月(2025-09〜2026-04)の清掃費**: 当時アプリ(v2)の清掃請求書機能ではなく **GAS版アプリ(民泊wpp/minpaku-fix)で清掃スタッフが月次請求書を作成**していた。そのPDFが Drive `81hassac / 長浜_請求書入力 (File responses) / 請求書PDF / {YYYY-MM}` に**月次フォルダで保存されている(2025-10〜2026-04 の各月)**。→ **2026-07-12: 4月分を実データ計上**（田中俊子15,600 + 梶本里奈11,000 + 金本4,100 + 原田裕子4,000 = **¥34,700**、`source="drive_pdf"`・fileId冪等）。Gemini抽出・物件はフォルダパスで the Terrace 長浜と確定・v2 invoices との誤混入なしを検証済。**残る過去月(2025-10〜2026-03)も同フォルダに請求書PDFがあるので、同じ手順(scratchpad/extract-apr-cleaning-invoices.cjs + book-apr-cleaning.cjs 相当)で計上可能**（ユーザー要望時）。source=drive_pdf は v2 invoice(source=invoice)/タイミー等手動(source=manual) と区別され、import-cleaning 再実行でも消えない。
- **【2026-07-12 解決】the Terrace 2026-04 電気代の二重計上を除外**: やますけ指摘「¥41,348は発行日4/13だから3月分では」が的中。`260413 請求書(広長浜_電気代_41348円)スマートビリング.pdf`(発行2026-04-13・支払期限4/30)は**3月使用分**で、同一請求書が3月(ファイル名「03月分」)と4月(ファイル名「41348円」)に**二重計上**されていた。4月から¥41,348を除外→水道光熱費 ¥125,345→**¥83,997**。4月正しい電気代は`260514…エネパル(4月分)¥31,621`のみ。**4月損益: 売上169,229 − 経費132,678 − 清掃34,700 − 宿泊税2,800 = ¥1,851(黒字化、率1.1%)**。報告書PDF再生成済。
- ⚠️ **電気代の月ズレは全期間の問題(要全体整理)**: エネパル/スマートビリング電気は「発行月=使用月の翌月」でファイル名の月判定(import-utilities)が1ヶ月ズレる。精査で判明: `260312 電気¥33,978`(3月計上だが発行3/12=**2月使用分**の疑い) / `260413 電気¥41,348`(3月分・正しく3月にあり+4月に二重→除外済) / `260514 電気¥31,621`(4月分・正)。つまり各月に前月分電気が混入している構造。2月〜6月の電気を発行日→使用月で全部並べ直す整理が必要(やますけ意向確認後)。エネパル電気は2026-06分よりクレカ払い(セゾン明細)へ移行済=import-credit-card-electric で対応。
- **the Terrace 2026-05 の清掃費は ¥101,376**（v2 invoice 3名¥69,800 + **タイミー手動¥31,576=やますけ本人が入力した確定値**、いずれも excluded=false）。2026-07-11 時点の一部報告「5月清掃¥69,800」はタイミー分を見落とした古い値で、**正しくは¥101,376**。タイミー分は正常(ユーザー確認済 2026-07-12)。
- 空 pnl doc(2025-11/2026-01 等)は**触らない**(実害なし)。

## ★次セッション再開点(2026-07-12 セッション移行)
**直前まで完了したこと**:
1. **過去月清掃費計上完了**: 2025-10〜2026-03 の GAS版清掃請求書PDF を Firestore に計上済(6ヶ月合計 **¥289,988**、source="drive_pdf"、fileId冪等)。独立検証(Workflow 6並列 adversarial)で全月 match=true・二重計上なしを確認済。
   - 内訳: 2025-10 ¥38,300 / 2025-11 ¥75,900 / 2025-12 ¥31,500 / 2026-01 ¥22,500 / 2026-02 ¥33,500 / 2026-03 ¥88,288
   - **除外済**: 2026-02「西山PCテスト」名義7件 ¥33,500(テスト) / 2025-10「西山恭介」名義2件 ¥7,300(**ユーザー確認済=すべてテスト・計上不要**)
   - スクリプト: `scratchpad/process-past-cleaning.cjs`(分類ロジック: classify() で「テスト」「西山恭介」「西山PCテスト」を除外)
2. **4月清掃費 ¥34,700 計上済**(田中15,600+梶本11,000+金本4,100+原田4,000)
3. **4月電気代二重計上¥41,348を除外済**(3月分の重複が4月にもあった)、4月利益 ¥-39,497→**¥1,851黒字化**

**★次セッション最初にやること = 電気代の全期間並べ直し(2月〜6月)**:
やますけ確定「電気代並べなおして」の依頼。
- **問題**: エネパル/スマートビリング電気は「発行月=使用月の翌月」で、ファイル名基準の import-utilities で使用月が1ヶ月ズレる構造。各月に前月分電気が混入している。
- **既知の並べ直し前データ**(この時点の実測):
  - 3月に計上済: `260312 電気¥33,978`(発行3/12→**2月使用**の疑い) + `260413 電気¥41,348`(発行4/13→**3月使用・正**)
  - 4月に計上済: `260514 エネパル¥31,621`(発行5/14→**4月使用・正**、ファイル名「4月分」明記) ← 唯一
  - 5月: 電気の計上なし
  - 6月: `260615 請求書(広長浜_ガス料金_6月分)伊丹産業¥5,919` はガス。エネパルは 8月クレカ明細で来る想定
  - ※ 2月以前・9月〜12月・1月の電気は要棚卸し(現状 utilitiesIndex に電気エントリなしの可能性)
- **やり方**:
  1. `scratchpad/audit-all-electric.cjs` を新規作成: 全期間の utilitiesIndex から電気代を全部拾い、各PDFの発行日(ファイル名先頭YYMMDD or Gemini)→使用月を判定 → 現在の計上月と正しい使用月の対応表を出す
  2. ユーザー確認後、`scratchpad/realign-electric.cjs` で utilitiesIndex を並べ直し(各月の電気エントリを削除→正しい月に追加)、水道光熱費 expenses.amount を新しい月別合計で書き直し
  3. 影響を受ける月の pnl 帳票PDF再生成
  4. 電気単独の月ズレは今回で解消するが、`import-utilities` のロジック自体(ファイル名N月分を優先/無ければ発行日→前月)は追って恒久修正(次NEXT)
- **参考ファイル**(既に scratchpad にある):
  - `verify-electric-41348-detail.cjs`(¥41,348検証・削除済)
  - `fix-apr-duplicate-electric.cjs`(4月から重複除外・実行済)
  - `verify-apr-electric-period.cjs`(4月utilitiesIndexダンプ)

**次セッションへの依頼文(コピペ用)**:
> pnl-automation-plan.md の「★次セッション再開点」から。電気代並べ直しを実行してください。全期間の電気代を audit → ユーザー(私)確認 → realign。

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

## DONE（2026-07-10 運営形態導入＋代行手数料の料率再構成・本番 v0710h / commit 25988b4）
- **【★代行手数料のちぐはぐ解消＋体系整理 完成】** NEXT#0 を実装・デプロイ(relay+本番/functions api+pnlMonthlyImport)・実データ検証済。真因は**スナップショット固定でもキャッシュでもなく `|| 50`**（`Number(0)||50=50` で 0% が保存時に 50% へ化ける）だった。
  - **運営形態(operationMode)を物件マスタに新設**: `agency_hassac`(八朔代行)/`agency_other`(その他代行)/`self`(自社運営=代行なし)。物件詳細に選択UI追加。旧 `settlementMode`(self/daiko)は後方互換で読み継ぎ＆保存時に同期。決定ロジックは `resolveOperationMode(prop)`(functions/api/ota-csv-logic.js)。
  - **自社運営=手数料0%強制**: `effectiveFeeRatePct` が self なら誤って料率が入っていても常に0。月別収支の代行手数料列・料率UI・精算書を**全非表示**（月次業務報告書は内部用に発行可＝ユーザー決定）。物件詳細でも self 選択時に料率欄を隠す。
  - **料率SSOT一本化＋0%保存可**: `managementFeeRate` の `|| 50` を front(properties.js 2箇所)/functions(properties.js update) 全撤廃。料率の優先順位は「月固定(`propertyMonthlyPnL.feeRatePct`) ＞ 物件既定(`managementFeeRate`) ＞ 50」。月別収支で行の料率チップをクリックしてその月だけ固定/解除(`PATCH /pnl/:pid/:ym/fee-rate`)、ツールバー「既定料率を変更」で未固定月へ即反映。
  - **代行手数料列＝精算書と同一式**: `/pnl/summary` が `computeSettlement`(入金額A=Airbnb総額+Booking手取り − 宿泊税B、×料率、+消費税)で各月の実請求額(税込)＋実効料率を返し、フロントは表示のみ。`computeDepositAmount`/`effectiveFeeRatePct` を settlement.js と共有し乖離ゼロ。
  - agency_other の精算書は会社情報(発行元)未設定でブロック(報告書は可)。月次バッチ(pnlMonthlyImport)は精算書を **agency_hassac のみ**生成。
  - テスト: ota-csv-logic.test.js に helper のユニット追加(**全109緑**)。実データ検算: 宿小町(代行)5月=税込110,534(宿泊税800控除) / the Terrace(自社)5月=料率50保存でも実効0%＝0。
  - 本番 operationMode 設定済(2026-07-10 ユーザー確認反映): 宿小町=agency_hassac / the Terrace=self / **WAKA-KUSA=agency_hassac(料率70%)** / **UJINA=agency_hassac(料率5%=八朔の取り分)**(旅館業申請者=tomi企画(富永洋)だが**運営は八朔**)。他物件は未設定(UI既定=八朔代行)。
  - **若草の契約条件メモ**: 家具家電購入は八朔負担。この費用は **pnl の費目・収支から除外**する(開業後にpnl化する際は費目計上しない/計上済みなら除外フラグ)。開業前のため現状データ計上なし。
  - 変更: functions(ota-csv-logic.js/pnl.js/settlement.js/properties.js/scheduled/pnlMonthlyImport.js)、front(index.html/js/pages/pnl.js/js/pages/properties.js/js/api.js)。

## DONE（2026-07-10 the Terrace Booking収支の月ズレ・取りこぼし修正）
- **ユーザー指摘「the Terrace 2月が0泊はおかしい」は正しかった**。2026-02 は Booking 6件・gross¥293,480（NAGAI/KUO/nishihan/SOTA/KISHIOKA/Nakai）なのに pnl は0だった。
- **真因**: 過去分バックフィルの Booking CSV が (1)月ラベルと中身がズレて保存(別月予約の混入) (2)一部月(2月/12月)を丸ごと取りこぼし。加えて Booking.com セッション失効で再取得も不可の状態。ファイル名(=要求月)で取込むため**中身の別月データを誤計上**していた。Airbnb側(開始日で正しく分割)は無事。宿小町(Airbnbのみ)は無影響。
- **リスナー修正(feature/yadozei-csv commit aeb5230)**: `handleBookingCsv` のDL行選択が `:is(li,tr,div)` のネストで親コンテナ誤爆し `.last()` で別月行を掴む不具合→各「ダウンロード可能」リンクの祖先行に月初+月末が含まれる行だけ選ぶ方式に。さらに `verifyBookingCsvMonth` で取得CSVのチェックイン日が要求月と一致するか検証し、不一致なら保存せずエラー(静かな月ズレを根絶)。
- **再取得**: Booking セッション再ログイン(`--login`)後、全期間(2025-08〜2026-12)を arrival基準で1本エクスポート→実チェックイン月で振り分け。`sumBookingCsv` 同一ロジックで各月を再計算し pnl の `revenue.booking` と `nights` を修正(**8ヶ月**: 25-09/10/11/12・26-01/02/03/06)。**全10ヶ月が extranet 実績と一致**を確認(scratchpad/analyze-booking-all.cjs)。
- **正しい各月Booking gross**: 09=0 / 10=99,666 / 11=332,884 / 12=88,200 / 26-01=0 / 02=293,480 / 03=286,528 / 04=0 / 05=335,600 / 06=62,986。
- **運用注意(重要)**: Booking.com セッションは失効する。失効時は `pm2 stop yadozei-listener` → `node yadozei-listener.mjs --login`(Bookingにログイン) → Ctrl+C → `pm2 start yadozei-listener`。**失効中は自動取得が失敗する**(8/2の月次取得前に要確認)。過去分の掃引は scratchpad の analyze/rebuild-terrace-booking.cjs 参照。
- 訂正: 旧記載「the Terrace 2026-02 は Airbnb・Booking とも予約0」「2025-12/2026-01/2026-02はBooking予約0」は**誤り**(バックフィルの取りこぼし/月ズレ)。
- **【宿泊税(やどぜい)への波及検証 = 汚染なし】** `yadozeiQueue` の実アップロード履歴を全確認: やどぜいへ実インポートされたのは **2026-05 のみ**(Airbnb+Booking)。他月(2025-09〜2026-04/2026-06)は**一度も未アップロード**(バックフィル時にUpload連鎖を停止していたため、月ズレCSVはやどぜいへ送られていない)。アップロードした2026-05 Booking CSV 4本は全て中身が正しく5月(catfile確認)。**2026-05 申告書PDF=課税50泊(¥10,000)+非課税36泊=計86人泊**で5月実績と整合、複数回アップロードでも**二重計上なし**(やどぜいが予約単位で重複排除)。→ **Bookingバグは宿泊税申告を汚染していない**。
- **宿泊税の運用残**: やどぜい経由で自動申告済みは 2026-05 のみ。過去分(2025-09〜2026-04/2026-06)は自動化経由では未申告(手動申告済みか要確認)。必要なら修正版リスナーで正しく取得→アップロード可能。

## 2026-07-11 収支検証（the Terrace 5月・6月）で判明した要対応
検証結論: **収入・経費の金額集計は正確**（5月はAirbnb/Booking CSV再計算＋経費8件PDF OCRが全件一致で実証）。問題は「取込漏れ・資料未着・下記バグ・電気クレカ化」に集約。

### 確定バグ（ユーザーGO済み・実装中）
- **①Booking決済手数料**: `computePnl`(pnl-logic.js:164)は `paymentFee` 対応済みだが、予約CSVに決済手数料の列が無く常に0。→ **ユーザー決定=Booking手数料請求書PDFをGeminiで自動取込し `revenue.booking.paymentFee` をセット**。6月決済手数料=1,448（請求書#1656724183）。全Booking利用月に影響。
- **②voided除外**: `import-cleaning`(pnl.js:858)が draft のみ除外し取消済(voided)が残る。→ voided除外＋既存クリーンアップ（chosenに無いinvoice由来行を削除）。5月に西山800(voided)混入→正しくは**70,600ではなく69,800**。
- **③複数物件按分**: `import-cleaning`(pnl.js:877)が `inv.total`(基本給・交通費込み全額)を top物件へ計上。→ **単一物件請求は現状維持（基本給込み全額）、複数物件請求のみ byProperty.total＋共通手当を shiftCount 比で按分**。5・6月は単一物件のみで数字不変（潜在バグ）。

### 電気代クレカ化（重要・新経路が必要）
- **the Terrace の電気=エネパル**。6月分より請求が**クレカ払い（セゾンプラチナビジネスAMEX 名義:西山恭介、収納代行アプラス/スマートビリング）に切替**。→ 光熱費PDFフォルダ(`driveUtilitiesFolder`)取込では拾えない。
- **6月電気代=36,459円**（支払先エネパル、8月カード請求分。2026-07-11 ユーザー実確認）。以前の請求はスマートビリングのコンビニ/振込PDF（3・4月分まで、4月分¥31,621は1月分¥3,176+1月分¥16,172+4月分¥12,273の混在）。
- セゾン明細=Drive「セゾン」`1l15Zou0b5AsQZS1qluPLfXYypbf16QGY` / 「241002 セゾンプラチナビジネスAMEX」`1f8GiV49afjuTuYuTe77aWT_nGVDA1UYZ` に `SAISON_YYMM.csv/pdf`。**CSVはShift-JIS化けするのでPDFを読む**。明細内「ソフトバンクでんき」は切替前/別物件の可能性。→ 将来クレカ明細から電気代抽出経路 or 手入力。

### 6月 the Terrace あるべき経費（元資料でOCR確定済み）
- 清掃13,200 / ガス5,919 / **電気36,459** / 水道(4-6月分¥7,319の月割≈2,440) / ごみ2,200 / 消耗品4,387 / 通信1,200 / Booking決済手数料1,448。
- 6月は `pnlBatchRuns` に2026-06記録なし=**バッチ未実行**。売上(Airbnb358,460/Booking62,986)とガス5,919のみ計上済み。清掃`cleaningCosts`空・`receiptsIndex`空。
- ⚠️ Drive上 `booking_reservations_2026-06.csv` の中身が**3月の予約**（月ズレ残骸）。Firestore値は掃引済で正しいが、「OTA CSV取込」ボタン再実行で再汚染リスク→要削除/修正。
- 6月レシート(ハローズ/ダイソー/ローソン/ごみ)は八朔月次フォルダ`1OFuLlh4…`にあり物件フォルダ`60`(driveReceiptsFolderId=1GaQFwg2…)に未整理→自動取込が拾えない。

### 5月 the Terrace 検証値（正常取込月・突合OK）
- 収入: Airbnb335,785(6件10泊)/Booking335,600・コミッション50,340・net285,260(3件6泊) 全一致。
- 費目: 水道光熱費22,652(ガス3,601+水道19,051)/消耗品費7,395(コーナン492+ダイソー3,525+ダイソー2,205+セリア110+ハローズ1,063)/小修繕費297(電球) 全一致。清掃70,600→西山800(voided)除外で**69,800**。
- 5月電気代は請求書未着で未計上（開発記録の44,142は暫定値、現在22,652）。オロナミンC等アメニティ/接待の費目区分は要確認。

## DONE（2026-07-11 バグ修正＋5月是正＋6月反映 全完了）
**コード変更**:
- `functions/api/pnl.js` `import-cleaning`: ②voided除外(`if (inv.voided === true) return;`)＋既存クリーンアップ(chosenIdsに無いinvoice由来行を削除、`removedRows`)＋③按分(`cleaningAmountForProperty(inv, propertyId)`呼び出しに置換、2箇所)。
- `functions/api/pnl.js` `applyParsedToPnl_`: ①`docKind==="booking_invoice"`処理を追加(revenue.bookingのpaymentFeeを補完、gross/commissionは既存保持、netRevenue=gross-commission-paymentFee)。`analyzePnlPdf_`プロンプトにbooking_invoice分類＋bookingInvoiceブロックを追加。
- `functions/api/pnl-logic.js`: `cleaningAmountForProperty(inv, propertyId)`新規＋export(単一物件=inv.total全額 / 複数物件=byProperty.total＋共通手当shiftCount比按分)。
- `functions/api/pnl-logic.test.js`: `cleaningAmountForProperty`テスト6件追加(単一/1物件/複数按分/shiftCount0/該当外/¥カンマ入り)。**全127テスト緑**。
- デプロイ: `firebase deploy --only functions:api --project minpaku-v2` 成功。フロント変更なし=bump不要。

**5月是正(実行結果)**:
- `import-cleaning` 再実行 → 田中俊子25200＋平川マサキ22300＋梶本里奈22300＝**69,800** (西山800/田中旧版6200/西山300 の voided=true 3件除外、削除行1件)。**70,600→69,800** で予測通り。

**6月反映(実行結果、self運営=代行手数料なし)**:
- 清掃取込: 田中15,000＋平川800＝**15,800** (invoice実額が真実。plan.md旧記載「13,200」は不正確だった)。
- 決済手数料: paymentFee=**1,448** を admin書き込みで反映 → netRevenue=62,986-9,448-1,448=**52,090**。
- 水道光熱費: import-utilities実行で水道4-6月分PDFは「事前通知/見積」判定で自動skip → **overridden=true で 44,818 手入力**(内訳: ガス5,919+水道月割2,440+電気36,459 エネパル/クレカ払い)。breakdown を expenses ドキュメントに保存。
- Wi-Fi通信費: **1,200 手入力(overridden=true)**。
- ゴミ処理費: **2,200 手入力(overridden=true、Gemini実測)**。※import-receipts の filter が「請求書」名を拾わない実装のため、手入力で反映(下記NEXT#0参照)。
- 消耗品費: 5件のPDFを 八朔月次`1OFuLlh4…`→ Terrace60`1GaQFwg2…`へ Drive API で移動 → import-receipts で **4,387 自動計上**(ダイソー1,863+ハローズ767+ハローズ1,458+ニトリ299)。plan.md「4,387」に完全一致。
- 最終値: 売上421,446 / OTA手数料10,896 / 清掃15,800 / 経費52,605 → **利益342,145 (率81.2%)**。

**6月CSV残骸掃除**:
- `booking_reservations_2026-06_1783544603989.csv` (id=1xEc2NYP8i71QJux-keescts2mN1aQBPb、中身3月予約) をTerrace OTAcsvフォルダから**trashに送付**(復元可能)。八朔月次にある同名別コピー(id=1tCXkWlx...)は listener 監視外なので放置OK。

**今回の実行スクリプト(全て scratchpad/)**:
- `dryrun-cleaning-import-2026-05.cjs` / `exec-import-cleaning-2026-05.cjs`(5月是正)
- `inspect-terrace-2026-06.cjs` / `dryrun-cleaning-2026-06.cjs`
- `exec-terrace-2026-06-step1.cjs`(清掃+paymentFee) / `-step2.cjs`(電気/水道月割/通信 overridden)
- `exec-api-utilities-2026-06.cjs`(import-utilities) / `exec-api-receipts-2026-06.cjs`(import-receipts)
- `list-hassac-june-receipts.cjs` / `move-june-receipts-to-terrace60.cjs`
- `extract-gomi-2026-06.cjs`(Gemini実測+反映) / `trash-bad-june-csv.cjs`

**API 認証パターン**: ADCではcreateCustomTokenが署名不可(ENOTFOUND metadata)。代わりに **`settings/taxDocs.gasSecret` を読み Bearer `gas-{secret}` で叩けば認証を通過**(functions/index.js:65-73 の gas ブランチ)。scratchpadから本番APIを叩くときの標準手段。Drive操作は yamasuke81 OAuthトークン(`settings/gmailOAuth/tokens/{yamasuke81@gmail.com}.refreshToken`+ `settings/gmailOAuth`の clientId/clientSecret)で `google.auth.OAuth2` を作る。

## DONE（2026-07-11 6月クローズ: 宿泊税＋バッチ再実行）
- **the Terrace 5月宿泊税**: `import-tax` を folderId=旧宿泊税フォルダ`1yN4K39...` 指定で叩き、`yadozei_申告書_2026-05_1782979510817.pdf` から **10,000円** を自動抽出(confidence=100、申告書「課税50泊×200円」と一致)。pnl.taxWithholding=10,000 反映。
- **the Terrace 6月宿泊税**: 申告書PDF未生成(yadozeiQueue に upload/pdf_fetch が enqueue されていない)ため、booking-refetch/booking_all.csv とAirbnb CSVから予約単位で計算 → **600円**(Booking Siu 3人×1泊 34,400円 /人/泊=11,466 → 200円/人泊×3。他は全て /人/泊<10,000 で非課税)。admin書き込み(source=手計算, breakdown保存)。
- **宿小町6月宿泊税**: Airbnb 9件全て /人/泊 3,017〜6,591円で **0円**。監査可能性のため明示的に taxWithholding=0 で反映(内訳breakdown保存)。5月の 800円と対照的なのは6月が短期・低単価予約中心のため。
- **pnlMonthlyImport 2026-06 手動再実行**: `POST /pnl/run-monthly-import {yearMonth:'2026-06'}`。両物件で完了:
  - **YADO KOMACHI**: 売上171,062 / 経費83,001 / 清掃6,710 / 利益81,351 (率47.6%)。settlement=**94,084円(税込)** 下書きPDF生成。tax取込は「PDF無し」で失敗するが既存 taxWithholding=0 保持。
  - **the Terrace**: 売上421,446 / 経費52,605 / 清掃15,800 / 利益342,145 (率81.2%)。tax取込失敗するが既存 taxWithholding=600 保持。overridden系(水道光熱44,818/Wi-Fi 1,200/ゴミ2,200)＋paymentFee 1,448 全て保持。report下書きPDF生成(self運営なので settlement は生成せず)。
  - pnlBatchRuns runId=`2026-06_1783722801` 記録。
- 実行スクリプト: `find-yadozei-june.cjs` / `find-yadozei-may-terrace.cjs` / `find-yadozei-komachi-june.cjs`(申告書PDF所在調査) / `calc-terrace-tax-2026-06-v2.cjs` / `calc-komachi-tax-2026-06.cjs`(宿泊税手計算) / `exec-api-import-tax-terrace-may.cjs`(5月API取込) / `exec-tax-terrace-2026-06.cjs`(6月手入力) / `exec-run-monthly-import-2026-06.cjs`(バッチ再実行)。
- **判明した6月やどぜい未実行の原因**: yadozeiQueue に airbnb_csv_fetch / booking_csv_fetch は enqueue 済(status=done)だが、`yadozei_csv_upload` / `yadozei_pdf_fetch` が連鎖enqueueされていない。listener 側で連鎖が回っていない or フラグ設定変更が影響。8/2 の月次自動取得までに要確認。
- **広島県宿泊税ルール（今後の計算根拠）**: 1人1泊あたり宿泊料金で判定。<10,000円=非課税 / 10,000〜20,000円=200円 / 20,000円〜=500円。乳幼児は「大人+子ども」に含めない運用。Airbnbの「収入」列(ホスト受取)ベースで計算(税抜換算は誤差1割程度で判定閾値をまたぐ稀ケース以外は影響なし)。

## DONE（2026-07-11 NEXT全項目実装・本番反映済）
- **#5 予約CSVから宿泊税自動計算(申告書PDF不在時のフォールバック)**: `computeAccommodationTax` / `hiroshimaTaxPerPersonPerNight` / `extractAirbnbReservations` / `extractBookingReservations` を pure関数として追加(pnl-logic, ota-csv-logic)。宿小町5月=800円/the Terrace 5月Booking抜粋=5,600円 の実データ検算緑。settlement.js の import-tax にフォールバックとして組込済み(申告書PDF不在時に自動計算→taxWithholdingBreakdown保存)。
- **#0 経費PDF分類ロジックを classifyExpenseByName_ に集約**: receipts系(ごみ/害虫/クリーニング/消耗品/修繕/広告)とutilities系(光熱/通信/固定電話)、対象外(通帳/配当/カード明細/契約金/届出)を明示的に振り分け。listReceiptPdfs_ は「請求書」名も拾えるように拡張しつつ scope=receipts のみ通す設計。光熱請求書との競合排除、6月ごみ処理費「合計請求書」の手入力回避を根治。
- **#1 バッチ完了通知の承認導線**: pnlBatchRuns に approvedAt/rejectedAt を記録。エンドポイント `GET/POST /pnl/batch-runs/:runId/(approve|reject)` を追加(承認要 owner role, /:propertyId/:yearMonth 誤マッチ回避のため router 順序で前段配置)。承認画面 `public/pnl-approval.html` を実装(Firebase Auth + Bootstrap SPA、下書きPDFリンク＋承認/却下UI)。pnlMonthlyImport の通知本文に承認URLを自動付与(settings/notifications.appUrl + openExternalBrowser=1 付き)。
- **#4 yadozei upload連鎖の未実行原因の特定**: 6月分は csv_fetch=done だが upload連鎖が飛んでいなかった。原因=6/8時点で `yadozei.yadozeiUpload.enabled=false`(バックフィル停止フラグ)だったため。現在は両物件 true に復帰済で次回8/2以降は自動で連鎖する見込み。**Booking.com セッションが `logged_out`** のため、8/2 の月次自動取得の前に `--login` で再ログインが必要(手順は memory `project_minpaku_v2_yadozei_csv_auto.md`)。6月分の申告書PDFは生成されないが、pnl の taxWithholding は #5 の計算値または手入力で既に反映済み(the Terrace 600円/宿小町 0円)。
- **#3 電気代クレカ化対応**: セゾン明細PDFから電気料金を抽出→「エネパル/収納代行アプラス/スマートビリング」系のみを絞り込む pure関数 `filterElectricPaymentsForProperty` を実装。エンドポイント `POST /pnl/:pid/:ym/import-credit-card-electric` を追加(the Terrace `driveSaisonFolderId=1f8GiV49afjuTuYuTe77aWT_nGVDA1UYZ` 設定済み)。**明細検索は yearMonth の翌々月分**(エネパル 6月分請求→8月クレカ支払→8月明細)。dryRun でSAISON_2601.pdfを確認: ソフトバンクでんき18,643円を detected、フィルタで adopted=0(別物件のため正しく除外)。**実運用初回稼働は2026-08分明細=SAISON_2608.pdf**が来た時点。8月バッチで自動的にthe Terrace の水道光熱費に加算される想定。creditCardIndex で二重計上防止、水道光熱費が overridden=true なら手動値を保護。
- **全188テスト緑**(pnl-logic 41件・ota-csv-logic 34件・pricing-logic 43件・その他)。commit `4e9ff84` (feat(pnl): 宿泊税自動計算+承認導線+分類リファクタ+yadozei調査記録)＋次コミット (電気クレカ化) で本番反映済み。

## DONE（2026-07-11 workflow監査結果に基づく critical/high 修正）
Workflow audit(65エージェント/54 findings→adversarial verify通過27件)で発見した重大バグを一括修正。

- **[critical] 承認画面 pnl-approval.html の Firebase SDK 本体未ロード** → firebase-app-compat.js + firebase-auth-compat.js を追加。同時にXSS対策(全innerHTML補間を escapeHtml/safeHref)、ネイティブ confirm/alert 禁止ルール順守(showConfirm/showAlert 実装)、二重クリック抑止(setBusy)、未ログイン時の /?redirect= リダイレクト、モーダル背景オーバーレイ実装。
- **[critical] PDF署名エラー `Cannot sign data without client_email` 修正** → getSignedUrl を v4 化 + Cloud Functions Gen2 runtime SA (`418111574543-compute@developer.gserviceaccount.com`) に `roles/iam.serviceAccountTokenCreator` を付与(gcloud iam service-accounts add-iam-policy-binding で SA自身に対して付与)。5月 the Terrace report PDF を実データで再生成成功(revenueGross=671,385 / profit=520,901)。
- **[high] 承認/却下 endpoint を owner 限定** → pnl.js の approve/reject/GET に `req.user.role !== 'owner'` の403チェックを追加。requireOwnerRole ヘルパー化。
- **[high] firestore.rules に pnl 系ルール追加** → propertyMonthlyPnL(owner + subOwner 自所有物件のみ read、write は API 経由禁止) / expenseCategories(owner/subOwner read) / pnlBatchRuns(owner限定 read、write禁止)。
- **[high] PDF署名URL 7日失効問題を根絶** → savePdfToStorage_ の返り値を `{url, storagePath}` に変更、pnlMonthlyImport で storagePath を pnlBatchRuns.results[].steps.{report|settlement}.storagePath に保存。GET /pnl/batch-runs/:runId で毎回 getFreshSignedUrl_(15分有効の v4 署名) で url を差し替え。過去通知のリンクが失効しても再アクセス時に新署名で開ける運用に。
- 認識訂正: Cloud Scheduler `firebase-schedule-pnlMonthlyImport` は **毎月6日 05:00 JST** (schedule `0 5 6 * *`)。8/2 は yadozei CSV dispatcher の実取得日で pnl バッチではない。
- 全154テスト緑。

## NEXT
1. **8/6 05:00 JST の月次自動バッチ(初回本番稼働)を見届ける**: pnlMonthlyImport が発火→7月分をfullloop→承認通知→やますけが承認画面で確認→approve→送付。エネパル(the Terrace 8月明細)の自動計上も同時。
2. **Booking.com セッション再ログイン**: 現在 logged_out。手順は memory `project_minpaku_v2_yadozei_csv_auto.md`。8/1深夜までに完了要。
3. **7月分の Drive 投入(8/2〜8/5 人手)**: Terrace/宿小町 の光熱PDF(007配下)/レシート(60配下)/清掃請求書 を投入。ScanSorter経由で自動振り分けさせる。
4. **the Terrace 固定費台帳の整備**: workflow audit で「家賃/Wi-Fi通信費/ゴミ処理費/リネン・クリーニング/固定電話 の月額固定費が5月時点で空」を指摘。properties.pnlSettings.monthlyFixedCosts を新設し、pnlMonthlyImport にapplyFixedCosts_ を組込 → 2025-09〜2026-05 バックフィル。※ ただし the Terrace は self運営で家賃なし・Wi-Fi/固定電話は光熱utilities経由で拾える設計なので、実質「ゴミ処理費」の固定化のみで足りる可能性(要確認)。
5. **importCreditCardElectric を pnlMonthlyImport.run() に組込**: importUtilities 直後に invoke。未設定物件は skipped扱い。8月から自動稼働。
6. **バッチ通知本文の警告強化**: importOtaCsv error 時に「🚨 売上未取得」を通知先頭に挿入するガード。売上¥0の下書きが黙って届く事故を防止。
7. **2026-04・2026-03 リカバリ**: pnlBatchRuns に 2026-04/2026-03 の run が無い(workflow audit)。4月/3月分を手動バッチ実行して整備。
8. **税抜換算対応(遅延優先度低)**: Airbnb「収入」列基準で /人/泊 を計算する現行仕様は、閾値10,000円をまたぐ稀ケースで誤差の可能性。運用で問題が出るまで保留。

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
