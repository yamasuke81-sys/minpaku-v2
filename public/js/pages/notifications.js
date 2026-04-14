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
      { name: "date",     label: "清掃日",       sample: "2026/04/20",  source: "recruitment.checkoutDate" },
      { name: "property", label: "物件名",       sample: "長浜民泊A",    source: "recruitment.propertyName" },
      { name: "url",      label: "回答ページURL", sample: "https://minpaku-v2.web.app/#/my-recruitment", source: "自動生成" },
      { name: "count",    label: "回答数",       sample: "3",           source: "recruitment.responses.length" },
      { name: "staff",    label: "確定スタッフ名", sample: "山田太郎",    source: "recruitment.selectedStaff" },
      { name: "memo",     label: "メモ",         sample: "BBQ後の片付けあり", source: "recruitment.memo" },
    ],
    // 予約系で使える変数
    booking: [
      { name: "date",     label: "チェックアウト日", sample: "2026/04/20", source: "booking.checkOut" },
      { name: "checkin",  label: "チェックイン日",   sample: "2026/04/18", source: "booking.checkIn" },
      { name: "property", label: "物件名",          sample: "長浜民泊A",   source: "booking.propertyName" },
      { name: "guest",    label: "ゲスト名",        sample: "John Smith", source: "booking.guestName" },
      { name: "nights",   label: "宿泊数",          sample: "2",          source: "自動計算" },
      { name: "site",     label: "予約サイト",       sample: "Airbnb",     source: "booking.source" },
    ],
    // スタッフ系で使える変数
    staff: [
      { name: "staff",    label: "スタッフ名",  sample: "山田太郎",      source: "staff.name" },
      { name: "date",     label: "対象日",      sample: "2026/04/20",   source: "shift.date" },
      { name: "property", label: "物件名",      sample: "長浜民泊A",     source: "shift.propertyName" },
    ],
    // 経理系で使える変数
    invoice: [
      { name: "month",    label: "対象月",      sample: "4",            source: "invoice.yearMonth" },
      { name: "staff",    label: "スタッフ名",  sample: "山田太郎",      source: "invoice.staffName" },
      { name: "total",    label: "合計金額",    sample: "¥45,000",      source: "invoice.total" },
      { name: "url",      label: "確認ページURL", sample: "https://minpaku-v2.web.app/#/my-dashboard", source: "自動生成" },
    ],
    // 清掃系で使える変数
    cleaning: [
      { name: "date",     label: "清掃日",      sample: "2026/04/20",   source: "checklist.date" },
      { name: "property", label: "物件名",      sample: "長浜民泊A",     source: "checklist.propertyName" },
      { name: "staff",    label: "スタッフ名",  sample: "山田太郎",      source: "checklist.staffName" },
      { name: "time",     label: "完了時刻",    sample: "14:30",        source: "checklist.completedAt" },
    ],
  },

  // 通知種別ごとに使えるグループを紐付け
  notifications: [
    { key: "recruit_start", label: "清掃スタッフ募集", desc: "新しい清掃予定に対してスタッフへ募集通知を送信", icon: "bi-megaphone", group: "recruit", varGroup: "recruit", defaultTiming: "immediate",
      defaultMsg: "🧹 清掃スタッフ募集\n\n{date} {property}\n清掃スタッフを募集しています。\n回答をお願いします（◎OK / △微妙 / ×NG）\n\n回答: {url}" },
    { key: "recruit_remind", label: "募集リマインド", desc: "回答が集まらない場合にリマインド送信", icon: "bi-alarm", group: "recruit", varGroup: "recruit", defaultTiming: "evening",
      defaultMsg: "📋 募集回答のお願い\n\n{date} {property}\nまだ回答が届いていません（現在{count}件）。\n回答: {url}" },
    { key: "staff_confirm", label: "スタッフ確定通知", desc: "スタッフ確定時に本人とオーナーに通知", icon: "bi-person-check", group: "recruit", varGroup: "recruit", defaultTiming: "immediate",
      defaultMsg: "✅ 清掃担当が確定しました\n\n{date} {property}\n担当: {staff}\nよろしくお願いします。" },
    { key: "staff_undecided", label: "スタッフ未決定リマインド", desc: "清掃日が近いのにスタッフ未確定の場合にオーナーへ通知", icon: "bi-exclamation-triangle", group: "recruit", varGroup: "recruit", defaultTiming: "morning",
      defaultMsg: "⚠️ スタッフ未確定\n\n{date} {property}\n清掃日が近づいていますが、まだスタッフが確定していません。\n回答状況: {count}件" },
    { key: "urgent_remind", label: "直前予約リマインド", desc: "直前予約に対する緊急リマインド", icon: "bi-lightning", group: "recruit", varGroup: "recruit", defaultTiming: "immediate",
      defaultMsg: "🔴 緊急: 直前予約の清掃手配\n\n{date} {property}\n直前予約が入りました。至急スタッフの手配をお願いします。" },
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
    { key: "roster_remind", label: "名簿未入力リマインド", desc: "宿泊者名簿が未入力の予約についてリマインド", icon: "bi-person-vcard", group: "booking", varGroup: "booking", defaultTiming: "morning",
      defaultMsg: "📝 名簿入力のお願い\n\n{checkin} {property}\nゲスト: {guest}\n宿泊者名簿がまだ届いていません。" },
    { key: "invoice_request", label: "請求書要請", desc: "月末にスタッフへ請求書の提出を依頼", icon: "bi-receipt", group: "invoice", varGroup: "invoice", defaultTiming: "morning",
      defaultMsg: "💰 {month}月分の請求書\n\n合計: {total}\n内容を確認してください。\n確認: {url}" },
    { key: "cleaning_done", label: "清掃完了通知", desc: "清掃チェックリスト完了時にオーナーに通知", icon: "bi-clipboard-check", group: "cleaning", varGroup: "cleaning", defaultTiming: "immediate",
      defaultMsg: "✨ 清掃完了\n\n{date} {property}\n{staff}さんが{time}に清掃を完了しました。" },
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

      <div class="d-flex flex-wrap gap-3 mb-3 small text-muted">
        <span><i class="bi bi-person-circle text-success"></i> オーナーLINE</span>
        <span><i class="bi bi-people-fill text-primary"></i> グループLINE</span>
        <span><i class="bi bi-person-lines-fill text-info"></i> スタッフ個別LINE</span>
        <span><i class="bi bi-envelope text-warning"></i> オーナーメール</span>
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

    document.getElementById("btnSaveNotifySettings").addEventListener("click", () => this.saveSettings());
    await this.loadSettings();
    this.renderNotifications();
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
        const customMessage = ch.customMessage || "";
        const msgValue = customMessage || n.defaultMsg || n.desc;
        const vars = this.systemVariables[n.varGroup] || [];
        const timing = ch.timing || n.defaultTiming || "immediate";
        const timingMinutes = ch.timingMinutes || "";

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
                <div class="d-flex align-items-center gap-2 mb-1">
                  <i class="bi ${n.icon} text-primary"></i>
                  <strong>${n.label}</strong>
                </div>
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
                </div>

                <!-- 通知タイミング設定 -->
                <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
                  <span class="small text-muted"><i class="bi bi-clock"></i> 通知タイミング:</span>
                  <select class="form-select form-select-sm notify-timing-select" style="width:auto;" data-key="${n.key}" data-field="timing">
                    <option value="immediate" ${timing === "immediate" ? "selected" : ""}>即時</option>
                    <option value="5min" ${timing === "5min" ? "selected" : ""}>5分後</option>
                    <option value="15min" ${timing === "15min" ? "selected" : ""}>15分後</option>
                    <option value="30min" ${timing === "30min" ? "selected" : ""}>30分後</option>
                    <option value="1hour" ${timing === "1hour" ? "selected" : ""}>1時間後</option>
                    <option value="morning" ${timing === "morning" ? "selected" : ""}>翌朝6時</option>
                    <option value="evening" ${timing === "evening" ? "selected" : ""}>当日18時</option>
                    <option value="custom" ${timing === "custom" ? "selected" : ""}>カスタム（分指定）</option>
                  </select>
                  <input type="number" class="form-control form-control-sm notify-timing-minutes"
                    style="width:90px; ${timing === "custom" ? "" : "display:none;"}"
                    data-key="${n.key}" data-field="timingMinutes"
                    value="${timingMinutes}" min="1" placeholder="分数">
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
              </div>

              <div class="form-check form-switch notify-toggle ms-3">
                <input class="form-check-input" type="checkbox" data-key="${n.key}" data-field="enabled" ${enabled ? "checked" : ""}>
              </div>
            </div>
          </div>`;
      }).join("");

      // イベント委譲
      container.addEventListener("click", (e) => {
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

      // タイミングselect変更時 → カスタム入力欄の表示切替
      container.addEventListener("change", (e) => {
        if (e.target.classList.contains("notify-timing-select")) {
          const key = e.target.dataset.key;
          const minutesInput = container.querySelector(`.notify-timing-minutes[data-key="${key}"]`);
          if (minutesInput) {
            minutesInput.style.display = e.target.value === "custom" ? "" : "none";
          }
        }
      });
    }
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

    // メッセージをサンプル値で置換して送信
    let message = ta ? ta.value : "";
    vars.forEach(v => {
      message = message.replace(new RegExp(`\\{${v.name}\\}`, "g"), v.sample);
    });

    const get = (field) => {
      const el = document.querySelector(`[data-key="${key}"][data-field="${field}"]`);
      return el ? el.checked : false;
    };
    const targets = {
      ownerLine: get("ownerLine"),
      groupLine: get("groupLine"),
      staffLine: get("staffLine"),
      ownerEmail: get("ownerEmail"),
    };

    if (!targets.ownerLine && !targets.groupLine && !targets.staffLine && !targets.ownerEmail) {
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
        body: JSON.stringify({ type: key, message: `【テスト】${message}`, targets }),
      });
      const data = await res.json();
      if (res.ok) {
        const sent = (data.results || []).filter(r => r.success).length;
        showToast("送信完了", `${sent}件送信しました`, "success");
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

  async saveSettings() {
    try {
      const channels = {};
      this.notifications.forEach(n => {
        const get = (field) => {
          const el = document.querySelector(`[data-key="${n.key}"][data-field="${field}"]`);
          return el ? el.checked : false;
        };
        const ta = document.querySelector(`textarea[data-key="${n.key}"][data-field="customMessage"]`);
        const timingSel = document.querySelector(`select[data-key="${n.key}"][data-field="timing"]`);
        const timingMinEl = document.querySelector(`input[data-key="${n.key}"][data-field="timingMinutes"]`);
        const timingVal = timingSel ? timingSel.value : (n.defaultTiming || "immediate");
        const entry = {
          enabled: get("enabled"),
          ownerLine: get("ownerLine"),
          groupLine: get("groupLine"),
          staffLine: get("staffLine"),
          ownerEmail: get("ownerEmail"),
          customMessage: ta ? ta.value : "",
          timing: timingVal,
        };
        if (timingVal === "custom" && timingMinEl && timingMinEl.value) {
          entry.timingMinutes = parseInt(timingMinEl.value, 10) || 0;
        }
        channels[n.key] = entry;
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
