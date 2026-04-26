/**
 * 通知設定ページ
 * 各通知の有効/無効・送り先・メッセージテンプレート・プレビュー・テスト送信
 */
const NotificationsPage = {
  settings: {},

  // テスト送信APIエンドポイント
  TEST_API_URL: "https://api-5qrfx7ujcq-an.a.run.app/notifications/test",

  // ========== システム定義変数 (NotifyChannelEditor から alias) ==========
  // 単一情報源は public/js/shared/notify-channel-editor.js
  get systemVariables() { return window.NotifyChannelEditor.SYSTEM_VARIABLES; },
  get notifications() { return window.NotifyChannelEditor.NOTIFICATIONS; },

  // (元の systemVariables 定義は notify-channel-editor.js に移動)
  _legacySystemVariables_unused_: {
    // 募集系で使える変数
    recruit: [
      { name: "date",     label: "作業日",        sample: "2026/04/20",  source: "recruitment.checkoutDate" },
      { name: "property", label: "物件名",        sample: "長浜民泊A",    source: "recruitment.propertyName" },
      { name: "work",     label: "作業内容",      sample: "清掃",         source: "recruitment.workType (清掃 / 直前点検)" },
      { name: "url",      label: "回答ページURL", sample: "https://minpaku-v2.web.app/#/my-recruitment", source: "自動生成" },
      { name: "count",    label: "回答数",        sample: "3",           source: "recruitment.responses.length" },
      { name: "staff",    label: "確定スタッフ名", sample: "山田太郎",    source: "recruitment.selectedStaff" },
      { name: "memo",     label: "メモ",          sample: "BBQ後の片付けあり", source: "recruitment.memo" },
      { name: "response", label: "回答内容",      sample: "◎",           source: "response.response (◎/△/×)" },
    ],
    // 予約系で使える変数
    booking: [
      { name: "date",     label: "チェックアウト日", sample: "2026/04/20", source: "booking.checkOut" },
      { name: "checkin",  label: "チェックイン日",   sample: "2026/04/18", source: "booking.checkIn" },
      { name: "property", label: "物件名",          sample: "長浜民泊A",   source: "booking.propertyName" },
      { name: "guest",    label: "ゲスト名",        sample: "John Smith", source: "booking.guestName" },
      { name: "nights",   label: "宿泊数",          sample: "2",          source: "自動計算" },
      { name: "site",     label: "予約サイト",       sample: "Airbnb",     source: "booking.source" },
      { name: "url",      label: "名簿ページURL",   sample: "https://minpaku-v2.web.app/#/guests", source: "自動生成" },
    ],
    // スタッフ系で使える変数
    staff: [
      { name: "staff",    label: "スタッフ名",  sample: "山田太郎",      source: "staff.name" },
      { name: "date",     label: "対象日",      sample: "2026/04/20",   source: "shift.date" },
      { name: "property", label: "物件名",      sample: "長浜民泊A",     source: "shift.propertyName" },
      { name: "url",      label: "マイページURL", sample: "https://minpaku-v2.web.app/#/my-dashboard", source: "自動生成" },
      { name: "reason",   label: "理由",        sample: "直近15回の募集に無回答", source: "staff.inactiveReason" },
    ],
    // 経理系で使える変数
    invoice: [
      { name: "month",    label: "対象月",      sample: "4",            source: "invoice.yearMonth" },
      { name: "staff",    label: "スタッフ名",  sample: "山田太郎",      source: "invoice.staffName" },
      { name: "property", label: "物件名",      sample: "長浜民泊A",     source: "invoice.propertyName" },
      { name: "total",    label: "合計金額",    sample: "¥45,000",      source: "invoice.total" },
      { name: "url",      label: "確認/作成ページURL", sample: "https://minpaku-v2.web.app/#/my-invoice-create", source: "請求書要請: /#/my-invoice-create、提出通知: /#/invoices" },
    ],
    // 清掃系で使える変数
    cleaning: [
      { name: "date",     label: "清掃日",          sample: "2026/04/20",   source: "checklist.date" },
      { name: "property", label: "物件名",          sample: "長浜民泊A",     source: "checklist.propertyName" },
      { name: "staff",    label: "スタッフ名",       sample: "山田太郎",      source: "checklist.staffName" },
      { name: "time",     label: "完了時刻",        sample: "14:30",        source: "checklist.completedAt" },
      { name: "url",      label: "チェックリストURL", sample: "https://minpaku-v2.web.app/#/my-checklist/xxx", source: "自動生成 (該当シフトのチェックリストページ)" },
    ],
    // ランドリー系で使える変数 (アクション違いは通知type別に定義、action 変数は使わない)
    laundry: [
      { name: "date",     label: "清掃日",          sample: "2026/04/20",   source: "checklist.checkoutDate" },
      { name: "property", label: "物件名",          sample: "長浜民泊A",     source: "checklist.propertyName" },
      { name: "staff",    label: "担当スタッフ",     sample: "山田太郎",     source: "checklist.laundry.*.by.name" },
      { name: "time",     label: "実施時刻",         sample: "19:30",       source: "checklist.laundry.*.at" },
      { name: "url",      label: "チェックリストURL", sample: "https://minpaku-v2.web.app/#/my-checklist/xxx", source: "自動生成 (該当シフトのチェックリストページ)" },
    ],
  },

  // (元の notifications 定義は notify-channel-editor.js に移動。下は履歴保存用 dead code)
  _legacyNotifications_unused_: [
    { key: "recruit_response", label: "スタッフ回答通知", desc: "スタッフが募集に回答(◎/△/×)した時にWebアプリ管理者へ通知", icon: "bi-reply", group: "recruit", varGroup: "recruit", defaultTiming: "immediate",
      defaultMsg: "📋 募集に回答がありました\n\n日付: {date} ({property})\n{staff}: {response}\n候補: {count}名" },
    { key: "recruit_start", label: "作業スタッフ募集", desc: "新しい清掃/直前点検に対してスタッフへ募集通知を送信", icon: "bi-megaphone", group: "recruit", varGroup: "recruit", defaultTiming: "immediate",
      defaultMsg: "🧹 {work}スタッフ募集\n\n{date} {property}\n{work}スタッフを募集しています。\n回答をお願いします（◎OK / △微妙 / ×NG）\n\n回答: {url}" },
    { key: "recruit_remind", label: "募集リマインド", desc: "回答が集まらない場合にリマインド送信", icon: "bi-alarm", group: "recruit", varGroup: "recruit", defaultTiming: "evening",
      defaultMsg: "📋 {work}募集 回答のお願い\n\n{date} {property}\nまだ回答が届いていません（現在{count}件）。\n回答: {url}" },
    { key: "staff_confirm", label: "スタッフ確定通知", desc: "スタッフ確定時に本人とWebアプリ管理者に通知", icon: "bi-person-check", group: "recruit", varGroup: "recruit", defaultTiming: "immediate",
      defaultMsg: "✅ {work}担当が確定しました\n\n{date} {property}\n担当: {staff}\nよろしくお願いします。" },
    { key: "staff_undecided", label: "スタッフ未決定リマインド", desc: "作業日が近いのにスタッフ未確定の場合にWebアプリ管理者へ通知", icon: "bi-exclamation-triangle", group: "recruit", varGroup: "recruit", defaultTiming: "morning",
      defaultMsg: "⚠️ {work}スタッフ未確定\n\n{date} {property}\n作業日が近づいていますが、まだスタッフが確定していません。\n回答状況: {count}件" },
    { key: "urgent_remind", label: "直前予約リマインド", desc: "直前予約に対する緊急リマインド", icon: "bi-lightning", group: "recruit", varGroup: "recruit", defaultTiming: "immediate",
      defaultMsg: "🔴 緊急: 直前予約の{work}手配\n\n{date} {property}\n直前予約が入りました。至急スタッフの手配をお願いします。" },
    { key: "booking_cancel", label: "予約キャンセル通知", desc: "予約がキャンセルされた場合に通知", icon: "bi-x-circle", group: "booking", varGroup: "booking", defaultTiming: "immediate",
      defaultMsg: "❌ 予約キャンセル\n\n{checkin}〜{date} {property}\nゲスト: {guest}（{site}）\n予約がキャンセルされました。" },
    { key: "booking_change", label: "予約変更通知", desc: "予約日程が変更された場合に通知", icon: "bi-arrow-repeat", group: "booking", varGroup: "booking", defaultTiming: "immediate",
      defaultMsg: "🔄 予約変更\n\n{property}\n新しい日程: {checkin}〜{date}（{nights}泊）\nゲスト: {guest}" },
    { key: "cancel_request", label: "出勤キャンセル要望", desc: "スタッフからの出勤キャンセル要望をWebアプリ管理者に通知", icon: "bi-person-dash", group: "staff", varGroup: "staff", defaultTiming: "immediate",
      defaultMsg: "🙋 出勤キャンセル要望\n\n{staff}さんから{date} {property}の出勤キャンセル要望がありました。" },
    { key: "cancel_approve", label: "キャンセル承認通知", desc: "出勤キャンセルを承認した場合にスタッフに通知", icon: "bi-check-circle", group: "staff", varGroup: "staff", defaultTiming: "immediate",
      defaultMsg: "✅ キャンセル承認\n\n{date} {property}の出勤キャンセルが承認されました。" },
    { key: "cancel_reject", label: "キャンセル却下通知", desc: "出勤キャンセルを却下した場合にスタッフに通知", icon: "bi-dash-circle", group: "staff", varGroup: "staff", defaultTiming: "immediate",
      defaultMsg: "❌ キャンセル不可\n\n{date} {property}の出勤キャンセルは対応できませんでした。出勤をお願いします。" },
    { key: "staff_inactive", label: "スタッフ非アクティブ化通知", desc: "直近15回の募集に無回答のスタッフを非アクティブ化した時にWebアプリ管理者へ通知", icon: "bi-person-slash", group: "staff", varGroup: "staff", defaultTiming: "immediate",
      defaultMsg: "⚠️ スタッフ非アクティブ化\n\n{staff} さんを非アクティブに変更しました。\n理由: {reason}\n解除はスタッフ管理から行えます。" },
    { key: "roster_remind", label: "名簿未入力リマインド", desc: "宿泊者名簿が未入力の予約についてリマインド", icon: "bi-person-vcard", group: "booking", varGroup: "booking", defaultTiming: "morning",
      defaultMsg: "📝 名簿入力のお願い\n\n{checkin} {property}\nゲスト: {guest}\n宿泊者名簿がまだ届いていません。" },
    { key: "roster_received", label: "宿泊者名簿 受信通知", desc: "宿泊者名簿のフォーム回答が届いた時にWebアプリ管理者等へ通知", icon: "bi-envelope-check", group: "booking", varGroup: "booking", defaultTiming: "immediate",
      defaultMsg: "📨 宿泊者名簿が届きました\n\n{checkin} {property}\nゲスト: {guest}\n詳細: {url}" },
    { key: "form_complete_mail_failed", label: "名簿入力完了メール 送信失敗", desc: "宿泊者へ送る完了メールが送信エラーになった時、Webアプリ管理者等へ通知", icon: "bi-envelope-exclamation", group: "booking", varGroup: "booking", defaultTiming: "immediate",
      defaultEnabled: true, defaultOwnerLine: true, defaultGroupLine: false, defaultStaffLine: false, defaultEmail: true,
      defaultMsg: "⚠️ 完了メール送信失敗\n\n物件: {property}\nゲスト: {guest} ({email})\nエラー: {error}\n\n手動で連絡してください。" },
    { key: "invoice_request", label: "請求書要請", desc: "月末にスタッフへ請求書の提出を依頼（URLは請求書作成ページ）", icon: "bi-receipt", group: "invoice", varGroup: "invoice", defaultTiming: "morning",
      defaultMsg: "💰 {month}月分の請求書作成をお願いします\n\n作業明細をご確認の上、請求書の送信をお願いします。\n作成ページ: {url}" },
    { key: "invoice_submitted", label: "請求書提出通知", desc: "スタッフが請求書を送信した時にWebアプリ管理者へ通知", icon: "bi-send-check", group: "invoice", varGroup: "invoice", defaultTiming: "immediate",
      defaultMsg: "📨 請求書が提出されました\n\n{staff} さんから {month}月分の請求書が届きました。\n合計: {total}\n確認: {url}" },
    { key: "cleaning_done", label: "清掃完了通知", desc: "清掃チェックリスト完了時にWebアプリ管理者に通知", icon: "bi-clipboard-check", group: "cleaning", varGroup: "cleaning", defaultTiming: "immediate",
      defaultMsg: "✨ 清掃完了\n\n{date} {property}\n{staff}さんが{time}に清掃を完了しました。\n詳細: {url}" },
    { key: "laundry_put_out", label: "ランドリー 出した", desc: "スタッフが「洗濯物を出した」ボタンを押した時にWebアプリ管理者等へ通知", icon: "bi-arrow-up-circle", group: "cleaning", varGroup: "laundry", defaultTiming: "immediate",
      defaultMsg: "🧺 ランドリー 出した\n\n{date} {property}\n{staff}さんが{time}に洗濯物を出しました。\n詳細: {url}" },
    { key: "laundry_collected", label: "ランドリー 回収した", desc: "スタッフが「洗濯物を回収した」ボタンを押した時にWebアプリ管理者等へ通知", icon: "bi-arrow-down-circle", group: "cleaning", varGroup: "laundry", defaultTiming: "immediate",
      defaultMsg: "🧺 ランドリー 回収した\n\n{date} {property}\n{staff}さんが{time}に洗濯物を回収しました。\n詳細: {url}" },
    { key: "laundry_stored", label: "ランドリー 収納した", desc: "スタッフが「洗濯物を収納した」ボタンを押した時にWebアプリ管理者等へ通知", icon: "bi-check2-circle", group: "cleaning", varGroup: "laundry", defaultTiming: "immediate",
      defaultMsg: "🧺 ランドリー 収納した\n\n{date} {property}\n{staff}さんが{time}に洗濯物を収納しました。\n詳細: {url}" },
    // D-3: ダブルブッキング検知通知（デフォルト: Webアプリ管理者LINE+グループLINE有効、スタッフ無効）
    { key: "double_booking", label: "ダブルブッキング検知", desc: "同物件・同日程に複数予約が重複した際にWebアプリ管理者へ緊急通知", icon: "bi-exclamation-triangle-fill", group: "booking", varGroup: "booking", defaultTiming: "immediate",
      defaultEnabled: true, defaultOwnerLine: true, defaultGroupLine: true, defaultStaffLine: false, defaultEmail: false,
      defaultMsg: "【⚠️ ダブルブッキング警告】\n物件: {property}\n日程: {checkin} 〜 {date}\n\n衝突予約が検出されました。至急確認してください。\n確認: {url}" },
  ],

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-bell"></i> 通知設定</h2>
        <div class="d-flex align-items-center gap-2">
          <span id="notifyAutoSaveStatus" style="min-width:110px;text-align:right;"></span>
          <small class="text-muted d-none d-sm-inline">(自動保存)</small>
        </div>
      </div>

      <!-- 通知の ON/OFF・送信先・本文は物件別のみ参照（2026-04-26 ポリシー変更）-->
      <div class="alert alert-warning mb-3">
        <div class="d-flex align-items-start gap-2">
          <i class="bi bi-exclamation-triangle-fill fs-5 flex-shrink-0"></i>
          <div class="flex-grow-1">
            <strong>このページの「通知のON/OFF」「送信先」「本文テンプレ」は運用に反映されません</strong>
            <p class="small mb-2 mt-1">
              通知の有効/無効・宛先・カスタムメッセージはすべて
              <a href="#/reservation-flow"><strong>予約フロー構成</strong></a> /
              <a href="#/cleaning-flow"><strong>清掃フロー構成</strong></a> の物件別カードに統合されました。
              このページの設定値は無視されます。下記の各通知種別カードは参考表示のみです。
            </p>
            <small class="text-muted">Webアプリ管理者の個別通知先（メール/Discord）など個人設定はここで編集します。</small>
          </div>
        </div>
      </div>

      <!-- LINE 通知は物件ごとに設定する方針に変更 (2026-04-19) -->
      <div class="alert alert-primary mb-3">
        <div class="d-flex align-items-start gap-2">
          <i class="bi bi-info-circle-fill fs-5 flex-shrink-0"></i>
          <div class="flex-grow-1">
            <strong>LINE 通知の設定は「物件ごと」に変わりました</strong>
            <p class="small mb-2 mt-1">
              LINE 公式アカウント (Bot) は <strong>各物件の編集画面</strong>で紐付けます。
              1物件あたり最大2つの Bot を登録可能。無料枠 <code>200通/月 × Bot数</code> 分が使えます (例: 4物件×2Bot = 1,600通/月 無料)。
            </p>
            <a href="#/properties" class="btn btn-sm btn-primary">
              <i class="bi bi-arrow-right-circle"></i> 物件管理ページで LINE 設定する
            </a>
            <small class="text-muted ms-2">物件一覧 → 「編集」 → 「LINE 連携(物件単位)」セクション</small>
          </div>
        </div>
      </div>

      <!-- Webアプリ管理者個別通知先 -->
      <div class="card mb-4">
        <div class="card-header">
          <h6 class="mb-0"><i class="bi bi-person-gear"></i> Webアプリ管理者個別通知先</h6>
        </div>
        <div class="card-body">
          <div class="row g-3">
            <div class="col-md-6">
              <label class="form-label">Webアプリ管理者LINE User ID</label>
              <input type="text" class="form-control" id="lineOwnerUserId" placeholder="Uxxxxxx...">
              <div class="form-text">Webアプリ管理者宛の個別通知に使用 (物件LINEの Bot を友達追加すると自動取得)</div>
            </div>
            <div class="col-md-6">
              <label class="form-label">Webアプリ管理者メールアドレス</label>
              <div class="input-group">
                <input type="email" class="form-control" id="ownerEmail" placeholder="owner@example.com">
                <button class="btn btn-outline-warning" type="button" id="btnGmailReauth" title="Gmail OAuth 再接続">
                  <i class="bi bi-shield-check"></i> Gmail再接続
                </button>
              </div>
              <div class="form-text">メール通知の送信先。送信時 invalid_grant エラーが出たら「Gmail再接続」を押してください。</div>
            </div>
            <div class="col-md-6">
              <label class="form-label">Discord (Webアプリ管理者) Webhook URL</label>
              <input type="url" class="form-control" id="discordOwnerWebhookUrl" placeholder="https://discord.com/api/webhooks/...">
              <div class="form-text">Discord サーバー → チャンネル設定 → 連携サービス → Webhook で作成</div>
            </div>
            <div class="col-md-6">
              <label class="form-label">Discord (物件オーナー) Webhook URL</label>
              <input type="url" class="form-control" id="discordSubOwnerWebhookUrl" placeholder="https://discord.com/api/webhooks/...">
              <div class="form-text">物件オーナー共有チャンネルの Webhook URL</div>
            </div>
          </div>
          <!-- Webアプリ管理者LINE通知 Bot リスト -->
          <div class="col-12 mt-3">
            <hr class="my-2">
            <div class="d-flex align-items-center justify-content-between mb-2">
              <label class="form-label mb-0"><i class="bi bi-robot"></i> Webアプリ管理者LINE通知 Bot リスト</label>
              <button type="button" class="btn btn-sm btn-outline-primary" id="btnAddOwnerLineChannel">
                <i class="bi bi-plus-circle"></i> Bot を追加
              </button>
            </div>
            <div class="form-text mb-2">Webアプリ管理者宛通知専用の Bot を複数登録できます。fallback 戦略では無料枠切れ時に次の Bot へ自動切替します（最大3つ）。</div>
            <div id="ownerLineChannelsList"></div>
            <div class="mt-2">
              <label class="form-label small text-muted mb-1"><i class="bi bi-shuffle"></i> 配信戦略</label>
              <select class="form-select form-select-sm w-auto" id="ownerLineChannelStrategy">
                <option value="fallback">fallback — 残枠あり Bot を順に試みる</option>
                <option value="roundrobin">roundrobin — 日付ベースで交互使用</option>
              </select>
            </div>
          </div>
          <!-- 旧データ後方互換用 (画面には表示しないが値を保持・保存) -->
          <input type="hidden" id="lineChannelToken">
          <input type="hidden" id="lineGroupId">
        </div>
      </div>

      <!-- 通知チャンネル設定 -->
      <h5 class="mb-3">通知チャンネル設定 <small class="text-muted">（参考表示・運用には使われません）</small></h5>
      <div class="alert alert-secondary small mb-3">
        <i class="bi bi-archive"></i>
        通知の ON/OFF・送信先・本文は <a href="#/reservation-flow" class="alert-link">予約フロー構成</a> /
        <a href="#/cleaning-flow" class="alert-link">清掃フロー構成</a> の物件別カードでのみ設定できます。
        ここの値を変更しても運用には反映されません。
      </div>

      <div class="d-flex flex-wrap gap-3 mb-3 small text-muted">
        <span><i class="bi bi-person-circle text-success"></i> Webアプリ管理者LINE</span>
        <span><i class="bi bi-people-fill text-primary"></i> グループLINE</span>
        <span><i class="bi bi-person-lines-fill text-info"></i> スタッフ個別LINE</span>
        <span><i class="bi bi-envelope text-warning"></i> Webアプリ管理者メール</span>
        <span><i class="bi bi-discord" style="color:#5865F2"></i> Discord(Webアプリ管理者)</span>
        <span><i class="bi bi-discord" style="color:#8da0f8"></i> Discord(物件オーナー)</span>
      </div>

      <!-- 送信元情報 (この通知がどこから届くか) -->
      <div class="alert alert-light border mb-3" id="notifySenderInfoBox">
        <div class="small fw-bold mb-1"><i class="bi bi-send-check"></i> 送信元（各通知がどのアカウント・Botから届くか）</div>
        <div class="small" id="notifySenderInfoContent">
          <div class="text-muted">読込中...</div>
        </div>
      </div>

      <h6 class="text-muted mb-2"><i class="bi bi-megaphone"></i> 募集関連</h6>
      <div id="notifyGroup_recruit" class="mb-4"></div>
      <h6 class="text-muted mb-2"><i class="bi bi-calendar-event"></i> 予約関連</h6>
      <div id="notifyGroup_booking" class="mb-4"></div>
      <h6 class="text-muted mb-2"><i class="bi bi-people"></i> スタッフ関連</h6>
      <div id="notifyGroup_staff" class="mb-4"></div>
      <h6 class="text-muted mb-2"><i class="bi bi-receipt"></i> 経理関連</h6>
      <div id="notifyGroup_invoice" class="mb-4"></div>
      <h6 class="text-muted mb-2"><i class="bi bi-clipboard-check"></i> 清掃関連</h6>
      <div id="notifyGroup_cleaning" class="mb-4"></div>

      <!-- 宿泊者宛 サンクスメール (名簿入力完了後、宿泊者へ自動送信) -->
      <h6 class="text-muted mb-2"><i class="bi bi-envelope-heart"></i> 宿泊者宛メール</h6>
      <div class="card mb-4">
        <div class="card-body">
          <div class="d-flex align-items-center gap-2 mb-2">
            <i class="bi bi-person-heart text-danger"></i>
            <strong>宿泊者名簿 入力完了 サンクスメール</strong>
          </div>
          <div class="text-muted small mb-3">
            宿泊者が名簿を送信した直後に、宿泊者本人のメールアドレス宛に自動送信されるメール。
            送信者は該当物件の物件オーナー (staff.isSubOwner=true。未設定時は staff.isOwner=true)。
            宛先: 宿泊者が名簿で入力したメールアドレス。
          </div>
          <div class="row g-2">
            <div class="col-12">
              <label class="form-label small mb-1">件名（{propertyName}, {guestName}, {checkIn}, {checkOut} 等の変数使用可）</label>
              <input type="text" class="form-control form-control-sm" id="guestConfirmationSubject" placeholder="【{propertyName}】宿泊者名簿をお預かりしました／{guestName} 様">
            </div>
            <div class="col-12">
              <label class="form-label small mb-1">本文</label>
              <textarea class="form-control form-control-sm" id="guestConfirmationBody" rows="12" placeholder="{guestName} 様&#10;&#10;宿泊者名簿のご記入ありがとうございます。&#10;以下の内容で受け付けました。&#10;&#10;{summary}&#10;..."></textarea>
            </div>
            <div class="col-12">
              <div class="small text-muted">
                利用可能変数:
                <code>{guestName}</code> <code>{propertyName}</code> <code>{propertyAddress}</code>
                <code>{checkIn}</code> <code>{checkOut}</code> <code>{checkInTime}</code> <code>{checkOutTime}</code>
                <code>{guestCount}</code> <code>{summary}</code> <code>{editUrl}</code> <code>{guideUrl}</code>
              </div>
            </div>
          </div>
          <div class="mt-2">
            <button class="btn btn-sm btn-success" id="btnSaveGuestConfirmation"><i class="bi bi-check-lg"></i> 宿泊者宛メールを保存</button>
            <span id="guestConfirmationSaveStatus" class="small ms-2"></span>
          </div>
        </div>
      </div>
    `;

    await this.loadSettings();
    this.renderNotifications();
    // 自動保存をセットアップ (各入力の change/input で debounced 保存)
    this._setupAutoSave();
    // Gmail 再認証ボタン
    document.getElementById("btnGmailReauth").addEventListener("click", () => {
      const email = (document.getElementById("ownerEmail").value || "").trim();
      if (!email) {
        showToast("エラー", "先にWebアプリ管理者メールアドレスを入力してください", "error");
        return;
      }
      const url = `https://api-5qrfx7ujcq-an.a.run.app/gmail-auth/start?email=${encodeURIComponent(email)}`;
      window.open(url, "_blank");
      showToast("再認証", "Google認証ページを新しいタブで開きました。承認後この画面に戻ってテスト送信してください。", "info");
    });
  },

  async loadSettings() {
    try {
      const doc = await db.collection("settings").doc("notifications").get();
      this.settings = doc.exists ? doc.data() : {};
    } catch (e) {
      this.settings = {};
    }
    document.getElementById("lineChannelToken").value = this.settings.lineChannelToken || this.settings.lineToken || "";
    document.getElementById("lineGroupId").value = this.settings.lineGroupId || "";
    document.getElementById("lineOwnerUserId").value = this.settings.lineOwnerUserId || this.settings.lineOwnerId || "";
    document.getElementById("ownerEmail").value = this.settings.ownerEmail || "";
    const d1 = document.getElementById("discordOwnerWebhookUrl");
    const d2 = document.getElementById("discordSubOwnerWebhookUrl");
    if (d1) d1.value = this.settings.discordOwnerWebhookUrl || "";
    if (d2) d2.value = this.settings.discordSubOwnerWebhookUrl || "";

    // 送信元情報ボックスを更新 (チャネル別に細分化)
    try {
      const box = document.getElementById("notifySenderInfoContent");
      if (box) {
        const esc = (s) => String(s || "").replace(/</g, "&lt;");
        // データ収集
        const [gmailTokens, propSnap, staffSnap] = await Promise.all([
          db.collection("settings").doc("gmailOAuth").collection("tokens").get(),
          db.collection("properties").where("active", "==", true).get(),
          db.collection("staff").where("active", "==", true).get(),
        ]);
        const gmailList = gmailTokens.docs.map(d => ({ email: d.data().email })).filter(g => g.email);
        const gmailAll = gmailList.map(g => g.email);
        const gmailPrimary = gmailAll[0] || "";
        const defaultBot = this.settings.ownerLineChannels?.[0]?.name || "(Bot 名未設定)";
        const ownerUserId = this.settings.lineOwnerUserId || this.settings.lineOwnerId || "";
        const ownerEmailGlobal = this.settings.ownerEmail || "";
        // 物件別 LINE Bot
        const propBots = [];
        propSnap.docs.forEach(d => {
          const p = d.data();
          if (Array.isArray(p.lineChannels)) {
            p.lineChannels.forEach(ch => {
              if (ch.enabled && ch.name) propBots.push({ property: p.name, bot: ch.name, group: ch.groupId });
            });
          }
        });
        const propWithLineCount = propBots.length;
        // スタッフ LINE
        const staffAll = staffSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const staffLineCount = staffAll.filter(s => s.lineUserId).length;
        const staffEmailCount = staffAll.filter(s => s.email).length;
        // 物件オーナー (サブオーナー)
        const subOwners = staffAll.filter(s => s.isSubOwner);
        const subOwnerLineCount = subOwners.filter(s => s.subOwnerLineUserId).length;
        const subOwnerEmailCount = subOwners.filter(s => s.subOwnerEmail || s.email).length;
        // Discord
        const discOwner = this.settings.discordOwnerWebhookUrl ? `<code>${esc(this.settings.discordOwnerWebhookUrl.slice(0, 60))}...</code>` : '<span class="text-danger">未設定</span>';
        const discSub = this.settings.discordSubOwnerWebhookUrl ? `<code>${esc(this.settings.discordSubOwnerWebhookUrl.slice(0, 60))}...</code>` : '<span class="text-danger">未設定</span>';

        // 編集画面へのリンクを生成
        // href: SPA ルート (#/xxx) または 同ページ内アンカー (data-scroll-to="要素ID")
        const editLink = (opts) => {
          const label = opts.label || "編集";
          if (opts.scrollTo) {
            return `<a href="javascript:void(0)" class="btn btn-sm btn-outline-secondary py-0 px-2 sender-edit-link"
                      data-scroll-to="${opts.scrollTo}" title="${esc(opts.title || "この設定を編集")}"
                      style="font-size:0.75em; white-space:nowrap;">
                      <i class="bi bi-pencil-square"></i> ${esc(label)}
                    </a>`;
          }
          return `<a href="${opts.href}" class="btn btn-sm btn-outline-secondary py-0 px-2"
                    title="${esc(opts.title || "この設定を編集")}"
                    style="font-size:0.75em; white-space:nowrap;">
                    <i class="bi bi-pencil-square"></i> ${esc(label)}
                  </a>`;
        };

        const row = (icon, label, detail, editHtml) =>
          `<div class="d-flex align-items-start gap-2 py-1 border-bottom" style="font-size:0.85em;">
             <span style="min-width:240px;">${icon} <strong>${esc(label)}</strong></span>
             <span class="flex-grow-1">${detail}</span>
             <span class="flex-shrink-0">${editHtml || ""}</span>
           </div>`;

        box.innerHTML = `
          ${row('<i class="bi bi-person-circle text-success"></i>', "Webアプリ管理者LINE", `
            From Bot: <code>${esc(defaultBot)}</code><br>
            To (宛先): User ID <code>${esc(ownerUserId || "未設定")}</code>`,
            editLink({ scrollTo: "ownerLineChannelsList", label: "Bot/User ID を編集", title: "Webアプリ管理者の LINE Bot・User ID 設定へ" }))}
          ${row('<i class="bi bi-people-fill text-primary"></i>', "グループLINE (物件別)", propBots.length === 0
            ? '<span class="text-danger">物件 LINE チャネル未登録</span>'
            : propBots.map(b => `${esc(b.property)}: Bot <code>${esc(b.bot)}</code> / Group <code>${esc(String(b.group || "").slice(0, 20))}...</code>`).join("<br>"),
            editLink({ href: "#/properties", label: "物件管理で編集", title: "物件ごとの LINE チャネル設定へ" }))}
          ${row('<i class="bi bi-person-lines-fill text-info"></i>', "スタッフ個別LINE", `
            From Bot: <code>${esc(defaultBot)}</code><br>
            To: 対象スタッフ ${staffLineCount} 名 (staff.lineUserId あり)`,
            editLink({ href: "#/staff", label: "スタッフ管理で編集", title: "各スタッフの LINE User ID 設定へ" }))}
          ${row('<i class="bi bi-person-badge text-success"></i>', "物件オーナー個別LINE", `
            From Bot: <code>${esc(defaultBot)}</code><br>
            To: 物件オーナー ${subOwnerLineCount} 名 (staff.subOwnerLineUserId あり)`,
            editLink({ href: "#/staff", label: "スタッフ管理で編集", title: "物件オーナー(サブオーナー)の LINE User ID 設定へ" }))}
          ${row('<i class="bi bi-envelope text-warning"></i>', "Webアプリ管理者メール", `
            From: <code>${esc(gmailPrimary || "Gmail 未連携")}</code>${gmailAll.length > 1 ? ` (ほか ${gmailAll.length - 1} 連携)` : ""}<br>
            To: <code>${esc(ownerEmailGlobal || "settings/notifications.ownerEmail 未設定")}</code>`,
            editLink({ scrollTo: "ownerEmail", label: "宛先/Gmail 再接続", title: "宛先メール編集・Gmail 再認証へ" }))}
          ${row('<i class="bi bi-envelope-at text-success"></i>', "物件オーナー個別メール", `
            From: 物件オーナーの Gmail (未連携なら先頭 Gmail にフォールバック)<br>
            To: 物件オーナー ${subOwnerEmailCount} 名 (subOwnerEmail または email)`,
            editLink({ href: "#/staff", label: "スタッフ管理で編集", title: "物件オーナー(サブオーナー)のメール設定へ" }))}
          ${row('<i class="bi bi-envelope-fill text-info"></i>', "スタッフ個別メール", `
            From: <code>${esc(gmailPrimary || "Gmail 未連携")}</code><br>
            To: 対象スタッフ ${staffEmailCount} 名 (staff.email あり)`,
            editLink({ href: "#/staff", label: "スタッフ管理で編集", title: "各スタッフのメール設定へ" }))}
          ${row('<i class="bi bi-envelope-heart text-danger"></i>', "宿泊者宛サンクスメール", `
            From: 該当物件の物件オーナー Gmail (isSubOwner > isOwner)<br>
            To: 宿泊者が名簿で入力したメール (strict: 物件オーナー Gmail 未連携なら送信スキップ)`,
            editLink({ scrollTo: "btnSaveGuestConfirmation", label: "本文を編集", title: "宿泊者宛サンクスメール本文の編集欄へ" }))}
          ${row('<i class="bi bi-discord" style="color:#5865F2"></i>', "Discord (Webアプリ管理者)", `
            From Bot: Discord Webhook の Bot (名前/アイコンは Discord 側)<br>
            To: Webhook URL ${discOwner}`,
            editLink({ scrollTo: "discordOwnerWebhookUrl", label: "Webhook URL を編集", title: "Webアプリ管理者 Discord Webhook URL 入力欄へ" }))}
          ${row('<i class="bi bi-discord" style="color:#8da0f8"></i>', "Discord (物件オーナー)", `
            From Bot: Discord Webhook の Bot (名前/アイコンは Discord 側)<br>
            To: Webhook URL ${discSub}`,
            editLink({ scrollTo: "discordSubOwnerWebhookUrl", label: "Webhook URL を編集", title: "物件オーナー Discord Webhook URL 入力欄へ" }))}
        `;

        // 同ページ内スクロール用ハンドラ
        box.querySelectorAll(".sender-edit-link[data-scroll-to]").forEach(a => {
          a.addEventListener("click", (e) => {
            e.preventDefault();
            const id = a.dataset.scrollTo;
            const target = document.getElementById(id);
            if (!target) return;
            target.scrollIntoView({ behavior: "smooth", block: "center" });
            // 一時ハイライトで視認性 UP
            target.style.transition = "box-shadow 0.3s";
            const prev = target.style.boxShadow;
            target.style.boxShadow = "0 0 0 3px #ffc107";
            setTimeout(() => { target.style.boxShadow = prev; }, 1600);
            // 入力要素なら focus
            if (target.matches && target.matches("input, textarea, select")) {
              setTimeout(() => target.focus(), 300);
            }
          });
        });
      }
    } catch (e) {
      console.warn("送信元情報取得エラー:", e.message);
    }

    // 宿泊者宛サンクスメール テンプレート (settings/guestForm.emailTemplates.guestConfirmation)
    try {
      const gfDoc = await db.collection("settings").doc("guestForm").get();
      const tpl = (gfDoc.exists && gfDoc.data().emailTemplates?.guestConfirmation) || {};
      const subjEl = document.getElementById("guestConfirmationSubject");
      const bodyEl = document.getElementById("guestConfirmationBody");
      if (subjEl) subjEl.value = tpl.subject || "";
      if (bodyEl) bodyEl.value = tpl.body || "";
    } catch (_) {}

    // 保存ボタン (1度だけバインド)
    const saveBtn = document.getElementById("btnSaveGuestConfirmation");
    if (saveBtn && !saveBtn._bound) {
      saveBtn._bound = true;
      saveBtn.addEventListener("click", async () => {
        const subject = document.getElementById("guestConfirmationSubject")?.value?.trim() || "";
        const body = document.getElementById("guestConfirmationBody")?.value || "";
        const status = document.getElementById("guestConfirmationSaveStatus");
        if (status) status.innerHTML = '<span class="text-muted">保存中...</span>';
        try {
          await db.collection("settings").doc("guestForm").set({
            emailTemplates: { guestConfirmation: { subject, body } },
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
          if (status) status.innerHTML = '<span class="text-success"><i class="bi bi-check-circle"></i> 保存しました</span>';
          showToast("完了", "宿泊者宛メールを保存しました", "success");
        } catch (e) {
          if (status) status.innerHTML = `<span class="text-danger">保存失敗: ${e.message}</span>`;
        }
      });
    }

    // ownerLineChannels の読み込みと描画
    this._renderOwnerLineChannels(this.settings.ownerLineChannels || []);
    const stratEl = document.getElementById("ownerLineChannelStrategy");
    if (stratEl) stratEl.value = this.settings.ownerLineChannelStrategy || "fallback";

    // Bot追加ボタン
    const addBtn = document.getElementById("btnAddOwnerLineChannel");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        const list = document.getElementById("ownerLineChannelsList");
        if (!list) return;
        const count = list.querySelectorAll(".owner-line-channel-row").length;
        if (count >= 3) {
          showToast("上限", "Bot は最大3つまで登録できます", "warning");
          return;
        }
        this._appendOwnerLineChannelRow({}, count);
      });
    }
  },

  // ownerLineChannels を描画（初期表示）
  _renderOwnerLineChannels(channels) {
    const list = document.getElementById("ownerLineChannelsList");
    if (!list) return;
    list.innerHTML = "";
    channels.forEach((ch, idx) => this._appendOwnerLineChannelRow(ch, idx));
  },

  // ownerLineChannels の1行を追加
  _appendOwnerLineChannelRow(ch, idx) {
    const list = document.getElementById("ownerLineChannelsList");
    if (!list) return;
    const row = document.createElement("div");
    row.className = "owner-line-channel-row border rounded p-2 mb-2";
    row.innerHTML = `
      <div class="d-flex align-items-center justify-content-between mb-2">
        <span class="small text-muted">Bot #${idx + 1}</span>
        <button type="button" class="btn btn-sm btn-link text-danger p-0 btn-remove-owner-line-channel" title="削除">
          <i class="bi bi-trash"></i>
        </button>
      </div>
      <div class="row g-2">
        <div class="col-md-4">
          <label class="form-label small mb-1">表示名</label>
          <input type="text" class="form-control form-control-sm owner-line-ch-name" placeholder="例: Bot#1" value="${this._escapeAttr(ch.name || "")}">
        </div>
        <div class="col-md-4">
          <label class="form-label small mb-1">チャネルアクセストークン</label>
          <input type="password" class="form-control form-control-sm owner-line-ch-token" placeholder="チャネルアクセストークン" value="${this._escapeAttr(ch.token || "")}">
        </div>
        <div class="col-md-4">
          <label class="form-label small mb-1">Webアプリ管理者 LINE User ID</label>
          <input type="text" class="form-control form-control-sm owner-line-ch-userId" placeholder="Uxxxxxxxxxx" value="${this._escapeAttr(ch.userId || "")}">
        </div>
      </div>
    `;
    // 削除ボタン
    row.querySelector(".btn-remove-owner-line-channel").addEventListener("click", () => {
      row.remove();
      // 番号を再採番
      list.querySelectorAll(".owner-line-channel-row").forEach((r, i) => {
        const label = r.querySelector(".text-muted");
        if (label) label.textContent = `Bot #${i + 1}`;
      });
    });
    list.appendChild(row);
  },

  // HTML属性用エスケープ
  _escapeAttr(s) {
    return String(s || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  },

  renderNotifications() {
    // Phase A: 共有コンポーネント NotifyChannelEditor を使用
    const groups = window.NotifyChannelEditor.groupNotifications();
    for (const [group, items] of Object.entries(groups)) {
      const container = document.getElementById(`notifyGroup_${group}`);
      if (!container) continue;
      container.innerHTML = items.map(n =>
        window.NotifyChannelEditor.renderNotificationCard(
          n,
          (this.settings.channels || {})[n.key] || {},
          { collapsed: true, showTestButton: true }
        )
      ).join("");
      window.NotifyChannelEditor.bindCardEvents(container, {
        onTestSend: (key, channelData, varGroup, btn) => this.sendTestNotification(btn),
        // onChange は document.body の input/change で _setupAutoSave が拾うため不要
      });
    }
  },

  // ===== 旧 renderNotifications 本体は notify-channel-editor.js に移動 (dead code) =====
  _legacyRenderNotifications_unused_() {
    /* DEAD CODE — 残しておくと文字列内の構文崩れがリスクなので即 return */ return;
    /* eslint-disable */
    const groups = {};
    this.notifications.forEach(n => {
      if (!groups[n.group]) groups[n.group] = [];
      groups[n.group].push(n);
    });

    for (const [group, items] of Object.entries(groups)) {
      const container = document.getElementById(`notifyGroup_${group}`);
      if (!container) continue;

      container.innerHTML = items.map(n => {
        const ch = (this.settings.channels || {})[n.key] || {};
        // Firestore 未設定の場合は通知定義の defaultXxx を使用
        const enabled = ch.enabled !== undefined ? ch.enabled !== false : (n.defaultEnabled !== false);
        const ownerLine = ch.ownerLine !== undefined ? ch.ownerLine !== false : (n.defaultOwnerLine !== false);
        const groupLine = ch.groupLine !== undefined ? !!ch.groupLine : (!!n.defaultGroupLine);
        const staffLine = ch.staffLine !== undefined ? !!ch.staffLine : (!!n.defaultStaffLine);
        const ownerEmail = ch.ownerEmail !== undefined ? !!ch.ownerEmail : (!!n.defaultEmail);
        const discordOwner = !!ch.discordOwner;
        const discordSubOwner = !!ch.discordSubOwner;
        // FCM (Web Push) チャネル
        const fcmStaff = !!ch.fcmStaff;
        const fcmOwner = !!ch.fcmOwner;
        const customMessage = ch.customMessage || "";
        const msgValue = customMessage || n.defaultMsg || n.desc;
        const vars = this.systemVariables[n.varGroup] || [];

        // タイミング配列化 (旧データは単一 timing/mode から復元)
        let timings = Array.isArray(ch.timings) && ch.timings.length
          ? ch.timings
          : [{
              mode: ch.mode || "event",
              timing: ch.timing || n.defaultTiming || "immediate",
              timingMinutes: ch.timingMinutes || "",
              beforeDays: ch.beforeDays || 3,
              beforeTime: ch.beforeTime || "09:00",
              schedulePattern: ch.schedulePattern || "monthEnd",
              scheduleDay: ch.scheduleDay || 1,
              scheduleDow: ch.scheduleDow || 0,
              scheduleTime: ch.scheduleTime || "09:00",
            }];

        // 利用可能な変数タグ
        const varTags = vars.map(v =>
          `<span class="badge bg-light text-dark border me-1 mb-1 var-insert-tag" role="button" data-var="{${v.name}}" data-target="${n.key}" title="${v.label}（${v.source}）">{${v.name}} <small class="text-muted">${v.label}</small></span>`
        ).join("");

        // プレビュー用サンプル置換
        let preview = msgValue;
        vars.forEach(v => {
          preview = preview.replace(new RegExp(`\\{${v.name}\\}`, "g"), v.sample);
        });

        return `
          <div class="notify-channel-card">
            <div class="d-flex justify-content-between align-items-start">
              <div class="flex-grow-1">
                <div class="d-flex align-items-center gap-2 mb-1" style="cursor:pointer;" data-notify-toggle="${n.key}">
                  <i class="bi bi-chevron-right notify-chevron" data-key="${n.key}" style="transition:transform 0.2s;"></i>
                  <i class="bi ${n.icon} text-primary"></i>
                  <strong>${n.label}</strong>
                </div>
                <div class="notify-collapse" data-key="${n.key}" style="display:none;">
                <div class="text-muted small mb-2">${n.desc}</div>

                <div class="d-flex flex-wrap gap-3 mb-2">
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;" title="送信元: settings/notifications.lineChannelToken の LINE Bot (Bot 名はこのページ上部「送信元」セクション参照)">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="ownerLine" ${ownerLine ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-person-circle text-success"></i> Webアプリ管理者LINE <span class="text-muted" style="font-size:0.75em;">(送信元: LINE Bot)</span></span>
                  </label>
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;" title="送信元: 該当物件の properties.lineChannels[].name の Bot (物件別)">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="groupLine" ${groupLine ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-people-fill text-primary"></i> グループLINE <span class="text-muted" style="font-size:0.75em;">(送信元: 物件別 LINE Bot)</span></span>
                  </label>
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;" title="送信元: 共通 LINE Bot (Webアプリ管理者と同じ)">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="staffLine" ${staffLine ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-person-lines-fill text-info"></i> スタッフ個別LINE <span class="text-muted" style="font-size:0.75em;">(送信元: LINE Bot)</span></span>
                  </label>
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;" title="送信元: 共通 LINE Bot (Webアプリ管理者と同じ)">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="subOwnerLine" ${(ch.subOwnerLine) ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-person-badge text-success"></i> 物件オーナー個別LINE <span class="text-muted" style="font-size:0.75em;">(送信元: LINE Bot)</span></span>
                  </label>
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;" title="送信元: settings/gmailOAuth/tokens の先頭アカウント (連携済み Gmail)">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="ownerEmail" ${ownerEmail ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-envelope text-warning"></i> Webアプリ管理者メール <span class="text-muted" style="font-size:0.75em;">(送信元: 連携済み Gmail)</span></span>
                  </label>
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;" title="送信元: 該当物件オーナーの Gmail (連携済み) / 未連携ならフォールバック">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="subOwnerEmail" ${(ch.subOwnerEmail) ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-envelope-at text-success"></i> 物件オーナー個別メール <span class="text-muted" style="font-size:0.75em;">(送信元: 物件オーナーの Gmail)</span></span>
                  </label>
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;" title="送信元: 連携済み Gmail (Webアプリ管理者メールと同じ)">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="staffEmail" ${(ch.staffEmail) ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-envelope-fill text-info"></i> スタッフ個別メール <span class="text-muted" style="font-size:0.75em;">(送信元: 連携済み Gmail)</span></span>
                  </label>
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;" title="送信元: Discord Webhook の Bot (Discord 側で Bot 名/アイコン設定)">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="discordOwner" ${discordOwner ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-discord" style="color:#5865F2"></i> Discord(Webアプリ管理者) <span class="text-muted" style="font-size:0.75em;">(送信元: Discord Bot)</span></span>
                  </label>
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;" title="送信元: Discord Webhook の Bot (Discord 側で Bot 名/アイコン設定)">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="discordSubOwner" ${discordSubOwner ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-discord" style="color:#8da0f8"></i> Discord(物件オーナー) <span class="text-muted" style="font-size:0.75em;">(送信元: Discord Bot)</span></span>
                  </label>
                  <!-- FCM (Web Push) は将来再検討。現時点で iOS 制約により導入保留のため非表示。 -->
                  <label class="form-check form-check-inline mb-0 d-none" style="cursor:pointer;">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="fcmStaff" ${fcmStaff ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-bell-fill text-primary"></i> Web Push(スタッフ)</span>
                  </label>
                  <label class="form-check form-check-inline mb-0 d-none" style="cursor:pointer;">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="fcmOwner" ${fcmOwner ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-bell text-success"></i> Web Push(Webアプリ管理者)</span>
                  </label>
                </div>

                <!-- 通知タイミング設定 (複数) -->
                <div class="mb-2 notify-timings-wrap" data-key="${n.key}">
                  <div class="small text-muted mb-1"><i class="bi bi-clock"></i> 通知タイミング (複数追加可能)</div>
                  <div class="notify-timings" data-key="${n.key}">
                    ${timings.map((t, idx) => this.renderTimingRow(n.key, t, idx)).join("")}
                  </div>
                  <button type="button" class="btn btn-sm btn-outline-primary mt-1 notify-add-timing" data-key="${n.key}">
                    <i class="bi bi-plus"></i> タイミングを追加
                  </button>
                </div>

                <!-- 利用可能な変数（クリックで挿入） -->
                <div class="mb-2">
                  <span class="small text-muted">変数（クリックで挿入）:</span>
                  <div class="d-flex flex-wrap mt-1">${varTags}</div>
                </div>

                <!-- メッセージ + プレビュー -->
                <div class="row g-2 mb-2">
                  <div class="col-md-6">
                    <label class="form-label small text-muted mb-1"><i class="bi bi-pencil"></i> メッセージ</label>
                    <textarea class="form-control form-control-sm notify-msg-input"
                              rows="5"
                              data-key="${n.key}"
                              data-var-group="${n.varGroup}"
                              data-field="customMessage">${msgValue}</textarea>
                  </div>
                  <div class="col-md-6">
                    <label class="form-label small text-muted mb-1"><i class="bi bi-eye"></i> プレビュー</label>
                    <div class="notify-preview border rounded p-2 bg-light small" data-preview="${n.key}" style="white-space:pre-wrap;min-height:130px;font-size:0.85rem;">${preview}</div>
                  </div>
                </div>

                <button class="btn btn-sm btn-outline-primary btn-test-send" type="button"
                        data-key="${n.key}" data-var-group="${n.varGroup}">
                  <i class="bi bi-send"></i> テスト送信
                </button>
                </div><!-- /notify-collapse -->
              </div>

              <div class="form-check form-switch notify-toggle ms-3">
                <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="enabled" ${enabled ? "checked" : ""}>
              </div>
            </div>
          </div>`;
      }).join("");

      // イベント委譲
      container.addEventListener("click", (e) => {
        // 折り畳みトグル
        const toggler = e.target.closest("[data-notify-toggle]");
        if (toggler && !e.target.closest("input") && !e.target.closest("button")) {
          const key = toggler.dataset.notifyToggle;
          const body = container.querySelector(`.notify-collapse[data-key="${key}"]`);
          const chev = container.querySelector(`.notify-chevron[data-key="${key}"]`);
          if (body) {
            const isOpen = body.style.display !== "none";
            body.style.display = isOpen ? "none" : "";
            if (chev) chev.style.transform = isOpen ? "rotate(0deg)" : "rotate(90deg)";
          }
          return;
        }
        // テスト送信
        const btn = e.target.closest(".btn-test-send");
        if (btn) this.sendTestNotification(btn);
        // 変数タグクリック → textarea に挿入
        const tag = e.target.closest(".var-insert-tag");
        if (tag) {
          const targetKey = tag.dataset.target;
          const ta = container.querySelector(`textarea[data-key="${targetKey}"]`);
          if (ta) {
            const pos = ta.selectionStart || ta.value.length;
            ta.value = ta.value.slice(0, pos) + tag.dataset.var + ta.value.slice(pos);
            ta.focus();
            ta.selectionStart = ta.selectionEnd = pos + tag.dataset.var.length;
            this.updatePreview(targetKey);
          }
        }
      });

      // textarea入力時プレビュー更新
      container.addEventListener("input", (e) => {
        if (e.target.classList.contains("notify-msg-input")) {
          this.updatePreview(e.target.dataset.key);
        }
      });

      // タイミング関連の表示切替 (data-key + data-idx 単位)
      container.addEventListener("change", (e) => {
        const key = e.target.dataset.key;
        const idx = e.target.dataset.idx;
        if (!key || idx === undefined) return;
        const row = container.querySelector(`.notify-timing-row[data-key="${key}"][data-idx="${idx}"]`);
        if (!row) return;

        if (e.target.classList.contains("notify-mode-radio")) {
          const mode = e.target.value;
          const eventBlock = row.querySelector(".notify-mode-event");
          const dateBlock = row.querySelector(".notify-mode-date");
          if (eventBlock) {
            eventBlock.classList.toggle("d-flex", mode === "event");
            eventBlock.classList.toggle("d-none", mode !== "event");
          }
          if (dateBlock) {
            dateBlock.classList.toggle("d-flex", mode === "date");
            dateBlock.classList.toggle("d-none", mode !== "date");
          }
        }

        if (e.target.classList.contains("notify-timing-select")) {
          const val = e.target.value;
          row.querySelector(".notify-timing-minutes")?.classList.toggle("d-none", val !== "custom");
          row.querySelector(".notify-before-days")?.classList.toggle("d-none", val !== "beforeEvent");
          row.querySelector(".notify-before-suffix")?.classList.toggle("d-none", val !== "beforeEvent");
          row.querySelector(".notify-before-time")?.classList.toggle("d-none", val !== "beforeEvent");
        }

        if (e.target.classList.contains("notify-schedule-pattern")) {
          const val = e.target.value;
          row.querySelector(".notify-schedule-day")?.classList.toggle("d-none", val !== "monthlyDay");
          row.querySelector(".notify-schedule-dow")?.classList.toggle("d-none", val !== "weekly");
        }
      });

      // タイミング追加・削除
      container.addEventListener("click", (e) => {
        const addBtn = e.target.closest(".notify-add-timing");
        if (addBtn) {
          const key = addBtn.dataset.key;
          const list = container.querySelector(`.notify-timings[data-key="${key}"]`);
          if (!list) return;
          const idx = list.querySelectorAll(".notify-timing-row").length;
          const emptyT = { mode: "event", timing: "immediate", timingMinutes: "", beforeDays: 3, beforeTime: "09:00", schedulePattern: "monthEnd", scheduleDay: 1, scheduleDow: 0, scheduleTime: "09:00" };
          list.insertAdjacentHTML("beforeend", this.renderTimingRow(key, emptyT, idx));
        }
        const rmBtn = e.target.closest(".notify-remove-timing");
        if (rmBtn) {
          const row = rmBtn.closest(".notify-timing-row");
          const list = row?.parentElement;
          row?.remove();
          // idx再採番
          list?.querySelectorAll(".notify-timing-row").forEach((r, i) => {
            r.dataset.idx = i;
            r.querySelectorAll("[data-idx]").forEach(el => el.dataset.idx = i);
          });
        }
      });
    }
  },

  // 通知タイミング1行を描画
  renderTimingRow(key, t, idx) {
    const mode = t.mode || "event";
    const timing = t.timing || "immediate";
    const showEventBlock = mode === "event";
    const showDateBlock = mode === "date";
    const showMinutes = showEventBlock && timing === "custom";
    const showBeforeEvent = showEventBlock && timing === "beforeEvent";
    const pat = t.schedulePattern || "monthEnd";
    return `
      <div class="notify-timing-row d-flex flex-wrap align-items-center gap-1 p-2 mb-1 border rounded" data-key="${key}" data-idx="${idx}">
        <div class="btn-group btn-group-sm" role="group">
          <input type="radio" class="btn-check notify-mode-radio" name="mode-${key}-${idx}" id="mode-event-${key}-${idx}" value="event" ${mode==="event"?"checked":""} data-key="${key}" data-idx="${idx}">
          <label class="btn btn-outline-secondary" for="mode-event-${key}-${idx}">都度</label>
          <input type="radio" class="btn-check notify-mode-radio" name="mode-${key}-${idx}" id="mode-date-${key}-${idx}" value="date" ${mode==="date"?"checked":""} data-key="${key}" data-idx="${idx}">
          <label class="btn btn-outline-secondary" for="mode-date-${key}-${idx}">日付</label>
        </div>

        <div class="notify-mode-event align-items-center gap-1 ${showEventBlock?"d-flex":"d-none"}" data-key="${key}" data-idx="${idx}">
          <select class="form-select form-select-sm notify-timing-select" style="width:auto;" data-key="${key}" data-idx="${idx}" data-field="timing">
            ${[["immediate","即時"],["5min","5分後"],["15min","15分後"],["30min","30分後"],["1hour","1時間後"],["morning","翌朝6時"],["evening","当日18時"],["custom","カスタム（分）"],["beforeEvent","N日前のHH:MM"]].map(([v,l]) => `<option value="${v}" ${timing===v?"selected":""}>${l}</option>`).join("")}
          </select>
          <input type="number" class="form-control form-control-sm notify-timing-minutes ${showMinutes?"":"d-none"}"
            style="width:90px;" data-key="${key}" data-idx="${idx}" data-field="timingMinutes"
            value="${t.timingMinutes||""}" min="1" placeholder="分数">
          <input type="number" class="form-control form-control-sm notify-before-days ${showBeforeEvent?"":"d-none"}"
            style="width:72px;" data-key="${key}" data-idx="${idx}" data-field="beforeDays"
            value="${t.beforeDays||3}" min="0" placeholder="日">
          <span class="small notify-before-suffix ${showBeforeEvent?"":"d-none"}" data-key="${key}" data-idx="${idx}">日前の</span>
          <input type="time" class="form-control form-control-sm notify-before-time ${showBeforeEvent?"":"d-none"}"
            style="width:110px;" data-key="${key}" data-idx="${idx}" data-field="beforeTime"
            value="${t.beforeTime||"09:00"}">
        </div>

        <div class="notify-mode-date align-items-center gap-1 ${showDateBlock?"d-flex":"d-none"}" data-key="${key}" data-idx="${idx}">
          <select class="form-select form-select-sm notify-schedule-pattern" style="width:auto;" data-key="${key}" data-idx="${idx}" data-field="schedulePattern">
            <option value="monthEnd" ${pat==="monthEnd"?"selected":""}>毎月 月末</option>
            <option value="monthlyDay" ${pat==="monthlyDay"?"selected":""}>毎月 N日</option>
            <option value="weekly" ${pat==="weekly"?"selected":""}>毎週 曜日</option>
            <option value="daily" ${pat==="daily"?"selected":""}>毎日</option>
          </select>
          <input type="number" class="form-control form-control-sm notify-schedule-day ${pat==="monthlyDay"?"":"d-none"}"
            style="width:70px;" data-key="${key}" data-idx="${idx}" data-field="scheduleDay"
            value="${t.scheduleDay||1}" min="1" max="31" placeholder="日">
          <select class="form-select form-select-sm notify-schedule-dow ${pat==="weekly"?"":"d-none"}"
            style="width:auto;" data-key="${key}" data-idx="${idx}" data-field="scheduleDow">
            ${["日","月","火","水","木","金","土"].map((d,i)=>`<option value="${i}" ${(t.scheduleDow||0)==i?"selected":""}>${d}</option>`).join("")}
          </select>
          <input type="time" class="form-control form-control-sm notify-schedule-time"
            style="width:110px;" data-key="${key}" data-idx="${idx}" data-field="scheduleTime"
            value="${t.scheduleTime||"09:00"}">
        </div>

        <button type="button" class="btn btn-sm btn-link text-danger ms-auto notify-remove-timing" data-key="${key}" data-idx="${idx}" title="このタイミングを削除">
          <i class="bi bi-x-circle"></i>
        </button>
      </div>
    `;
  },

  updatePreview(key) {
    const ta = document.querySelector(`textarea[data-key="${key}"][data-field="customMessage"]`);
    const el = document.querySelector(`[data-preview="${key}"]`);
    if (!ta || !el) return;
    const varGroup = ta.dataset.varGroup;
    const vars = this.systemVariables[varGroup] || [];
    let msg = ta.value || "";
    vars.forEach(v => {
      msg = msg.replace(new RegExp(`\\{${v.name}\\}`, "g"), v.sample);
    });
    el.textContent = msg;
  },

  async sendTestNotification(btn) {
    const key = btn.dataset.key;
    const varGroup = btn.dataset.varGroup;
    const ta = document.querySelector(`textarea[data-key="${key}"][data-field="customMessage"]`);
    const vars = this.systemVariables[varGroup] || [];

    // メッセージをサンプル値で置換してプレビュー用 body を作成
    let message = ta ? ta.value : "";
    vars.forEach(v => {
      message = message.replace(new RegExp(`\\{${v.name}\\}`, "g"), v.sample);
    });
    // バックエンドの resolveMessage_ で customMessage を再置換する時に使うサンプル値 map
    const sampleVars = {};
    vars.forEach(v => { sampleVars[v.name] = v.sample; });

    const get = (field) => {
      const el = document.querySelector(`[data-key="${key}"][data-field="${field}"]`);
      return el ? el.checked : false;
    };
    const targets = {
      ownerLine: get("ownerLine"),
      groupLine: get("groupLine"),
      staffLine: get("staffLine"),
      staffEmail: get("staffEmail"),
      ownerEmail: get("ownerEmail"),
      subOwnerLine: get("subOwnerLine"),
      subOwnerEmail: get("subOwnerEmail"),
      discordOwner: get("discordOwner"),
      discordSubOwner: get("discordSubOwner"),
      fcmStaff: get("fcmStaff"),
      fcmOwner: get("fcmOwner"),
    };

    if (!targets.ownerLine && !targets.groupLine && !targets.staffLine && !targets.staffEmail && !targets.ownerEmail && !targets.subOwnerLine && !targets.subOwnerEmail && !targets.discordOwner && !targets.discordSubOwner && !targets.fcmStaff && !targets.fcmOwner) {
      showToast("エラー", "送信先を1つ以上チェックしてください", "error");
      return;
    }

    btn.disabled = true;
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 送信中...';

    try {
      const token = await firebase.auth().currentUser.getIdToken();
      const res = await fetch(this.TEST_API_URL, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ type: key, message: `【テスト】${message}`, targets, vars: sampleVars }),
      });
      const data = await res.json();
      if (res.ok) {
        // チャネル別に成功/失敗を集計
        const successes = [];  // ラベル(例: Webアプリ管理者LINE)
        const errs = [];       // { label, reason }
        const labelMap = { ownerLine: "Webアプリ管理者LINE", groupLine: "グループLINE", staffLine: "スタッフ個別LINE", staffEmail: "スタッフ個別メール", ownerEmail: "Webアプリ管理者メール", subOwnerLine: "物件オーナー個別LINE", subOwnerEmail: "物件オーナー個別メール", discordOwner: "Discord(Webアプリ管理者)", discordSubOwner: "Discord(物件オーナー)", fcmStaff: "Web Push(スタッフ)", fcmOwner: "Web Push(Webアプリ管理者)" };
        for (const r of (data.results || [])) {
          const label = labelMap[r.target] || r.target;
          if (Array.isArray(r.staffResults)) {
            r.staffResults.forEach(s => {
              if (s.success) successes.push(`${label}(${s.staffName})`);
              else errs.push({ label: `${label}:${s.staffName}`, reason: this._friendlyError(s.error) });
            });
            // staffLine 全体にエラーがある場合も追加
            if (r.error && !r.staffResults.length) errs.push({ label, reason: this._friendlyError(r.error) });
          } else if (r.success === true) {
            successes.push(label);
          } else if (r.success === false) {
            errs.push({ label, reason: this._friendlyError(r.error) });
          }
        }
        // トーストを分割表示 (成功+エラー両方)
        if (successes.length) {
          showToast("送信成功", `${successes.length}件: ${successes.join(", ")}`, "success");
        }
        if (errs.length) {
          const msg = errs.map(e => `• ${e.label}: ${e.reason}`).join("\n");
          showToast("送信失敗", msg, "error");
        }
        if (!successes.length && !errs.length) {
          showToast("送信失敗", "どの送信先も処理されませんでした", "error");
        }
        if (errs.length) console.warn("テスト送信エラー詳細:", errs);
      } else {
        showToast("エラー", data.error || "送信に失敗しました", "error");
      }
    } catch (e) {
      showToast("エラー", e.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  },

  async saveSettings(opts = {}) {
    try {
      // Phase A: 共有コンポーネントから値を読み取る
      const channels = {};
      this.notifications.forEach(n => {
        // ページ全体スコープで読み取り (idPrefix なし = 通知設定タブの既定構成)
        channels[n.key] = window.NotifyChannelEditor.readChannelValue(document, n.key, { idPrefix: "" });
      });

      // ownerLineChannels を収集
      const ownerLineChannels = [];
      document.querySelectorAll("#ownerLineChannelsList .owner-line-channel-row").forEach(row => {
        const token = (row.querySelector(".owner-line-ch-token")?.value || "").trim();
        const userId = (row.querySelector(".owner-line-ch-userId")?.value || "").trim();
        const name = (row.querySelector(".owner-line-ch-name")?.value || "").trim();
        if (token || userId) {
          ownerLineChannels.push({ token, userId, name });
        }
      });

      const data = {
        lineChannelToken: document.getElementById("lineChannelToken").value.trim(),
        lineGroupId: document.getElementById("lineGroupId").value.trim(),
        lineOwnerUserId: document.getElementById("lineOwnerUserId").value.trim(),
        ownerEmail: document.getElementById("ownerEmail").value.trim(),
        discordOwnerWebhookUrl: (document.getElementById("discordOwnerWebhookUrl")?.value || "").trim(),
        discordSubOwnerWebhookUrl: (document.getElementById("discordSubOwnerWebhookUrl")?.value || "").trim(),
        ownerLineChannels,
        ownerLineChannelStrategy: document.getElementById("ownerLineChannelStrategy")?.value || "fallback",
        enableLine: true,
        channels,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };

      await db.collection("settings").doc("notifications").set(data, { merge: true });
      this.settings = { ...this.settings, ...data };
      if (opts && opts.silent) {
        this._showAutoSaveIndicator("saved");
      } else {
        showToast("成功", "通知設定を保存しました", "success");
      }
    } catch (e) {
      if (opts && opts.silent) {
        this._showAutoSaveIndicator("error", e.message);
      } else {
        showToast("エラー", e.message, "error");
      }
    }
  },

  // 自動保存の状態表示 (ヘッダーの保存ボタン横に小さく)
  _showAutoSaveIndicator(state, msg) {
    const el = document.getElementById("notifyAutoSaveStatus");
    if (!el) return;
    if (state === "saving") {
      el.innerHTML = `<span class="text-muted small"><i class="bi bi-arrow-repeat spin"></i> 保存中…</span>`;
    } else if (state === "saved") {
      el.innerHTML = `<span class="text-success small"><i class="bi bi-check-circle-fill"></i> 保存済み</span>`;
      // 3秒後にフェードアウト
      setTimeout(() => { if (el.innerHTML.includes("保存済み")) el.innerHTML = ""; }, 3000);
    } else if (state === "error") {
      el.innerHTML = `<span class="text-danger small"><i class="bi bi-exclamation-triangle"></i> 保存失敗: ${this._escapeHtml(msg || "")}</span>`;
    } else {
      el.innerHTML = "";
    }
  },

  _escapeHtml(s) {
    const d = document.createElement("div"); d.textContent = String(s || ""); return d.innerHTML;
  },

  // エラーメッセージを日本語で分かりやすく翻訳
  _friendlyError(err) {
    const s = String(err || "");
    if (/429.*monthly/i.test(s)) return "LINE月間送信上限到達";
    if (/429/.test(s)) return "LINEレート制限(429)";
    if (/invalid_grant/.test(s)) return "Gmail認証失効 → Gmail再接続ボタンを押してください";
    if (/Gmail OAuth/i.test(s) || /gmailOAuth/.test(s)) return "Gmail未設定";
    if (/LINEチャネルトークン未設定/.test(s)) return "LINE設定未入力(チャネルトークン)";
    if (/\u30aa\u30fc\u30ca\u30fcLINE User ID\u672a\u8a2d\u5b9a/.test(s) || /Owner.*User ID/i.test(s)) return "Webアプリ管理者LINE User ID 未設定";
    if (/LINE\u30b0\u30eb\u30fc\u30d7ID \u672a\u8a2d\u5b9a/.test(s)) return "LINEグループID未設定";
    if (/LINE\u672a\u9023\u643a/.test(s)) return "このスタッフはLINE未連携";
    if (/\u30aa\u30fc\u30ca\u30fc\u30e1\u30fc\u30eb\u30a2\u30c9\u30ec\u30b9\u672a\u8a2d\u5b9a/.test(s)) return "Webアプリ管理者メールアドレス未入力";
    if (/401|Unauthorized/.test(s)) return "認証エラー(ログインし直してください)";
    if (/fetch|network|ENOTFOUND/i.test(s)) return "ネットワークエラー";
    return s.slice(0, 160);
  },

  // ページ全体の input/change イベントを監視して debounced で自動保存
  _setupAutoSave() {
    if (this._autoSaveAttached) return;
    this._autoSaveAttached = true;
    const container = document.getElementById("pageContainer") || document.body;
    const debouncedSave = () => {
      this._showAutoSaveIndicator("saving");
      if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
      this._autoSaveTimer = setTimeout(() => {
        this.saveSettings({ silent: true });
      }, 800);
    };
    container.addEventListener("input", (e) => {
      // button や non-data 要素からの input イベントは無視
      const t = e.target;
      if (!t) return;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") {
        debouncedSave();
      }
    });
    container.addEventListener("change", (e) => {
      const t = e.target;
      if (!t) return;
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") {
        debouncedSave();
      }
    });
  },
};
