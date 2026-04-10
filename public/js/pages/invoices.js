/**
 * 請求書管理ページ
 * 月次集計・生成・明細表示・ステータス管理（draft→confirmed→paid）
 */
const InvoicesPage = {
  invoices: [],
  staffList: [],
  selectedMonth: "",
  detailModal: null,

  async render(container) {
    const now = new Date();
    this.selectedMonth = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");

    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-receipt"></i> 請求書管理</h2>
        <div class="d-flex gap-2">
          <input type="month" class="form-control form-control-sm" id="invoiceMonth" style="width:160px;">
          <button class="btn btn-primary btn-sm" id="btnGenerateInvoices">
            <i class="bi bi-calculator"></i> 月次集計・生成
          </button>
        </div>
      </div>

      <!-- サマリーカード -->
      <div class="row g-3 mb-3" id="invoiceSummary"></div>

      <!-- 請求書一覧 -->
      <div id="invoiceList">
        <div class="text-center py-4">
          <div class="spinner-border text-primary" role="status"></div>
          <p class="mt-2 text-muted">読み込み中...</p>
        </div>
      </div>
    `;

    document.getElementById("invoiceMonth").value = this.selectedMonth;
    document.getElementById("invoiceMonth").addEventListener("change", (e) => {
      this.selectedMonth = e.target.value;
      this.loadInvoices();
    });

    document.getElementById("btnGenerateInvoices").addEventListener("click", () => {
      this.generateInvoices();
    });

    await this.loadData();
  },

  async loadData() {
    try {
      this.staffList = await API.staff.list(false);
      await this.loadInvoices();
    } catch (e) {
      showToast("エラー", `データ読み込み失敗: ${e.message}`, "error");
    }
  },

  async loadInvoices() {
    try {
      this.invoices = await API.invoices.list({ yearMonth: this.selectedMonth });
      this.renderSummary();
      this.renderList();
    } catch (e) {
      showToast("エラー", `請求書読み込み失敗: ${e.message}`, "error");
    }
  },

  renderSummary() {
    const container = document.getElementById("invoiceSummary");
    const total = this.invoices.reduce((s, i) => s + (i.total || 0), 0);
    const draftCount = this.invoices.filter(i => i.status === "draft").length;
    const confirmedCount = this.invoices.filter(i => i.status === "confirmed").length;
    const paidCount = this.invoices.filter(i => i.status === "paid").length;

    container.innerHTML = `
      <div class="col-6 col-md-3">
        <div class="card card-stat primary">
          <div class="card-body py-2">
            <div class="text-muted small">合計金額</div>
            <div class="fs-4 fw-bold">${formatCurrency(total)}</div>
          </div>
        </div>
      </div>
      <div class="col-6 col-md-3">
        <div class="card card-stat warning">
          <div class="card-body py-2">
            <div class="text-muted small">下書き</div>
            <div class="fs-4 fw-bold">${draftCount}件</div>
          </div>
        </div>
      </div>
      <div class="col-6 col-md-3">
        <div class="card card-stat success">
          <div class="card-body py-2">
            <div class="text-muted small">確認済み</div>
            <div class="fs-4 fw-bold">${confirmedCount}件</div>
          </div>
        </div>
      </div>
      <div class="col-6 col-md-3">
        <div class="card card-stat danger">
          <div class="card-body py-2">
            <div class="text-muted small">支払済み</div>
            <div class="fs-4 fw-bold">${paidCount}件</div>
          </div>
        </div>
      </div>
    `;
  },

  renderList() {
    const container = document.getElementById("invoiceList");

    if (!this.invoices.length) {
      container.innerHTML = `
        <div class="empty-state">
          <i class="bi bi-receipt"></i>
          <p>${this.selectedMonth} の請求書がありません</p>
          <p class="small text-muted">「月次集計・生成」ボタンで作成できます</p>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="table-responsive">
        <table class="table table-hover align-middle">
          <thead class="table-light">
            <tr>
              <th>スタッフ</th>
              <th class="text-end">清掃回数</th>
              <th class="text-end">基本報酬</th>
              <th class="text-end">ランドリー</th>
              <th class="text-end">交通費</th>
              <th class="text-end fw-bold">合計</th>
              <th>ステータス</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${this.invoices.map(inv => this.renderRow(inv)).join("")}
          </tbody>
          <tfoot class="table-light">
            <tr>
              <th>合計</th>
              <th class="text-end">${this.invoices.reduce((s, i) => s + (i.details?.shiftCount || 0), 0)}回</th>
              <th class="text-end">${formatCurrency(this.invoices.reduce((s, i) => s + (i.basePayment || 0), 0))}</th>
              <th class="text-end">${formatCurrency(this.invoices.reduce((s, i) => s + (i.laundryFee || 0), 0))}</th>
              <th class="text-end">${formatCurrency(this.invoices.reduce((s, i) => s + (i.transportationFee || 0), 0))}</th>
              <th class="text-end fw-bold">${formatCurrency(this.invoices.reduce((s, i) => s + (i.total || 0), 0))}</th>
              <th></th>
              <th></th>
            </tr>
          </tfoot>
        </table>
      </div>
    `;

    // 行クリックイベント
    container.querySelectorAll(".btn-invoice-detail").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const inv = this.invoices.find(i => i.id === id);
        if (inv) this.openDetailModal(inv);
      });
    });

    container.querySelectorAll(".btn-invoice-confirm").forEach(btn => {
      btn.addEventListener("click", () => this.confirmInvoice(btn.dataset.id));
    });

    container.querySelectorAll(".btn-invoice-paid").forEach(btn => {
      btn.addEventListener("click", () => this.markPaid(btn.dataset.id));
    });

    container.querySelectorAll(".btn-invoice-delete").forEach(btn => {
      btn.addEventListener("click", () => this.deleteInvoice(btn.dataset.id));
    });
  },

  renderRow(inv) {
    const statusBadge = {
      draft: '<span class="badge bg-secondary">下書き</span>',
      pending: '<span class="badge bg-warning text-dark">確認待ち</span>',
      confirmed: '<span class="badge bg-success">確認済み</span>',
      paid: '<span class="badge bg-primary">支払済み</span>',
    }[inv.status] || `<span class="badge bg-secondary">${this.esc(inv.status)}</span>`;

    const shiftCount = inv.details?.shiftCount || inv.details?.shifts?.length || 0;

    return `
      <tr>
        <td><strong>${this.esc(inv.staffName || inv.staffId)}</strong></td>
        <td class="text-end">${shiftCount}回</td>
        <td class="text-end">${formatCurrency(inv.basePayment || 0)}</td>
        <td class="text-end">${formatCurrency(inv.laundryFee || 0)}</td>
        <td class="text-end">${formatCurrency(inv.transportationFee || 0)}</td>
        <td class="text-end fw-bold">${formatCurrency(inv.total || 0)}</td>
        <td>${statusBadge}</td>
        <td>
          <div class="btn-group btn-group-sm">
            <button class="btn btn-outline-primary btn-invoice-detail" data-id="${inv.id}" title="詳細">
              <i class="bi bi-eye"></i>
            </button>
            ${inv.status === "draft" ? `
              <button class="btn btn-outline-success btn-invoice-confirm" data-id="${inv.id}" title="確認済みにする">
                <i class="bi bi-check-lg"></i>
              </button>
            ` : ""}
            ${inv.status === "confirmed" ? `
              <button class="btn btn-outline-primary btn-invoice-paid" data-id="${inv.id}" title="支払済みにする">
                <i class="bi bi-cash-coin"></i>
              </button>
            ` : ""}
            ${inv.status === "draft" ? `
              <button class="btn btn-outline-danger btn-invoice-delete" data-id="${inv.id}" title="削除">
                <i class="bi bi-trash"></i>
              </button>
            ` : ""}
          </div>
        </td>
      </tr>
    `;
  },

  openDetailModal(inv) {
    let modalEl = document.getElementById("invoiceDetailModal");
    if (!modalEl) {
      const div = document.createElement("div");
      div.innerHTML = `
        <div class="modal fade" id="invoiceDetailModal" tabindex="-1">
          <div class="modal-dialog modal-lg">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title" id="invoiceDetailTitle"></h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
              </div>
              <div class="modal-body" id="invoiceDetailBody"></div>
            </div>
          </div>
        </div>`;
      document.body.appendChild(div.firstElementChild);
      modalEl = document.getElementById("invoiceDetailModal");
    }

    const details = inv.details || {};
    const shifts = details.shifts || [];
    const laundry = details.laundry || [];

    document.getElementById("invoiceDetailTitle").textContent =
      `${inv.staffName || inv.staffId} — ${inv.yearMonth}`;

    document.getElementById("invoiceDetailBody").innerHTML = `
      <div class="row mb-3">
        <div class="col-6">
          <strong>スタッフ:</strong> ${this.esc(inv.staffName || inv.staffId)}<br>
          <strong>対象月:</strong> ${this.esc(inv.yearMonth)}<br>
          <strong>ステータス:</strong> ${this.getStatusBadge(inv.status)}
        </div>
        <div class="col-6 text-end">
          <div class="fs-2 fw-bold text-primary">${formatCurrency(inv.total || 0)}</div>
        </div>
      </div>

      <h6><i class="bi bi-calendar-check"></i> 清掃明細（${shifts.length}回）</h6>
      ${shifts.length ? `
        <table class="table table-sm table-bordered mb-3">
          <thead class="table-light">
            <tr><th>日付</th><th>物件</th><th class="text-end">報酬</th></tr>
          </thead>
          <tbody>
            ${shifts.map(s => `
              <tr>
                <td>${this.esc(s.date || "")}</td>
                <td>${this.esc(s.propertyName || "-")}</td>
                <td class="text-end">${formatCurrency(s.amount || 0)}</td>
              </tr>
            `).join("")}
          </tbody>
          <tfoot class="table-light">
            <tr><th colspan="2">小計</th><th class="text-end">${formatCurrency(inv.basePayment || 0)}</th></tr>
          </tfoot>
        </table>
      ` : '<p class="text-muted small">清掃なし</p>'}

      ${laundry.length ? `
        <h6><i class="bi bi-water"></i> ランドリー明細（${laundry.length}件）</h6>
        <table class="table table-sm table-bordered mb-3">
          <thead class="table-light">
            <tr><th>日付</th><th class="text-end">金額</th></tr>
          </thead>
          <tbody>
            ${laundry.map(l => `
              <tr>
                <td>${this.esc(l.date || "")}</td>
                <td class="text-end">${formatCurrency(l.amount || 0)}</td>
              </tr>
            `).join("")}
          </tbody>
          <tfoot class="table-light">
            <tr><th>小計</th><th class="text-end">${formatCurrency(inv.laundryFee || 0)}</th></tr>
          </tfoot>
        </table>
      ` : ""}

      <table class="table table-bordered">
        <tbody>
          <tr><td>基本報酬（${details.ratePerJob ? formatCurrency(details.ratePerJob) + " × " + shifts.length + "回" : ""}）</td><td class="text-end">${formatCurrency(inv.basePayment || 0)}</td></tr>
          <tr><td>ランドリー</td><td class="text-end">${formatCurrency(inv.laundryFee || 0)}</td></tr>
          <tr><td>交通費（${details.transportPerShift ? formatCurrency(details.transportPerShift) + " × " + shifts.length + "回" : ""}）</td><td class="text-end">${formatCurrency(inv.transportationFee || 0)}</td></tr>
          <tr><td>特別手当</td><td class="text-end">${formatCurrency(inv.specialAllowance || 0)}</td></tr>
          <tr class="table-primary fw-bold"><td>合計</td><td class="text-end">${formatCurrency(inv.total || 0)}</td></tr>
        </tbody>
      </table>
    `;

    new bootstrap.Modal(modalEl).show();
  },

  getStatusBadge(status) {
    const map = {
      draft: '<span class="badge bg-secondary">下書き</span>',
      pending: '<span class="badge bg-warning text-dark">確認待ち</span>',
      confirmed: '<span class="badge bg-success">確認済み</span>',
      paid: '<span class="badge bg-primary">支払済み</span>',
    };
    return map[status] || `<span class="badge bg-secondary">${status}</span>`;
  },

  async generateInvoices() {
    if (!this.selectedMonth) {
      showToast("エラー", "対象月を選択してください", "error");
      return;
    }
    if (!confirm(`${this.selectedMonth} の請求書を生成しますか？\n確定済み募集とランドリー記録から自動集計します。`)) return;

    try {
      const btn = document.getElementById("btnGenerateInvoices");
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 生成中...';

      const result = await API.invoices.generate(this.selectedMonth);
      showToast("完了", `${result.created}件の請求書を生成しました${result.skipped ? `（${result.skipped}件は既存のためスキップ）` : ""}`, "success");
      await this.loadInvoices();
    } catch (e) {
      showToast("エラー", `生成失敗: ${e.message}`, "error");
    } finally {
      const btn = document.getElementById("btnGenerateInvoices");
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-calculator"></i> 月次集計・生成';
    }
  },

  async confirmInvoice(id) {
    const inv = this.invoices.find(i => i.id === id);
    if (!confirm(`${inv?.staffName || ""} の請求書を確認済みにしますか？`)) return;
    try {
      await API.invoices.confirm(id);
      showToast("完了", "確認済みにしました", "success");
      await this.loadInvoices();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  async markPaid(id) {
    const inv = this.invoices.find(i => i.id === id);
    if (!confirm(`${inv?.staffName || ""} の請求書を支払済みにしますか？`)) return;
    try {
      await API.invoices.markPaid(id);
      showToast("完了", "支払済みにしました", "success");
      await this.loadInvoices();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  async deleteInvoice(id) {
    const inv = this.invoices.find(i => i.id === id);
    if (!confirm(`${inv?.staffName || ""} の請求書を削除しますか？`)) return;
    try {
      await API.invoices.delete(id);
      showToast("完了", "削除しました", "success");
      await this.loadInvoices();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  esc(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  },
};
