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

## DONE(2026-07-14 空白期間電気の完全解明: 楽天でんき広長浜2契約を発見し5ヶ月分¥89,103を計上)
やますけが debug Chrome で楽天でんきマイページにログイン→契約一覧・月別料金APIを読解し、**「the Terrace 空白期間(25-09〜26-01)の電気」の正体を完全解明**:
- **広長浜(the Terrace)は楽天でんき2契約(customer_no 8076582092/8076582292、2025-07-22〜2026-01-22)で稼働していた**。中国電力の¥1,954×2(25-09/10計上済)は0kWhの基本料のみ(未使用の旧契約=経費としては正当なので保持)。
- 月別料金API `https://api.energy.rakuten.co.jp/mypage/v1/usages/denki/{customer_no}/monthly?target_year=YYYY` で公式値を取得(セゾン翌月8日決済、2/8決済17,925+4,736=MF実測と一致)。
- **計上(5ヶ月合計¥89,103)**: 09=19,494 / 10=16,392 / 11=18,522 / 12=12,034 / 01=22,661(creditCardIndex `rakuten:{cn}:{ym}` 冪等)。2025-08分(7/22-8/20)¥15,009 は**開業前のため計上せず**(宿小町と同方針)。
- **反映後利益**: 09=¥260,769(90.2%) / 10=¥422,417(84.9%) / 11=¥366,914(69.6%) / 12=¥336,559(82%) / 01=¥81,278(51.7%)。
- **これで the Terrace の電気は開業以来全月計上済み**: 09-01=楽天でんき / 02=¥33,978 / 03=¥41,348 / 04=¥31,621 / 05=¥36,459 / 06=7月中旬のカードposted後に07:35ルーチンが自動計上予定。
- **楽天でんき契約⇔物件の確定対応**(マイページAPI実測): 8070379292=エクセリア小町704(恭介・**宿小町**) / 8076857892=呉市清水2-3-13 DJD(八朔・開業前?) / 8071429292=西川原石(恭介・0kWh) / 8087608092=音戸町鰯浜(恭介・2026-05開始) / 8076582092・8076582292=広長浜(解約済)。**宿小町の電気はこのAPI直読み(契約8070379292)が最良ソース**(カード行の大小ヒューリスティック不要)。

