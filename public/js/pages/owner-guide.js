/**
 * 物件オーナー用 使い方ガイド
 * ログイン方法 / 画面の見方 / 予約・名簿・清掃・収支の確認方法 を1ページに集約した静的ヘルプ
 * (staff-guide.js と同じ構成の公開ページ。ログイン不要)
 */
const OwnerGuidePage = {
  async render(container) {
    container.innerHTML = `
      <div class="container-fluid px-3 py-3" style="max-width:820px;margin:0 auto;">
        <h4 class="mb-3"><i class="bi bi-info-circle"></i> 民泊管理v2 物件オーナー用ガイド</h4>
        <p class="text-muted small">
          このページは物件オーナーの皆さま向けの使い方マニュアルです。
          困ったときはいつでもこのページを開いてご確認ください。
        </p>

        <!-- 目次 -->
        <div class="card mb-4">
          <div class="card-body py-2">
            <strong class="small text-muted">目次</strong>
            <ol class="mb-0 small">
              <li><a href="#og-login">ログイン方法</a></li>
              <li><a href="#og-view">画面の見方（メニュー一覧）</a></li>
              <li>
                <a href="#og-schedule">予約状況を確認する</a>
                <ul class="mb-0">
                  <li><a href="#og-calendar">カレンダーの見方</a></li>
                  <li><a href="#og-cancelled">キャンセル予約一覧</a></li>
                  <li><a href="#og-requests">直接予約リクエスト</a></li>
                </ul>
              </li>
              <li><a href="#og-guests">宿泊者名簿を確認する</a></li>
              <li><a href="#og-cleaning">清掃の状況を確認する</a></li>
              <li><a href="#og-pnl">収支・帳票を確認する</a></li>
              <li><a href="#og-reports">定期報告・宿泊税</a></li>
              <li><a href="#og-notify">通知について</a></li>
            </ol>
          </div>
        </div>

        <!-- ===== 1. ログイン方法 ===== -->
        <section id="og-login" class="mb-5">
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
                  <div class="small text-muted">（例：https://app.setouchi-stay.com/invite.html?token=xxxxx）</div>
                </li>
                <li>「<span class="text-success">○○さん</span>」とご自身の名前が表示されることを確認</li>
                <li>緑色の <strong>「LINEで参加する」</strong> ボタンをタップ</li>
                <li>LINEの認証画面で「許可する」をタップ</li>
                <li>「登録完了！」が出たら自動でオーナー用の画面に移動します</li>
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
                  <a href="https://app.setouchi-stay.com/" target="_blank" rel="noopener">https://app.setouchi-stay.com/</a>
                  を開く（ブックマーク／ホーム画面追加推奨）
                </li>
                <li>ログイン状態が保持されていれば、そのままオーナー用の画面が開きます。
                  ログイン画面が表示された場合のみ、緑色の
                  <strong>「LINEでログイン（スタッフ用）」</strong> ボタンを1回タップしてください。
                  <div class="small text-muted">※ボタン名は「スタッフ用」ですが、物件オーナーの方も同じボタンでログインします。</div></li>
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
        <section id="og-view" class="mb-5">
          <h5 class="bg-primary text-white px-3 py-2 rounded-3 shadow-sm mb-3" style="font-weight:700;">
            2. 画面の見方（メニュー一覧）
          </h5>
          <div class="alert alert-primary small">
            <i class="bi bi-list fs-5"></i>
            <strong>スマホで左メニューを開くには：</strong>
            画面左上の <strong>「<i class="bi bi-list"></i>（三本線）」</strong>
            アイコンをタップしてください。サイドメニューが横からスライドして開きます。
            メニュー外をタップするか、もう一度三本線アイコンをタップすると閉じます。
            <div class="mt-1 text-muted">PC・タブレットでは常に左側に表示されているため、この操作は不要です。</div>
          </div>
          <div class="alert alert-success small">
            <i class="bi bi-shield-check"></i>
            アプリに表示されるのは <strong>ご自身が所有する物件のデータのみ</strong> です。
            他のオーナー様の物件情報は表示されません。
          </div>
          <p>
            ログインすると、左メニューに次の項目が表示されます。
            基本は「見て確認する」使い方で大丈夫です。操作が必要な場面はほとんどありません。
          </p>

          <h6 class="fw-bold mt-3 border-start border-4 border-secondary ps-2 py-1 bg-light">予約まわり</h6>
          <ul>
            <li><i class="bi bi-calendar-check"></i> <strong>予約・清掃スケジュール</strong> — 予約と清掃の状況をカレンダーで確認（メインの画面）</li>
            <li><i class="bi bi-layout-three-columns"></i> <strong>【テスト】縦カレンダー／匿名カレンダー（縦）</strong> — 表示形式ちがいのカレンダー（お好みで）</li>
            <li><i class="bi bi-x-circle"></i> <strong>キャンセル予約一覧</strong> — キャンセルになった予約の履歴</li>
            <li><i class="bi bi-inbox"></i> <strong>直接予約リクエスト</strong> — 公式サイトからの予約申込の状況</li>
            <li><i class="bi bi-person-vcard"></i> <strong>宿泊者名簿</strong> — ゲスト情報と名簿の提出状況</li>
            <li><i class="bi bi-book"></i> <strong>ゲスト案内</strong> — ゲストに送られる案内ページの内容確認</li>
          </ul>

          <h6 class="fw-bold mt-3 border-start border-4 border-secondary ps-2 py-1 bg-light">清掃まわり</h6>
          <ul>
            <li><i class="bi bi-megaphone"></i> <strong>募集</strong> — 清掃スタッフ募集の回答・確定状況</li>
            <li><i class="bi bi-clipboard-check"></i> <strong>チェックリスト</strong> — 清掃チェックリストの内容と実施状況</li>
            <li><i class="bi bi-basket3"></i> <strong>ランドリー</strong> — リネン・ランドリー運用の記録</li>
            <li><i class="bi bi-people"></i> <strong>スタッフ</strong> — 清掃スタッフの一覧</li>
            <li><i class="bi bi-currency-yen"></i> <strong>報酬単価</strong> — 清掃報酬の単価設定</li>
            <li><i class="bi bi-receipt"></i> <strong>請求書</strong> — 清掃スタッフからの月次請求書</li>
            <li><i class="bi bi-credit-card-2-front"></i> <strong>プリカ管理</strong> — 備品購入用プリペイドカードの記録</li>
            <li><i class="bi bi-arrow-right-circle"></i> <strong>予約 / 清掃フロー構成</strong> — 予約から清掃までの自動フロー設定</li>
          </ul>

          <h6 class="fw-bold mt-3 border-start border-4 border-secondary ps-2 py-1 bg-light">経営まわり</h6>
          <ul>
            <li><i class="bi bi-graph-up-arrow"></i> <strong>収支</strong> — 月別の売上・経費・利益と帳票（報告書・精算書）</li>
            <li><i class="bi bi-file-earmark-bar-graph"></i> <strong>定期報告（住宅宿泊事業法）</strong> — 民泊新法の定期報告用の集計</li>
            <li><i class="bi bi-calculator"></i> <strong>宿泊税計算・申告</strong> — 外部サービス「やどぜい」へのリンク</li>
            <li><i class="bi bi-buildings"></i> <strong>物件</strong> — 物件の登録情報</li>
            <li><i class="bi bi-info-circle"></i> <strong>使い方ガイド</strong> — このページ</li>
          </ul>
        </section>

        <!-- ===== 3. 予約状況を確認する ===== -->
        <section id="og-schedule" class="mb-5">
          <h5 class="bg-primary text-white px-3 py-2 rounded-3 shadow-sm mb-3" style="font-weight:700;">
            3. 予約状況を確認する
          </h5>

          <!-- (a) カレンダー -->
          <h6 id="og-calendar" class="mt-3 fw-bold border-start border-4 border-primary ps-2 py-1 bg-light">
            (a) カレンダーの見方
          </h6>
          <ol>
            <li>左メニューから <strong>「予約・清掃スケジュール」</strong> をタップ</li>
            <li>横スクロール式のカレンダーが表示されます（日付が横に並びます）</li>
            <li>
              <span style="background:#a7c7ff;display:inline-block;width:14px;height:14px;border-radius:2px;vertical-align:middle;"></span>
              <strong>水色のバー＝確定済みの宿泊予約</strong> です。
              バーをタップすると、ゲスト名・人数・チェックイン／チェックアウトなどの詳細が確認できます
            </li>
            <li>各日付セルの <strong>「清」「直」</strong> のピル（小さい丸バッジ）は清掃関係の状態です。
              色で進み具合がわかります：
              <div class="mt-2 ps-2">
                <div class="fw-bold small text-muted">清＝清掃募集（チェックアウト日に発生）</div>
                <ul class="mt-1 mb-2">
                  <li>
                    <span style="background:#fd7e14;color:#fff;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;">清</span>
                    <strong>オレンジ</strong> ＝ 募集中（スタッフの回答待ち）
                  </li>
                  <li>
                    <span style="background:#ffc107;color:#333;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;">清</span>
                    <strong>黄色</strong> ＝ 選定済（担当スタッフを選定中）
                  </li>
                  <li>
                    <span style="background:#198754;color:#fff;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;">清</span>
                    <strong>緑</strong> ＝ 確定済（担当スタッフ決定）
                  </li>
                </ul>
                <div class="fw-bold small text-muted">直＝直前点検募集（チェックイン日に発生）</div>
                <ul class="mt-1 mb-0">
                  <li>
                    <span style="background:#a78bfa;color:#1e0a3c;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;">直</span>
                    薄紫＝募集中 ／
                    <span style="background:#c4b5fd;color:#1e0a3c;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;">直</span>
                    中紫＝選定済 ／
                    <span style="background:#7c3aed;color:#fff;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;">直</span>
                    濃紫＝確定済
                  </li>
                </ul>
              </div>
            </li>
          </ol>
          <div class="alert alert-info small">
            <i class="bi bi-info-circle"></i>
            ざっくり言うと、<strong>「水色バーで予約が入っているか」「チェックアウト日の『清』が緑になっているか」</strong>
            の2点を見れば、予約と清掃の状況が把握できます。
          </div>
          <div class="alert alert-light border small">
            <strong>表示形式の切り替え：</strong>
            左メニューの「【テスト】縦カレンダー」「【テスト】匿名カレンダー（縦）」で、
            縦並び表示や個人名を出さない集計表示にも切り替えられます。見やすいものをお使いください。
          </div>

          <!-- (b) キャンセル予約一覧 -->
          <h6 id="og-cancelled" class="mt-4 fw-bold border-start border-4 border-primary ps-2 py-1 bg-light">
            (b) キャンセル予約一覧
          </h6>
          <p>
            左メニューの <strong>「キャンセル予約一覧」</strong> で、キャンセルになった予約の履歴を確認できます。
            カレンダーからは消えるため、過去のキャンセルを確認したいときはこちらをご覧ください。
          </p>

          <!-- (c) 直接予約リクエスト -->
          <h6 id="og-requests" class="mt-4 fw-bold border-start border-4 border-primary ps-2 py-1 bg-light">
            (c) 直接予約リクエスト
          </h6>
          <p>
            公式サイト（直販サイト）からの予約申込は、いったん「リクエスト」として受け付けられ、
            承認されると正式な予約になります。左メニューの <strong>「直接予約リクエスト」</strong> で、
            <strong>未対応／承認済み／却下</strong> のタブごとに状況を確認できます。
          </p>
          <div class="alert alert-warning small">
            <i class="bi bi-exclamation-triangle"></i>
            リクエストの <strong>承認・却下・返金の操作は Webアプリ管理者が行います</strong>。
            オーナー画面では状況の確認のみ可能です。気になる申込があれば管理者にご連絡ください。
          </div>
        </section>

        <!-- ===== 4. 宿泊者名簿 ===== -->
        <section id="og-guests" class="mb-5">
          <h5 class="bg-primary text-white px-3 py-2 rounded-3 shadow-sm mb-3" style="font-weight:700;">
            4. 宿泊者名簿を確認する
          </h5>
          <p>
            旅館業法・住宅宿泊事業法で義務付けられている宿泊者名簿は、ゲストがチェックイン前に
            スマホで入力する仕組みになっています。左メニューの <strong>「宿泊者名簿」</strong> で、
            予約ごとの提出状況と内容（代表者名・人数・連絡先など）を確認できます。
          </p>
          <ol>
            <li>左メニューから <strong>「宿泊者名簿」</strong> をタップ</li>
            <li>予約の一覧が表示されます。名簿が提出済みかどうかがひと目でわかります</li>
            <li>行をタップすると、提出された名簿の詳細を確認できます</li>
          </ol>
          <div class="alert alert-info small">
            <i class="bi bi-info-circle"></i>
            名簿が未提出のゲストには、チェックイン前に自動でリマインドが送られる仕組みになっています。
            オーナー様側での督促作業は基本的に不要です。
          </div>
        </section>

        <!-- ===== 5. 清掃の状況 ===== -->
        <section id="og-cleaning" class="mb-5">
          <h5 class="bg-primary text-white px-3 py-2 rounded-3 shadow-sm mb-3" style="font-weight:700;">
            5. 清掃の状況を確認する
          </h5>
          <p>
            チェックアウト後の清掃は、予約に連動して自動で募集 → スタッフ確定 → 当日チェックリスト実施、
            という流れで進みます。オーナー様は以下のメニューで各段階を確認できます。
          </p>
          <ul>
            <li>
              <strong><i class="bi bi-megaphone"></i> 募集</strong> —
              清掃募集ごとのスタッフの回答状況（◎／△／×）と確定状況
            </li>
            <li>
              <strong><i class="bi bi-clipboard-check"></i> チェックリスト</strong> —
              物件ごとの清掃チェックリストの内容。清掃当日はスタッフがここにチェックと写真を記録します
            </li>
            <li>
              <strong><i class="bi bi-basket3"></i> ランドリー</strong> —
              リネン類の持ち出し・持ち込みなどランドリー運用の記録
            </li>
            <li>
              <strong><i class="bi bi-receipt"></i> 請求書</strong> —
              清掃スタッフから月末に提出される請求書の内容と金額
            </li>
          </ul>
          <div class="alert alert-info small">
            <i class="bi bi-info-circle"></i>
            日々の清掃手配（募集の作成・スタッフの選定・確定）は自動化されており、管理者が運用しています。
            オーナー様の操作は不要です。
          </div>
        </section>

        <!-- ===== 6. 収支・帳票 ===== -->
        <section id="og-pnl" class="mb-5">
          <h5 class="bg-primary text-white px-3 py-2 rounded-3 shadow-sm mb-3" style="font-weight:700;">
            6. 収支・帳票を確認する
          </h5>
          <p>
            左メニューの <strong>「収支」</strong> で、物件ごとの月別収支（売上・清掃費・経費・宿泊税・利益）を
            確認できます。売上や経費は OTA の予約データや請求書から自動で取り込まれます。
          </p>
          <h6 class="fw-bold mt-3 border-start border-4 border-secondary ps-2 py-1 bg-light">月別収支の見方</h6>
          <ol>
            <li>左メニューから <strong>「収支」</strong> をタップ</li>
            <li>物件と年を選んで <strong>「表示」</strong> をタップ</li>
            <li>月ごとの行に、売上（Airbnb／Booking.com／直接予約）・清掃費・経費・宿泊税・利益が表示されます</li>
          </ol>
          <h6 class="fw-bold mt-3 border-start border-4 border-secondary ps-2 py-1 bg-light">帳票（報告書・精算書）の表示</h6>
          <ol>
            <li>確認したい月の行の右側にある <strong>「帳票」</strong> ボタンをタップ</li>
            <li><strong>月次業務報告書</strong>（運営代行物件の場合は <strong>精算書兼請求書</strong> も）を PDF で表示できます</li>
            <li>「出典・内訳を確認」から、各金額の元になったファイル（予約CSV・請求書PDFなど）も確認できます</li>
          </ol>
          <div class="alert alert-warning small">
            <i class="bi bi-exclamation-triangle"></i>
            金額に疑問がある場合や、まだ数字が入っていない月がある場合は、Webアプリ管理者までお問い合わせください。
            経費の一部（紙の領収書など）は取り込みまでに時間がかかることがあります。
          </div>
        </section>

        <!-- ===== 7. 定期報告・宿泊税 ===== -->
        <section id="og-reports" class="mb-5">
          <h5 class="bg-primary text-white px-3 py-2 rounded-3 shadow-sm mb-3" style="font-weight:700;">
            7. 定期報告・宿泊税
          </h5>
          <ul>
            <li>
              <strong><i class="bi bi-file-earmark-bar-graph"></i> 定期報告（住宅宿泊事業法）</strong> —
              民泊新法（住宅宿泊事業法）の物件で2ヶ月ごとに必要な定期報告用の集計
              （宿泊日数・宿泊者数・国籍別内訳など）を確認できます
            </li>
            <li>
              <strong><i class="bi bi-calculator"></i> 宿泊税計算・申告</strong> —
              宿泊税の計算・申告に使っている外部サービス「やどぜい」へのリンクです
            </li>
          </ul>
          <div class="alert alert-info small">
            <i class="bi bi-info-circle"></i>
            定期報告・宿泊税とも、実際の申告手続きは管理者側で運用しています。
            オーナー様は内容の確認にご利用ください。
          </div>
        </section>

        <!-- ===== 8. 通知について ===== -->
        <section id="og-notify" class="mb-5">
          <h5 class="bg-primary text-white px-3 py-2 rounded-3 shadow-sm mb-3" style="font-weight:700;">
            8. 通知について
          </h5>
          <p>
            新規予約・キャンセル・直接予約リクエスト・名簿提出などの出来事は、設定に応じて
            <strong>LINE またはメール</strong> でオーナー様宛に自動通知されます。
            アプリを毎日開かなくても、通知を見れば大きな動きは把握できます。
          </p>
          <div class="alert alert-light border small">
            <strong>通知の種類や宛先を変えたいとき：</strong>
            「この通知は不要」「メールではなくLINEにしたい」などのご希望は、
            Webアプリ管理者（やますけ）までご連絡ください。設定を変更します。
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
