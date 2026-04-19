/**
 * 通知設定ページ
 * 各通知の有効/無効・送り先・メッセージテンプレート・プレビュー・テスト送信
 */
const NotificationsPage = {
  settings: {},

  // テスト送信APIエンドポイント
  TEST_API_URL: "https://api-5qrfx7ujcq-an.a.run.app/notifications/test",

  // ========== システム定義変数 ==========
  // 通知種別ごとに利用可能な変数を定義
  // source: 実送信時にどのデータから取得するかの説明
  systemVariables: {
    // 募集系で使える変数
    recruit: [
      { name: "date",     label: "作業日",        sample: "2026/04/20",  source: "recruitment.checkoutDate" },
      { name: "property", label: "物件名",        sample: "長浜民泊A",    source: "recruitment.propertyName" },
      { name: "work",     label: "作業内容",      sample: "清掃",         source: "recruitment.workType (清掃 / 直前点検)" },
      { name: "url",      label: "回答ページURL", sample: "https://minpaku-v2.web.app/#/my-recruitment", source: "自動生成" },
      { name: "count",    label: "回答数",        sample: "3",           source: "recruitment.responses.length" },
      { name: "staff",    label: "確定スタッフ名", sample: "山田太郎",    source: "recruitment.selectedStaff" },
      { name: "memo",     label: "メモ",          sample: "BBQ後の片付けあり", source: "recruitment.memo" },
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

  // 通知種別ごとに使えるグループを紐付け
  notifications: [
    { key: "recruit_start", label: "作業スタッフ募集", desc: "新しい清掃/直前点検に対してスタッフへ募集通知を送信", icon: "bi-megaphone", group: "recruit", varGroup: "recruit", defaultTiming: "immediate",
      defaultMsg: "🧹 {work}スタッフ募集\n\n{date} {property}\n{work}スタッフを募集しています。\n回答をお願いします（◎OK / △微妙 / ×NG）\n\n回答: {url}" },
    { key: "recruit_remind", label: "募集リマインド", desc: "回答が集まらない場合にリマインド送信", icon: "bi-alarm", group: "recruit", varGroup: "recruit", defaultTiming: "evening",
      defaultMsg: "📋 {work}募集 回答のお願い\n\n{date} {property}\nまだ回答が届いていません（現在{count}件）。\n回答: {url}" },
    { key: "staff_confirm", label: "スタッフ確定通知", desc: "スタッフ確定時に本人とオーナーに通知", icon: "bi-person-check", group: "recruit", varGroup: "recruit", defaultTiming: "immediate",
      defaultMsg: "✅ {work}担当が確定しました\n\n{date} {property}\n担当: {staff}\nよろしくお願いします。" },
    { key: "staff_undecided", label: "スタッフ未決定リマインド", desc: "作業日が近いのにスタッフ未確定の場合にオーナーへ通知", icon: "bi-exclamation-triangle", group: "recruit", varGroup: "recruit", defaultTiming: "morning",
      defaultMsg: "⚠️ {work}スタッフ未確定\n\n{date} {property}\n作業日が近づいていますが、まだスタッフが確定していません。\n回答状況: {count}件" },
    { key: "urgent_remind", label: "直前予約リマインド", desc: "直前予約に対する緊急リマインド", icon: "bi-lightning", group: "recruit", varGroup: "recruit", defaultTiming: "immediate",
      defaultMsg: "🔴 緊急: 直前予約の{work}手配\n\n{date} {property}\n直前予約が入りました。至急スタッフの手配をお願いします。" },
    { key: "booking_cancel", label: "予約キャンセル通知", desc: "予約がキャンセルされた場合に通知", icon: "bi-x-circle", group: "booking", varGroup: "booking", defaultTiming: "immediate",
      defaultMsg: "❌ 予約キャンセル\n\n{checkin}〜{date} {property}\nゲスト: {guest}（{site}）\n予約がキャンセルされました。" },
    { key: "booking_change", label: "予約変更通知", desc: "予約日程が変更された場合に通知", icon: "bi-arrow-repeat", group: "booking", varGroup: "booking", defaultTiming: "immediate",
      defaultMsg: "🔄 予約変更\n\n{property}\n新しい日程: {checkin}〜{date}（{nights}泊）\nゲスト: {guest}" },
    { key: "cancel_request", label: "出勤キャンセル要望", desc: "スタッフからの出勤キャンセル要望をオーナーに通知", icon: "bi-person-dash", group: "staff", varGroup: "staff", defaultTiming: "immediate",
      defaultMsg: "🙋 出勤キャンセル要望\n\n{staff}さんから{date} {property}の出勤キャンセル要望がありました。" },
    { key: "cancel_approve", label: "キャンセル承認通知", desc: "出勤キャンセルを承認した場合にスタッフに通知", icon: "bi-check-circle", group: "staff", varGroup: "staff", defaultTiming: "immediate",
      defaultMsg: "✅ キャンセル承認\n\n{date} {property}の出勤キャンセルが承認されました。" },
    { key: "cancel_reject", label: "キャンセル却下通知", desc: "出勤キャンセルを却下した場合にスタッフに通知", icon: "bi-dash-circle", group: "staff", varGroup: "staff", defaultTiming: "immediate",
      defaultMsg: "❌ キャンセル不可\n\n{date} {property}の出勤キャンセルは対応できませんでした。出勤をお願いします。" },
    { key: "staff_inactive", label: "スタッフ非アクティブ化通知", desc: "直近15回の募集に無回答のスタッフを非アクティブ化した時にオーナーへ通知", icon: "bi-person-slash", group: "staff", varGroup: "staff", defaultTiming: "immediate",
      defaultMsg: "⚠️ スタッフ非アクティブ化\n\n{staff} さんを非アクティブに変更しました。\n理由: {reason}\n解除はスタッフ管理から行えます。" },
    { key: "roster_remind", label: "名簿未入力リマインド", desc: "宿泊者名簿が未入力の予約についてリマインド", icon: "bi-person-vcard", group: "booking", varGroup: "booking", defaultTiming: "morning",
      defaultMsg: "📝 名簿入力のお願い\n\n{checkin} {property}\nゲスト: {guest}\n宿泊者名簿がまだ届いていません。" },
    { key: "roster_received", label: "宿泊者名簿 受信通知", desc: "宿泊者名簿のフォーム回答が届いた時にオーナー等へ通知", icon: "bi-envelope-check", group: "booking", varGroup: "booking", defaultTiming: "immediate",
      defaultMsg: "📨 宿泊者名簿が届きました\n\n{checkin} {property}\nゲスト: {guest}\n詳細: {url}" },
    { key: "invoice_request", label: "請求書要請", desc: "月末にスタッフへ請求書の提出を依頼（URLは請求書作成ページ）", icon: "bi-receipt", group: "invoice", varGroup: "invoice", defaultTiming: "morning",
      defaultMsg: "💰 {month}月分の請求書作成をお願いします\n\n作業明細をご確認の上、請求書の送信をお願いします。\n作成ページ: {url}" },
    { key: "invoice_submitted", label: "請求書提出通知", desc: "スタッフが請求書を送信した時にオーナーへ通知", icon: "bi-send-check", group: "invoice", varGroup: "invoice", defaultTiming: "immediate",
      defaultMsg: "📨 請求書が提出されました\n\n{staff} さんから {month}月分の請求書が届きました。\n合計: {total}\n確認: {url}" },
    { key: "cleaning_done", label: "清掃完了通知", desc: "清掃チェックリスト完了時にオーナーに通知", icon: "bi-clipboard-check", group: "cleaning", varGroup: "cleaning", defaultTiming: "immediate",
      defaultMsg: "✨ 清掃完了\n\n{date} {property}\n{staff}さんが{time}に清掃を完了しました。\n詳細: {url}" },
    { key: "laundry_put_out", label: "ランドリー 出した", desc: "スタッフが「洗濯物を出した」ボタンを押した時にオーナー等へ通知", icon: "bi-arrow-up-circle", group: "cleaning", varGroup: "laundry", defaultTiming: "immediate",
      defaultMsg: "🧺 ランドリー 出した\n\n{date} {property}\n{staff}さんが{time}に洗濯物を出しました。\n詳細: {url}" },
    { key: "laundry_collected", label: "ランドリー 回収した", desc: "スタッフが「洗濯物を回収した」ボタンを押した時にオーナー等へ通知", icon: "bi-arrow-down-circle", group: "cleaning", varGroup: "laundry", defaultTiming: "immediate",
      defaultMsg: "🧺 ランドリー 回収した\n\n{date} {property}\n{staff}さんが{time}に洗濯物を回収しました。\n詳細: {url}" },
    { key: "laundry_stored", label: "ランドリー 収納した", desc: "スタッフが「洗濯物を収納した」ボタンを押した時にオーナー等へ通知", icon: "bi-check2-circle", group: "cleaning", varGroup: "laundry", defaultTiming: "immediate",
      defaultMsg: "🧺 ランドリー 収納した\n\n{date} {property}\n{staff}さんが{time}に洗濯物を収納しました。\n詳細: {url}" },
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

      <!-- オーナー個別通知先 -->
      <div class="card mb-4">
        <div class="card-header">
          <h6 class="mb-0"><i class="bi bi-person-gear"></i> オーナー個別通知先</h6>
        </div>
        <div class="card-body">
          <div class="row g-3">
            <div class="col-md-6">
              <label class="form-label">オーナーLINE User ID</label>
              <input type="text" class="form-control" id="lineOwnerUserId" placeholder="Uxxxxxx...">
              <div class="form-text">オーナー宛の個別通知に使用 (物件LINEの Bot を友達追加すると自動取得)</div>
            </div>
            <div class="col-md-6">
              <label class="form-label">オーナーメールアドレス</label>
              <div class="input-group">
                <input type="email" class="form-control" id="ownerEmail" placeholder="owner@example.com">
                <button class="btn btn-outline-warning" type="button" id="btnGmailReauth" title="Gmail OAuth 再接続">
                  <i class="bi bi-shield-check"></i> Gmail再接続
                </button>
              </div>
              <div class="form-text">メール通知の送信先。送信時 invalid_grant エラーが出たら「Gmail再接続」を押してください。</div>
            </div>
            <div class="col-md-6">
              <label class="form-label">Discord (オーナー) Webhook URL</label>
              <input type="url" class="form-control" id="discordOwnerWebhookUrl" placeholder="https://discord.com/api/webhooks/...">
              <div class="form-text">Discord サーバー → チャンネル設定 → 連携サービス → Webhook で作成</div>
            </div>
            <div class="col-md-6">
              <label class="form-label">Discord (サブオーナー) Webhook URL</label>
              <input type="url" class="form-control" id="discordSubOwnerWebhookUrl" placeholder="https://discord.com/api/webhooks/...">
              <div class="form-text">サブオーナー共有チャンネルの Webhook URL</div>
            </div>
          </div>
          <!-- 旧データ後方互換用 (画面には表示しないが値を保持・保存) -->
          <input type="hidden" id="lineChannelToken">
          <input type="hidden" id="lineGroupId">
        </div>
      </div>

      <!-- 通知チャンネル設定 -->
      <h5 class="mb-3">通知チャンネル設定</h5>
      <p class="text-muted small mb-3">各通知の有効/無効と送り先を設定します。送り先は複数選択可能です。</p>

      <div class="d-flex flex-wrap gap-3 mb-3 small text-muted">
        <span><i class="bi bi-person-circle text-success"></i> オーナーLINE</span>
        <span><i class="bi bi-people-fill text-primary"></i> グループLINE</span>
        <span><i class="bi bi-person-lines-fill text-info"></i> スタッフ個別LINE</span>
        <span><i class="bi bi-envelope text-warning"></i> オーナーメール</span>
        <span><i class="bi bi-discord" style="color:#5865F2"></i> Discord(オーナー)</span>
        <span><i class="bi bi-discord" style="color:#8da0f8"></i> Discord(サブオーナー)</span>
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
    `;

    await this.loadSettings();
    this.renderNotifications();
    // 自動保存をセットアップ (各入力の change/input で debounced 保存)
    this._setupAutoSave();
    // Gmail 再認証ボタン
    document.getElementById("btnGmailReauth").addEventListener("click", () => {
      const email = (document.getElementById("ownerEmail").value || "").trim();
      if (!email) {
        showToast("エラー", "先にオーナーメールアドレスを入力してください", "error");
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
  },

  renderNotifications() {
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
        const enabled = ch.enabled !== false;
        const ownerLine = ch.ownerLine !== false;
        const groupLine = !!ch.groupLine;
        const staffLine = !!ch.staffLine;
        const ownerEmail = !!ch.ownerEmail;
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
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="ownerLine" ${ownerLine ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-person-circle text-success"></i> オーナーLINE</span>
                  </label>
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="groupLine" ${groupLine ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-people-fill text-primary"></i> グループLINE</span>
                  </label>
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="staffLine" ${staffLine ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-person-lines-fill text-info"></i> スタッフ個別LINE</span>
                  </label>
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="ownerEmail" ${ownerEmail ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-envelope text-warning"></i> オーナーメール</span>
                  </label>
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="discordOwner" ${discordOwner ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-discord" style="color:#5865F2"></i> Discord(オーナー)</span>
                  </label>
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="discordSubOwner" ${discordSubOwner ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-discord" style="color:#8da0f8"></i> Discord(サブオーナー)</span>
                  </label>
                  <!-- FCM (Web Push) は将来再検討。現時点で iOS 制約により導入保留のため非表示。 -->
                  <label class="form-check form-check-inline mb-0 d-none" style="cursor:pointer;">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="fcmStaff" ${fcmStaff ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-bell-fill text-primary"></i> Web Push(スタッフ)</span>
                  </label>
                  <label class="form-check form-check-inline mb-0 d-none" style="cursor:pointer;">
                    <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="fcmOwner" ${fcmOwner ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-bell text-success"></i> Web Push(オーナー)</span>
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
      ownerEmail: get("ownerEmail"),
      fcmStaff: get("fcmStaff"),
      fcmOwner: get("fcmOwner"),
    };

    if (!targets.ownerLine && !targets.groupLine && !targets.staffLine && !targets.ownerEmail && !targets.fcmStaff && !targets.fcmOwner) {
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
        const successes = [];  // ラベル(例: オーナーLINE)
        const errs = [];       // { label, reason }
        const labelMap = { ownerLine: "オーナーLINE", groupLine: "グループLINE", staffLine: "スタッフ個別LINE", ownerEmail: "オーナーメール", fcmStaff: "Web Push(スタッフ)", fcmOwner: "Web Push(オーナー)" };
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
      const channels = {};
      this.notifications.forEach(n => {
        const get = (field) => {
          const el = document.querySelector(`[data-key="${n.key}"][data-field="${field}"]`);
          return el ? el.checked : false;
        };
        const ta = document.querySelector(`textarea[data-key="${n.key}"][data-field="customMessage"]`);
        // タイミング配列を収集
        const rows = document.querySelectorAll(`.notify-timings[data-key="${n.key}"] .notify-timing-row`);
        const timings = [];
        rows.forEach((row, idx) => {
          const modeChecked = row.querySelector(`input[name^="mode-${n.key}-"]:checked`);
          const mode = modeChecked ? modeChecked.value : "event";
          const q = (sel) => row.querySelector(sel);
          const t = { mode };
          if (mode === "event") {
            const timing = q(`select[data-field="timing"]`)?.value || "immediate";
            t.timing = timing;
            if (timing === "custom") {
              t.timingMinutes = parseInt(q(`input[data-field="timingMinutes"]`)?.value, 10) || 0;
            } else if (timing === "beforeEvent") {
              t.beforeDays = parseInt(q(`input[data-field="beforeDays"]`)?.value, 10) || 0;
              t.beforeTime = q(`input[data-field="beforeTime"]`)?.value || "09:00";
            }
          } else {
            t.schedulePattern = q(`select[data-field="schedulePattern"]`)?.value || "monthEnd";
            t.scheduleTime = q(`input[data-field="scheduleTime"]`)?.value || "09:00";
            if (t.schedulePattern === "monthlyDay") {
              t.scheduleDay = parseInt(q(`input[data-field="scheduleDay"]`)?.value, 10) || 1;
            } else if (t.schedulePattern === "weekly") {
              t.scheduleDow = parseInt(q(`select[data-field="scheduleDow"]`)?.value, 10) || 0;
            }
          }
          timings.push(t);
        });
        const entry = {
          enabled: get("enabled"),
          ownerLine: get("ownerLine"),
          groupLine: get("groupLine"),
          staffLine: get("staffLine"),
          ownerEmail: get("ownerEmail"),
          // FCM (Web Push) チャネル
          fcmStaff: get("fcmStaff"),
          fcmOwner: get("fcmOwner"),
          customMessage: ta ? ta.value : "",
          timings,            // 複数タイミング配列
        };
        // 後方互換: 旧UIの単一フィールドも代表値として埋める (undefinedは入れない)
        if (timings[0]) {
          const t0 = timings[0];
          if (t0.mode) entry.mode = t0.mode;
          if (t0.timing) entry.timing = t0.timing;
          if (t0.timingMinutes !== undefined) entry.timingMinutes = t0.timingMinutes;
          if (t0.beforeDays !== undefined) entry.beforeDays = t0.beforeDays;
          if (t0.beforeTime) entry.beforeTime = t0.beforeTime;
          if (t0.schedulePattern) entry.schedulePattern = t0.schedulePattern;
          if (t0.scheduleDay !== undefined) entry.scheduleDay = t0.scheduleDay;
          if (t0.scheduleDow !== undefined) entry.scheduleDow = t0.scheduleDow;
          if (t0.scheduleTime) entry.scheduleTime = t0.scheduleTime;
        }
        // 安全策: entryからundefinedを除去
        Object.keys(entry).forEach(k => { if (entry[k] === undefined) delete entry[k]; });
        channels[n.key] = entry;
      });

      const data = {
        lineChannelToken: document.getElementById("lineChannelToken").value.trim(),
        lineGroupId: document.getElementById("lineGroupId").value.trim(),
        lineOwnerUserId: document.getElementById("lineOwnerUserId").value.trim(),
        ownerEmail: document.getElementById("ownerEmail").value.trim(),
        discordOwnerWebhookUrl: (document.getElementById("discordOwnerWebhookUrl")?.value || "").trim(),
        discordSubOwnerWebhookUrl: (document.getElementById("discordSubOwnerWebhookUrl")?.value || "").trim(),
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
    if (/\u30aa\u30fc\u30ca\u30fcLINE User ID\u672a\u8a2d\u5b9a/.test(s) || /Owner.*User ID/i.test(s)) return "オーナーLINE User ID 未設定";
    if (/LINE\u30b0\u30eb\u30fc\u30d7ID \u672a\u8a2d\u5b9a/.test(s)) return "LINEグループID未設定";
    if (/LINE\u672a\u9023\u643a/.test(s)) return "このスタッフはLINE未連携";
    if (/\u30aa\u30fc\u30ca\u30fc\u30e1\u30fc\u30eb\u30a2\u30c9\u30ec\u30b9\u672a\u8a2d\u5b9a/.test(s)) return "オーナーメールアドレス未入力";
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
