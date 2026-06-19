/**
 * 収支ページ
 * 月別収支サマリー・費目管理・清掃費明細・Drive取り込み
 */
const PnlPage = {
  properties: [],
  selectedPropertyId: null,
  TERRACE_PID: "tsZybhDMcPrxqgcRy7wp",

  // 検索範囲（YYYY-MM）
  fromYM: "",
  toYM: "",

  // APIレスポンスキャッシュ
  summaryData: null,  // { months:[], categories:[] }

  // モーダルインスタンス
  _cleaningModal: null,
  _bookingModal: null,
  _catModal: null,

  // 清掃費モーダル用の現在表示中の年月・物件
  _cleaningYM: null,
  _cleaningData: null,  // GET /pnl/:propertyId/:yearMonth のレスポンス

  async render(container) {
    // デフォルト期間: 直近12ヶ月
    const now = new Date();
    const to = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const fromDate = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const from = `${fromDate.getFullYear()}-${String(fromDate.getMonth() + 1).padStart(2, "0")}`;
    this.fromYM = this.fromYM || from;
    this.toYM = this.toYM || to;

    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-graph-up-arrow"></i> 収支</h2>
      </div>

      <!-- 物件スイッチャ -->
      <div id="pnlPropSwitcher" class="mb-3"></div>

      <!-- ヘッダコントロール -->
      <div class="card mb-3">
        <div class="card-body py-2">
          <div class="d-flex flex-wrap align-items-center gap-2">
            <label class="form-label mb-0 small text-muted">期間:</label>
            <input type="month" class="form-control form-control-sm" id="pnlFrom" value="${this.escapeHtml(this.fromYM)}" style="width:140px">
            <span class="text-muted small">〜</span>
            <input type="month" class="form-control form-control-sm" id="pnlTo" value="${this.escapeHtml(this.toYM)}" style="width:140px">
            <button class="btn btn-sm btn-primary" id="btnPnlLoad">
              <i class="bi bi-arrow-clockwise"></i> 読み込み
            </button>
            <div class="ms-auto d-flex gap-2 flex-wrap">
              <button class="btn btn-sm btn-outline-secondary" id="btnPnlRecalc">
                <i class="bi bi-calculator"></i> 宿泊日数/清掃回数を再集計
              </button>
              <button class="btn btn-sm btn-outline-info" id="btnPnlCategories">
                <i class="bi bi-tags"></i> 費目設定
              </button>
              <button class="btn btn-sm btn-outline-success" id="btnPnlImport">
                <i class="bi bi-cloud-download"></i> Drive取り込み
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 月別収支テーブル -->
      <div class="card mb-4">
        <div class="card-header">
          <i class="bi bi-table"></i> 月別収支
        </div>
        <div class="card-body p-0">
          <div class="table-responsive">
            <div id="pnlTableWrap">
              <div class="text-center py-5 text-muted">
                <i class="bi bi-arrow-up-circle fs-3 d-block mb-2"></i>
                物件と期間を選択して「読み込み」を押してください
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // モーダルHTML追加
    this._ensureModals();

    this.bindEvents();
    await this.loadProperties();
    // 物件が確定したら自動ロード
    if (this.selectedPropertyId) {
      await this.loadSummary();
    }
  },

  // ===== モーダル挿入 =====
  _ensureModals() {
    if (document.getElementById("pnlCleaningModal")) return;

    const html = `
      <!-- 清掃費明細モーダル -->
      <div class="modal fade" id="pnlCleaningModal" tabindex="-1">
        <div class="modal-dialog modal-lg modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-broom"></i> 清掃費明細</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body" id="pnlCleaningBody">
              <div class="text-center py-3"><div class="spinner-border text-primary"></div></div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-primary btn-sm" id="btnPnlAddCleaning">
                <i class="bi bi-plus-lg"></i> 手動行追加
              </button>
              <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">閉じる</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Booking明細モーダル -->
      <div class="modal fade" id="pnlBookingModal" tabindex="-1">
        <div class="modal-dialog modal-lg modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-calendar2-check"></i> Booking.com 予約明細</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body" id="pnlBookingBody">
              <div class="text-center py-3"><div class="spinner-border text-primary"></div></div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">閉じる</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 費目設定モーダル -->
      <div class="modal fade" id="pnlCatModal" tabindex="-1">
        <div class="modal-dialog modal-lg modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-tags"></i> 費目設定</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body" id="pnlCatBody">
              <div class="text-center py-3"><div class="spinner-border text-primary"></div></div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-primary btn-sm" id="btnPnlAddCat">
                <i class="bi bi-plus-lg"></i> 費目追加
              </button>
              <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">閉じる</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 売上手修正モーダル -->
      <div class="modal fade" id="pnlRevenueModal" tabindex="-1">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="pnlRevenueModalTitle"><i class="bi bi-pencil-square"></i> 売上修正</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <input type="hidden" id="pnlRevenueYM">
              <input type="hidden" id="pnlRevenueField">
              <p class="text-muted small">※ 手修正すると <strong>manualOverride</strong> フラグが立ち、自動計算より優先されます。</p>
              <div class="mb-3">
                <label class="form-label">金額 (円)</label>
                <input type="number" class="form-control" id="pnlRevenueAmount" min="0">
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">キャンセル</button>
              <button type="button" class="btn btn-primary btn-sm" id="btnPnlRevenueSave">保存</button>
            </div>
          </div>
        </div>
      </div>
    `;

    const div = document.createElement("div");
    div.innerHTML = html;
    document.body.appendChild(div);
  },

  // ===== 物件ロード & スイッチャ =====
  async loadProperties() {
    try {
      this.properties = (API.properties && typeof API.properties.listMinpakuNumbered === "function")
        ? await API.properties.listMinpakuNumbered() : [];
    } catch (_) {
      this.properties = [];
    }
    // サブオーナーフィルタ
    let owned = null;
    if (typeof App !== "undefined" && App.impersonating && App.impersonatingData) {
      owned = App.impersonatingData.ownedPropertyIds || [];
    } else if (typeof Auth !== "undefined" && Auth.isSubOwner && Auth.isSubOwner()) {
      owned = Array.isArray(Auth.currentUser?.ownedPropertyIds) ? Auth.currentUser.ownedPropertyIds : [];
    }
    if (owned) {
      const ownedSet = new Set(owned);
      this.properties = this.properties.filter(p => ownedSet.has(p.id));
    }
    if (this.properties.length > 0) {
      const terrace = this.properties.find(p => p.id === this.TERRACE_PID);
      this.selectedPropertyId = this.selectedPropertyId || (terrace ? terrace.id : this.properties[0].id);
    }
    this.renderPropSwitcher();
  },

  renderPropSwitcher() {
    const host = document.getElementById("pnlPropSwitcher");
    if (!host) return;
    if (this.properties.length === 0) { host.innerHTML = ""; return; }
    host.innerHTML = `
      <div class="d-flex align-items-center flex-wrap gap-2">
        <span class="text-muted small me-1"><i class="bi bi-building"></i> 物件:</span>
        ${this.properties.map(p => {
          const active = p.id === this.selectedPropertyId;
          return `<button type="button"
            class="btn btn-sm ${active ? "btn-primary" : "btn-outline-secondary"} btn-pnl-prop"
            data-prop-id="${this.escapeHtml(p.id)}">
            <span class="badge rounded-pill me-1" style="background:${p._color || "#6c757d"}">${p._num || ""}</span>${this.escapeHtml(p.name || "")}
          </button>`;
        }).join("")}
      </div>`;
    host.querySelectorAll(".btn-pnl-prop").forEach(btn => {
      btn.addEventListener("click", () => this.switchProperty(btn.dataset.propId));
    });
  },

  async switchProperty(propId) {
    if (propId === this.selectedPropertyId) return;
    this.selectedPropertyId = propId;
    this.summaryData = null;
    this.renderPropSwitcher();
    await this.loadSummary();
  },

  // ===== イベントバインド =====
  bindEvents() {
    document.getElementById("btnPnlLoad").addEventListener("click", async () => {
      this.fromYM = document.getElementById("pnlFrom").value;
      this.toYM = document.getElementById("pnlTo").value;
      await this.loadSummary();
    });

    document.getElementById("btnPnlRecalc").addEventListener("click", () => {
      this.recalcNightsAndCleaning();
    });

    document.getElementById("btnPnlCategories").addEventListener("click", () => {
      this.openCatModal();
    });

    document.getElementById("btnPnlImport").addEventListener("click", () => {
      this.runDriveImport();
    });
  },

  // ===== サマリーロード & テーブル描画 =====
  async loadSummary() {
    if (!this.selectedPropertyId) return;
    const wrap = document.getElementById("pnlTableWrap");
    if (!wrap) return;
    wrap.innerHTML = `<div class="text-center py-5"><div class="spinner-border text-primary"></div><p class="mt-2 text-muted small">集計中...</p></div>`;

    try {
      this.summaryData = await API.pnl.summary(this.selectedPropertyId, this.fromYM, this.toYM);
      this.renderTable();
    } catch (e) {
      wrap.innerHTML = `<div class="alert alert-danger m-3">集計エラー: ${this.escapeHtml(e.message)}</div>`;
    }
  },

  renderTable() {
    const wrap = document.getElementById("pnlTableWrap");
    if (!wrap || !this.summaryData) return;

    const { months, categories } = this.summaryData;
    if (!months || months.length === 0) {
      wrap.innerHTML = `<div class="text-center py-5 text-muted">対象期間にデータがありません</div>`;
      return;
    }

    // 動的費目列
    const cats = (categories || []).filter(c => c.active !== false);

    const th = (label, cls = "") => `<th class="text-nowrap ${cls}">${this.escapeHtml(label)}</th>`;

    const header = `
      <thead class="table-light" style="position:sticky;top:0;z-index:1;">
        <tr>
          ${th("年月", "text-center")}
          ${th("宿泊日数", "text-end")}
          ${th("清掃回数", "text-end")}
          ${th("売上(Airbnb)", "text-end")}
          ${th("売上(Booking)", "text-end")}
          ${th("売上合計", "text-end")}
          ${th("OTA手数料", "text-end")}
          ${th("清掃費", "text-end")}
          ${cats.map(c => th(c.name, "text-end")).join("")}
          ${th("費目計", "text-end")}
          ${th("利益", "text-end")}
          ${th("利益率", "text-end")}
        </tr>
      </thead>`;

    const rows = months.map(m => {
      const profitNeg = (m.profit || 0) < 0;
      const profitClass = profitNeg ? "text-danger fw-bold" : "";
      const rate = m.profitRate != null ? `${m.profitRate.toFixed(1)}%` : "-";

      const catCells = cats.map(c => {
        const exp = (m.expenses || []).find(e => e.catId === c.id);
        const amt = exp ? exp.amount : 0;
        return `<td class="text-end pnl-expense-cell"
          data-ym="${this.escapeHtml(m.yearMonth)}"
          data-cat-id="${this.escapeHtml(c.id)}"
          data-cat-name="${this.escapeHtml(c.name)}"
          style="cursor:pointer;white-space:nowrap;"
          title="クリックして手入力">${this.fmtYen(amt)}</td>`;
      }).join("");

      return `
        <tr>
          <td class="text-center fw-bold text-nowrap">${this.escapeHtml(m.yearMonth)}</td>
          <td class="text-end">${m.nights ?? "-"}</td>
          <td class="text-end">${m.cleaningCount ?? "-"}</td>
          <td class="text-end pnl-airbnb-cell" data-ym="${this.escapeHtml(m.yearMonth)}" style="cursor:pointer;" title="クリックして修正">${this.fmtYen(m.revenueAirbnb)}</td>
          <td class="text-end pnl-booking-cell" data-ym="${this.escapeHtml(m.yearMonth)}" style="cursor:pointer;" title="クリックして明細/修正">${this.fmtYen(m.revenueBooking)}</td>
          <td class="text-end fw-bold">${this.fmtYen(m.revenueGross)}</td>
          <td class="text-end text-muted">${this.fmtYen(m.otaFees)}</td>
          <td class="text-end pnl-cleaning-cell" data-ym="${this.escapeHtml(m.yearMonth)}" style="cursor:pointer;text-decoration:underline dotted;" title="クリックして明細">${this.fmtYen(m.cleaningTotal)}</td>
          ${catCells}
          <td class="text-end">${this.fmtYen(m.expensesTotal)}</td>
          <td class="text-end ${profitClass}">${this.fmtYen(m.profit)}</td>
          <td class="text-end ${profitNeg ? "text-danger" : ""}">${rate}</td>
        </tr>`;
    }).join("");

    // 合計行
    const totals = this._calcTotals(months, cats);
    const totCatCells = cats.map(c => `<td class="text-end fw-bold">${this.fmtYen(totals.catMap[c.id] || 0)}</td>`).join("");
    const totProfitNeg = totals.profit < 0;
    const totRate = totals.revenueGross > 0
      ? `${(totals.profit / totals.revenueGross * 100).toFixed(1)}%` : "-";

    const footer = `
      <tfoot class="table-secondary fw-bold" style="position:sticky;bottom:0;">
        <tr>
          <td class="text-center">合計</td>
          <td class="text-end">${totals.nights}</td>
          <td class="text-end">${totals.cleaningCount}</td>
          <td class="text-end">${this.fmtYen(totals.revenueAirbnb)}</td>
          <td class="text-end">${this.fmtYen(totals.revenueBooking)}</td>
          <td class="text-end">${this.fmtYen(totals.revenueGross)}</td>
          <td class="text-end">${this.fmtYen(totals.otaFees)}</td>
          <td class="text-end">${this.fmtYen(totals.cleaningTotal)}</td>
          ${totCatCells}
          <td class="text-end">${this.fmtYen(totals.expensesTotal)}</td>
          <td class="text-end ${totProfitNeg ? "text-danger" : ""}">${this.fmtYen(totals.profit)}</td>
          <td class="text-end ${totProfitNeg ? "text-danger" : ""}">${totRate}</td>
        </tr>
      </tfoot>`;

    wrap.innerHTML = `
      <table class="table table-hover table-bordered table-sm align-middle mb-0" style="font-size:0.85rem;">
        ${header}
        <tbody>${rows}</tbody>
        ${footer}
      </table>`;

    // セルクリックイベント
    wrap.querySelectorAll(".pnl-cleaning-cell").forEach(td => {
      td.addEventListener("click", () => this.openCleaningModal(td.dataset.ym));
    });

    wrap.querySelectorAll(".pnl-booking-cell").forEach(td => {
      td.addEventListener("click", () => this.openBookingModal(td.dataset.ym));
    });

    wrap.querySelectorAll(".pnl-expense-cell").forEach(td => {
      td.addEventListener("click", () => this.openExpenseInput(td.dataset.ym, td.dataset.catId, td.dataset.catName));
    });

    wrap.querySelectorAll(".pnl-airbnb-cell").forEach(td => {
      td.addEventListener("click", () => this.openRevenueModal(td.dataset.ym, "airbnb"));
    });
  },

  _calcTotals(months, cats) {
    const t = {
      nights: 0, cleaningCount: 0,
      revenueAirbnb: 0, revenueBooking: 0, revenueGross: 0,
      otaFees: 0, cleaningTotal: 0, expensesTotal: 0, profit: 0,
      catMap: {},
    };
    for (const c of cats) t.catMap[c.id] = 0;
    for (const m of months) {
      t.nights += m.nights || 0;
      t.cleaningCount += m.cleaningCount || 0;
      t.revenueAirbnb += m.revenueAirbnb || 0;
      t.revenueBooking += m.revenueBooking || 0;
      t.revenueGross += m.revenueGross || 0;
      t.otaFees += m.otaFees || 0;
      t.cleaningTotal += m.cleaningTotal || 0;
      t.expensesTotal += m.expensesTotal || 0;
      t.profit += m.profit || 0;
      for (const c of cats) {
        const exp = (m.expenses || []).find(e => e.catId === c.id);
        if (exp) t.catMap[c.id] = (t.catMap[c.id] || 0) + (exp.amount || 0);
      }
    }
    return t;
  },

  // ===== 清掃費明細モーダル =====
  async openCleaningModal(yearMonth) {
    this._cleaningYM = yearMonth;
    if (!this._cleaningModal) {
      this._cleaningModal = new bootstrap.Modal(document.getElementById("pnlCleaningModal"));
    }
    const body = document.getElementById("pnlCleaningBody");
    body.innerHTML = `<div class="text-center py-3"><div class="spinner-border text-primary"></div></div>`;
    this._cleaningModal.show();

    try {
      this._cleaningData = await API.pnl.getMonth(this.selectedPropertyId, yearMonth);
      this._renderCleaningBody();
    } catch (e) {
      body.innerHTML = `<div class="alert alert-danger">エラー: ${this.escapeHtml(e.message)}</div>`;
    }

    // 手動行追加ボタン
    const btnAdd = document.getElementById("btnPnlAddCleaning");
    if (btnAdd && !btnAdd._bound) {
      btnAdd._bound = true;
      btnAdd.addEventListener("click", () => this.addManualCleaningRow());
    }
  },

  _renderCleaningBody() {
    const body = document.getElementById("pnlCleaningBody");
    const costs = (this._cleaningData?.cleaningCosts || []);

    if (costs.length === 0) {
      body.innerHTML = `<p class="text-muted">清掃費データがありません。</p>`;
      return;
    }

    const rows = costs.map((row, idx) => {
      const isDrive = row.source === "drive";
      const excludedClass = row.excluded ? "table-secondary text-muted" : "";
      return `
        <tr class="${excludedClass}" data-row-id="${this.escapeHtml(row.id || String(idx))}">
          <td>
            <span class="badge ${isDrive ? "bg-info text-dark" : "bg-secondary"}">${isDrive ? "Drive" : "手動"}</span>
          </td>
          <td>
            <input type="text" class="form-control form-control-sm cleaning-staff-name"
              value="${this.escapeHtml(row.staffName || "")}" placeholder="スタッフ名">
          </td>
          <td>
            <input type="number" class="form-control form-control-sm cleaning-amount" style="width:100px"
              value="${row.amount || 0}" min="0">
          </td>
          <td class="text-center">
            <div class="form-check d-inline-block">
              <input class="form-check-input cleaning-excluded" type="checkbox" ${row.excluded ? "checked" : ""}
                title="除外">
            </div>
          </td>
          <td>
            <button class="btn btn-sm btn-outline-primary btn-cleaning-save" data-idx="${idx}">
              <i class="bi bi-check-lg"></i>
            </button>
            ${isDrive
              ? `<span class="text-muted small ms-1">削除はDrive行除外を使用</span>`
              : `<button class="btn btn-sm btn-outline-danger btn-cleaning-delete ms-1" data-idx="${idx}"><i class="bi bi-trash"></i></button>`
            }
          </td>
        </tr>`;
    }).join("");

    body.innerHTML = `
      <p class="text-muted small mb-2">
        <i class="bi bi-info-circle"></i>
        Drive取込行は「除外」チェックで集計から外せます。手動行は削除可能です。
      </p>
      <div class="table-responsive">
        <table class="table table-sm table-bordered align-middle">
          <thead class="table-light">
            <tr>
              <th>種別</th><th>スタッフ名</th><th>金額</th><th>除外</th><th></th>
            </tr>
          </thead>
          <tbody id="pnlCleaningRows">${rows}</tbody>
        </table>
      </div>`;

    // 保存ボタン
    body.querySelectorAll(".btn-cleaning-save").forEach(btn => {
      btn.addEventListener("click", () => this._saveCleaningRow(Number(btn.dataset.idx)));
    });
    // 削除ボタン
    body.querySelectorAll(".btn-cleaning-delete").forEach(btn => {
      btn.addEventListener("click", () => this._deleteCleaningRow(Number(btn.dataset.idx)));
    });
  },

  async _saveCleaningRow(idx) {
    const costs = this._cleaningData?.cleaningCosts || [];
    const row = costs[idx];
    if (!row) return;

    const tbody = document.getElementById("pnlCleaningRows");
    const tr = tbody.querySelectorAll("tr")[idx];
    if (!tr) return;

    const staffName = tr.querySelector(".cleaning-staff-name")?.value || "";
    const amount = Number(tr.querySelector(".cleaning-amount")?.value) || 0;
    const excluded = tr.querySelector(".cleaning-excluded")?.checked || false;

    try {
      await API.pnl.patchCleaning(this.selectedPropertyId, this._cleaningYM, row.id, { staffName, amount, excluded });
      showToast("保存", "清掃費を更新しました", "success");
      // データ更新してサマリーも再描画
      this._cleaningData = await API.pnl.getMonth(this.selectedPropertyId, this._cleaningYM);
      this._renderCleaningBody();
      await this.loadSummary();
    } catch (e) {
      showToast("エラー", `保存失敗: ${e.message}`, "error");
    }
  },

  async _deleteCleaningRow(idx) {
    const costs = this._cleaningData?.cleaningCosts || [];
    const row = costs[idx];
    if (!row) return;

    const ok = await showConfirm("削除確認", "この手動追加行を削除しますか？");
    if (!ok) return;

    try {
      await API.pnl.deleteCleaning(this.selectedPropertyId, this._cleaningYM, row.id);
      showToast("削除", "削除しました", "success");
      this._cleaningData = await API.pnl.getMonth(this.selectedPropertyId, this._cleaningYM);
      this._renderCleaningBody();
      await this.loadSummary();
    } catch (e) {
      showToast("エラー", `削除失敗: ${e.message}`, "error");
    }
  },

  async addManualCleaningRow() {
    const staffName = await showPrompt("スタッフ名（任意）", { title: "清掃費 手動追加", placeholder: "氏名" });
    if (staffName === null) return;
    const amtStr = await showPrompt("金額（円）", { title: "清掃費 手動追加", type: "number" });
    if (amtStr === null) return;
    const amount = Number(amtStr) || 0;

    try {
      await API.pnl.postCleaning(this.selectedPropertyId, this._cleaningYM, { staffName, amount });
      showToast("追加", "手動行を追加しました", "success");
      this._cleaningData = await API.pnl.getMonth(this.selectedPropertyId, this._cleaningYM);
      this._renderCleaningBody();
      await this.loadSummary();
    } catch (e) {
      showToast("エラー", `追加失敗: ${e.message}`, "error");
    }
  },

  // ===== Booking明細モーダル =====
  async openBookingModal(yearMonth) {
    if (!this._bookingModal) {
      this._bookingModal = new bootstrap.Modal(document.getElementById("pnlBookingModal"));
    }
    const body = document.getElementById("pnlBookingBody");
    body.innerHTML = `<div class="text-center py-3"><div class="spinner-border text-primary"></div></div>`;
    this._bookingModal.show();

    try {
      const data = await API.pnl.getMonth(this.selectedPropertyId, yearMonth);
      const details = data.bookingDetails || [];

      if (details.length === 0) {
        body.innerHTML = `<p class="text-muted">対象月の Booking.com 予約データがありません。</p>`;
        return;
      }

      const rows = details.map(d => `
        <tr>
          <td class="text-nowrap">${this.escapeHtml(d.reservationNumber || "-")}</td>
          <td class="text-nowrap">${this.escapeHtml(d.checkIn || "")}</td>
          <td class="text-nowrap">${this.escapeHtml(d.checkOut || "")}</td>
          <td>${this.escapeHtml(d.guestName || "")}</td>
          <td class="text-end">${this.fmtYen(d.amount)}</td>
          <td class="text-end">${this.fmtYen(d.commission)}</td>
          <td class="text-end">${this.fmtYen(d.paymentFee)}</td>
          <td class="text-end fw-bold">${this.fmtYen(d.netRevenue)}</td>
        </tr>`).join("");

      body.innerHTML = `
        <div class="table-responsive">
          <table class="table table-sm table-bordered align-middle" style="font-size:0.8rem;">
            <thead class="table-light">
              <tr>
                <th>照会番号</th><th>IN</th><th>OUT</th><th>氏名</th>
                <th class="text-end">金額</th><th class="text-end">手数料</th><th class="text-end">支払手数料</th><th class="text-end">純収益</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <p class="text-muted small mt-2">
          Booking.com 売上を手修正する場合は、メインテーブルの「売上(Booking)」セルをクリックしてください。
        </p>`;
    } catch (e) {
      body.innerHTML = `<div class="alert alert-danger">エラー: ${this.escapeHtml(e.message)}</div>`;
    }
  },

  // ===== 費目手入力 =====
  async openExpenseInput(yearMonth, catId, catName) {
    const current = this._getExpenseAmount(yearMonth, catId);
    const amtStr = await showPrompt(`${catName}（${yearMonth}）の金額`, { title: "費目入力", type: "number", defaultValue: current || 0 });
    if (amtStr === null) return;
    const amount = Number(amtStr) || 0;

    try {
      await API.pnl.putExpense(this.selectedPropertyId, yearMonth, catId, { amount });
      showToast("保存", `${catName} を更新しました`, "success");
      await this.loadSummary();
    } catch (e) {
      showToast("エラー", `保存失敗: ${e.message}`, "error");
    }
  },

  _getExpenseAmount(yearMonth, catId) {
    const month = (this.summaryData?.months || []).find(m => m.yearMonth === yearMonth);
    if (!month) return 0;
    const exp = (month.expenses || []).find(e => e.catId === catId);
    return exp ? (exp.amount || 0) : 0;
  },

  // ===== 売上手修正モーダル =====
  async openRevenueModal(yearMonth, field) {
    const modal = document.getElementById("pnlRevenueModal");
    if (!modal) return;
    const bsModal = bootstrap.Modal.getOrCreateInstance(modal);

    document.getElementById("pnlRevenueYM").value = yearMonth;
    document.getElementById("pnlRevenueField").value = field;
    document.getElementById("pnlRevenueModalTitle").innerHTML =
      `<i class="bi bi-pencil-square"></i> ${field === "airbnb" ? "Airbnb" : "Booking.com"} 売上修正 (${yearMonth})`;

    // 現在値をセット
    const month = (this.summaryData?.months || []).find(m => m.yearMonth === yearMonth);
    const cur = field === "airbnb" ? (month?.revenueAirbnb || 0) : (month?.revenueBooking || 0);
    document.getElementById("pnlRevenueAmount").value = cur;

    bsModal.show();

    const saveBtn = document.getElementById("btnPnlRevenueSave");
    // 古いリスナをクローン差替えで除去
    const fresh = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(fresh, saveBtn);
    fresh.addEventListener("click", async () => {
      const amount = Number(document.getElementById("pnlRevenueAmount").value) || 0;
      const patchData = field === "airbnb"
        ? { revenue: { airbnb: { grossRevenue: amount } } }
        : { revenue: { booking: { grossRevenue: amount } } };
      try {
        await API.pnl.patchMonth(this.selectedPropertyId, yearMonth, patchData);
        showToast("保存", "売上を更新しました", "success");
        bsModal.hide();
        await this.loadSummary();
      } catch (e2) {
        showToast("エラー", `保存失敗: ${e2.message}`, "error");
      }
    });
  },

  // ===== 費目設定モーダル =====
  async openCatModal() {
    if (!this._catModal) {
      this._catModal = new bootstrap.Modal(document.getElementById("pnlCatModal"));
    }
    const body = document.getElementById("pnlCatBody");
    body.innerHTML = `<div class="text-center py-3"><div class="spinner-border text-primary"></div></div>`;
    this._catModal.show();

    await this._loadAndRenderCats();

    const btnAdd = document.getElementById("btnPnlAddCat");
    if (btnAdd && !btnAdd._bound) {
      btnAdd._bound = true;
      btnAdd.addEventListener("click", () => this._showCatForm(null));
    }
  },

  async _loadAndRenderCats() {
    const body = document.getElementById("pnlCatBody");
    try {
      const cats = await API.pnl.getCategories();
      if (cats.length === 0) {
        body.innerHTML = `<p class="text-muted">費目がありません。「費目追加」で追加してください。</p>`;
        return;
      }

      const rows = cats.map(c => `
        <tr class="${c.active === false ? "table-secondary text-muted" : ""}">
          <td>${this.escapeHtml(c.name)}</td>
          <td><span class="badge ${c.type === "fixed" ? "bg-primary" : "bg-secondary"}">${c.type === "fixed" ? "定額" : "手入力"}</span></td>
          <td class="text-end">${c.type === "fixed" ? this.fmtYen(c.defaultAmount || 0) : "-"}</td>
          <td><small class="text-muted">${c.appliesTo === "all" ? "全物件" : this.escapeHtml(c.appliesTo || "")}</small></td>
          <td>
            <button class="btn btn-sm btn-outline-primary btn-cat-edit" data-cat-id="${this.escapeHtml(c.id)}">
              <i class="bi bi-pencil"></i>
            </button>
            <button class="btn btn-sm btn-outline-danger ms-1 btn-cat-delete" data-cat-id="${this.escapeHtml(c.id)}" data-cat-name="${this.escapeHtml(c.name)}">
              <i class="bi bi-trash"></i>
            </button>
          </td>
        </tr>`).join("");

      body.innerHTML = `
        <div class="table-responsive">
          <table class="table table-sm table-bordered align-middle">
            <thead class="table-light">
              <tr><th>費目名</th><th>種別</th><th class="text-end">既定額</th><th>対象</th><th></th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;

      body.querySelectorAll(".btn-cat-edit").forEach(btn => {
        btn.addEventListener("click", async () => {
          const cats2 = await API.pnl.getCategories();
          const cat = cats2.find(c => c.id === btn.dataset.catId);
          if (cat) this._showCatForm(cat);
        });
      });

      body.querySelectorAll(".btn-cat-delete").forEach(btn => {
        btn.addEventListener("click", async () => {
          const ok = await showConfirm("費目削除", `「${btn.dataset.catName}」を削除（非活性化）しますか？`);
          if (!ok) return;
          try {
            await API.pnl.deleteCategory(btn.dataset.catId);
            showToast("削除", "費目を削除しました", "success");
            await this._loadAndRenderCats();
            await this.loadSummary();
          } catch (e) {
            showToast("エラー", `削除失敗: ${e.message}`, "error");
          }
        });
      });
    } catch (e) {
      body.innerHTML = `<div class="alert alert-danger">エラー: ${this.escapeHtml(e.message)}</div>`;
    }
  },

  _showCatForm(cat) {
    const body = document.getElementById("pnlCatBody");
    const isEdit = !!cat;
    body.innerHTML = `
      <form id="pnlCatForm">
        <div class="row g-3">
          <div class="col-12">
            <label class="form-label">費目名 <span class="text-danger">*</span></label>
            <input type="text" class="form-control" id="catFormName" value="${this.escapeHtml(cat?.name || "")}" required>
          </div>
          <div class="col-md-6">
            <label class="form-label">種別</label>
            <select class="form-select" id="catFormType">
              <option value="fixed" ${cat?.type === "fixed" ? "selected" : ""}>定額（毎月同額）</option>
              <option value="manual" ${cat?.type !== "fixed" ? "selected" : ""}>手入力（月ごとに入力）</option>
            </select>
          </div>
          <div class="col-md-6" id="catFormDefaultAmtWrap" style="display:${cat?.type === "fixed" ? "" : "none"}">
            <label class="form-label">既定額（円）</label>
            <input type="number" class="form-control" id="catFormDefaultAmount" value="${cat?.defaultAmount || 0}" min="0">
          </div>
          <div class="col-md-6">
            <label class="form-label">対象</label>
            <select class="form-select" id="catFormAppliesTo">
              <option value="all" ${cat?.appliesTo === "all" || !cat?.appliesTo ? "selected" : ""}>全物件</option>
              <option value="${this.escapeHtml(this.selectedPropertyId || "")}" ${cat?.appliesTo && cat.appliesTo !== "all" ? "selected" : ""}>この物件のみ</option>
            </select>
          </div>
          <div class="col-md-6">
            <label class="form-label">表示順</label>
            <input type="number" class="form-control" id="catFormOrder" value="${cat?.displayOrder ?? 0}" min="0">
          </div>
        </div>
        <div class="mt-3 d-flex gap-2">
          <button type="submit" class="btn btn-primary btn-sm">${isEdit ? "更新" : "追加"}</button>
          <button type="button" class="btn btn-secondary btn-sm" id="btnCatFormCancel">キャンセル</button>
        </div>
      </form>`;

    // 種別変更で定額欄表示切替
    document.getElementById("catFormType").addEventListener("change", function() {
      document.getElementById("catFormDefaultAmtWrap").style.display = this.value === "fixed" ? "" : "none";
    });

    document.getElementById("btnCatFormCancel").addEventListener("click", () => this._loadAndRenderCats());

    document.getElementById("pnlCatForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = {
        name: document.getElementById("catFormName").value.trim(),
        type: document.getElementById("catFormType").value,
        defaultAmount: Number(document.getElementById("catFormDefaultAmount").value) || 0,
        appliesTo: document.getElementById("catFormAppliesTo").value || "all",
        displayOrder: Number(document.getElementById("catFormOrder").value) || 0,
      };
      if (!payload.name) { showToast("エラー", "費目名は必須です", "error"); return; }
      try {
        if (isEdit) {
          await API.pnl.updateCategory(cat.id, payload);
          showToast("更新", "費目を更新しました", "success");
        } else {
          await API.pnl.postCategory(payload);
          showToast("追加", "費目を追加しました", "success");
        }
        await this._loadAndRenderCats();
        await this.loadSummary();
      } catch (e2) {
        showToast("エラー", `保存失敗: ${e2.message}`, "error");
      }
    });
  },

  // ===== Drive取り込み =====
  async runDriveImport() {
    showToast("Drive取り込み", "ドライブをスキャン中...", "info");
    try {
      // ドライラン
      const preview = await API.pnl.importDrive({ dryRun: true });
      const items = preview.items || [];

      if (items.length === 0) {
        showToast("Drive取り込み", "新規取り込み対象のファイルがありません", "success");
        return;
      }

      // プレビューリスト生成
      const statusLabel = {
        preview: "取込予定",
        applied: "適用済",
        skipped_dup: "重複スキップ",
        skipped_other: "スキップ",
        unresolved: "物件未判定",
        error: "エラー",
      };
      const statusClass = {
        preview: "bg-success",
        applied: "bg-primary",
        skipped_dup: "bg-secondary",
        skipped_other: "bg-secondary",
        unresolved: "bg-warning text-dark",
        error: "bg-danger",
      };

      const rows = items.map(it => `
        <tr>
          <td class="small text-truncate" style="max-width:200px" title="${this.escapeHtml(it.fileName || "")}">${this.escapeHtml(it.fileName || "")}</td>
          <td><span class="badge ${statusClass[it.status] || "bg-secondary"}">${statusLabel[it.status] || it.status}</span></td>
          <td class="small">${this.escapeHtml(it.docKind || "")}</td>
          <td class="small">${this.escapeHtml(it.yearMonth || "")}</td>
        </tr>`).join("");

      const previewHtml = `
        <p>${preview.scanned ?? 0}件スキャン / <strong>${items.filter(i => i.status === "preview").length}件取込予定</strong></p>
        <div style="max-height:300px;overflow-y:auto;">
          <table class="table table-sm table-bordered" style="font-size:0.8rem;">
            <thead class="table-light"><tr><th>ファイル名</th><th>状態</th><th>種別</th><th>年月</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;

      const ok = await showConfirm("Drive取り込み確認", previewHtml);
      if (!ok) return;

      // 本実行
      const result = await API.pnl.importDrive({ dryRun: false });
      showToast(
        "Drive取り込み完了",
        `適用: ${result.applied ?? 0}件 / スキップ: ${result.skippedDup ?? 0}件 / エラー: ${result.errors ?? 0}件`,
        (result.errors > 0) ? "warning" : "success"
      );
      await this.loadSummary();
    } catch (e) {
      showToast("エラー", `Drive取り込み失敗: ${e.message}`, "error");
    }
  },

  // ===== 宿泊日数/清掃回数再集計 =====
  async recalcNightsAndCleaning() {
    if (!this.selectedPropertyId) return;
    const ok = await showConfirm("再集計", `${this.fromYM}〜${this.toYM} の宿泊日数・清掃回数を予約データから再集計しますか？`);
    if (!ok) return;

    try {
      showToast("再集計中", `${this.fromYM}〜${this.toYM} を処理中...`, "info");
      // from〜to の各月を順次再集計(bookings/shifts から nights/cleaningCount を計算)
      const months = this._enumerateMonths(this.fromYM, this.toYM);
      for (const ym of months) {
        await API.pnl.recalc(this.selectedPropertyId, ym);
      }
      showToast("完了", `${months.length}ヶ月を再集計しました`, "success");
      await this.loadSummary();
    } catch (e) {
      showToast("エラー", `再集計失敗: ${e.message}`, "error");
    }
  },

  // "2026-01" 〜 "2026-03" → ["2026-01","2026-02","2026-03"]
  _enumerateMonths(fromYM, toYM) {
    const out = [];
    const [fy, fm] = fromYM.split("-").map(Number);
    const [ty, tm] = toYM.split("-").map(Number);
    let y = fy, m = fm;
    while (y < ty || (y === ty && m <= tm)) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return out;
  },

  // ===== ユーティリティ =====
  fmtYen(v) {
    if (v == null || v === "") return "-";
    const n = Number(v);
    if (isNaN(n)) return "-";
    return `¥${n.toLocaleString("ja-JP")}`;
  },

  escapeHtml(s) {
    if (typeof window.escapeHtml === "function") return window.escapeHtml(s);
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");
  },

  selectedPropertyName() {
    const p = this.properties.find(x => x.id === this.selectedPropertyId);
    return p ? (p.name || "") : "";
  },
};
