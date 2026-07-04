/**
 * 直接予約リクエスト 管理画面
 * - 宿公式サイトからの予約リクエスト (bookingRequests) を一覧表示
 * - 承認 → bookings を新規作成 (source:"direct")、iCal フィード配信・募集生成へ自動連携
 * - 却下 → 理由を添えてゲストへお断りメール送信
 * - タブで pending / approved / rejected を切替 (cancelled-bookings.js / contacts.js のパターンを踏襲)
 */
const BookingRequestsPage = {
  state: {
    tab: "pending",
    items: [],
  },

  CF_BASE: "https://api-5qrfx7ujcq-an.a.run.app",

  async render(container) {
    container.innerHTML = `
      <div class="d-flex align-items-center mb-3">
        <h4 class="mb-0"><i class="bi bi-inbox"></i> 直接予約リクエスト</h4>
        <span class="ms-3 text-muted small" id="brSummary">読み込み中...</span>
      </div>
      <ul class="nav nav-tabs mb-3" id="brTabs" role="tablist">
        <li class="nav-item">
          <button class="nav-link active" data-bs-toggle="tab" data-bs-target="#br-tab-pending" type="button" data-tab="pending">
            <i class="bi bi-hourglass-split"></i> 未対応
          </button>
        </li>
        <li class="nav-item">
          <button class="nav-link" data-bs-toggle="tab" data-bs-target="#br-tab-approved" type="button" data-tab="approved">
            <i class="bi bi-check-circle"></i> 承認済み
          </button>
        </li>
        <li class="nav-item">
          <button class="nav-link" data-bs-toggle="tab" data-bs-target="#br-tab-rejected" type="button" data-tab="rejected">
            <i class="bi bi-x-circle"></i> 却下済み
          </button>
        </li>
      </ul>
      <div class="tab-content">
        <div class="tab-pane fade show active" id="br-tab-pending">
          <div id="brList">読み込み中...</div>
        </div>
        <div class="tab-pane fade" id="br-tab-approved">
          <div id="brListApproved" class="text-muted small">タブを開くと読み込みます</div>
        </div>
        <div class="tab-pane fade" id="br-tab-rejected">
          <div id="brListRejected" class="text-muted small">タブを開くと読み込みます</div>
        </div>
      </div>
    `;
    this._bindTabs(container);
    await this._load("pending");
  },

  _bindTabs(container) {
    container.querySelectorAll('#brTabs button[data-tab]').forEach((btn) => {
      btn.addEventListener("shown.bs.tab", () => {
        const tab = btn.dataset.tab;
        this.state.tab = tab;
        this._load(tab);
      });
    });
  },

  async _getIdToken() {
    return firebase.auth().currentUser.getIdToken();
  },

  _targetElId(tab) {
    if (tab === "approved") return "brListApproved";
    if (tab === "rejected") return "brListRejected";
    return "brList";
  },

  async _load(tab) {
    const elId = this._targetElId(tab);
    const el = document.getElementById(elId);
    if (el) el.innerHTML = '<div class="text-muted text-center py-4">読み込み中...</div>';
    try {
      const idToken = await this._getIdToken();
      const res = await fetch(`${this.CF_BASE}/booking-requests?status=${encodeURIComponent(tab)}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const items = await res.json();
      this.state.items = items;
      this._renderList(tab, items);
      if (tab === "pending") {
        const summary = document.getElementById("brSummary");
        if (summary) summary.textContent = `未対応 ${items.length} 件`;
      }
    } catch (e) {
      console.error("[booking-requests] load error:", e);
      if (el) el.innerHTML = `<div class="alert alert-danger">読み込みに失敗しました: ${this._esc(e.message || String(e))}</div>`;
    }
  },

  _renderList(tab, items) {
    const el = document.getElementById(this._targetElId(tab));
    if (!el) return;
    if (!items || items.length === 0) {
      const label = tab === "pending" ? "未対応のリクエストはありません" : tab === "approved" ? "承認済みのリクエストはありません" : "却下済みのリクエストはありません";
      el.innerHTML = `<div class="text-muted text-center py-4">${label}</div>`;
      return;
    }
    el.innerHTML = items.map((x) => this._renderCard(x, tab)).join("");
    if (tab === "pending") {
      el.querySelectorAll(".br-approve").forEach((btn) => {
        btn.addEventListener("click", () => this._onApprove(btn.dataset.id));
      });
      el.querySelectorAll(".br-reject").forEach((btn) => {
        btn.addEventListener("click", () => this._onReject(btn.dataset.id));
      });
    }
  },

  _renderCard(x, tab) {
    const planLabel = x.plan === "nonrefundable" ? "返金不可プラン" : "スタンダード";
    const elapsed = this._elapsedLabel(x.createdAt);
    const statusBadge = tab === "approved"
      ? '<span class="badge bg-success">承認済み</span>'
      : tab === "rejected"
        ? '<span class="badge bg-secondary">却下済み</span>'
        : '<span class="badge bg-warning text-dark">未対応</span>';

    const actionsHtml = tab === "pending"
      ? `
        <div class="mt-2 d-flex gap-2">
          <button class="btn btn-sm btn-success br-approve" data-id="${this._esc(x.id)}">
            <i class="bi bi-check-lg"></i> 承認する
          </button>
          <button class="btn btn-sm btn-outline-danger br-reject" data-id="${this._esc(x.id)}">
            <i class="bi bi-x-lg"></i> 却下する
          </button>
        </div>`
      : tab === "rejected" && x.rejectReason
        ? `<div class="mt-2 small text-muted"><i class="bi bi-chat-left-text"></i> 却下理由: ${this._esc(x.rejectReason)}</div>`
        : "";

    return `
      <div class="card mb-2" data-request-id="${this._esc(x.id)}">
        <div class="card-body py-2">
          <div class="d-flex justify-content-between align-items-start">
            <div>
              <div class="fw-bold">${this._esc(x.propertyName || x.propertyId || "-")} ${statusBadge}</div>
              <div class="small text-muted">${this._esc(x.checkIn || "-")} 〜 ${this._esc(x.checkOut || "-")}（${this._esc(String(x.guestCount || "-"))}名 / ${planLabel}）</div>
            </div>
            <div class="text-muted small text-end">${elapsed}</div>
          </div>
          <div class="mt-2 small">
            <div><i class="bi bi-person"></i> ${this._esc(x.guestName || "-")}</div>
            <div><i class="bi bi-envelope"></i> ${this._esc(x.email || "-")}</div>
            ${x.notes ? `<div class="mt-1"><i class="bi bi-chat-left-text"></i> ${this._esc(x.notes)}</div>` : ""}
          </div>
          ${actionsHtml}
        </div>
      </div>`;
  },

  async _onApprove(id) {
    const x = this.state.items.find((i) => i.id === id);
    if (!x) return;
    const ok = await showConfirm(
      `承認して予約を確定しますか？OTAカレンダーに反映されます。\n\n${x.propertyName || x.propertyId}\n${x.checkIn} 〜 ${x.checkOut}（${x.guestCount || "-"}名）\nお名前: ${x.guestName}`,
      { title: "予約リクエストの承認", okLabel: "承認する", okClass: "btn-success" }
    );
    if (!ok) return;

    const card = document.querySelector(`[data-request-id="${CSS.escape(id)}"]`);
    const buttons = card ? card.querySelectorAll("button") : [];
    buttons.forEach((b) => (b.disabled = true));

    try {
      const idToken = await this._getIdToken();
      const res = await fetch(`${this.CF_BASE}/booking-requests/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err.error === "selected_dates_unavailable") {
          throw new Error("この日程は既に別の予約で埋まっています (承認できません)");
        }
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      showToast("承認完了", `${x.guestName || "リクエスト"} の予約を確定しました`, "success");
      await this._load("pending");
    } catch (e) {
      buttons.forEach((b) => (b.disabled = false));
      await showAlert(`承認に失敗しました: ${e.message || e}`);
    }
  },

  async _onReject(id) {
    const x = this.state.items.find((i) => i.id === id);
    if (!x) return;
    const reason = await showPrompt(
      `却下理由（任意・ゲストへの案内文に反映されます）:\n\n${x.propertyName || x.propertyId}\n${x.checkIn} 〜 ${x.checkOut}`,
      { title: "予約リクエストの却下", okLabel: "却下する", defaultValue: "" }
    );
    if (reason === null) return; // キャンセル

    const card = document.querySelector(`[data-request-id="${CSS.escape(id)}"]`);
    const buttons = card ? card.querySelectorAll("button") : [];
    buttons.forEach((b) => (b.disabled = true));

    try {
      const idToken = await this._getIdToken();
      const res = await fetch(`${this.CF_BASE}/booking-requests/${encodeURIComponent(id)}/reject`, {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      showToast("却下しました", `${x.guestName || "リクエスト"} を却下しました`, "success");
      await this._load("pending");
    } catch (e) {
      buttons.forEach((b) => (b.disabled = false));
      await showAlert(`却下処理に失敗しました: ${e.message || e}`);
    }
  },

  _elapsedLabel(createdAt) {
    const ms = this._toMs(createdAt);
    if (!ms) return "-";
    const diffMin = Math.floor((Date.now() - ms) / 60000);
    if (diffMin < 1) return "たった今";
    if (diffMin < 60) return `${diffMin}分前`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}時間前`;
    const diffD = Math.floor(diffH / 24);
    return `${diffD}日前`;
  },

  _toMs(v) {
    if (!v) return 0;
    if (typeof v.toMillis === "function") return v.toMillis();
    if (v._seconds) return v._seconds * 1000;
    if (v instanceof Date) return v.getTime();
    return 0;
  },

  _esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },

  cleanup() {},
};
