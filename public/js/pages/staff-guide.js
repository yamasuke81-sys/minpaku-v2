/**
 * スタッフ用 使い方ガイド
 * ログイン方法 / 画面の見方 / 請求書の作成・送信 を1ページに集約した静的ヘルプ
 */
const StaffGuidePage = {
  async render(container) {
    container.innerHTML = `
      <div class="container-fluid px-3 py-3" style="max-width:820px;margin:0 auto;">
        <h4 class="mb-3"><i class="bi bi-info-circle"></i> 民泊管理v2 スタッフ用ガイド</h4>
        <p class="text-muted small">
          このページは清掃スタッフの皆さま向けの使い方マニュアルです。
          困ったときはいつでもこのページを開いてご確認ください。
        </p>

        <!-- 目次 -->
        <div class="card mb-4">
          <div class="card-body py-2">
            <strong class="small text-muted">目次</strong>
            <ol class="mb-0 small">
              <li><a href="#sg-login">ログイン方法</a></li>
              <li>
                <a href="#sg-view">画面の見方</a>
                <ul class="mb-0">
                  <li><a href="#sg-calendar">カレンダーで募集を確認する</a></li>
                  <li><a href="#sg-checklist-cleaning">清掃チェックリストの表示</a></li>
                  <li><a href="#sg-checklist-inspection">直前チェックのチェックリスト</a></li>
                </ul>
              </li>
              <li><a href="#sg-response">募集への回答方法</a></li>
              <li>
                <a href="#sg-invoice">請求書の作成・送信方法</a>
                <ul class="mb-0">
                  <li><a href="#sg-invoice-exclude">自動追加項目を除外したい場合</a></li>
                  <li><a href="#sg-invoice-manual">手動で明細を追記する方法</a></li>
                </ul>
              </li>
              <li><a href="#sg-timee">タイミーの方と一緒に作業する場合</a></li>
            </ol>
          </div>
        </div>

        <!-- ===== 1. ログイン方法 ===== -->
        <section id="sg-login" class="mb-5">
          <h5 class="bg-primary text-white px-3 py-2 rounded-3 shadow-sm mb-3" style="font-weight:700;">
            1. ログイン方法
          </h5>
          <p>
            初回は <strong>Webアプリ管理者から送られてくる個別の招待URL</strong> から LINE認証を行ってください。
            2回目以降は通常のログイン画面から LINE ボタン1つでログインできます。
          </p>

          <!-- 初回 -->
          <div class="card mb-3 border-success">
            <div class="card-header bg-success text-white">
              <i class="bi bi-1-circle"></i> 初回（招待URLからの登録）
            </div>
            <div class="card-body">
              <ol class="mb-2">
                <li>Webアプリ管理者から LINE またはメールで届いた
                  <strong>個別の招待URL</strong> をタップ
                  <div class="small text-muted">（例：https://minpaku-v2.web.app/invite.html?token=xxxxx）</div>
                </li>
                <li>「<span class="text-success">○○さん</span>」とご自身の名前が表示されることを確認</li>
                <li>緑色の <strong>「LINEで参加する」</strong> ボタンをタップ</li>
                <li>LINEの認証画面で「許可する」をタップ</li>
                <li>「登録完了！」が出たら自動でスタッフ画面に移動します</li>
              </ol>
              <div class="alert alert-warning small mb-2">
                <i class="bi bi-exclamation-triangle"></i>
                <strong>招待URLの有効期限は発行から7日間</strong> です。期限が切れた場合は管理者に再発行を依頼してください。
              </div>
              <div class="alert alert-info small mb-0">
                <i class="bi bi-info-circle"></i>
                招待URLは <strong>1人1本・1回のみ有効</strong> です。他の人と共有しないでください。
              </div>
            </div>
          </div>

          <!-- 2回目以降 -->
          <div class="card mb-3 border-primary">
            <div class="card-header bg-primary text-white">
              <i class="bi bi-2-circle"></i> 2回目以降（通常ログイン）
            </div>
            <div class="card-body">
              <ol class="mb-2">
                <li>
                  <a href="https://minpaku-v2.web.app/" target="_blank" rel="noopener">https://minpaku-v2.web.app/</a>
                  を開く（ブックマーク／ホーム画面追加推奨）
                </li>
                <li>ログイン状態が保持されていれば、そのままスタッフ画面が開きます。
                  ログイン画面が表示された場合のみ、緑色の
                  <strong>「LINEでログイン（スタッフ用）」</strong> ボタンを1回タップしてください。</li>
              </ol>
              <div class="alert alert-info small mb-0">
                <i class="bi bi-info-circle"></i>
                スマホのホーム画面に追加しておくと、アプリのように1タップで開けます。
              </div>
            </div>
          </div>

          <div class="alert alert-light border small">
            <strong>ログアウト方法：</strong>
            左メニュー（スマホは左上の三本線アイコンから開く）の一番下にあるご自身のお名前をタップするとログアウトできます。
          </div>
          <div class="alert alert-light border small">
            <strong>うまくいかないとき：</strong>
            「招待リンクが無効です」と出る／LINE認証後にエラー／別アカウントで紐付いてしまった、などの場合は
            Webアプリ管理者（やますけ）までご連絡ください。再発行・再紐付けを行います。
          </div>
        </section>

        <!-- ===== 2. 画面の見方 ===== -->
        <section id="sg-view" class="mb-5">
          <h5 class="bg-primary text-white px-3 py-2 rounded-3 shadow-sm mb-3" style="font-weight:700;">
            2. 画面の見方
          </h5>
          <div class="alert alert-primary small">
            <i class="bi bi-list fs-5"></i>
            <strong>スマホで左メニューを開くには：</strong>
            画面左上の <strong>「<i class="bi bi-list"></i>（三本線）」</strong>
            アイコンをタップしてください。サイドメニューが横からスライドして開きます。
            メニュー外をタップするか、もう一度三本線アイコンをタップすると閉じます。
            <div class="mt-1 text-muted">PC・タブレットでは常に左側に表示されているため、この操作は不要です。</div>
          </div>
          <p>
            ログインすると、左メニューに次の項目が表示されます。
          </p>
          <ul>
            <li><i class="bi bi-calendar-check"></i> <strong>清掃スケジュール</strong> — 募集の確認・回答</li>
            <li><i class="bi bi-clipboard-check"></i> <strong>チェックリスト</strong> — 清掃当日のチェック入力</li>
            <li><i class="bi bi-receipt"></i> <strong>請求書</strong> — 月末の請求書作成・送信</li>
            <li><i class="bi bi-info-circle"></i> <strong>使い方ガイド</strong> — このページ</li>
          </ul>

          <!-- (a) カレンダー -->
          <h6 id="sg-calendar" class="mt-4 fw-bold border-start border-4 border-primary ps-2 py-1 bg-light">
            (a) カレンダーでの清掃募集と直前チェック募集の確認方法
          </h6>
          <ol>
            <li>左メニューから <strong>「清掃スケジュール」</strong> をタップ</li>
            <li>横スクロール式のカレンダーが表示されます（日付が横、スタッフ名が縦）</li>
            <li>各日付セルに表示される <strong>「清」「直」</strong> のピル（小さい丸バッジ）が募集です。
              色で状態を判別します：
              <div class="mt-2 ps-2">
                <div class="fw-bold small text-muted">清＝清掃募集（チェックアウト日に発生）</div>
                <ul class="mt-1 mb-2">
                  <li>
                    <span style="background:#fd7e14;color:#fff;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;">清</span>
                    <strong>オレンジ</strong> ＝ 募集中（要回答）
                  </li>
                  <li>
                    <span style="background:#ffc107;color:#333;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;">清</span>
                    <strong>黄色</strong> ＝ 選定済（管理者が候補を選定中）
                  </li>
                  <li>
                    <span style="background:#198754;color:#fff;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;">清</span>
                    <strong>緑</strong> ＝ 確定済（あなたが担当に確定）
                  </li>
                </ul>
                <div class="fw-bold small text-muted">直＝直前点検募集（チェックイン日に発生）</div>
                <ul class="mt-1 mb-2">
                  <li>
                    <span style="background:#a78bfa;color:#1e0a3c;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;">直</span>
                    <strong>薄紫</strong> ＝ 募集中
                  </li>
                  <li>
                    <span style="background:#c4b5fd;color:#1e0a3c;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;">直</span>
                    <strong>中紫</strong> ＝ 選定済
                  </li>
                  <li>
                    <span style="background:#7c3aed;color:#fff;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;">直</span>
                    <strong>濃紫</strong> ＝ 確定済
                  </li>
                </ul>
                <div class="fw-bold small text-muted">予約バー（参考）</div>
                <ul class="mt-1 mb-0">
                  <li>
                    <span style="background:#a7c7ff;display:inline-block;width:14px;height:14px;border-radius:2px;vertical-align:middle;"></span>
                    水色＝確定済みの宿泊予約
                  </li>
                </ul>
              </div>
            </li>
            <li>あなたの行に表示される回答マーク：
              <ul class="mt-2">
                <li>◎ ＝ OK と回答済</li>
                <li>△ ＝ 条件付きで回答済</li>
                <li>× ＝ NG と回答済</li>
                <li>マークなし＝未回答</li>
              </ul>
            </li>
            <li>バーまたはセルをタップすると <strong>募集詳細モーダル</strong> が開きます（回答方法は次の項目で説明）</li>
          </ol>
          <div class="alert alert-info small">
            <i class="bi bi-info-circle"></i>
            <strong>確定済みセル</strong>（あなたが選定されたもの）をタップすると、宿泊者情報や時間など詳細を確認できます。
          </div>

          <!-- (b) 清掃チェックリスト -->
          <h6 id="sg-checklist-cleaning" class="mt-4 fw-bold border-start border-4 border-primary ps-2 py-1 bg-light">
            (b) 清掃チェックリストの表示方法
          </h6>
          <p class="mb-2">開き方は3通りあります。どれでもOKです。</p>
          <ol>
            <li>
              <strong>左メニューから開く</strong> — 左メニュー（スマホは左上の三本線アイコンから開く）の
              <strong>「チェックリスト」</strong> をタップ
            </li>
            <li>
              <strong>清掃スケジュール画面の右上ボタンから開く</strong> —
              清掃スケジュール画面のタイトル右側にある黄色い
              <span class="badge bg-warning text-dark border"><i class="bi bi-clipboard-check"></i></span>
              ボタンをタップすると、直近の清掃チェックリストが開きます
            </li>
            <li>
              <strong>募集詳細モーダルの上部から開く</strong> —
              清掃スケジュール画面で確定済みのバー／セルをタップして開いた募集詳細モーダル内の上部にも、
              チェックリストを開くボタンがあります
            </li>
          </ol>
          <p class="mt-3 mb-2">開いた後の操作：</p>
          <ol>
            <li>本日／直近の清掃シフトに対応するチェックリストが自動で表示されます</li>
            <li>物件が複数ある場合は上部のタブで切り替え</li>
            <li>項目をタップしてチェックを入れる／必要に応じて写真を撮影してアップロード</li>
            <li>全項目チェック完了後、ページ下部の <strong>「完了」</strong> ボタンで送信</li>
          </ol>

          <!-- (c) 直前チェックのチェックリスト -->
          <h6 id="sg-checklist-inspection" class="mt-4 fw-bold border-start border-4 border-primary ps-2 py-1 bg-light">
            (c) 直前チェックのチェックリストの表示方法
          </h6>
          <div class="alert alert-secondary">
            <i class="bi bi-tools"></i>
            <strong>準備中</strong>
            — この機能は現在準備中です。公開され次第、このページに手順を追記します。
          </div>
        </section>

        <!-- ===== 3. 募集への回答方法 ===== -->
        <section id="sg-response" class="mb-5">
          <h5 class="bg-primary text-white px-3 py-2 rounded-3 shadow-sm mb-3" style="font-weight:700;">
            3. 募集への回答方法
          </h5>
          <p>
            清掃募集・直前チェック募集が出たら、できるだけ早く回答してください。
            未回答が続くと自動的に「非アクティブ」扱いとなり、以降の募集に表示されなくなります。
          </p>

          <h6 class="fw-bold mt-3 border-start border-4 border-secondary ps-2 py-1 bg-light">基本の回答手順</h6>
          <ol>
            <li>左メニューから <strong>「清掃スケジュール」</strong> をタップ</li>
            <li>自分の行の対象日のバー（または空セル）をタップ → <strong>募集詳細モーダル</strong> が開く</li>
            <li>モーダル上部に表示される <strong>日付・物件名・宿泊人数・チェックアウト時刻</strong> を確認</li>
            <li>下部の3つのボタンから自分の状態に合うものをタップ：
              <ul class="mt-2">
                <li>
                  <span class="badge bg-success">◎ OK</span>
                  — 対応可能。タップ後すぐに回答が送信されます
                </li>
                <li>
                  <span class="badge bg-warning text-dark">△ 条件付</span>
                  — 時間帯など条件あり。タップすると <strong>理由入力欄</strong> が表示されます（後述）
                </li>
                <li>
                  <span class="badge bg-danger">× NG</span>
                  — 対応不可。タップ後すぐに回答が送信されます
                </li>
              </ul>
            </li>
            <li>送信後、カレンダーのセルに対応マーク（◎ / △ / ×）が表示されます</li>
          </ol>

          <h6 class="fw-bold mt-3 border-start border-4 border-secondary ps-2 py-1 bg-light">△（条件付）で回答する場合</h6>
          <ol>
            <li><span class="badge bg-warning text-dark">△ 条件付</span> ボタンをタップすると <strong>理由入力欄</strong> が下に展開されます</li>
            <li>プリセットボタン（<span class="badge bg-light text-dark border">午後◎</span>
              <span class="badge bg-light text-dark border">午前◎</span> など）をタップすると素早く入力できます</li>
            <li>必要に応じて理由欄に手入力で追記（例：「14時以降なら可能」「他物件と掛け持ち不可」など）</li>
            <li>右下の <span class="badge bg-primary">△で回答する</span> ボタンをタップして送信</li>
          </ol>
          <div class="alert alert-warning small">
            <i class="bi bi-exclamation-triangle"></i>
            △の理由は <strong>必須</strong> です。未入力のまま送信しようとすると弾かれます。
            管理者が選定する際の判断材料になりますので、できるだけ具体的に書いてください。
          </div>

          <h6 class="fw-bold mt-3 border-start border-4 border-secondary ps-2 py-1 bg-light">回答を取り消す・変更する</h6>
          <ul>
            <li>回答済のセルを再度タップして募集詳細モーダルを開き、別のボタンをタップすれば <strong>上書き</strong> されます</li>
            <li>モーダル内に <strong>「回答を取消」</strong> ボタンがある場合、それをタップすると未回答状態に戻せます</li>
            <li>確定済（管理者がスタッフを決定した後）は回答変更ができません。変更したい場合は管理者にご連絡ください</li>
          </ul>

          <div class="alert alert-info small">
            <i class="bi bi-bell"></i>
            新しい募集が出ると、設定によりグループLINE／個別LINE／メールで通知が届きます。
            通知メッセージのリンクから直接アプリを開いて回答できます。
          </div>
          <div class="alert alert-danger small">
            <i class="bi bi-x-octagon"></i>
            <strong>非アクティブ化について：</strong>
            直近15回の募集で一度も回答がないと自動的に非アクティブとなり、以降の募集対象から外れます。
            解除する場合はWebアプリ管理者（やますけ）までご連絡ください。
          </div>
        </section>

        <!-- ===== 4. 請求書 ===== -->
        <section id="sg-invoice" class="mb-5">
          <h5 class="bg-primary text-white px-3 py-2 rounded-3 shadow-sm mb-3" style="font-weight:700;">
            4. 請求書の作成・送信方法
          </h5>
          <p>
            月末（または締め日）に、その月に対応した清掃分の請求書をスタッフ側で作成し、Webアプリ管理者へ送信します。
          </p>
          <h6 class="fw-bold mt-3 border-start border-4 border-secondary ps-2 py-1 bg-light">基本の作成・送信手順</h6>
          <ol>
            <li>左メニュー（スマホは左上の三本線アイコンから開く）の
              <strong>「請求書」</strong> をタップ</li>
            <li>画面上部の <strong>対象年月</strong> プルダウンで請求対象の月を選択（通常は前月）</li>
            <li>その月に確定済みのシフトとランドリー記録などが
              <strong>自動集計</strong> され、明細欄に一覧表示されます</li>
            <li>表示内容を確認：日付・物件・金額が正しいか</li>
            <li>必要に応じて
              <a href="#sg-invoice-exclude">自動追加項目の除外</a> や
              <a href="#sg-invoice-manual">手動で追記</a> を行ってください</li>
            <li>初回のみ、振込先の銀行情報（銀行名・支店名・口座種別・口座番号・名義）を入力します。
              <strong>「スタッフ情報」</strong> の折りたたみを開いて入力し、<strong>保存</strong>
              （2回目以降は自動で読み込まれます）</li>
            <li>合計金額を確認したうえで、画面下部の
              <span class="badge bg-primary"><i class="bi bi-send"></i> Webアプリ管理者へ送信</span>
              ボタンをタップ</li>
            <li>確認ダイアログで <strong>「OK」</strong> をタップすると送信完了</li>
          </ol>
          <div class="alert alert-success small">
            <i class="bi bi-check-circle"></i>
            送信が完了すると「送信済み」バッジが表示されます。管理者側で内容を確認のうえ振込処理を行います。
          </div>

          <h6 id="sg-invoice-exclude" class="fw-bold mt-4 border-start border-4 border-secondary ps-2 py-1 bg-light">自動追加項目を除外したい場合</h6>
          <p>
            自動集計で表示された明細のうち、請求対象から外したいもの
            （例：すでに別途精算済み・対応していなかった項目など）は除外できます。
          </p>
          <ol>
            <li>明細テーブルの右側にある
              <span class="badge bg-light text-danger border"><i class="bi bi-dash-circle"></i> 除外</span>
              ボタンをタップ</li>
            <li>確認ダイアログで <strong>「OK」</strong> をタップ（情報自体は削除されません）</li>
            <li>除外した項目は明細から外れ、合計金額が自動で再計算されます</li>
            <li>除外した項目は明細下の
              <strong>「除外済み ◯件 ▸」</strong>
              を開くと一覧で確認できます。
              <span class="badge bg-light text-secondary border"><i class="bi bi-arrow-counterclockwise"></i> 除外解除</span>
              ボタンで元に戻すことも可能です</li>
          </ol>

          <h6 id="sg-invoice-manual" class="fw-bold mt-4 border-start border-4 border-secondary ps-2 py-1 bg-light">手動で明細を追記する方法</h6>
          <p>
            自動集計に含まれない項目（交通費、特別加算、自動で拾えなかった作業分など）は
            <strong>「追加明細」</strong> セクションから手動で追加できます。自動集計から漏れている分があれば、
            管理者に連絡せずこちらに自分で追記してください。
          </p>
          <ol>
            <li>明細テーブルの下にある <strong>「追加明細」</strong> セクションを表示</li>
            <li>
              <span class="badge bg-light text-secondary border"><i class="bi bi-plus"></i> 行を追加</span>
              ボタンをタップして新しい行を追加</li>
            <li>各列を入力：
              <ul class="mt-2">
                <li><strong>日付</strong> — 作業日や該当日（カレンダーから選択）</li>
                <li><strong>項目</strong> — 内容（例：「交通費（広島→長浜）」「特別加算（深夜対応）」など）</li>
                <li><strong>金額(円)</strong> — 円単位で入力</li>
                <li><strong>メモ</strong> — 必要に応じて補足</li>
              </ul>
            </li>
            <li>追加した行は合計金額に自動反映されます</li>
            <li>行を削除したい場合は、各行右側のごみ箱アイコンをタップ</li>
          </ol>
          <div class="alert alert-info small">
            <i class="bi bi-info-circle"></i>
            必要があれば、合計欄の上にある <strong>「メモ」</strong> 欄に
            管理者向けのコメントを書くこともできます（請求書本体に表示されます）。
          </div>

          <div class="alert alert-warning small mt-3">
            <i class="bi bi-exclamation-triangle"></i>
            送信後の内容修正が必要な場合は、管理者にご連絡ください。
          </div>
        </section>

        <!-- ===== 5. タイミー対応 ===== -->
        <section id="sg-timee" class="mb-5">
          <h5 class="bg-primary text-white px-3 py-2 rounded-3 shadow-sm mb-3" style="font-weight:700;">
            5. タイミーの方と一緒に作業する場合
          </h5>
          <p>
            タイミーで応募してきたヘルパーさんと一緒に清掃する日は、
            以下の2つの対応が必要です。どちらも
            <strong>清掃チェックリスト画面 右上の
            <span class="badge bg-primary"><i class="bi bi-qr-code"></i></span>
            ボタン</strong>
            から表示できる QRコードを使います。
          </p>
          <div class="alert alert-info small">
            <i class="bi bi-info-circle"></i>
            QRボタンをタップすると <strong>上下2個のQRコード</strong> が表示されます。
            <strong>上＝タイミーさん用チェックリスト</strong>／
            <strong>下＝タイミーCI/CO（出勤・退勤）用</strong> です。
          </div>

          <h6 class="fw-bold mt-3 border-start border-4 border-secondary ps-2 py-1 bg-light">❶ 出勤・退勤時（チェックイン／チェックアウト）</h6>
          <p>
            タイミーの方はタイムカードの代わりに、スマホで QRコードを読み取って
            <strong>チェックイン（出勤）</strong> と
            <strong>チェックアウト（退勤）</strong> を行う必要があります。
            この QRコードを清掃チェックリストに登録してあるので、こちらから提示して読み取ってもらってください。
          </p>
          <ol>
            <li>清掃チェックリスト画面の右上の
              <span class="badge bg-primary"><i class="bi bi-qr-code"></i></span>
              ボタンをタップ</li>
            <li>上下2個のQRコードが表示される</li>
            <li><strong>下のQRコード（タイミー CI/CO 用）</strong> をタイミーの方のスマホで読み取ってもらう</li>
            <li>出勤時と退勤時の <strong>2回</strong> 同じ操作が必要です</li>
          </ol>

          <h6 class="fw-bold mt-4 border-start border-4 border-secondary ps-2 py-1 bg-light">❷ タイミーさん用のチェックリスト</h6>
          <p>
            タイミーの方には、こちらが使うチェックリストとは別の
            <strong>タイミー専用バージョン</strong>（コインランドリー出しなどスタッフ専用作業を除外したもの）
            を用意しています。
            こちらも QRコードで読み取ってもらえば、その方のスマホで使ってもらえます。
          </p>
          <ol>
            <li>清掃チェックリスト画面の右上の
              <span class="badge bg-primary"><i class="bi bi-qr-code"></i></span>
              ボタンをタップ</li>
            <li>上下2個のQRコードが表示される</li>
            <li><strong>上のQRコード（タイミーさん用チェックリスト）</strong> をタイミーの方のスマホで読み取ってもらう</li>
            <li>タイミーの方のスマホでチェックリスト画面が開き、その方が直接チェックを入れられるようになります</li>
          </ol>
          <div class="alert alert-info small">
            <i class="bi bi-info-circle"></i>
            QRコードはどちらも紙に印刷して現地に貼ってもOKです。
            清掃チェックリストから PNGダウンロードボタンで保存できます。
          </div>
        </section>

        <hr>
        <p class="small text-muted text-center mb-4">
          ご不明な点があれば、Webアプリ管理者（やますけ）まで LINE またはメールでお問い合わせください。
        </p>
      </div>
    `;
  }
};
