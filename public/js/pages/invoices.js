/**
 * 請求書管理ページ
 * 月次集計・生成・明細表示・ステータス管理（draft→confirmed→paid）
 */
const InvoicesPage = {
  invoices: [],
  staffList: [],
  properties: [],           // 物件一覧
  selectedPropertyIds: [],  // 物件フィルタ選択中の物件ID
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

      <!-- 物件フィルタ -->
      <div id="propEyeFilterHost-invoices"></div>

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
      const [staffList, properties] = await Promise.all([
        API.staff.list(false),
        API.properties.listMinpakuNumbered(),
      ]);
      this.staffList = staffList;
      this.properties = properties;
      this.selectedPropertyIds = properties.map(p => p.id);

      // 物件フィルタ描画 (目アイコン型で統一)
      this._propEyeCtrl = PropertyEyeFilter.render({
        containerId: "propEyeFilterHost-invoices",
        tabKey: "invoices",
        properties: properties,
        onChange: (visibleIds) => {
          this.selectedPropertyIds = visibleIds;
          this.renderSummary();
          this.renderList();
        },
      });

      await this.loadInvoices();
    } catch (e) {
      showToast("エラー", `データ読み込み失敗: ${e.message}`, "error");
    }
  },

  async loadInvoices() {
    try {
      this.invoices = await API.invoices.list({ yearMonth: this.selectedMonth });
      // impersonation 中: 物件オーナー所有物件に該当する請求書のみ表示
      if (typeof App !== "undefined" && App.impersonating && App.impersonatingData) {
        const owned = new Set(App.impersonatingData.ownedPropertyIds || []);
        this.invoices = this.invoices.filter(inv => {
          // トップレベル propertyId
          if (inv.propertyId && owned.has(inv.propertyId)) return true;
          // byProperty[*].propertyId
          const byProp = Array.isArray(inv.byProperty) ? inv.byProperty : [];
          if (byProp.some(bp => bp && owned.has(bp.propertyId))) return true;
          // details / items から推定 (後方互換)
          const details = inv.details || {};
          const shifts = Array.isArray(details.shifts) ? details.shifts : [];
          if (shifts.some(s => s && owned.has(s.propertyId))) return true;
          return false;
        });
      }
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

    // 物件フィルタ: スタッフの assignedPropertyIds で絞り込む
    const filteredInvoices = this.selectedPropertyIds && this.selectedPropertyIds.length > 0
      ? this.invoices.filter(inv => {
          const staff = this.staffList.find(s => s.id === inv.staffId);
          if (!staff) return true;
          const assigned = Array.isArray(staff.assignedPropertyIds) ? staff.assignedPropertyIds : [];
          if (assigned.length === 0) return true; // 担当未設定は常に表示
          return assigned.some(pid => this.selectedPropertyIds.includes(pid));
        })
      : [];

    if (!filteredInvoices.length) {
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
              <th>対象物件</th>
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
            ${filteredInvoices.map(inv => this.renderRow(inv)).join("")}
          </tbody>
          <tfoot class="table-light">
            <tr>
              <th>合計</th>
              <th></th>
              <th class="text-end">${filteredInvoices.reduce((s, i) => s + (i.details?.shiftCount || 0), 0)}回</th>
              <th class="text-end">${formatCurrency(filteredInvoices.reduce((s, i) => s + (i.basePayment || 0), 0))}</th>
              <th class="text-end">${formatCurrency(filteredInvoices.reduce((s, i) => s + (i.laundryFee || 0), 0))}</th>
              <th class="text-end">${formatCurrency(filteredInvoices.reduce((s, i) => s + (i.transportationFee || 0), 0))}</th>
              <th class="text-end fw-bold">${formatCurrency(filteredInvoices.reduce((s, i) => s + (i.total || 0), 0))}</th>
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

    container.querySelectorAll(".btn-invoice-recalculate").forEach(btn => {
      btn.addEventListener("click", () => this.recalculateInvoice(btn.dataset.id));
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

    // 対象物件バッジ (byProperty から物件IDを抽出して番号バッジ表示)
    const byProperty = inv.byProperty || {};
    const propBadges = Object.keys(byProperty).map(pid => {
      const p = (this.properties || []).find(pp => pp.id === pid);
      if (!p) return `<span class="badge bg-secondary me-1" title="${this.esc(byProperty[pid]?.propertyName || pid)}">?</span>`;
      return `<span class="badge me-1" style="background:${p._color || "#6c757d"};color:#fff;min-width:22px;" title="${this.esc(p.name)}">${p._num || "-"}</span>`;
    }).join("") || '<span class="text-muted small">-</span>';

    return `
      <tr>
        <td><strong>${this.esc(inv.staffName || inv.staffId)}</strong></td>
        <td>${propBadges}</td>
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
            ${["draft", "submitted"].includes(inv.status) ? `
              <button class="btn btn-outline-warning btn-invoice-recalculate" data-id="${inv.id}" title="再計算">
                <i class="bi bi-arrow-clockwise"></i>
              </button>
            ` : ""}
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
    const special = details.special || [];
    const manualItems = details.manualItems || [];
    const byProperty = inv.byProperty || {};
    const isOwner = Auth.currentUser?.role === "owner";

    document.getElementById("invoiceDetailTitle").textContent =
      `${inv.staffName || inv.staffId} — ${inv.yearMonth}`;

    const fmtDate = (val) => {
      if (!val) return "";
      const d = val.toDate ? val.toDate() : (val.seconds ? new Date(val.seconds * 1000) : new Date(val));
      return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
    };

    // 物件別内訳 HTML
    const byPropertyEntries = Object.entries(byProperty);
    const byPropertyHtml = byPropertyEntries.length ? `
      <h6><i class="bi bi-building"></i> 物件別内訳</h6>
      <table class="table table-sm table-bordered mb-3">
        <thead class="table-light">
          <tr><th>物件</th><th class="text-end">清掃回数</th><th class="text-end">清掃報酬</th><th class="text-end">ランドリー</th><th class="text-end fw-bold">小計</th></tr>
        </thead>
        <tbody>
          ${byPropertyEntries.map(([pid, bp]) => {
            const p = (this.properties || []).find(pp => pp.id === pid);
            const label = p
              ? `${renderPropertyNumberBadge(p)}${this.esc(p.name)}`
              : this.esc(bp.propertyName || pid);
            return `
            <tr>
              <td>${label}</td>
              <td class="text-end">${bp.shiftCount || 0}回</td>
              <td class="text-end">${formatCurrency(bp.shiftAmount || 0)}</td>
              <td class="text-end">${formatCurrency(bp.laundryAmount || 0)}</td>
              <td class="text-end fw-bold">${formatCurrency(bp.total || 0)}</td>
            </tr>
          `;
          }).join("")}
        </tbody>
      </table>
    ` : "";

    document.getElementById("invoiceDetailBody").innerHTML = `
      <div class="row mb-3">
        <div class="col-6">
          <strong>スタッフ:</strong> ${this.esc(inv.staffName || inv.staffId)}<br>
          <strong>対象月:</strong> ${this.esc(inv.yearMonth)}<br>
          <strong>ステータス:</strong> ${this.getStatusBadge(inv.status)}
        </div>
        <div class="col-6 text-end">
          <div class="fs-2 fw-bold text-primary">${formatCurrency(inv.total || 0)}</div>
          ${isOwner && ["draft", "submitted"].includes(inv.status) ? `
            <button class="btn btn-sm btn-outline-warning mt-1" id="btnRecalcModal" data-id="${inv.id}">
              <i class="bi bi-arrow-clockwise"></i> 再計算
            </button>
          ` : ""}
        </div>
      </div>

      ${byPropertyHtml}

      <!-- 清掃明細 -->
      <h6><i class="bi bi-calendar-check"></i> 作業明細（${shifts.length}件）</h6>
      ${shifts.length ? `
        <table class="table table-sm table-bordered mb-3">
          <thead class="table-light">
            <tr><th>日付</th><th>物件</th><th>種別</th><th class="text-end">報酬</th></tr>
          </thead>
          <tbody>
            ${shifts.map(s => {
              const typeLabel = {
                cleaning_by_count: "清掃", pre_inspection: "直前点検", other: "その他",
                laundry_put_out: "ランドリー出し", laundry_collected: "ランドリー受取", laundry_expense: "ランドリー立替",
              }[s.workType] || s.workType || "清掃";
              let detail = "";
              if (s.isTimee && s.timeeDetail) {
                const td = s.timeeDetail;
                detail = `<br><small class="text-info">${td.start}〜${td.end}(${td.durationH}h) × ¥${(td.hourlyRate||0).toLocaleString()}/h</small>`;
              } else if (s.guestCount > 1) {
                detail = `<small class="text-muted"> (ゲスト${s.guestCount}名)</small>`;
              }
              const sp = (this.properties || []).find(pp => pp.id === s.propertyId);
              const sLabel = sp
                ? `${renderPropertyNumberBadge(sp)}${this.esc(sp.name)}`
                : this.esc(s.propertyName || "-");
              return `
              <tr>
                <td>${this.esc(fmtDate(s.date))}</td>
                <td>${sLabel}${detail}</td>
                <td><span class="badge bg-secondary">${typeLabel}</span>${s.isTimee ? ' <span class="badge bg-info text-dark">タイミー</span>' : ""}</td>
                <td class="text-end">${formatCurrency(s.amount || 0)}</td>
              </tr>`;
            }).join("")}
          </tbody>
          <tfoot class="table-light">
            <tr><th colspan="3">小計</th><th class="text-end">${formatCurrency(inv.basePayment || 0)}</th></tr>
          </tfoot>
        </table>
      ` : '<p class="text-muted small">清掃なし</p>'}

      <!-- 特別加算明細 -->
      ${special.length ? `
        <h6><i class="bi bi-star-fill text-warning"></i> 特別加算（${special.length}件）</h6>
        <table class="table table-sm table-bordered mb-3">
          <thead class="table-light">
            <tr><th>日付</th><th>名称</th><th class="text-end">加算額</th></tr>
          </thead>
          <tbody>
            ${special.map(sp => `
              <tr>
                <td>${this.esc(fmtDate(sp.date) || sp.dateStr || "")}</td>
                <td>${this.esc(sp.name || "(特別加算)")}</td>
                <td class="text-end text-warning fw-bold">+${formatCurrency(sp.amount || 0)}</td>
              </tr>
            `).join("")}
          </tbody>
          <tfoot class="table-light">
            <tr><th colspan="2">小計</th><th class="text-end">${formatCurrency(inv.specialAllowance || 0)}</th></tr>
          </tfoot>
        </table>
      ` : ""}

      <!-- ランドリー立替明細 -->
      ${laundry.length ? `
        <h6><i class="bi bi-water"></i> ランドリー立替（${laundry.length}件）</h6>
        <table class="table table-sm table-bordered mb-3">
          <thead class="table-light">
            <tr><th>日付</th><th>メモ</th><th class="text-end">金額</th></tr>
          </thead>
          <tbody>
            ${laundry.map(l => `
              <tr>
                <td>${this.esc(fmtDate(l.date))}</td>
                <td>${this.esc(l.memo || "")}</td>
                <td class="text-end">${formatCurrency(l.amount || 0)}</td>
              </tr>
            `).join("")}
          </tbody>
          <tfoot class="table-light">
            <tr><th colspan="2">小計</th><th class="text-end">${formatCurrency(inv.laundryFee || 0)}</th></tr>
          </tfoot>
        </table>
      ` : ""}

      <!-- 手動追加項目 -->
      <div class="d-flex justify-content-between align-items-center mb-2">
        <h6 class="mb-0"><i class="bi bi-plus-circle"></i> 手動追加項目</h6>
        ${isOwner ? `
          <button class="btn btn-outline-secondary btn-sm" id="btnAddManualItem" data-inv-id="${inv.id}">
            <i class="bi bi-plus"></i> 項目を追加
          </button>
        ` : ""}
      </div>
      <table class="table table-sm table-bordered mb-3">
        <thead class="table-light">
          <tr><th>項目名</th><th class="text-end">金額</th>${isOwner ? "<th></th>" : ""}</tr>
        </thead>
        <tbody id="manualItemsBody">
          ${manualItems.length ? manualItems.map((item, idx) => `
            <tr>
              <td>${this.esc(item.label)}${item.memo ? `<br><small class="text-muted">${this.esc(item.memo)}</small>` : ""}</td>
              <td class="text-end">${formatCurrency(item.amount || 0)}</td>
              ${isOwner ? `
                <td class="text-center">
                  <button class="btn btn-outline-danger btn-xs btn-delete-manual-item" data-inv-id="${inv.id}" data-index="${idx}" style="padding:1px 6px;font-size:0.75rem;">
                    <i class="bi bi-trash"></i>
                  </button>
                </td>
              ` : ""}
            </tr>
          `).join("") : `<tr><td colspan="${isOwner ? 3 : 2}" class="text-muted text-center small">手動追加項目なし</td></tr>`}
        </tbody>
        ${manualItems.length ? `
          <tfoot class="table-light">
            <tr>
              <th>小計</th>
              <th class="text-end">${formatCurrency(manualItems.reduce((s, i) => s + (i.amount || 0), 0))}</th>
              ${isOwner ? "<th></th>" : ""}
            </tr>
          </tfoot>
        ` : ""}
      </table>

      <!-- 合計 -->
      <table class="table table-bordered">
        <tbody>
          <tr><td>基本報酬（清掃）</td><td class="text-end">${formatCurrency(inv.basePayment || 0)}</td></tr>
          ${special.length ? `<tr><td>特別加算合計</td><td class="text-end text-warning">${formatCurrency(inv.specialAllowance || 0)}</td></tr>` : ""}
          <tr><td>ランドリー立替</td><td class="text-end">${formatCurrency(inv.laundryFee || 0)}</td></tr>
          <tr><td>交通費</td><td class="text-end">${formatCurrency(inv.transportationFee || 0)}</td></tr>
          ${manualItems.length ? `<tr><td>手動追加項目</td><td class="text-end">${formatCurrency(manualItems.reduce((s, i) => s + (i.amount || 0), 0))}</td></tr>` : ""}
          <tr class="table-primary fw-bold"><td>合計</td><td class="text-end">${formatCurrency(inv.total || 0)}</td></tr>
        </tbody>
      </table>

      ${isOwner && ["draft", "submitted"].includes(inv.status) ? `
        <!-- 記録情報（Webアプリ管理者のみ編集可） -->
        <hr>
        <h6><i class="bi bi-pencil-square"></i> 記録情報</h6>
        <div class="row g-2 mb-2">
          <div class="col-6">
            <label class="form-label small mb-1">交通費（円）</label>
            <input type="number" class="form-control form-control-sm" id="editTransportationFee"
              value="${inv.transportationFee || 0}" min="0" step="100">
          </div>
        </div>
        <div class="mb-2">
          <label class="form-label small mb-1">備考 (remarks)</label>
          <input type="text" class="form-control form-control-sm" id="editRemarks"
            value="${this.esc(inv.remarks || "")}" placeholder="社内メモなど">
        </div>
        <div class="mb-2">
          <label class="form-label small mb-1">メモ (memo)</label>
          <textarea class="form-control form-control-sm" id="editMemo" rows="2"
            placeholder="スタッフへの連絡事項など">${this.esc(inv.memo || "")}</textarea>
        </div>
        <button class="btn btn-primary btn-sm" id="btnSaveRecordInfo" data-inv-id="${inv.id}">
          <i class="bi bi-floppy"></i> 記録情報を保存
        </button>
      ` : ""}
    `;

    // 再計算ボタン
    const btnRecalc = document.getElementById("btnRecalcModal");
    if (btnRecalc) {
      btnRecalc.addEventListener("click", () => this.recalculateInvoice(btnRecalc.dataset.id));
    }

    // 記録情報保存ボタン
    const btnSave = document.getElementById("btnSaveRecordInfo");
    if (btnSave) {
      btnSave.addEventListener("click", () => this.saveRecordInfo(inv));
    }

    // 項目追加ボタン
    const btnAdd = document.getElementById("btnAddManualItem");
    if (btnAdd) {
      btnAdd.addEventListener("click", () => this.addManualItem(inv));
    }

    // 項目削除ボタン
    document.querySelectorAll(".btn-delete-manual-item").forEach(btn => {
      btn.addEventListener("click", () => {
        const invId = btn.dataset.invId;
        const index = parseInt(btn.dataset.index, 10);
        this.deleteManualItem(invId, index, inv);
      });
    });

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
    const ok = await showConfirm(`${this.selectedMonth} の請求書を生成しますか？\n報酬単価マスタ・ランドリー立替・特別加算から自動集計します。`, "月次集計・生成");
    if (!ok) return;

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
    const ok = await showConfirm(`${inv?.staffName || ""} の請求書を確認済みにしますか？`, "確認済みにする");
    if (!ok) return;
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
    const ok = await showConfirm(`${inv?.staffName || ""} の請求書を支払済みにしますか？`, "支払済みにする");
    if (!ok) return;
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
    const ok = await showConfirm(`${inv?.staffName || ""} の請求書を削除しますか？`, "削除の確認");
    if (!ok) return;
    try {
      await API.invoices.delete(id);
      showToast("完了", "削除しました", "success");
      await this.loadInvoices();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  async recalculateInvoice(id) {
    const inv = this.invoices.find(i => i.id === id);
    const ok = await showConfirm(`${inv?.staffName || ""} の請求書を最新の報酬単価マスタから再計算しますか？\n手動追加項目は保持されます。`, "再計算");
    if (!ok) return;
    try {
      const result = await API.invoices.recalculate(id);
      showToast("完了", `再計算完了 合計: ${formatCurrency(result.total)}`, "success");
      const modalEl = document.getElementById("invoiceDetailModal");
      bootstrap.Modal.getInstance(modalEl)?.hide();
      await this.loadInvoices();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  async addManualItem(inv) {
    const result = await showPrompt("項目名を入力してください:", "手動項目を追加");
    if (result === null) return;
    const label = result.trim();
    if (!label) return;
    const amountResult = await showPrompt("金額を入力してください（円）:", "手動項目を追加");
    if (amountResult === null) return;
    const amount = parseInt(amountResult.replace(/,/g, ""), 10);
    if (isNaN(amount)) {
      showToast("エラー", "金額は数値で入力してください", "error");
      return;
    }
    try {
      await API.invoices.addItem(inv.id, { label, amount });
      showToast("完了", "項目を追加しました", "success");
      const modalEl = document.getElementById("invoiceDetailModal");
      bootstrap.Modal.getInstance(modalEl)?.hide();
      await this.loadInvoices();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  async deleteManualItem(invId, index, inv) {
    const ok = await showConfirm(`「${inv.details?.manualItems?.[index]?.label || "この項目"}」を削除しますか？`, "項目削除");
    if (!ok) return;
    try {
      await API.invoices.deleteItem(invId, index);
      showToast("完了", "項目を削除しました", "success");
      const modalEl = document.getElementById("invoiceDetailModal");
      bootstrap.Modal.getInstance(modalEl)?.hide();
      await this.loadInvoices();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  async saveRecordInfo(inv) {
    const transportationFee = parseInt(document.getElementById("editTransportationFee")?.value || "0", 10);
    const remarks = document.getElementById("editRemarks")?.value ?? "";
    const memo = document.getElementById("editMemo")?.value ?? "";

    const btn = document.getElementById("btnSaveRecordInfo");
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 保存中...'; }

    try {
      await API.invoices.update(inv.id, { transportationFee, remarks, memo });
      showToast("完了", "記録情報を保存しました", "success");
      // モーダルを閉じて一覧を再読み込み
      const modalEl = document.getElementById("invoiceDetailModal");
      bootstrap.Modal.getInstance(modalEl)?.hide();
      await this.loadInvoices();
    } catch (e) {
      showToast("エラー", `保存失敗: ${e.message}`, "error");
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-floppy"></i> 記録情報を保存'; }
    }
  },

  esc(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  },
};
