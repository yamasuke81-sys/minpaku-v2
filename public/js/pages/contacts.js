/**
 * 連絡先マスタ — メール / LINE / Discord を一元管理
 *
 * データの実体は各ドキュメントに保存される（このタブはUIレイヤーのみで、相互同期問題は起きない）:
 *   - スタッフ: staff/{id} の email / lineUserId / subOwnerEmail / subOwnerLineUserId / subOwnerDiscordWebhookUrl
 *   - Webアプリ管理者: settings/notifications の ownerEmail (or notifyEmails) / lineOwnerUserId / lineGroupId / lineChannelToken / discordOwnerWebhookUrl / discordSubOwnerWebhookUrl
 *   - Gmail OAuth: settings/gmailOAuth/tokens の連携アカウント (読み取りのみ・連携は #/email-verification)
 *   - 物件別 LINE Bot: properties/{id}.lineChannels[] (読み取り+簡易編集、本格編集は物件編集モーダル)
 */

const ContactsPage = {
  staff: [],
  properties: [],
  notifSettings: null,
  gmailTokens: [],

  async render(container) {
    container.innerHTML = `
      <div class="container-fluid py-3">
        <div class="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
          <h1 class="h4 mb-0"><i class="bi bi-person-rolodex me-2"></i>連絡先マスタ</h1>
          <div class="text-muted small">登録済みの LINE / メール / Discord 宛先を一元管理します</div>
        </div>

        <ul class="nav nav-tabs mb-3" id="contactsTabs" role="tablist">
          <li class="nav-item"><button class="nav-link active" data-bs-toggle="tab" data-bs-target="#tab-emails" type="button"><i class="bi bi-envelope"></i> メール</button></li>
          <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#tab-lines" type="button"><i class="bi bi-chat-dots"></i> LINE</button></li>
          <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#tab-discord" type="button"><i class="bi bi-discord"></i> Discord</button></li>
        </ul>

        <div class="tab-content">
          <div class="tab-pane fade show active" id="tab-emails"><div id="emailsArea">読み込み中…</div></div>
          <div class="tab-pane fade" id="tab-lines"><div id="linesArea">読み込み中…</div></div>
          <div class="tab-pane fade" id="tab-discord"><div id="discordArea">読み込み中…</div></div>
        </div>
      </div>
    `;
    await this.loadAll();
    this.renderEmails();
    this.renderLines();
    this.renderDiscord();
    this.bindEvents();
  },

  async loadAll() {
    try {
      const [staffSnap, propSnap, notifDoc, tokensSnap] = await Promise.all([
        db.collection("staff").orderBy("displayOrder", "asc").get(),
        db.collection("properties").get(),
        db.collection("settings").doc("notifications").get(),
        db.collection("settings").doc("gmailOAuth").collection("tokens").get(),
      ]);
      this.staff = staffSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      this.properties = propSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.propertyNumber ?? 999) - (b.propertyNumber ?? 999));
      this.notifSettings = notifDoc.exists ? notifDoc.data() : {};
      this.gmailTokens = tokensSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      console.error("[contacts] 読み込み失敗:", e);
      showToast("エラー", "読み込み失敗: " + e.message, "error");
    }
  },

  // ============================================================
  // メールタブ
  // ============================================================
  renderEmails() {
    const linkedSet = new Set(this.gmailTokens.map(t => (t.email || "").toLowerCase()).filter(Boolean));
    const linkedBadge = (mail) => {
      if (!mail) return "";
      return linkedSet.has(mail.toLowerCase())
        ? `<span class="badge bg-success-subtle text-success border ms-1" title="Gmail連携済み"><i class="bi bi-check-circle"></i> 連携済</span>`
        : `<span class="badge bg-secondary-subtle text-secondary border ms-1" title="Gmail未連携">未連携</span>`;
    };

    // Web管理者
    const webAdmin = this.notifSettings || {};
    const webAdminEmail = webAdmin.ownerEmail || (Array.isArray(webAdmin.notifyEmails) ? webAdmin.notifyEmails[0] : "") || "";

    let html = `
      <div class="alert alert-info py-2 small">
        <i class="bi bi-info-circle"></i> ここでの編集は元の場所（スタッフ管理 / 通知設定 / 物件管理）と<strong>相互同期</strong>します。
        <a href="#/email-verification" class="ms-2 text-decoration-none"><i class="bi bi-google"></i> Gmail 連携 →</a>
      </div>

      <h5 class="mt-3"><i class="bi bi-person-gear"></i> Webアプリ管理者</h5>
      <div class="card mb-3"><div class="card-body p-2">
        <table class="table table-sm align-middle mb-0">
          <thead class="table-light"><tr><th style="width:200px;">用途</th><th>メールアドレス</th><th style="width:140px;">連携</th><th style="width:80px;"></th></tr></thead>
          <tbody>
            <tr>
              <td class="small">通知受信用 (settings/notifications.ownerEmail)</td>
              <td><input class="form-control form-control-sm c-email-input" data-target="settings" data-field="ownerEmail" value="${this._esc(webAdminEmail)}"></td>
              <td>${linkedBadge(webAdminEmail)}</td>
              <td><button class="btn btn-sm btn-primary c-save-btn" data-target="settings" data-field="ownerEmail">保存</button></td>
            </tr>
          </tbody>
        </table>
      </div></div>

      <h5 class="mt-3"><i class="bi bi-people"></i> スタッフ / 物件オーナー</h5>
      <div class="card mb-3"><div class="card-body p-2">
        <table class="table table-sm align-middle mb-0">
          <thead class="table-light"><tr><th style="width:140px;">名前</th><th style="width:90px;">区分</th><th>メール (送信元/通知用)</th><th>サブメール (物件オーナー用)</th><th style="width:80px;"></th></tr></thead>
          <tbody>
            ${this.staff.map(s => `
              <tr data-staff-id="${s.id}">
                <td class="small">${this._esc(s.name || "(無名)")}${s.active === false ? ' <span class="badge bg-secondary">無効</span>' : ""}</td>
                <td class="small">
                  ${s.isOwner ? '<span class="badge bg-warning-subtle text-warning border">オーナー</span>' : ""}
                  ${s.isSubOwner ? '<span class="badge bg-info-subtle text-info border">物件オーナー</span>' : ""}
                  ${!s.isOwner && !s.isSubOwner ? '<span class="badge bg-light text-muted border">スタッフ</span>' : ""}
                </td>
                <td>
                  <input class="form-control form-control-sm c-email-input mb-1" data-target="staff" data-staff-id="${s.id}" data-field="email" value="${this._esc(s.email || "")}">
                  ${linkedBadge(s.email)}
                </td>
                <td>
                  ${s.isSubOwner ? `
                    <input class="form-control form-control-sm c-email-input mb-1" data-target="staff" data-staff-id="${s.id}" data-field="subOwnerEmail" value="${this._esc(s.subOwnerEmail || "")}" placeholder="物件オーナー専用メール (任意)">
                    ${linkedBadge(s.subOwnerEmail)}
                  ` : '<span class="text-muted small">—</span>'}
                </td>
                <td><button class="btn btn-sm btn-primary c-save-row-btn" data-target="staff" data-staff-id="${s.id}">保存</button></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div></div>

      <h5 class="mt-3"><i class="bi bi-google"></i> 連携済み Gmail (送信元として利用可能)</h5>
      <div class="card mb-3"><div class="card-body p-2">
        ${this.gmailTokens.length === 0
          ? '<div class="text-muted small">連携アカウントなし。<a href="#/email-verification">メール照合タブ</a>から Gmail 連携を追加できます。</div>'
          : `<table class="table table-sm mb-0">
              <thead class="table-light"><tr><th>Gmail アドレス</th><th style="width:120px;">最終更新</th></tr></thead>
              <tbody>${this.gmailTokens.map(t => `<tr><td><code>${this._esc(t.email || "(不明)")}</code></td><td class="small text-muted">${this._fmtDate(t.updatedAt)}</td></tr>`).join("")}</tbody>
            </table>`}
        <div class="mt-2 small"><a href="#/email-verification"><i class="bi bi-plus-circle"></i> Gmail 連携を追加 / 解除</a></div>
      </div></div>
    `;

    document.getElementById("emailsArea").innerHTML = html;
  },

  // ============================================================
  // LINEタブ
  // ============================================================
  renderLines() {
    const s = this.notifSettings || {};
    const tokenStat = s.lineChannelToken ? `<span class="badge bg-success-subtle text-success border">設定済</span>` : `<span class="badge bg-danger-subtle text-danger border">未設定</span>`;

    let html = `
      <div class="alert alert-info py-2 small">
        <i class="bi bi-info-circle"></i> 物件別グループLINE は物件ごとに複数 Bot を登録可能です（物件編集→LINE連携）。
      </div>

      <h5 class="mt-3"><i class="bi bi-person-gear"></i> Webアプリ管理者LINE</h5>
      <div class="card mb-3"><div class="card-body p-2">
        <table class="table table-sm align-middle mb-0">
          <tbody>
            <tr><td class="small" style="width:200px;">LINE Bot Channel Token</td><td>${tokenStat} <a href="#/notifications" class="ms-2 small">設定→</a></td></tr>
            <tr>
              <td class="small">Webアプリ管理者 LINE User ID</td>
              <td>
                <div class="d-flex gap-2">
                  <input class="form-control form-control-sm c-line-input" data-target="settings" data-field="lineOwnerUserId" value="${this._esc(s.lineOwnerUserId || "")}" placeholder="Uxxxxxxxxxx...">
                  <button class="btn btn-sm btn-primary c-save-btn" data-target="settings" data-field="lineOwnerUserId">保存</button>
                </div>
              </td>
            </tr>
            <tr>
              <td class="small">グローバル Group ID (物件未指定時のフォールバック)</td>
              <td>
                <div class="d-flex gap-2">
                  <input class="form-control form-control-sm c-line-input" data-target="settings" data-field="lineGroupId" value="${this._esc(s.lineGroupId || "")}" placeholder="Cxxxxxxxxxx...">
                  <button class="btn btn-sm btn-primary c-save-btn" data-target="settings" data-field="lineGroupId">保存</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div></div>

      <h5 class="mt-3"><i class="bi bi-people"></i> スタッフ / 物件オーナーの LINE User ID</h5>
      <div class="card mb-3"><div class="card-body p-2">
        <table class="table table-sm align-middle mb-0">
          <thead class="table-light"><tr><th style="width:140px;">名前</th><th>スタッフ用 lineUserId</th><th>物件オーナー用 subOwnerLineUserId</th><th style="width:80px;"></th></tr></thead>
          <tbody>
            ${this.staff.map(staff => `
              <tr data-staff-id="${staff.id}">
                <td class="small">${this._esc(staff.name || "(無名)")}</td>
                <td>
                  <input class="form-control form-control-sm c-line-input" data-target="staff" data-staff-id="${staff.id}" data-field="lineUserId" value="${this._esc(staff.lineUserId || "")}" placeholder="Uxxxxxxxxxx...">
                </td>
                <td>
                  ${staff.isSubOwner ? `
                    <input class="form-control form-control-sm c-line-input" data-target="staff" data-staff-id="${staff.id}" data-field="subOwnerLineUserId" value="${this._esc(staff.subOwnerLineUserId || "")}" placeholder="Uxxxxxxxxxx...">
                  ` : '<span class="text-muted small">—</span>'}
                </td>
                <td><button class="btn btn-sm btn-primary c-save-row-btn" data-target="staff" data-staff-id="${staff.id}">保存</button></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div></div>

      <h5 class="mt-3"><i class="bi bi-buildings"></i> 物件別 LINE Bot (グループLINE 送信元)</h5>
      <div class="card mb-3"><div class="card-body p-2">
        ${this.properties.length === 0
          ? '<div class="text-muted small">物件なし</div>'
          : `<table class="table table-sm align-middle mb-0">
              <thead class="table-light"><tr><th style="width:200px;">物件</th><th>登録 Bot 数</th><th>Bot 名</th><th style="width:120px;"></th></tr></thead>
              <tbody>
                ${this.properties.map(p => {
                  const channels = Array.isArray(p.lineChannels) ? p.lineChannels : [];
                  return `<tr>
                    <td class="small fw-semibold">${this._esc(p.name || "(無名)")}</td>
                    <td>${channels.length}</td>
                    <td class="small">${channels.map(c => `<span class="badge bg-light text-dark border me-1">${this._esc(c.name || "(無名)")}</span>`).join("") || '<span class="text-muted">未登録</span>'}</td>
                    <td><a href="#/properties" class="btn btn-sm btn-outline-secondary">編集 →</a></td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>`}
      </div></div>
    `;
    document.getElementById("linesArea").innerHTML = html;
  },

  // ============================================================
  // Discordタブ
  // ============================================================
  renderDiscord() {
    const s = this.notifSettings || {};
    let html = `
      <div class="alert alert-info py-2 small">
        <i class="bi bi-info-circle"></i> Discord は Webhook URL を設定するだけで通知できます。
      </div>

      <h5 class="mt-3"><i class="bi bi-person-gear"></i> Webアプリ管理者 Discord</h5>
      <div class="card mb-3"><div class="card-body p-2">
        <table class="table table-sm align-middle mb-0">
          <tbody>
            <tr>
              <td class="small" style="width:200px;">Webhook URL (Webアプリ管理者宛)</td>
              <td><div class="d-flex gap-2">
                <input class="form-control form-control-sm c-discord-input" data-target="settings" data-field="discordOwnerWebhookUrl" value="${this._esc(s.discordOwnerWebhookUrl || "")}" placeholder="https://discord.com/api/webhooks/...">
                <button class="btn btn-sm btn-primary c-save-btn" data-target="settings" data-field="discordOwnerWebhookUrl">保存</button>
              </div></td>
            </tr>
            <tr>
              <td class="small">Webhook URL (物件オーナー全体宛・フォールバック)</td>
              <td><div class="d-flex gap-2">
                <input class="form-control form-control-sm c-discord-input" data-target="settings" data-field="discordSubOwnerWebhookUrl" value="${this._esc(s.discordSubOwnerWebhookUrl || "")}" placeholder="https://discord.com/api/webhooks/...">
                <button class="btn btn-sm btn-primary c-save-btn" data-target="settings" data-field="discordSubOwnerWebhookUrl">保存</button>
              </div></td>
            </tr>
          </tbody>
        </table>
      </div></div>

      <h5 class="mt-3"><i class="bi bi-person-badge"></i> 物件オーナー個別 Discord Webhook</h5>
      <div class="card mb-3"><div class="card-body p-2">
        <table class="table table-sm align-middle mb-0">
          <thead class="table-light"><tr><th style="width:200px;">物件オーナー</th><th>Webhook URL</th><th style="width:80px;"></th></tr></thead>
          <tbody>
            ${this.staff.filter(s => s.isSubOwner).map(staff => `
              <tr data-staff-id="${staff.id}">
                <td class="small fw-semibold">${this._esc(staff.name || "(無名)")}</td>
                <td>
                  <input class="form-control form-control-sm c-discord-input" data-target="staff" data-staff-id="${staff.id}" data-field="subOwnerDiscordWebhookUrl" value="${this._esc(staff.subOwnerDiscordWebhookUrl || "")}" placeholder="https://discord.com/api/webhooks/...">
                </td>
                <td><button class="btn btn-sm btn-primary c-save-row-btn" data-target="staff" data-staff-id="${staff.id}">保存</button></td>
              </tr>
            `).join("") || '<tr><td colspan="3" class="text-muted small">物件オーナーがいません (スタッフ管理で isSubOwner=true を設定)</td></tr>'}
          </tbody>
        </table>
      </div></div>
    `;
    document.getElementById("discordArea").innerHTML = html;
  },

  // ============================================================
  // 保存ハンドラ
  // ============================================================
  bindEvents() {
    document.querySelectorAll(".c-save-btn").forEach(btn => {
      btn.addEventListener("click", () => this.saveSingle(btn));
    });
    document.querySelectorAll(".c-save-row-btn").forEach(btn => {
      btn.addEventListener("click", () => this.saveStaffRow(btn));
    });
  },

  async saveSingle(btn) {
    const target = btn.dataset.target;
    const field = btn.dataset.field;
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    try {
      if (target === "settings") {
        const input = document.querySelector(`input[data-target="settings"][data-field="${field}"]`);
        const val = (input?.value || "").trim();
        await db.collection("settings").doc("notifications").set({ [field]: val }, { merge: true });
        if (this.notifSettings) this.notifSettings[field] = val;
        showToast("保存", `${field} を保存しました`, "success");
      }
    } catch (e) {
      showToast("エラー", "保存失敗: " + e.message, "error");
    } finally {
      btn.disabled = false; btn.innerHTML = orig;
    }
  },

  async saveStaffRow(btn) {
    const staffId = btn.dataset.staffId;
    const row = btn.closest("tr");
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    try {
      const inputs = row.querySelectorAll('input[data-target="staff"]');
      const update = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
      inputs.forEach(inp => {
        update[inp.dataset.field] = (inp.value || "").trim();
      });
      await db.collection("staff").doc(staffId).update(update);
      const local = this.staff.find(s => s.id === staffId);
      if (local) Object.assign(local, update);
      showToast("保存", "スタッフ情報を保存しました", "success");
    } catch (e) {
      showToast("エラー", "保存失敗: " + e.message, "error");
    } finally {
      btn.disabled = false; btn.innerHTML = orig;
    }
  },

  // ============================================================
  // ユーティリティ
  // ============================================================
  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },
  _fmtDate(ts) {
    if (!ts) return "-";
    try {
      const d = ts.toDate ? ts.toDate() : new Date(ts);
      return d.toISOString().slice(0, 10);
    } catch { return "-"; }
  },
};
