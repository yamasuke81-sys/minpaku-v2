/**
 * 通知設定ページ
 * 13種類の通知ごとに有効/無効・送り先（オーナーLINE/グループLINE/スタッフ個別LINE/オーナーメール）を複数選択
 * LINE接続設定（チャネルアクセストークン・グループID）
 * カスタムメッセージ編集・テスト送信機能付き
 */
const NotificationsPage = {
  settings: {},

  // テスト送信APIエンドポイント
  TEST_API_URL: "https://api-5qrfx7ujcq-an.a.run.app/notifications/test",

  // 通知の定義（desc: 設定画面の説明、defaultMsg: 実際に送信されるデフォルトメッセージ）
  // {date} {property} {staff} {guest} {month} は送信時に実データで置換される
  notifications: [
    { key: "recruit_start", label: "清掃スタッフ募集", desc: "新しい清掃予定に対してスタッフへ募集通知を送信", icon: "bi-megaphone", group: "recruit",
      defaultMsg: "🧹 清掃スタッフ募集\n\n{date} {property}\n清掃スタッフを募集しています。\n回答をお願いします（◎OK / △微妙 / ×NG）" },
    { key: "recruit_remind", label: "募集リマインド", desc: "回答が集まらない場合にリマインド送信", icon: "bi-alarm", group: "recruit",
      defaultMsg: "📋 募集回答のお願い\n\n{date} {property}\nまだ回答が届いていません。\n都合を確認して回答をお願いします。" },
    { key: "staff_confirm", label: "スタッフ確定通知", desc: "スタッフ確定時に本人とオーナーに通知", icon: "bi-person-check", group: "recruit",
      defaultMsg: "✅ 清掃担当が確定しました\n\n{date} {property}\n担当: {staff}\nよろしくお願いします。" },
    { key: "staff_undecided", label: "スタッフ未決定リマインド", desc: "清掃日が近いのにスタッフ未確定の場合にオーナーへ通知", icon: "bi-exclamation-triangle", group: "recruit",
      defaultMsg: "⚠️ スタッフ未確定\n\n{date} {property}\n清掃日が近づいていますが、まだスタッフが確定していません。\n早急に対応をお願いします。" },
    { key: "urgent_remind", label: "直前予約リマインド", desc: "直前予約に対する緊急リマインド", icon: "bi-lightning", group: "recruit",
      defaultMsg: "🔴 緊急: 直前予約の清掃手配\n\n{date} {property}\n直前予約が入りました。至急清掃スタッフの手配をお願いします。" },
    { key: "booking_cancel", label: "予約キャンセル通知", desc: "予約がキャンセルされた場合にオーナー・スタッフに通知", icon: "bi-x-circle", group: "booking",
      defaultMsg: "❌ 予約キャンセル\n\n{date} {property}\nゲスト: {guest}\n予約がキャンセルされました。清掃予定の確認をお願いします。" },
    { key: "booking_change", label: "予約変更通知", desc: "予約日程が変更された場合に通知", icon: "bi-arrow-repeat", group: "booking",
      defaultMsg: "🔄 予約変更\n\n{property}\n日程が変更されました。\n新しい日程: {date}\n清掃スケジュールを確認してください。" },
    { key: "cancel_request", label: "出勤キャンセル要望", desc: "スタッフからの出勤キャンセル要望をオーナーに通知", icon: "bi-person-dash", group: "staff",
      defaultMsg: "🙋 出勤キャンセル要望\n\n{staff}さんから{date}の出勤キャンセル要望がありました。\n確認・対応をお願いします。" },
    { key: "cancel_approve", label: "キャンセル承認通知", desc: "出勤キャンセルを承認した場合にスタッフに通知", icon: "bi-check-circle", group: "staff",
      defaultMsg: "✅ キャンセル承認\n\n{date}の出勤キャンセルが承認されました。" },
    { key: "cancel_reject", label: "キャンセル却下通知", desc: "出勤キャンセルを却下した場合にスタッフに通知", icon: "bi-dash-circle", group: "staff",
      defaultMsg: "❌ キャンセル不可\n\n申し訳ありませんが、{date}の出勤キャンセルは対応できませんでした。\n出勤をお願いします。" },
    { key: "roster_remind", label: "名簿未入力リマインド", desc: "宿泊者名簿が未入力の予約についてリマインド", icon: "bi-person-vcard", group: "booking",
      defaultMsg: "📝 宿泊者名簿の入力をお願いします\n\n{date} {property}\nチェックイン予定のゲストの名簿がまだ届いていません。" },
    { key: "invoice_request", label: "請求書要請", desc: "月末にスタッフへ請求書の提出を依頼", icon: "bi-receipt", group: "invoice",
      defaultMsg: "💰 請求書のご確認をお願いします\n\n{month}月分の請求書を作成しました。\n内容を確認し、問題なければ「確認」ボタンを押してください。" },
    { key: "cleaning_done", label: "清掃完了通知", desc: "清掃チェックリスト完了時にオーナーに通知", icon: "bi-clipboard-check", group: "cleaning",
      defaultMsg: "✨ 清掃完了\n\n{date} {property}\n{staff}さんが清掃を完了しました。" },
  ],

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-bell"></i> 通知設定</h2>
        <button class="btn btn-primary" id="btnSaveNotifySettings"><i class="bi bi-check-lg"></i> 保存</button>
      </div>

      <!-- LINE接続設定 -->
      <div class="card mb-4">
        <div class="card-header">
          <h6 class="mb-0"><i class="bi bi-line"></i> LINE接続設定</h6>
        </div>
        <div class="card-body">
          <div class="row g-3">
            <div class="col-md-6">
              <label class="form-label">LINEチャネルアクセストークン</label>
              <input type="password" class="form-control" id="lineChannelToken" placeholder="チャネルアクセストークンを入力">
              <div class="form-text">LINE Developers → Messaging API → Channel access token</div>
            </div>
            <div class="col-md-6">
              <label class="form-label">LINEグループID</label>
              <input type="text" class="form-control" id="lineGroupId" placeholder="Cxxxxxx...">
              <div class="form-text">スタッフ全員が参加するLINEグループのID</div>
            </div>
            <div class="col-md-6">
              <label class="form-label">オーナーLINE User ID</label>
              <input type="text" class="form-control" id="lineOwnerUserId" placeholder="Uxxxxxx...">
              <div class="form-text">オーナー宛の個別通知に使用（Bot友達追加時に自動取得）</div>
            </div>
            <div class="col-md-6">
              <label class="form-label">オーナーメールアドレス</label>
              <input type="email" class="form-control" id="ownerEmail" placeholder="owner@example.com">
              <div class="form-text">メール通知の送信先</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 通知チャンネル設定 -->
      <h5 class="mb-3">通知チャンネル設定</h5>
      <p class="text-muted small mb-3">各通知の有効/無効と送り先を設定します。送り先は複数選択可能です。</p>

      <!-- 凡例 -->
      <div class="d-flex flex-wrap gap-3 mb-3 small text-muted">
        <span><i class="bi bi-person-circle text-success"></i> オーナーLINE</span>
        <span><i class="bi bi-people-fill text-primary"></i> グループLINE</span>
        <span><i class="bi bi-person-lines-fill text-info"></i> スタッフ個別LINE</span>
        <span><i class="bi bi-envelope text-warning"></i> オーナーメール</span>
      </div>

      <!-- 募集関連 -->
      <h6 class="text-muted mb-2"><i class="bi bi-megaphone"></i> 募集関連</h6>
      <div id="notifyGroup_recruit" class="mb-4"></div>

      <!-- 予約関連 -->
      <h6 class="text-muted mb-2"><i class="bi bi-calendar-event"></i> 予約関連</h6>
      <div id="notifyGroup_booking" class="mb-4"></div>

      <!-- スタッフ関連 -->
      <h6 class="text-muted mb-2"><i class="bi bi-people"></i> スタッフ関連</h6>
      <div id="notifyGroup_staff" class="mb-4"></div>

      <!-- 経理関連 -->
      <h6 class="text-muted mb-2"><i class="bi bi-receipt"></i> 経理関連</h6>
      <div id="notifyGroup_invoice" class="mb-4"></div>

      <!-- 清掃関連 -->
      <h6 class="text-muted mb-2"><i class="bi bi-clipboard-check"></i> 清掃関連</h6>
      <div id="notifyGroup_cleaning" class="mb-4"></div>
    `;

    this.bindEvents();
    await this.loadSettings();
    this.renderNotifications();
  },

  bindEvents() {
    document.getElementById("btnSaveNotifySettings").addEventListener("click", () => this.saveSettings());
  },

  async loadSettings() {
    try {
      const doc = await db.collection("settings").doc("notifications").get();
      this.settings = doc.exists ? doc.data() : {};
    } catch (e) {
      this.settings = {};
    }

    // UI反映（フォールバック対応: 旧フィールド名も読み取る）
    document.getElementById("lineChannelToken").value  = this.settings.lineChannelToken || this.settings.lineToken || "";
    document.getElementById("lineGroupId").value       = this.settings.lineGroupId || "";
    document.getElementById("lineOwnerUserId").value   = this.settings.lineOwnerUserId || this.settings.lineOwnerId || "";
    document.getElementById("ownerEmail").value        = this.settings.ownerEmail || "";
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
        const channels       = this.settings.channels || {};
        const ch             = channels[n.key] || {};
        const enabled        = ch.enabled !== false;
        const ownerLine      = ch.ownerLine !== false;
        const groupLine      = !!ch.groupLine;
        const staffLine      = !!ch.staffLine;
        const ownerEmail     = !!ch.ownerEmail;
        const customMessage  = ch.customMessage || "";
        const collapseId     = `msgCollapse_${n.key}`;

        return `
          <div class="notify-channel-card">
            <div class="d-flex justify-content-between align-items-start">
              <div class="flex-grow-1">
                <div class="d-flex align-items-center gap-2 mb-1">
                  <i class="bi ${n.icon} text-primary"></i>
                  <strong>${n.label}</strong>
                </div>
                <div class="text-muted small mb-2">${n.desc}</div>

                <!-- 送り先チェックボックス -->
                <div class="d-flex flex-wrap gap-3 mb-3">
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;">
                    <input class="form-check-input" type="checkbox"
                           data-key="${n.key}" data-field="ownerLine" ${ownerLine ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-person-circle text-success"></i> オーナーLINE</span>
                  </label>
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;">
                    <input class="form-check-input" type="checkbox"
                           data-key="${n.key}" data-field="groupLine" ${groupLine ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-people-fill text-primary"></i> グループLINE</span>
                  </label>
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;">
                    <input class="form-check-input" type="checkbox"
                           data-key="${n.key}" data-field="staffLine" ${staffLine ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-person-lines-fill text-info"></i> スタッフ個別LINE</span>
                  </label>
                  <label class="form-check form-check-inline mb-0" style="cursor:pointer;">
                    <input class="form-check-input" type="checkbox"
                           data-key="${n.key}" data-field="ownerEmail" ${ownerEmail ? "checked" : ""}>
                    <span class="form-check-label small"><i class="bi bi-envelope text-warning"></i> オーナーメール</span>
                  </label>
                </div>

                <!-- 送信メッセージ編集 + プレビュー -->
                <div class="row g-2 mb-2">
                  <div class="col-md-6">
                    <label class="form-label small text-muted mb-1"><i class="bi bi-pencil"></i> メッセージ</label>
                    <textarea class="form-control form-control-sm notify-msg-input"
                              rows="4"
                              data-key="${n.key}"
                              data-field="customMessage">${customMessage || n.defaultMsg || n.desc}</textarea>
                    <div class="form-text">{date} {property} {staff} {guest} {month} が使えます</div>
                  </div>
                  <div class="col-md-6">
                    <label class="form-label small text-muted mb-1"><i class="bi bi-eye"></i> プレビュー</label>
                    <div class="notify-preview border rounded p-2 bg-light small" data-preview="${n.key}" style="white-space:pre-wrap;min-height:100px;font-size:0.85rem;"></div>
                  </div>
                </div>

                <!-- テスト送信ボタン -->
                <button class="btn btn-sm btn-outline-primary btn-test-send"
                        type="button"
                        data-key="${n.key}"
                        data-default-msg="${(n.defaultMsg || n.desc).replace(/"/g, '&quot;')}">
                  <i class="bi bi-send"></i> テスト送信
                </button>
              </div>

              <!-- 有効/無効トグル -->
              <div class="form-check form-switch notify-toggle ms-3">
                <input class="form-check-input" type="checkbox"
                       data-key="${n.key}" data-field="enabled" ${enabled ? "checked" : ""}>
              </div>
            </div>
          </div>`;
      }).join("");

      // テスト送信ボタンのイベントを委譲で登録
      container.addEventListener("click", (e) => {
        const btn = e.target.closest(".btn-test-send");
        if (btn) this.sendTestNotification(btn);
      });

      // プレビュー: textarea入力時にリアルタイム更新
      container.addEventListener("input", (e) => {
        if (e.target.classList.contains("notify-msg-input")) {
          const key = e.target.dataset.key;
          this.updatePreview(key, e.target.value);
        }
      });

      // 初期プレビュー表示
      container.querySelectorAll(".notify-msg-input").forEach(ta => {
        this.updatePreview(ta.dataset.key, ta.value);
      });
    }
  },

  // サンプルデータでプレビュー生成
  _sampleData: {
    date: "2026/04/20",
    property: "長浜民泊A",
    staff: "山田太郎",
    guest: "John Smith",
    month: "4",
  },

  updatePreview(key, rawMsg) {
    const el = document.querySelector(`[data-preview="${key}"]`);
    if (!el) return;
    let msg = rawMsg || "";
    // プレースホルダーをサンプルデータで置換
    Object.entries(this._sampleData).forEach(([k, v]) => {
      msg = msg.replace(new RegExp(`\\{${k}\\}`, "g"), v);
    });
    el.textContent = msg;
  },

  /**
   * テスト送信
   * @param {HTMLElement} btn クリックされたボタン要素
   */
  async sendTestNotification(btn) {
    const key        = btn.dataset.key;
    const defaultMsg = btn.dataset.defaultMsg;

    // 現在のカスタムメッセージを取得
    const textareaEl = document.querySelector(`textarea[data-key="${key}"][data-field="customMessage"]`);
    const message    = (textareaEl && textareaEl.value.trim()) ? textareaEl.value.trim() : defaultMsg;

    // 現在チェックされている送り先を取得
    const getChecked = (field) => {
      const el = document.querySelector(`input[data-key="${key}"][data-field="${field}"]`);
      return el ? el.checked : false;
    };
    const targets = {
      ownerLine:  getChecked("ownerLine"),
      groupLine:  getChecked("groupLine"),
      staffLine:  getChecked("staffLine"),
      ownerEmail: getChecked("ownerEmail"),
    };

    // スピナー表示
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 送信中...`;

    try {
      const user  = firebase.auth().currentUser;
      if (!user) throw new Error("ログインが必要です");

      const token = await user.getIdToken();

      const res = await fetch(this.TEST_API_URL, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ type: key, message, targets }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${res.status}`);
      }

      showToast("テスト送信完了", `「${key}」のテスト通知を送信しました`, "success");
    } catch (e) {
      showToast("送信エラー", e.message, "error");
    } finally {
      btn.disabled  = false;
      btn.innerHTML = originalHTML;
    }
  },

  async saveSettings() {
    try {
      const channels = {};
      this.notifications.forEach(n => {
        const getChecked = (field) => {
          const el = document.querySelector(`input[data-key="${n.key}"][data-field="${field}"]`);
          return el ? el.checked : false;
        };
        const textareaEl = document.querySelector(`textarea[data-key="${n.key}"][data-field="customMessage"]`);
        const customMessage = textareaEl ? textareaEl.value.trim() : "";

        channels[n.key] = {
          enabled:       getChecked("enabled"),
          ownerLine:     getChecked("ownerLine"),
          groupLine:     getChecked("groupLine"),
          staffLine:     getChecked("staffLine"),
          ownerEmail:    getChecked("ownerEmail"),
          customMessage,
        };
      });

      const data = {
        lineChannelToken: document.getElementById("lineChannelToken").value.trim(),
        lineGroupId:      document.getElementById("lineGroupId").value.trim(),
        lineOwnerUserId:  document.getElementById("lineOwnerUserId").value.trim(),
        ownerEmail:       document.getElementById("ownerEmail").value.trim(),
        enableLine:       true,
        channels,
        updatedAt:        firebase.firestore.FieldValue.serverTimestamp(),
      };

      await db.collection("settings").doc("notifications").set(data, { merge: true });
      this.settings = { ...this.settings, ...data };
      showToast("成功", "通知設定を保存しました", "success");
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },
};