## 調査確定(2026-07-14 MF化候補の全数棚卸し — 実装待ちGO確認)
やますけ依頼「MFに頼っていない部分でMFに頼れば済みそうなものをピックアップ」→ 全口座実スキャン+やますけ回答で確定した振り分け:
**MF化する(実装候補・全て実データで裏取り済)**:
1. **Airbnb入金監視**: 振込人=**ペイオニアジャパン**。**楽天第三=the Terrace / 楽天ハープ=宿小町**(やますけ確認済。ただし小町開業直後の2026-05前半は第三に混在していた)。予約単位入金(CI+数日)で、**3月の第三ペイオニア9件合計=¥631,664=帳簿3月Airbnb売上と完全一致**を実証済。mf-booking-monitor と同型で月次突合可能。
2. **宿小町ガス(ニシモトヤ)**: 楽天ハープから毎月上旬引落「SMBC(ニシモトヤ」(4/6¥2,080→7/6¥5,270)。PDF待ち不要・1ヶ月早い。
3. **宿小町電気(楽天でんき)**: セゾンカード毎月8日決済。同カードに2契約あり(大=小町: 2,481→3,747→5,016 がPDF系列と一致 / 小=開業前物件: 915→1,070→1,114)。**契約と物件の対応確定にはやますけが debug Chrome で楽天でんきマイページ(mypage.energy.rakuten.co.jp)にログインしてくれれば読める**(現在未ログイン確認済)。暫定ルール「大きい方=小町」でも運用可。
4. **固定電話(NTTファイナンス)**: 楽天第三 4/15 ¥6,188(帳簿の小町4月固定電話と一致)。※6/26はフーガからコンビニ支払¥6,729=支払い方法が揺れている点は注意。
**PDFベース継続で確定(やますけ回答)**: 伊丹産業ガス(Terrace)=振込用紙 / タイミー=振込用紙 / 巣だち(ゴミ)=振込用紙 / 消耗品レシート類(物件・費目の紐付けに現物必須)。
**呉市水道(Terrace)=口座振替だが MF で追えない**: 全MF連携口座の金額×日付スキャンでヒットなし。呉信海田(恭介・連携済)/広銀海田(八朔・連携済)にも水道行なし。**商銀海田は「手入力口座」=MFに明細が入らない** → 振替元は商銀海田 or 未連携口座の可能性が高い。→ 水道はPDF継続(もし振替口座を楽天第三等へ変更すればMF化可能=任意提案)。
**やますけアクション(任意)**: ①debug Chrome で楽天でんきにログイン(契約→物件対応の確定用) ②呉市水道の振替元口座を通帳で確認(MF化したい場合のみ)。

## DONE(2026-07-14 MF常設監視化: Booking入金の自動突合ルーチン+手数料/キャンセル料の恒久組込)
やますけ決定「今後はMFで監視しましょう」→ 実装完了・稼働開始。
- **sumBookingCsv を恒久修正(functions/api/ota-csv-logic.js)**: ①決済手数料 `paymentFee=round(gross×2.3%)/滞在`(定数 BOOKING_PAYMENT_FEE_RATE、銀行×財務明細で実証済)を自動計上、netRevenue=gross−comm−fee(=実際の銀行入金額)。②**キャンセル料徴収行(cancelledでもcomm>0)を売上として計上**(chargedCancelCount、泊数は加算しない)。→ 今後の「OTA CSV取込」やバッチは手数料もキャンセル料も最初から正しく入る(今回の2種類の漏れの再発防止)。テスト2件追加(全169緑)、import-ota-csv ハンドラも paymentFee 保存に対応。デプロイ済。
- **API新設 `POST /pnl/:pid/verify-booking-payout {amount,date}`**: 入金額を「前月チェックアウト分バッチ」の期待値(Drive予約CSVから CO∈対象月 の ok行+キャンセル料徴収行の Σ(gross−comm−fee))と突合し match/residual/滞在明細を返す。
- **PC監視ルーチン `scripts/mf-booking-monitor.mjs`(毎日07:40・command型=トークンゼロ)**: MFの楽天第三口座CSVから Booking入金を検知(MF取引IDで冪等)→APIで自動突合→**一致=💰✅ / 残差=🚨(財務明細確認を促す)を#経理へ通知**。E2E実証: 7/3入金¥52,090→CO6月分と1円一致✅、6/4入金¥277,541→CO5月分と1円一致✅。state=`~/.claude/channels/discord/mf-booking-monitor-state.json`。
- **落とし穴修正(両MFスクリプト共通)**: ①firebase-admin は Windows node で終了時 libuv assert クラッシュ(exit127)→routines のエラー誤通知になるため排除。APIシークレットは `~/.claude/channels/discord/v2-gas-secret.txt`(NotifyInbox と同方式)から読む。②playwright CDP 接続後の `process.exit()` も同クラッシュを誘発→`process.exitCode`+自然終了に変更。**PC常駐スクリプトの鉄則: admin SDK 禁止+process.exit() 禁止**。
- 常駐ルーチンは3本体制: 経理朝ダイジェスト07:20(Claude型) / MF電気代07:35(command型) / MF Booking入金監視07:40(command型)。AUTOMATION.md+ダッシュボード更新済。
- **★やますけ指示(2026-07-14): MF監視は OTA CSV 自動取得の「代替」ではない。yadozei-listener の Airbnb/Booking CSV ダウンロードは従来どおり継続する**(①やどぜい宿泊税申告に両CSVが必須 ②pnl売上取込の源泉 ③MF入金監視の期待値計算も Drive の予約CSVを参照=CSVが止まると監視も壊れる)。listener を止める判断は今後もしない。→ だからこそ NEXT#2 の Booking 再ログイン(8/1まで)は必須のまま。

## DONE(2026-07-14 銀行入金×Booking 全期間突合: 4月キャンセル料発見+決済手数料を全月確定)
やますけ指摘「Booking 4月売上ゼロはありえない」→ MF の楽天第三口座入金(ドイツギンコウ BOOKING.COMブン)と booking_all.csv を**チェックアウト月バッチで厳密突合**した結果、指摘どおり計上漏れを発見・是正。
- **突合結果: 9バッチ中7バッチが円単位で完全一致(残差0)** → booking_all.csv の ok滞在データと「決済手数料=round(gross×2.3%)」の正確性を同時に実証。
- **[是正1] 4月キャンセル料 ¥46,800 を計上**: 4/24-26 guest キャンセル(4/3予約)が100%徴収されていた。5/8入金 ¥38,704 = 46,800 − comm7,020(15%) − fee1,076(2.3%) と**1円一致**。4月 booking revenue に計上(cancellationFee=true)。**4月利益 ¥1,851→¥40,555(率18.8%)**。※もう1件の4月キャンセル(¥130,410、4/23-26)は comm=0=料金不徴収(無料キャンセル)で入金なし=正しくゼロ。
- **[是正2] Booking決済手数料を全月確定値でセット**(従来は6月の¥1,448のみ計上): 10月¥2,292 / 11月¥7,657 / 12月¥2,029 / 2月¥6,749 / 3月¥6,591 / 5月¥7,719(いずれも滞在ごとの round(gross×2.3%) 合計、CI月ベース)。netRevenue 再計算済。2026-02〜05 の報告書PDF再生成済(2月¥156,967 / 3月¥702,264 / 4月¥40,555 / 5月¥445,147)。
- **【解決済 2026-07-14】謎だった 2026-01-06 入金 ¥74,045 の正体判明**: やますけが extranet からDLした財務明細CSV(sln0Hj3zIHcpRhXG、1/1支払)により、**予約番号5549202547(12/27-28泊・宿泊者名空欄・gross¥86,400)が booking_all.csv(予約一覧エクスポート)から完全に欠落していた**ことが確定。86,400−comm10,368−fee1,987=74,045 で1円一致。→ **2025-12 に計上済**(booking gross 88,200→174,600 / net 149,632 / **12月利益 ¥348,593(85%)**)。Drive の 2025-12 CSV にも欠落行を追記(再取込で正値を再現可能)。**旧記載「12月Booking gross=88,200」は欠落があったため誤り、正=174,600**。
- **教訓**: Booking の「予約一覧エクスポート」は完全ではない(1件欠落実例)。**売上の ground truth は財務明細(payout statement)×銀行入金**。財務明細のキャンセル料徴収は「予約/ok」行として表示される(4月 Stefan Lang ¥46,800 で確認)。
- **注意(再取込時)**: 予約CSVには決済手数料が無いため、過去月を「OTA CSV取込」で再実行すると paymentFee/netRevenue が手数料抜きに戻る。過去月の再取込後は paymentFee の再セットが必要(scratchpad/fix-booking-fees-and-april-cancel.cjs 参照)。
- 検証スクリプト: `scratchpad/mf-scan-rakuten3-booking.mjs`(楽天第三のMF口座hash=`64SwijL8nXXCHReKyZpAbA`、CSV service_id=1331) / `scratchpad/reconcile-booking-payouts.cjs`(CO月バッチ突合) / `scratchpad/fix-booking-fees-and-april-cancel.cjs`(反映)。
- **今後の運用**: Booking の月次入金(楽天第三、翌月3-8日頃)と CO月バッチ期待値の突合はこの検証セットで随時再実行可能。キャンセル料は CSV の cancelled 行で **comm>0 = 徴収あり**のシグナル。

## DONE(2026-07-13 クレカ電気を MF ME 経由で自動取得する経路を実装・E2E実証)
やますけ発案「セゾン明細はマネーフォワードMEから取れない？」→ **取れることを実証し実装完了**。SAISON PDF の Drive 投入(2602〜2607未投入で途絶していた)と「バッチと明細到着のすれ違い」問題を同時に解消する。
- **MF の口座別明細CSVエンドポイントを発見**: `https://moneyforward.com/cf/csv?account_id_hash={hash}&year=Y&month=M&from=Y%2FM%2F01&service_id=27`。セゾンアメックス(八朔)の hash=`et2JNC6KSatQ9pMz6fL8voH-z9t8NpFGQ2rOnN6Ntkg`。Shift_JIS。各行に**MF取引ID**(冪等キーに最適)。posted月単位で任意月を取得可能。MF個別ページには 2024/12〜の全月CSVリンクあり。
- **API拡張(functions/api/pnl.js デプロイ済)**: `import-credit-card-electric` に **payments 直接モード**追加(`{payments:[{date,description,amount,mfId}], targetYm}`)。Drive/Gemini をスキップし、サーバ側 `filterElectricPaymentsForProperty`(エネパル/アプラス/スマートビリング allowlist)で最終採否→creditCardIndex 冪等キー=`mf:{mfId}`→水道光熱費へ加算(overridden保護は従来どおり)。従来の SAISON PDF モードも共存。
- **PC側スクリプト(新規)**: `scripts/mf-electric-import.mjs`。デバッグChrome(CDP:9222・MFログイン済・browse.mjs と同方式の読み取りGETのみ)→CSV取得→電気系行を抽出→**使用月=posted月-1** で API へ POST。`--month YYYY-MM` `--dry` 対応。実行は `NODE_PATH=../minpaku-v2-yadozei/scripts/node_modules node scripts/mf-electric-import.mjs`。
- **E2E実証**: 2026-05 posted分 → MF CSV 82行取得、楽天でんき2件(宿小町分)を候補検出→**サーバ allowlist が正しく除外(採用0)**=他物件誤計上なし。2026-07 posted分 → 22行・電気候補0(エネパル6月分は確定日7/19頃に posted される見込み)。6月分は水道光熱費 overridden=true のため仮に流れても上書き保護でスキップ=二重計上なし。
- **タイミング設計**: エネパル N月分 → (N+1)月中旬にカードposted → **毎月25日頃に当月posted分を実行**すれば使用月N に計上が間に合う(帳票は必要時に再生成)。旧課題「8/6バッチはSAISON_2609を探して常に空振り」は MF 経路で無効化。
- **残り**: スケジュール登録のみ(NEXT#4)。宿小町の楽天でんきは領収書PDF経路(60フォルダ)継続で変更なし。

## DONE(2026-07-13 総ざらい監査: OTA CSV残骸一掃＋再汚染是正＋宿泊税全期間整備)
**総点検で発見した実害2件を是正**:
- **[実害1] the Terrace 2026-03 Booking売上の再汚染**: 7/13 の手動バッチが Drive の月ズレCSV残骸(`booking_reservations_2026-03…csv`=中身2025-11×13件)から **¥332,884(11月の値)** を3月に再取込していた。booking_all.csv ground truth で検証→ 正 **¥286,528**(6件/コミッション42,979/net 243,549)。API 再取込で是正、宿泊税も 9,800(汚染CSV由来)→**¥11,200** に再計算。3月確定: **売上918,192 / 清掃91,966 / 経費74,392 / 税11,200 / 利益708,855(77.2%)**。報告書PDF再生成済。
- **[実害2] 宿小町 2026-06 Airbnb売上の二重計上**: 6月CSVに **Jessie Lee ¥18,100(5/29チェックイン=5月分)** が混入し5月CSVと二重。6月売上 171,062→**¥152,962**。**精算書 94,084→¥84,129(税込)** に是正。6月確定: 売上152,962 / 清掃37,468(飯田6,710+タイミー手動30,758=7/12以降にユーザー追加、正常) / 経費83,001 / 利益32,493(21.2%)。報告書+精算書再生成済。
**再発防止(Drive の CSV 全部品質保証)**:
- 全OTA CSV 17件の「ラベル月 vs 実チェックイン月」を機械検査(`scratchpad/audit-otacsv-inventory.cjs`)。**月ズレ残骸5件**(03←11月/01←10月/10←6月/09←5月/11=空)を trash し、**booking_all.csv から正しい月別CSVを全10ヶ月分生成・アップ**(2025-09〜2026-06、04は既存空が正)。宿小町6月CSVも Jessie 行を除去した修正版に差替。→ 今後どの月で「OTA CSV取込」やバッチを再実行しても正しい値が入る。
- 54電気の「41348円」リネーム重複PDFも trash(3月に再計上されかけたのを防止)。
**宿泊税の全期間整備**: the Terrace 2025-09〜2026-02 を修正済CSVから一括計算(`import-tax` フォールバック): 09=¥800 / 10=¥2,000 / 11=¥3,200 / 12=¥5,200 / 01=¥0 / 02=¥1,400。既存: 03=11,200 / 04=2,800 / 05=10,000(申告書) / 06=600(手計算)。※これらは pnl 帳簿値。**過去分のやどぜい実申告は 2026-05 のみ**(他月の申告状況はやますけ要確認)。
**整合性スイープ(全月×全物件)**: utilitiesIndex合計vs経費・fileId重複・清掃重複・Booking ground truth 照合 → **実データは全月クリーン**(検出された「不一致」5件は検査側の誤検知=utilitiesIndexには固定電話/通信費も含まれるのが正、「月跨ぎ重複」は4-6月分水道の月割仕様)。
**★新発見の運用ギャップ(要対応)**:
1. **セゾン明細PDFが 2601 で途絶**: Drive セゾンフォルダには SAISON_2510〜2601 のみ。**2602〜2607 が未投入**。the Terrace 5月電気は SAISON_2607.pdf 投入で自動計上可能(`import-credit-card-electric 2026-05 targetYm=2026-07`)。→ やますけ: セゾンWebから 2602〜最新の明細PDFをDL→セゾンフォルダへ投入。
2. **クレカ電気の月次バッチ設計ギャップ**: バッチは毎月6日に「前月」を処理するが、電気明細は「使用月+2ヶ月」の明細に載る(6月分→8月明細)。**8/6のバッチ(7月分処理)は SAISON_2609(9月到着)を探すため常に空振り**し、過去月を再訪しないため、クレカ電気は自動計上されない構造。→ 恒久修正案: pnlMonthlyImport で yearMonth-2 の月にも importCreditCardElectric を再実行する(次NEXT)。

## DONE(2026-07-13 統合整理・NEXT大幅消化)
- **NEXT#5 は既に実装済み確認**: `functions/scheduled/pnlMonthlyImport.js` line 74-78 で importCreditCardElectric が importUtilities 直後に呼ばれ、driveSaisonFolderId 未設定物件は `skipped` 正常扱いで通す。8月バッチから自動稼働(the Terrace 8月分クレカ明細=SAISON_2608.pdf 到着時)。plan.md 未実装表記が古かった。
- **NEXT#6 リカバリ(3月/4月月次バッチ実行)完了**: `POST /pnl/run-monthly-import`。宿小町は「開業前スキップ」(2026-05開業)で正しく除外、the Terrace は fullloop 完了。runId=`2026-03_1783889030` / `2026-04_1783889059`。
  - **3月バッチ**: 売上¥964,548(Airbnb¥631,664+Booking¥332,884、Booking rebuild反映)、宿泊税¥9,800(computed_from_reservations=予約CSVフォールバック計算)、水道光熱費¥95,225→**¥53,877**(下記重複除外後)、清掃¥91,966。**利益¥758,242(率78.6%)**。
  - **4月バッチ**: 売上¥169,229、宿泊税¥2,800、水道光熱費¥83,997(電気¥31,621+ガス¥10,570+水道¥3,705+水道¥38,101)、清掃¥34,700。**利益¥1,851(率1.1%)** (plan.md記載と一致)。
  - 3月/4月とも報告書PDFの下書きを Storage に自動生成済(self運営なので settlement は無し)。
- **副産物#1(3月電気重複除外)**: 7/10 に Drive `54電気` に **「260413 請求書(広長浜_電気代_3月分)エネパル.pdf」** (fileId=1yEwA4jDu_O6k_L7E1Zwfp68jJCNX8nUn、既存スマートビリング¥41,348 のリネーム重複) が追加されていて、バッチが二重計上した。utilitiesIndex から除外+Drive trash 送付。3月利益 ¥708,855→**¥758,242**(売上増分＋二重除外反映)。
- **副産物#2(宿小町ニシモトヤガス重複除外)**: `260318_小町民泊_請求書(ガス料金)_2080_ﾆｼﾓﾄﾔ_水道光熱費.pdf` (ScanSorter機械生成版) を Drive trash 送付。手書き整形名「260318 請求書(エクセリア小町_ガス料金)ニシモトヤ.pdf」を保持。宿小町は開業前=pnl影響なし(先手清掃)。
- **NEXT#8 空白期間電気の実態確定**: Gmail 全期間検索(81hassac@/yamasuke81@) と Drive 54電気 スキャンで以下を確定:
  - **the Terrace 楽天でんきお客様番号=8081365592**(供給先=呉市広長浜5-14-6、合同会社八朔・西山恭介)
  - 契約履歴: **2025-11-28 楽天でんき申込受付→2025-12-20 供給停止(3週間で解約)→2026-02-01 エネパル/スマートビリング登録→2026-03-12 スマートビリング初回請求¥33,978(使用月=2026-02、既に realign 済)**
  - 25-11/25-12/26-01 の電気請求書は Drive/Gmail いずれにも存在しない(楽天でんき申込→即解約の混乱期＋中国電力の月次通知はハガキ配送=スキャン未取込)。実請求は数千円と推定(中国電力の 25-09/10 実績=¥1,954/月 基本料金相当)されるが書類なしのため未計上。**pnl 実害は最大でも数千円×3ヶ月=1万円未満**。もし後日ハガキが発掘されれば追加できる。
- **NEXT#4 固定費台帳は追加実装せず、classifyExpenseByName_ の自動計上経路に統合**: the Terrace は self運営で家賃なし。過去実績調査で 6月に手入力¥2,200(ゴミ)/¥1,200(Wi-Fi) のみ、他月は 0。過去月に固定費が計上されていない真因は「Drive にレシート未投入」であって固定費台帳の欠如ではない。classifyExpenseByName_ が「合計請求書(ごみ処理_N月分)巣だち.pdf」/「請求書(通信費_N月分)NTTファイナンス.pdf」を正しくreceiptsに振り分けるようになったので、**7月以降のバッチで Drive投入されれば自動計上される**。properties.pnlSettings.monthlyFixedCosts 新設は現状不要=YAGNI で保留。過去バックフィルは金額指示さえあれば scratchpad で個別に上書きで対応可能。

## DONE(2026-07-12 NEXT#6/#10/#11 恒久化＋データ是正)
- **NEXT#11: parseBillMonths を pnl-logic.js の pure 関数へ移動＋エネパル補正(commit未、要ship)**: `functions/api/pnl-logic.js` の module.exports に `parseBillMonths(name)` を追加。判定順=①「A-B月分」範囲 → ②「N月分」単発(記載月>ファイル月なら前年) → ③明記なし+ファイル名に「エネパル」or「スマートビリング」→発行月の前月 → ④明記なし+その他=ファイル名月そのまま。pnl.js 内の `parseBillMonths_` は pure 版への薄いエイリアスへ集約(委譲)。テスト10件追加(pnl-logic.test.js、全168緑)。**firebase deploy --only functions:api 反映済**。今後の電気代ズレは自動で正しい月に載る。
- **NEXT#10: 2026-02 伊丹産業ガス2月分3重計上を除外**: `scratchpad/dedupe-gas-2026-02.cjs`。utilitiesIndex から fileId `1jMYvrCOGWFTXodd7jDU7L_GlKr2IWUNK` / `1ztJRCYk4HAcgC7-aY4tg-4-leIC7UtIg` の2件を除外(1OwIWHOGgZtCFvcUNqKsNVKV-og9TpdCV を保持)、Drive 上の重複2件も trash 送付(復元可)。**2026-02 水道光熱費 ¥44,288→¥41,334 / 利益 ¥160,762→¥163,716(率55.8%)**。帳票PDF再生成済。
- **NEXT#6(既存実装確認のみ、実装済み確認)**: pnlMonthlyImport 内で `revenueMissing`(computed.revenueGross===0 判定) を検知→通知タイトル「(要確認)」バナー「🚨【要確認】N物件で売上未取得/エラー」＋物件行「🚨売上未取得(下書き未生成・要人手対応)」まで完備(line 89-93, 139-153)。plan.md 側で未実装扱いだったが実際は既に恒久化済み。

## DONE(2026-07-12 電気代 全期間 audit → realign 完了)
- **audit(scratchpad/audit-all-electric.cjs)**: 2025-09〜2026-06 の全物件 utilitiesIndex から電気代を抽出→ Gemini で発行日/検針期間/使用月を判定。**ズレは1件のみ**と確定:
  - ❌ the Terrace `2026-03` に載っていた **¥33,978**(発行 2026-03-12、事業者=エネパル/スマートビリング、供給地点=広長浜) → **使用月=2026-02(発行月の前月)** が正しい。他のエネパル分と同じ規則。
  - その他は全て一致:
    - ✅ 中国電力 25-09/10 各¥1,954(令和7年9月分/10月分明記、うち0kWh・最低月額のみ)
    - ✅ スマートビリング 26-04-13発行¥41,348 (03月分明記)、26-05-14発行¥31,621(4月分明記=エネパル)
    - ✅ YADO KOMACHI 楽天でんき 26-04/05/06(各月「N月分」明記、使用月と一致)
- **realign(scratchpad/realign-electric-33978.cjs)**: ¥33,978 を 2026-03→2026-02 へ移動、両月の水道光熱費 expenses を再計算(overridden=false のため utilitiesIndex 合計で書き直し)。結果:
  - **the Terrace 2026-03**: 水道光熱費 ¥87,855 → **¥53,877** / 経費計 ¥74,392 / 利益 **¥708,855**(率 77.2%)
  - **the Terrace 2026-02**: 水道光熱費 ¥10,310 → **¥44,288** / 経費計 ¥48,033 / 利益 **¥160,762**(率 54.8%)
- **Drive調査(scratchpad/scan-terrace-electric-blanks.cjs + verify-electric-context.cjs)**: `007_光熱・インフラ/54電気` を再帰スキャン。**the Terrace の 2025-11 / 2025-12 / 2026-01 の電気請求書は Drive に存在しない**。
  - 中国電力からの請求は 25-09(¥1,954)・25-10(¥1,954)で途切れ、25-11以降Drive無し。おそらく中国電力→エネパル切替空白期間 or 実請求書が Gmail 側にしか残っていない。
  - 26-02-01 の「エネパル登録完了通知」は**「店舗補助金サポートパック(保険/補助金支援)」の登録**であり、電気供給契約の切替日ではない(誤解注意)。電気供給契約自体は 26-03-12 スマートビリング請求書の存在から 25-11〜26-02 の間には切替済み。
  - 25-11/12/26-01 の電気請求書は今後 Gmail 過去メール発掘で拾えるかも(次NEXT#9)。
- **副産物(未修正・記録のみ)**: 2026-02 utilitiesIndex に **伊丹産業ガス2月分 ¥1,477 が3重計上**(fileId 3つ: `1jMYvrCOGWFTXodd7jDU7L_GlKr2IWUNK` / `1OwIWHOGgZtCFvcUNqKsNVKV-og9TpdCV` / `1ztJRCYk4HAcgC7-aY4tg-4-leIC7UtIg`)。Drive `52 プロパンガス` に同名別コピーが3件存在。¥2,954 過剰計上の疑い→次NEXT#10。

## ★次セッション再開点(2026-07-12)
**直前まで完了したこと(全て本番反映済)**:
1. **過去月清掃費計上完了**: 2025-10〜2026-03 の GAS版清掃請求書PDF を Firestore に計上済(6ヶ月合計 **¥289,988**、source="drive_pdf"、fileId冪等)。
2. **4月清掃費 ¥34,700 計上済**、4月電気代二重計上¥41,348を除外済、4月利益 ¥1,851黒字化
3. **NEXT#0/#1/#3/#4/#5 は 2026-07-11 に既に本番反映済**(pnl-logic.js の filterElectricPaymentsForProperty/classifyExpenseByName_、pnl.js の import-receipts/utilities で scope 使用、承認導線、宿泊税自動計算)
4. **電気代 audit + realign 完了**(上記 DONE 参照)。全期間で唯一のズレ ¥33,978 を 2026-03→2026-02 に反映。

**★次にやること(優先度順)**:
- ★上記「NEXT」の 1-8 を優先度順に処理する。特に **8/6 05:00 JST の初回本番バッチ稼働**(NEXT#1)と **8/1 までの Booking セッション再ログイン**(NEXT#2)が時限性あり。
- 電気代 audit/realign の**恒久策**として、`import-utilities` のファイル名月判定を「1) ファイル名『N月分』明記あればそれ / 2) 無ければ発行日(先頭YYMMDD)→前月」の順で判定するようロジック改修する(次NEXT#11)。今回のズレは¥33,978の1件のみだったが、将来の請求書追加時に再発を防ぐ。

**次セッションへの依頼文(コピペ用)**:
> pnl-automation-plan.md の「★次セッション再開点」から。NEXT の優先度順で処理して。まずは 8/6 バッチ稼働の見届け準備(#1)＋Booking セッション再ログイン(#2)。

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
1. **8/6 05:00 JST の月次自動バッチ(初回本番稼働)を見届ける(★時限性)**: pnlMonthlyImport が発火→7月分をfullloop→承認通知→やますけが承認画面で確認→approve→送付。エネパル(the Terrace 8月クレカ明細=SAISON_2608.pdf)の自動計上も同時。
2. **Booking.com セッション再ログイン(★やますけPC作業、8/1深夜まで)**: 現在 Booking.com=`logged_out`(2026-07-12 実測、Airbnb/やどぜいは ok)。listener 自体は Hassac01 で lastSeenAt 生存中(PM2稼働中)。
   - **手順**: `pm2 stop yadozei-listener` → `cd C:\Users\yamas\AI_Workspace\minpaku-v2-yadozei && node scripts/yadozei-listener.mjs --login`(Playwrightブラウザが起動→Booking.com にログイン→cookie 保存されるまで放置) → Ctrl+C → `pm2 start yadozei-listener`
   - 完了確認: Firestore `settings/yadozeiListener.sessionCheck.sessions."Booking.com" === "ok"` になれば OK
   - ~~再ログイン後にやること: ¥74,045 の内訳確認~~ → **解決済(2026-07-14)**。やますけが財務明細CSVをDLし、booking_all.csv 欠落の予約5549202547(12/27-28、gross86,400)と確定。2025-12 計上済。
3. **7月分の Drive 投入(8/2〜8/5 人手)**: Terrace/宿小町 の光熱PDF(007配下)/レシート(60配下)/清掃請求書 を投入。ScanSorter経由で自動振り分けさせる。**ゴミ処理費・Wi-Fi通信費の月次自動計上もこれに乗せる**(過去月バックフィルはやますけが金額指示すれば scratchpad で個別上書き可能)。
4. **【2026-07-14 完了】クレカ電気の MF 自動取得ルーチン稼働開始**: routines.json に `mf-electric-import`(毎日07:35・**command型=Claude不使用でトークン消費ゼロ**)を登録し常駐bun再起動済み。計上発生時とエラー時のみ #経理 に通知(無音=正常)。AUTOMATION.md 台帳+ダッシュボード更新済。
   - **command型は今回 discord-secretary-resident.mjs に新設した仕組み**(routine.command=[exe,...args] を直接spawn、stdout の「NOTIFY: 」行だけ通知、非0終了はエラー通知、routine.env で NODE_PATH 等を注入)。今後の機械処理ルーチンにも使える。
   - **5月電気の謎も解決**: 「5月電気欠落」の正体は「5月分¥36,459がカード決済6/9で、やますけが6月分として6月に手入力していた誤帰属」だった。MF全月×PDF系列(2月分→3/12決済、3月分→4/13、4月分→5/14、カード上のエネパル決済は6/9の1件のみ=初回カード決済)の突合で5月分と確定。6月手入力¥44,818→¥8,359(ガス5,919+水道月割2,440、overridden解除=6月分電気の自動加算を許可)、5月へ MF ルート実計上¥36,459。**5月利益 ¥452,866(率67.5%) / 6月利益 ¥341,466(率81%、6月分電気が7月中旬にカードpostedされ次第ルーチンが自動加算予定)**。両月の報告書PDF再生成済。
6. **税抜換算対応(遅延優先度低)**: Airbnb「収入」列基準で /人/泊 を計算する現行仕様は、閾値10,000円をまたぐ稀ケースで誤差の可能性。運用で問題が出るまで保留。
7. **the Terrace 25-11/12/26-01 空白期間の電気は「書類なし」で確定**(NEXT#8 消化済)。中国電力ハガキ or 楽天でんき短期契約分の請求書が発掘された場合は個別追記可能。実害は最大数千円×3ヶ月レベル。
8. **過去月のやどぜい実申告状況の確認(★やますけ)**: 自動申告済みは 2026-05 のみ。2025-09〜2026-04/2026-06 の宿泊税を手動申告済みか要確認(pnl帳簿値は全月計算済み: 09=800/10=2,000/11=3,200/12=5,200/01=0/02=1,400/03=11,200/04=2,800/06=600)。

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
