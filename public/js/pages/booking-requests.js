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
      <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
        <h4 class="mb-0"><i class="bi bi-inbox"></i> 直接予約リクエスト</h4>
        <span class="text-muted small" id="brSummary">読み込み中...</span>
        <div class="ms-sm-auto d-flex gap-2">
          <a href="https://dashboard.stripe.com/acct_1Tqet7AoOutkYY4H/payments" target="_blank" rel="noopener" class="btn btn-sm btn-outline-primary" title="小町・若草の決済（個人事業アカウント）">
            <i class="bi bi-credit-card"></i> Stripe（個人）
          </a>
          <a href="https://dashboard.stripe.com/acct_1TIZYiIpGeRzVeLg/payments" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary" title="テラス等の決済（合同会社八朔アカウント）">
            <i class="bi bi-credit-card"></i> Stripe（八朔）
          </a>
        </div>
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
    if (tab === "approved") {
      el.querySelectorAll(".br-refund").forEach((btn) => {
        btn.addEventListener("click", () => this._onRefund(btn.dataset.id));
      });
    }
  },

  // 決済ステータスのラベル / Bootstrap カラークラス (直接予約のみで意味を持つ)
  // 全6状態: unconfigured / pending / paid / expired / refunded / partially_refunded
  _PAYMENT_META: {
    unconfigured: { label: "未設定", cls: "bg-secondary" },
    pending: { label: "支払い待ち", cls: "bg-warning text-dark" },
    paid: { label: "支払い済み", cls: "bg-success" },
    expired: { label: "期限切れ", cls: "bg-danger" },
    payment_failed: { label: "支払い失敗", cls: "bg-danger" },
    refunded: { label: "返金済み", cls: "bg-secondary" },
    partially_refunded: { label: "一部返金", cls: "bg-warning text-dark" },
  },

  // 決済バッジ HTML。amountPaid / amountRefunded を併記する。
  _paymentBadge(x) {
    const st = x.paymentStatus || "unconfigured";
    const meta = this._PAYMENT_META[st] || this._PAYMENT_META.unconfigured;
    const sess = x.paymentSession || {};
    const parts = [`<span class="badge ${meta.cls}"><i class="bi bi-credit-card"></i> ${meta.label}</span>`];
    // amountPaid 欠落時は承認時合計 (sess.amount) にフォールバック (支払い済みバッジ時のみ意味を持つ)
    const paidDisp = Number(sess.amountPaid) || Number(sess.amount) || 0;
    if (paidDisp) parts.push(`<span class="small text-muted">入金 ¥${paidDisp.toLocaleString("ja-JP")}</span>`);
    if (sess.amountRefunded) parts.push(`<span class="small text-muted">返金 ¥${Number(sess.amountRefunded).toLocaleString("ja-JP")}</span>`);
    return `<span class="d-inline-flex align-items-center gap-1 flex-wrap ms-1">${parts.join(" ")}</span>`;
  },

  // 返金可能な状態か (API 側の許可条件と一致させる: paid / partially_refunded のみ)
  _canRefund(x) {
    return x.paymentStatus === "paid" || x.paymentStatus === "partially_refunded";
  },

  _renderCard(x, tab) {
    const planLabel = x.plan === "nonrefundable" ? "返金不可プラン" : "スタンダード";
    const elapsed = this._elapsedLabel(x.createdAt);
    const statusBadge = tab === "approved"
      ? '<span class="badge bg-success">承認済み</span>'
      : tab === "rejected"
        ? '<span class="badge bg-secondary">却下済み</span>'
        : '<span class="badge bg-warning text-dark">未対応</span>';

    // 要チェックフラグ (男性・20代・5名以上): カードを視覚的に目立たせる
    const requiresReview = x.requiresReview === true;
    const reviewBadge = requiresReview
      ? '<span class="badge bg-danger ms-1"><i class="bi bi-exclamation-triangle-fill"></i> 要チェック</span>'
      : "";
    const reviewAlertHtml = requiresReview
      ? `<div class="alert alert-danger py-1 px-2 mb-2 small"><i class="bi bi-exclamation-triangle-fill"></i> 要チェック（男性・20代・5名以上）</div>`
      : "";

    // 決済バッジは直接予約 (bookingRequests は全て直接予約) の承認済み以降でのみ意味を持つ。
    // pending タブは決済未生成なので出さない。
    const paymentBadge = (tab !== "pending" && x.paymentStatus)
      ? this._paymentBadge(x)
      : "";

    // 返金ボタン: paid / partially_refunded かつ承認済みタブ、オーナー本人のみ (API は role==="owner" 必須)
    const canRefund = tab === "approved" && this._canRefund(x)
      && (typeof Auth !== "undefined") && Auth?.isOwner?.() && !Auth?.isSubOwner?.();

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
        : canRefund
          ? `
        <div class="mt-2">
          <button class="btn btn-sm btn-outline-danger br-refund" data-id="${this._esc(x.id)}">
            <i class="bi bi-arrow-counterclockwise"></i> 返金する
          </button>
        </div>`
          : "";

    // 人数内訳 (大人/子ども/乳幼児)。adults 未設定の旧データは guestCount のみ表示にフォールバック。
    const breakdownLabel = this._guestBreakdownLabel(x);

    return `
      <div class="card mb-2 ${requiresReview ? "border-danger" : ""}" data-request-id="${this._esc(x.id)}">
        <div class="card-body py-2">
          ${reviewAlertHtml}
          <div class="d-flex justify-content-between align-items-start">
            <div>
              <div class="fw-bold">${this._esc(x.propertyName || x.propertyId || "-")} ${statusBadge}${reviewBadge}</div>
              <div class="small text-muted">${this._esc(x.checkIn || "-")} 〜 ${this._esc(x.checkOut || "-")}（${this._esc(String(x.guestCount || "-"))}名${breakdownLabel ? ` / ${breakdownLabel}` : ""} / ${planLabel}）</div>
              ${paymentBadge ? `<div class="small mt-1">${paymentBadge}</div>` : ""}
            </div>
            <div class="text-muted small text-end">${elapsed}</div>
          </div>
          <div class="mt-2 small">
            <div><i class="bi bi-person"></i> ${this._esc(x.guestName || "-")}</div>
            <div><i class="bi bi-envelope"></i> ${this._esc(x.email || "-")}</div>
            ${x.age ? `<div><i class="bi bi-person-badge"></i> 年代: ${this._esc(x.age)}</div>` : ""}
            ${x.gender ? `<div><i class="bi bi-gender-ambiguous"></i> 性別: ${this._esc(x.gender)}</div>` : ""}
            ${x.nationality ? `<div><i class="bi bi-flag"></i> 国籍: ${this._esc(x.nationality)}</div>` : ""}
            ${x.memberComposition ? `<div><i class="bi bi-people"></i> メンバー構成: ${this._esc(x.memberComposition)}</div>` : ""}
            ${x.banquetAcknowledged ? `<div><i class="bi bi-check2-circle"></i> 宴会・騒ぎ禁止に同意済み</div>` : ""}
            ${x.notes ? `<div class="mt-1"><i class="bi bi-chat-left-text"></i> ${this._esc(x.notes)}</div>` : ""}
          </div>
          ${actionsHtml}
        </div>
      </div>`;
  },

  // 人数内訳の表示文字列 (例: "大人2 子ども1 乳幼児1")。adults 未設定 (旧データ) は空文字を返す。
  _guestBreakdownLabel(x) {
    if (x.adults == null) return "";
    const parts = [`大人${x.adults}`];
    if (x.children) parts.push(`子ども${x.children}`);
    if (x.infants) parts.push(`乳幼児${x.infants}`);
    return parts.join(" ");
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

  // 返金額 (円) + 理由 を入力するモーダル。OK 時 { amount, reason } を返す (キャンセルは null)。
  // amount は「全額」チェック時 null (= API 側が全額返金)、部分返金時は正の整数。
  _showRefundModal(x) {
    return new Promise((resolve) => {
      const sess = x.paymentSession || {};
      // amountPaid は webhook (checkout.session.completed) が書く。未達/古いドット記法で欠落する場合は
      // 承認時に確定した合計 (sess.amount = Checkout Session の請求額) にフォールバックして
      // 入金額表示と上限検証を機能させる (最終的な過大返金拒否は Stripe 実額でもサーバー側でも二重に行う)。
      const paid = Number(sess.amountPaid) || Number(sess.amount) || 0;
      const refunded = Number(sess.amountRefunded) || 0;
      const remaining = Math.max(0, paid - refunded); // 返金可能な残額
      const modalId = `refundModal_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const html = `
        <div class="modal fade" id="${modalId}" tabindex="-1">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title"><i class="bi bi-arrow-counterclockwise"></i> 返金</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
              </div>
              <div class="modal-body">
                <div class="small text-muted mb-2">
                  ${this._esc(x.propertyName || x.propertyId || "")}<br>
                  ${this._esc(x.checkIn || "-")} 〜 ${this._esc(x.checkOut || "-")}（${this._esc(x.guestName || "-")}）
                </div>
                <div class="small mb-3">
                  入金額: <strong>¥${paid.toLocaleString("ja-JP")}</strong>
                  ${refunded ? ` / 返金済: <strong>¥${refunded.toLocaleString("ja-JP")}</strong> / 残額: <strong>¥${remaining.toLocaleString("ja-JP")}</strong>` : ""}
                </div>
                <div class="form-check mb-2">
                  <input class="form-check-input" type="checkbox" id="${modalId}_full" checked>
                  <label class="form-check-label" for="${modalId}_full">全額返金${remaining ? `（¥${remaining.toLocaleString("ja-JP")}）` : ""}</label>
                </div>
                <div class="mb-2" id="${modalId}_amountWrap" style="display:none;">
                  <label class="form-label small mb-1">返金額（円・部分返金）</label>
                  <input type="number" class="form-control" id="${modalId}_amount" min="1" ${remaining ? `max="${remaining}"` : ""} placeholder="例: ${remaining || 1000}">
                </div>
                <div class="mb-1">
                  <label class="form-label small mb-1">返金理由（任意）</label>
                  <input type="text" class="form-control" id="${modalId}_reason" placeholder="例: ゲスト都合キャンセル（キャンセル料相殺後）">
                </div>
              </div>
              <div class="modal-footer">
                <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">キャンセル</button>
                <button type="button" class="btn btn-danger" data-role="ok"><i class="bi bi-arrow-counterclockwise"></i> 返金内容を確認</button>
              </div>
            </div>
          </div>
        </div>`;
      document.body.insertAdjacentHTML("beforeend", html);
      const el = document.getElementById(modalId);
      const modal = new bootstrap.Modal(el);
      const fullChk = el.querySelector(`#${modalId}_full`);
      const amountWrap = el.querySelector(`#${modalId}_amountWrap`);
      const amountInput = el.querySelector(`#${modalId}_amount`);
      const reasonInput = el.querySelector(`#${modalId}_reason`);
      fullChk.addEventListener("change", () => {
        amountWrap.style.display = fullChk.checked ? "none" : "block";
        if (!fullChk.checked) amountInput.focus();
      });
      let result = null;
      el.querySelector('[data-role="ok"]').addEventListener("click", () => {
        const reason = reasonInput.value.trim();
        if (fullChk.checked) {
          result = { amount: null, reason };
        } else {
          const amt = Math.floor(Number(amountInput.value));
          if (!Number.isFinite(amt) || amt <= 0) {
            amountInput.classList.add("is-invalid");
            return;
          }
          if (remaining && amt > remaining) {
            amountInput.classList.add("is-invalid");
            return;
          }
          result = { amount: amt, reason };
        }
        modal.hide();
      });
      el.addEventListener("hidden.bs.modal", () => { resolve(result); el.remove(); });
      modal.show();
    });
  },

  async _onRefund(id) {
    const x = this.state.items.find((i) => i.id === id);
    if (!x) return;
    if (!this._canRefund(x)) {
      await showAlert("この予約は返金できる状態ではありません");
      return;
    }

    const input = await this._showRefundModal(x);
    if (input === null) return; // キャンセル

    const amountLabel = input.amount == null
      ? "全額"
      : `¥${Number(input.amount).toLocaleString("ja-JP")}`;
    const ok = await showConfirm(
      `以下の内容で返金を実行します。よろしいですか？\n\n${x.propertyName || x.propertyId}\n${x.checkIn} 〜 ${x.checkOut}（${x.guestName || "-"}）\n返金額: ${amountLabel}${input.reason ? `\n理由: ${input.reason}` : ""}`,
      { title: "返金の確認", okLabel: "返金を実行", okClass: "btn-danger" }
    );
    if (!ok) return;

    const card = document.querySelector(`[data-request-id="${CSS.escape(id)}"]`);
    const buttons = card ? card.querySelectorAll("button") : [];
    buttons.forEach((b) => (b.disabled = true));

    try {
      const idToken = await this._getIdToken();
      const payload = {};
      if (input.amount != null) payload.amount = input.amount;
      if (input.reason) payload.reason = input.reason;
      const res = await fetch(`${this.CF_BASE}/booking-requests/${encodeURIComponent(id)}/refund`, {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      // paymentStatus の即時書き換えはしない (実データ更新は charge.refunded webhook が担う)。
      showToast(
        "返金を受け付けました",
        "反映は Stripe からの通知（webhook）で自動更新されます",
        "success"
      );
      // 一覧再取得はせず (webhook 反映前は状態が変わらないため)、ボタンのみ再有効化。
      buttons.forEach((b) => (b.disabled = false));
    } catch (e) {
      buttons.forEach((b) => (b.disabled = false));
      await showAlert(`返金に失敗しました: ${e.message || e}`);
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
