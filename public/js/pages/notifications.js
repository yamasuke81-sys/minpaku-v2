/**
 * 通知設定ページ
 * 13種類の通知ごとに有効/無効・送り先（オーナーLINE/グループLINE/オーナーメール）を複数選択
 * LINE接続設定（チャネルアクセストークン・グループID）
 */
const NotificationsPage = {
  settings: {},

  // 通知の定義
  notifications: [
    { key: "recruit_start", label: "清掃スタッフ募集", desc: "新しい清掃予定に対してスタッフへ募集通知を送信", icon: "bi-megaphone", group: "recruit" },
    { key: "recruit_remind", label: "募集リマインド", desc: "回答が集まらない場合にリマインド送信", icon: "bi-alarm", group: "recruit" },
    { key: "staff_confirm", label: "スタッフ確定通知", desc: "スタッフ確定時に本人とオーナーに通知", icon: "bi-person-check", group: "recruit" },
    { key: "staff_undecided", label: "スタッフ未決定リマインド", desc: "清掃日が近いのにスタッフ未確定の場合にオーナーへ通知", icon: "bi-exclamation-triangle", group: "recruit" },
    { key: "urgent_remind", label: "直前予約リマインド", desc: "直前予約に対する緊急リマインド", icon: "bi-lightning", group: "recruit" },
    { key: "booking_cancel", label: "予約キャンセル通知", desc: "予約がキャンセルされた場合にオーナー・スタッフに通知", icon: "bi-x-circle", group: "booking" },
    { key: "booking_change", label: "予約変更通知", desc: "予約日程が変更された場合に通知", icon: "bi-arrow-repeat", group: "booking" },
    { key: "cancel_request", label: "出勤キャンセル要望", desc: "スタッフからの出勤キャンセル要望をオーナーに通知", icon: "bi-person-dash", group: "staff" },
    { key: "cancel_approve", label: "キャンセル承認通知", desc: "出勤キャンセルを承認した場合にスタッフに通知", icon: "bi-check-circle", group: "staff" },
    { key: "cancel_reject", label: "キャンセル却下通知", desc: "出勤キャンセルを却下した場合にスタッフに通知", icon: "bi-dash-circle", group: "staff" },
    { key: "roster_remind", label: "名簿未入力リマインド", desc: "宿泊者名簿が未入力の予約についてリマインド", icon: "bi-person-vcard", group: "booking" },
    { key: "invoice_request", label: "請求書要請", desc: "月末にスタッフへ請求書の提出を依頼", icon: "bi-receipt", group: "invoice" },
    { key: "cleaning_done", label: "清掃完了通知", desc: "清掃チェックリスト完了時にオーナーに通知", icon: "bi-clipboard-check", group: "cleaning" },
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
    document.getElementById("lineChannelToken").value = this.settings.lineChannelToken || this.settings.lineToken || "";
    document.getElementById("lineGroupId").value = this.settings.lineGroupId || "";
    document.getElementById("lineOwnerUserId").value = this.settings.lineOwnerUserId || this.settings.lineOwnerId || "";
    document.getElementById("ownerEmail").value = this.settings.ownerEmail || "";
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
        const channels = this.settings.channels || {};
        const ch = channels[n.key] || {};
        const enabled = ch.enabled !== false;
        const ownerLine = ch.ownerLine !== false;
        const groupLine = !!ch.groupLine;
        const staffLine = !!ch.staffLine;
        const ownerEmail = !!ch.ownerEmail;

        return `
          <div class="notify-channel-card">
            <div class="d-flex justify-content-between align-items-start">
              <div class="flex-grow-1">
                <div class="d-flex align-items-center gap-2 mb-1">
                  <i class="bi ${n.icon} text-primary"></i>
                  <strong>${n.label}</strong>
                </div>
                <div class="text-muted small mb-2">${n.desc}</div>
                <div class="d-flex flex-wrap gap-3">
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
              </div>
              <div class="form-check form-switch notify-toggle ms-3">
                <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="enabled" ${enabled ? "checked" : ""}>
              </div>
            </div>
          </div>`;
      }).join("");
    }
  },

  async saveSettings() {
    try {
      const channels = {};
      this.notifications.forEach(n => {
        const get = (field) => {
          const el = document.querySelector(`[data-key="${n.key}"][data-field="${field}"]`);
          return el ? el.checked : false;
        };
        channels[n.key] = {
          enabled: get("enabled"),
          ownerLine: get("ownerLine"),
          groupLine: get("groupLine"),
          staffLine: get("staffLine"),
          ownerEmail: get("ownerEmail"),
        };
      });

      const data = {
        lineChannelToken: document.getElementById("lineChannelToken").value.trim(),
        lineGroupId: document.getElementById("lineGroupId").value.trim(),
        lineOwnerUserId: document.getElementById("lineOwnerUserId").value.trim(),
        ownerEmail: document.getElementById("ownerEmail").value.trim(),
        enableLine: true,
        channels,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };

      await db.collection("settings").doc("notifications").set(data, { merge: true });
      this.settings = { ...this.settings, ...data };
      showToast("成功", "通知設定を保存しました", "success");
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },
};
