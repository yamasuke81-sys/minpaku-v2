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
              <button class="btn btn-sm btn-success" id="btnPnlBatch">
                <i class="bi bi-magic"></i> 月次一括取込
              </button>
              <button class="btn btn-sm btn-outline-success" id="btnPnlOtaImport">
                <i class="bi bi-filetype-csv"></i> OTA CSV取込
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
              <button type="button" class="btn btn-outline-success btn-sm me-auto" id="btnPnlSeedCats">
                <i class="bi bi-stars"></i> 推奨費目を一括作成
              </button>
              <button type="button" class="btn btn-outline-primary btn-sm" id="btnPnlAddCat">
                <i class="bi bi-plus-lg"></i> 費目追加
              </button>
              <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">閉じる</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 帳票生成モーダル -->
      <div class="modal fade" id="pnlDocModal" tabindex="-1">
        <div class="modal-dialog modal-lg modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-file-earmark-text"></i> 月次帳票の生成 <span id="pnlDocTitle" class="text-muted small"></span></h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body" id="pnlDocBody">
              <div class="text-center py-3"><div class="spinner-border text-primary"></div></div>
            </div>
            <div class="modal-footer">
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

    document.getElementById("btnPnlOtaImport").addEventListener("click", () => {
      this.runOtaCsvImport();
    });

    document.getElementById("btnPnlBatch").addEventListener("click", () => {
      this.runMonthlyBatch();
    });
  },

  // 月次一括取込バッチを手動実行(全対象物件×指定月)
  async runMonthlyBatch() {
    const ym = await showPrompt("一括取込する年月（YYYY-MM）", { title: "月次一括取込", defaultValue: this.toYM || "" });
    if (ym == null) return;
    if (!/^\d{4}-\d{2}$/.test(ym)) { showToast("エラー", "YYYY-MM 形式で入力してください", "error"); return; }
    const ok = await showConfirm("月次一括取込", `${ym} の全対象物件について、売上・宿泊税・光熱費・領収書・清掃費を自動取込し、帳票の下書きを生成します。よろしいですか？（数分かかる場合があります）`);
    if (!ok) return;
    showToast("月次一括取込", `${ym} を処理中...`, "info");
    try {
      const r = await API.pnl.runMonthlyImport(ym);
      const lines = (r.results || []).map(x => {
        const s = x.steps || {};
        const ok2 = k => s[k] && !s[k].error;
        return `${x.property}: 売上${ok2("ota") ? "✓" : "—"} 宿泊税${ok2("tax") ? "✓" : "—"} 光熱${ok2("utilities") ? "✓" : "—"} 領収書${ok2("receipts") ? "✓" : "—"} 清掃${ok2("cleaning") ? "✓" : "—"} 報告書${ok2("report") ? "✓" : "—"}${s.settlement ? " 精算書" + (ok2("settlement") ? "✓" : "—") : ""}`;
      }).join("\n");
      await showAlert(`${ym} の一括取込が完了しました。\n\n${lines}\n\n各月の「帳票」→「出典・内訳を確認」で検算できます。`, { title: "完了" });
      await this.loadSummary();
    } catch (e) {
      showToast("エラー", `一括取込失敗: ${e.message}`, "error");
    }
  },

  // 選択中の物件オブジェクト(managementFeeRate等の参照用)
  selectedProperty() {
    return this.properties.find(p => p.id === this.selectedPropertyId) || null;
  },

  // 運営形態(summaryロード後に確定)。self=自社運営(代行なし) / agency_*=運営代行あり
  operationMode() {
    return (this.summaryData && this.summaryData.operationMode) || "agency_hassac";
  },
  isSelfOperated() {
    return this.operationMode() === "self";
  },
  isAgency() {
    return !this.isSelfOperated();
  },
  operationModeLabel() {
    const m = this.operationMode();
    if (m === "self") return "自社運営（代行なし）";
    if (m === "agency_other") return "運営代行あり（その他会社）";
    return "運営代行あり（八朔）";
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
    // 代行手数料列は「運営代行あり」の物件のみ表示(自社運営=代行なしは列ごと非表示)
    const agency = this.isAgency();

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
          ${agency ? th("代行手数料(税込)", "text-end") : ""}
          ${th("帳票", "text-center")}
        </tr>
      </thead>`;

    const rows = months.map(m => {
      const profitNeg = (m.profit || 0) < 0;
      const profitClass = profitNeg ? "text-danger fw-bold" : "";
      const rate = m.profitRate != null ? `${m.profitRate.toFixed(1)}%` : "-";
      // 代行手数料は精算書と同一式(実請求額・税込)。料率は月固定 or 物件既定
      const overridden = !!m.feeRateIsMonthOverride;
      const feeCell = agency ? `
          <td class="text-end text-primary text-nowrap">
            ${this.fmtYen(m.mgmtFeeInclTax)}
            <span class="pnl-feerate-chip badge ${overridden ? "bg-primary" : "bg-light text-secondary border"} ms-1"
              data-ym="${this.escapeHtml(m.yearMonth)}" style="cursor:pointer;font-weight:normal;"
              title="クリックしてこの月の料率を変更（空欄で既定に戻す）">${m.feeRatePct}%${overridden ? " 固定" : " 既定"}</span>
          </td>` : "";

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
          ${feeCell}
          <td class="text-center text-nowrap">
            <button class="btn btn-sm btn-outline-primary btn-pnl-doc" data-ym="${this.escapeHtml(m.yearMonth)}" title="帳票を生成">
              <i class="bi bi-file-earmark-text"></i>
            </button>
          </td>
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
          ${agency ? `<td class="text-end text-primary">${this.fmtYen(totals.mgmtFeeInclTax)}</td>` : ""}
          <td></td>
        </tr>
      </tfoot>`;

    // 運営形態バー(テーブル上部)。代行=既定料率の編集導線、自社=代行なしの注記
    const control = this._renderFeeControlBar();

    wrap.innerHTML = `
      ${control}
      <table class="table table-hover table-bordered table-sm align-middle mb-0" style="font-size:0.85rem;">
        ${header}
        <tbody>${rows}</tbody>
        ${footer}
      </table>`;

    // 月の料率チップ: クリックでその月だけ固定/解除
    wrap.querySelectorAll(".pnl-feerate-chip").forEach(el => {
      el.addEventListener("click", () => this.editMonthFeeRate(el.dataset.ym));
    });
    // 物件の既定料率を変更
    const dr = wrap.querySelector("#btnPnlDefaultRate");
    if (dr) dr.addEventListener("click", () => this.editDefaultFeeRate());

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

    wrap.querySelectorAll(".btn-pnl-doc").forEach(btn => {
      btn.addEventListener("click", () => this.openDocModal(btn.dataset.ym));
    });
  },

  // 運営形態バー(テーブル上部)
  _renderFeeControlBar() {
    if (this.isSelfOperated()) {
      return `<div class="px-2 py-2 border-bottom bg-light small text-muted">
        <i class="bi bi-house-check"></i> 運営形態: <b>自社運営（代行なし）</b> — 運営代行手数料は発生しません（精算書兼請求書なし・月次業務報告書は内部用に発行可）
      </div>`;
    }
    const defRate = this.summaryData?.managementFeeRate ?? 50;
    // 既定料率の変更はオーナーのみ(サブオーナーは月別の固定のみ可)
    const isSubOwner = (typeof Auth !== "undefined" && Auth.isSubOwner && Auth.isSubOwner());
    const editBtn = isSubOwner ? "" :
      `<button class="btn btn-sm btn-outline-primary py-0" id="btnPnlDefaultRate"><i class="bi bi-pencil"></i> 既定料率を変更</button>`;
    return `<div class="d-flex align-items-center flex-wrap gap-2 px-2 py-2 border-bottom bg-light small">
      <span class="text-muted"><i class="bi bi-briefcase"></i> 運営形態: <b>${this.escapeHtml(this.operationModeLabel())}</b></span>
      <span class="ms-2">既定料率: <b class="text-primary">${defRate}%</b></span>
      ${editBtn}
      <span class="text-muted ms-auto"><i class="bi bi-info-circle"></i> 各行の料率チップをクリックすると、その月だけ固定できます（税込＝実際の請求額）</span>
    </div>`;
  },

  // 月の代行手数料率を上書き/解除(空欄で物件既定に戻す)
  async editMonthFeeRate(yearMonth) {
    const m = (this.summaryData?.months || []).find(x => x.yearMonth === yearMonth);
    const isOverride = !!(m && m.feeRateIsMonthOverride);
    const input = await showPrompt(
      `${yearMonth} の運営代行料率（％）\n\n空欄にすると物件の既定料率（${this.summaryData?.managementFeeRate ?? 50}%）に戻します。`,
      { title: "この月の料率", defaultValue: isOverride && m ? String(m.feeRatePct) : "" });
    if (input === null) return; // キャンセル
    const trimmed = String(input).trim();
    let payload;
    if (trimmed === "") {
      payload = null; // 既定に戻す
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0 || n > 100) { showToast("エラー", "0〜100 の数値で入力してください", "error"); return; }
      payload = n;
    }
    try {
      await API.pnl.setFeeRate(this.selectedPropertyId, yearMonth, payload);
      showToast("料率更新", payload == null ? `${yearMonth} を既定料率に戻しました` : `${yearMonth} を ${payload}% に固定しました`, "success");
      await this.loadSummary();
    } catch (e) {
      showToast("エラー", `料率更新に失敗: ${e.message}`, "error");
    }
  },

  // 物件の既定料率を変更(月ごとに固定していない全月へ即反映)
  async editDefaultFeeRate() {
    const cur = this.summaryData?.managementFeeRate ?? 50;
    const input = await showPrompt(
      `この物件の既定の運営代行料率（％）\n\n月ごとに固定していない月へ即反映されます。`,
      { title: "既定料率を変更", defaultValue: String(cur) });
    if (input === null) return;
    const n = Number(String(input).trim());
    if (!Number.isFinite(n) || n < 0 || n > 100) { showToast("エラー", "0〜100 の数値で入力してください", "error"); return; }
    try {
      await API.properties.update(this.selectedPropertyId, { managementFeeRate: n });
      showToast("既定料率更新", `既定料率を ${n}% にしました`, "success");
      await this.loadSummary();
    } catch (e) {
      showToast("エラー", `更新に失敗: ${e.message}（既定料率の変更はオーナーのみ）`, "error");
    }
  },

  _calcTotals(months, cats) {
    const t = {
      nights: 0, cleaningCount: 0,
      revenueAirbnb: 0, revenueBooking: 0, revenueGross: 0,
      otaFees: 0, cleaningTotal: 0, expensesTotal: 0, profit: 0,
      mgmtFeeInclTax: 0,
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
      t.mgmtFeeInclTax += m.mgmtFeeInclTax || 0;
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

    const btnSeed = document.getElementById("btnPnlSeedCats");
    if (btnSeed && !btnSeed._bound) {
      btnSeed._bound = true;
      btnSeed.addEventListener("click", async () => {
        const ok = await showConfirm("推奨費目を作成", "運営代行の費用負担区分に沿った標準費目（家賃/水道光熱費/消耗品費/リネン・クリーニング/Wi-Fi/システム利用料 等）を一括作成します。既存の同名費目はスキップします。");
        if (!ok) return;
        try {
          const r = await API.pnl.seedDefaultCategories();
          showToast("完了", `費目を${r.created.length}件作成（${r.skipped}件は既存）`, "success");
          await this._loadAndRenderCats();
          await this.loadSummary();
        } catch (e) {
          showToast("エラー", `作成失敗: ${e.message}`, "error");
        }
      });
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

  // ===== OTA CSV取込(yadozeiがDLした予約CSV → 売上) =====
  async runOtaCsvImport() {
    if (!this.selectedPropertyId) return;
    const months = this._enumerateMonths(this.fromYM, this.toYM);
    const ok = await showConfirm(
      "OTA CSV取込",
      `${this.fromYM}〜${this.toYM}（${months.length}ヶ月）の Airbnb / Booking 予約CSV（やどぜい保存分）を集計して売上に取り込みます。よろしいですか？`
    );
    if (!ok) return;

    showToast("OTA CSV取込", `${months.length}ヶ月を処理中...`, "info");
    let applied = 0, notFound = 0, errors = 0;
    for (const ym of months) {
      try {
        await API.pnl.importOtaCsv(this.selectedPropertyId, ym);
        applied++;
      } catch (e) {
        // 対象月のCSVが無い(404)は正常(未取得月)。それ以外はエラー計上
        if (/見つかりません|見つからず|ありません/.test(e.message)) notFound++;
        else errors++;
      }
    }
    showToast(
      "OTA CSV取込 完了",
      `取込: ${applied}ヶ月 / CSV無: ${notFound}ヶ月${errors ? ` / エラー: ${errors}ヶ月` : ""}`,
      errors ? "warning" : "success"
    );
    await this.loadSummary();
  },

  // ===== 月次帳票の生成(報告書 / 精算書兼請求書) =====
  async openDocModal(yearMonth) {
    this._docYM = yearMonth;
    const modal = document.getElementById("pnlDocModal");
    if (!this._docModal) this._docModal = new bootstrap.Modal(modal);
    document.getElementById("pnlDocTitle").textContent = `— ${this.selectedPropertyName()}／${yearMonth}`;
    const body = document.getElementById("pnlDocBody");
    body.innerHTML = `<div class="text-center py-3"><div class="spinner-border text-primary"></div></div>`;
    this._docModal.show();

    try {
      this._docCtx = await API.pnl.settlementContext(this.selectedPropertyId, yearMonth);
      this._renderDocBody();
    } catch (e) {
      body.innerHTML = `<div class="alert alert-warning">${this.escapeHtml(e.message)}</div>
        <p class="text-muted small">売上データが無い場合は、先に「OTA CSV取込」を実行してください。</p>`;
    }
  },

  _renderDocBody() {
    const ctx = this._docCtx;
    const body = document.getElementById("pnlDocBody");
    const s = ctx.settlement;
    // 運営形態で出し分け: self=精算書なし(報告書のみ)/ agency_other=精算書ブロック / agency_hassac=通常
    const mode = ctx.operationMode || (ctx.settlementMode === "self" ? "self" : "agency_hassac");
    const isSelf = mode === "self";
    const isOther = mode === "agency_other";
    const showSettlement = !isSelf; // 精算プレビュー/精算書は運営代行ありのみ

    const settlementCol = showSettlement ? `
        <div class="col-md-7">
          <h6 class="text-muted"><i class="bi bi-receipt"></i> 精算プレビュー（運営代行手数料）</h6>
          <table class="table table-sm table-bordered mb-2">
            <tr><td>月間入金額 (A)</td><td class="text-end">${this.fmtYen(s.depositAmount)}</td></tr>
            <tr><td>宿泊税預り (B)
              <input type="number" id="pnlDocTax" class="form-control form-control-sm d-inline-block ms-1" style="width:100px" value="${s.taxWithholding || 0}" min="0">
              <button class="btn btn-outline-secondary btn-sm ms-1" id="btnDocImportTax" title="やどぜい月計表PDFから自動取込"><i class="bi bi-magic"></i> 月計表</button>
            </td><td class="text-end" id="pnlDocBView">▲ ${this.fmtYen(s.taxWithholding)}</td></tr>
            <tr class="table-light"><td>月間売上高 (A − B)</td><td class="text-end fw-bold" id="pnlDocBase">${this.fmtYen(s.salesBase)}</td></tr>
            <tr><td>運営代行手数料 (×${s.feeRatePct}%)</td><td class="text-end" id="pnlDocFee">${this.fmtYen(s.feeExclTax)}</td></tr>
            <tr><td>消費税 (${s.consumptionTaxPct}%)</td><td class="text-end" id="pnlDocTaxAmt">${this.fmtYen(s.consumptionTax)}</td></tr>
            <tr class="table-primary"><td>ご請求金額(税込)</td><td class="text-end fw-bold" id="pnlDocTotal">${this.fmtYen(s.feeInclTax)}</td></tr>
          </table>
          <div class="mb-2">
            <label class="form-label small mb-0">お支払期限</label>
            <input type="text" id="pnlDocDue" class="form-control form-control-sm" value="翌月末日">
          </div>
        </div>` : "";

    const noteAlert = isSelf
      ? `<div class="alert alert-info mt-3 mb-0 py-2 small"><i class="bi bi-info-circle"></i> この物件は<b>自社運営（代行なし）</b>のため、運営代行手数料・精算書兼請求書はありません。月次業務報告書は内部用に発行できます。</div>`
      : (isOther
        ? `<div class="alert alert-warning mt-3 mb-0 py-2 small"><i class="bi bi-exclamation-triangle"></i> <b>その他の運営代行会社</b>の会社情報（発行元）が未設定のため、精算書兼請求書はまだ発行できません（今後対応）。月次業務報告書は発行できます。</div>`
        : "");

    const settlementBtn = isSelf ? ""
      : `<button class="btn btn-primary btn-sm" id="btnDocSettlement" ${isOther ? "disabled" : ""}><i class="bi bi-receipt"></i> 精算書兼請求書 PDF</button>`;

    body.innerHTML = `
      <div class="row g-3">
        <div class="${showSettlement ? "col-md-5" : "col-12"}">
          <h6 class="text-muted"><i class="bi bi-activity"></i> 稼働概況</h6>
          <table class="table table-sm table-bordered mb-3">
            <tr><td>予約件数</td><td class="text-end">Airbnb ${ctx.revenue.airbnbReservations} / Booking ${ctx.revenue.bookingReservations}</td></tr>
            <tr><td>宿泊日数</td><td class="text-end">${ctx.nights} 泊</td></tr>
            <tr><td>稼働率</td><td class="text-end">${ctx.occupancyRate} %</td></tr>
            <tr><td>売上合計</td><td class="text-end">${this.fmtYen(ctx.computed.revenueGross)}</td></tr>
            <tr><td>運営利益</td><td class="text-end fw-bold">${this.fmtYen(ctx.computed.profit)}</td></tr>
          </table>
        </div>
        ${settlementCol}
        <div class="col-12">
          <label class="form-label small mb-0">備考 / 特記事項</label>
          <textarea id="pnlDocNote" class="form-control form-control-sm" rows="2" placeholder="帳票に印字されます(任意)"></textarea>
        </div>
      </div>
      ${noteAlert}
      <div class="d-flex gap-2 mt-3 flex-wrap">
        <button class="btn btn-outline-info btn-sm" id="btnDocImportReceipts"><i class="bi bi-receipt-cutoff"></i> 領収書を取込</button>
        <button class="btn btn-outline-info btn-sm" id="btnDocImportUtil"><i class="bi bi-lightning-charge"></i> 光熱費・通信費を取込</button>
        <button class="btn btn-outline-info btn-sm" id="btnDocImportCleaning"><i class="bi bi-broom"></i> 清掃費を取込</button>
        <button class="btn btn-outline-dark btn-sm" id="btnDocSources"><i class="bi bi-search"></i> 出典・内訳を確認</button>
        <button class="btn btn-outline-secondary btn-sm ms-auto" id="btnDocReport"><i class="bi bi-file-earmark-text"></i> 月次業務報告書 PDF</button>
        ${settlementBtn}
      </div>
      <div id="pnlDocResult" class="mt-2"></div>`;

    // 宿泊税Bの変更で精算プレビューを即再計算(クライアント側)。自社運営時は精算プレビュー非表示=要素なし
    const taxInput = document.getElementById("pnlDocTax");
    if (taxInput) {
      taxInput.addEventListener("input", () => this._recalcDocPreview());
      // 月計表PDFから宿泊税Bを自動取込
      document.getElementById("btnDocImportTax").addEventListener("click", async () => {
        const btn = document.getElementById("btnDocImportTax");
        const orig = btn.innerHTML;
        btn.disabled = true; btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span>`;
        try {
          const r = await API.pnl.importTax(this.selectedPropertyId, this._docYM);
          taxInput.value = r.taxWithholding;
          this._recalcDocPreview();
          showToast("宿泊税取込", `宿泊税 ${this.fmtYen(r.taxWithholding)} を取込（${r.sourceFile}）`, "success");
        } catch (e) {
          showToast("エラー", `取込失敗: ${e.message}`, "error");
        } finally {
          btn.disabled = false; btn.innerHTML = orig;
        }
      });
    }

    // 領収書PDFを費目に自動計上
    document.getElementById("btnDocImportReceipts").addEventListener("click", async () => {
      const btn = document.getElementById("btnDocImportReceipts");
      const orig = btn.innerHTML;
      btn.disabled = true; btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> 読取中...`;
      const result = document.getElementById("pnlDocResult");
      try {
        const r = await API.pnl.importReceipts(this.selectedPropertyId, this._docYM);
        const total = (r.items || []).filter(i => !i.error).reduce((s, i) => s + (i.amount || 0), 0);
        result.innerHTML = `<div class="alert alert-info py-2 mb-0">領収書 ${r.processed}件を計上（計 ${this.fmtYen(total)}）${r.skippedDup ? ` / 既取込${r.skippedDup}件` : ""}${r.errors ? ` / 失敗${r.errors}件` : ""}。費目に反映しました。</div>`;
        this._docCtx = await API.pnl.settlementContext(this.selectedPropertyId, this._docYM, document.getElementById("pnlDocTax")?.value);
        this._renderDocBody();
        await this.loadSummary();
      } catch (e) {
        result.innerHTML = `<div class="alert alert-danger py-2 mb-0">領収書取込失敗: ${this.escapeHtml(e.message)}</div>`;
      } finally {
        btn.disabled = false; btn.innerHTML = orig;
      }
    });

    // 光熱費・通信費を費目に自動計上
    document.getElementById("btnDocImportUtil").addEventListener("click", async () => {
      const btn = document.getElementById("btnDocImportUtil");
      const orig = btn.innerHTML;
      btn.disabled = true; btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> 読取中...`;
      const result = document.getElementById("pnlDocResult");
      try {
        const r = await API.pnl.importUtilities(this.selectedPropertyId, this._docYM);
        const total = (r.items || []).filter(i => !i.error).reduce((s, i) => s + (i.monthShare || 0), 0);
        result.innerHTML = `<div class="alert alert-info py-2 mb-0">光熱費・通信費 ${r.processed}件を計上（当月分 計 ${this.fmtYen(total)}）${r.skippedDup ? ` / 既取込${r.skippedDup}件` : ""}${r.errors ? ` / 失敗${r.errors}件` : ""}。費目に反映しました。</div>`;
        this._docCtx = await API.pnl.settlementContext(this.selectedPropertyId, this._docYM, document.getElementById("pnlDocTax")?.value);
        this._renderDocBody();
        await this.loadSummary();
      } catch (e) {
        result.innerHTML = `<div class="alert alert-danger py-2 mb-0">光熱費取込失敗: ${this.escapeHtml(e.message)}</div>`;
      } finally {
        btn.disabled = false; btn.innerHTML = orig;
      }
    });

    // 清掃費を取込(アプリの清掃スタッフ請求書から)
    document.getElementById("btnDocImportCleaning").addEventListener("click", async () => {
      const btn = document.getElementById("btnDocImportCleaning");
      const orig = btn.innerHTML;
      btn.disabled = true; btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> 取込中...`;
      const result = document.getElementById("pnlDocResult");
      try {
        const r = await API.pnl.importCleaning(this.selectedPropertyId, this._docYM);
        const total = (r.rows || []).reduce((s, i) => s + (i.amount || 0), 0);
        result.innerHTML = `<div class="alert alert-info py-2 mb-0">清掃費 請求書${r.invoices}件を計上（計 ${this.fmtYen(total)} / 追加${r.added}・更新${r.updated}）。清掃費に反映しました。</div>`;
        this._docCtx = await API.pnl.settlementContext(this.selectedPropertyId, this._docYM, document.getElementById("pnlDocTax")?.value);
        this._renderDocBody();
        await this.loadSummary();
      } catch (e) {
        result.innerHTML = `<div class="alert alert-danger py-2 mb-0">清掃費取込失敗: ${this.escapeHtml(e.message)}</div>`;
      } finally {
        btn.disabled = false; btn.innerHTML = orig;
      }
    });

    // 出典・内訳を確認(取込元ファイルのリンク+金額)
    document.getElementById("btnDocSources").addEventListener("click", () => this._showSources());

    document.getElementById("btnDocReport").addEventListener("click", () => this._generateDoc("report"));
    // 精算書ボタンは自社運営では非表示のため任意(?.で安全に結線)
    document.getElementById("btnDocSettlement")?.addEventListener("click", () => this._generateDoc("settlement"));
  },

  async _showSources() {
    const result = document.getElementById("pnlDocResult");
    result.innerHTML = `<div class="text-center py-2"><div class="spinner-border spinner-border-sm text-primary"></div> 出典を取得中...</div>`;
    try {
      const s = await API.pnl.getSources(this.selectedPropertyId, this._docYM);
      const yen = (n) => this.fmtYen(n);
      const linkCell = (name, link) => link
        ? `<a href="${link}" target="_blank" rel="noopener" title="${this.escapeHtml(name)}">${this.escapeHtml(name || "開く")} <i class="bi bi-box-arrow-up-right"></i></a>`
        : `<span class="text-muted">${this.escapeHtml(name || "-")}</span>`;
      const rows = [];
      (s.revenue || []).forEach(r => rows.push(`<tr><td>売上</td><td>${this.escapeHtml(r.label)}${r.count ? `（${r.count}件）` : ""}</td><td class="text-end">${yen(r.amount)}</td><td class="small">${linkCell(r.fileName, r.link)}</td></tr>`));
      if (s.tax) rows.push(`<tr><td>宿泊税</td><td>やどぜい申告書</td><td class="text-end">${yen(s.tax.amount)}</td><td class="small">${linkCell(s.tax.fileName, s.tax.link)}</td></tr>`);
      (s.expenses || []).forEach(e => rows.push(`<tr><td>${this.escapeHtml(e.kind)}</td><td>${this.escapeHtml(e.category)}</td><td class="text-end">${yen(e.amount)}</td><td class="small">${linkCell(e.fileName, e.link)}</td></tr>`));
      (s.cleaning || []).forEach(c => {
        const srcTag = c.sourceLabel ? `<br><span class="text-muted" style="font-size:0.7rem;">${this.escapeHtml(c.sourceLabel)}</span>` : "";
        const openLabel = c.source === "invoice" ? "請求書PDFを開く" : (c.source === "drive_pdf" ? "PDFを開く" : "開く");
        const cell = c.link ? linkCell(openLabel, c.link) : `<span class="text-muted">${this.escapeHtml(c.sourceLabel || "手入力")}</span>`;
        rows.push(`<tr class="${c.excluded ? "text-muted text-decoration-line-through" : ""}"><td>清掃費</td><td>${this.escapeHtml(c.staffName)}${c.excluded ? "（除外）" : ""}${srcTag}</td><td class="text-end">${yen(c.amount)}</td><td class="small">${cell}</td></tr>`);
      });
      // 除外した重複(採用しなかった方。金額差があれば要確認)
      (s.duplicates || []).forEach(dp => rows.push(`<tr class="table-warning"><td>重複除外</td><td class="small">${this.escapeHtml(dp.category)}${dp.needsReview ? ' <span class="badge bg-danger">⚠️要確認</span>' : ""}<br><span class="text-muted">採用: ${this.escapeHtml(dp.keptFileName)}（${yen(dp.keptAmount)}）</span></td><td class="text-end text-muted">${yen(dp.amount)}</td><td class="small">${linkCell("除外分を開く", dp.link)}</td></tr>`));

      result.innerHTML = rows.length ? `
        <div class="border rounded p-2" style="max-height:340px;overflow:auto;">
          <div class="fw-bold small mb-1"><i class="bi bi-search"></i> ${this.escapeHtml(this._docYM)} の取込元（金額・出典を確認）</div>
          <table class="table table-sm table-hover mb-0" style="font-size:0.8rem;">
            <thead class="table-light"><tr><th>区分</th><th>内容</th><th class="text-end">金額</th><th>出典（クリックで開く）</th></tr></thead>
            <tbody>${rows.join("")}</tbody>
          </table>
        </div>
        <p class="text-muted small mt-1 mb-0">※ リンクをクリックしてPDF/CSVを開き、金額と出典が正しいか確認できます。誤りは各費目セルを手修正すれば上書き保護されます。</p>`
        : `<div class="alert alert-secondary py-2 mb-0">この月の取込元はまだありません（各取込ボタンを実行すると出典が表示されます）。</div>`;
    } catch (e) {
      result.innerHTML = `<div class="alert alert-danger py-2 mb-0">出典取得失敗: ${this.escapeHtml(e.message)}</div>`;
    }
  },

  _recalcDocPreview() {
    const s = this._docCtx.settlement;
    const B = Math.max(0, Math.round(Number(document.getElementById("pnlDocTax")?.value) || 0));
    const base = Math.max(0, s.depositAmount - B);
    const fee = Math.round(base * s.feeRatePct / 100);
    const tax = Math.round(fee * s.consumptionTaxPct / 100);
    document.getElementById("pnlDocBView").textContent = "▲ " + this.fmtYen(B);
    document.getElementById("pnlDocBase").textContent = this.fmtYen(base);
    document.getElementById("pnlDocFee").textContent = this.fmtYen(fee);
    document.getElementById("pnlDocTaxAmt").textContent = this.fmtYen(tax);
    document.getElementById("pnlDocTotal").textContent = this.fmtYen(fee + tax);
  },

  async _generateDoc(kind) {
    const btnId = kind === "report" ? "btnDocReport" : "btnDocSettlement";
    const btn = document.getElementById(btnId);
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> 生成中...`;
    const result = document.getElementById("pnlDocResult");
    try {
      const body = {
        kind,
        taxWithholding: Math.max(0, Math.round(Number(document.getElementById("pnlDocTax")?.value) || 0)),
        note: document.getElementById("pnlDocNote")?.value || "",
        paymentDueText: document.getElementById("pnlDocDue")?.value || "翌月末日",
      };
      const res = await API.pnl.generateDoc(this.selectedPropertyId, this._docYM, body);
      const label = kind === "report" ? "月次業務報告書" : "精算書兼請求書";
      result.innerHTML = `<div class="alert alert-success py-2 mb-0">
        <i class="bi bi-check-circle"></i> ${label}を生成しました。
        <a href="${res.url}" target="_blank" rel="noopener" class="alert-link">PDFを開く</a>
      </div>`;
      window.open(res.url, "_blank", "noopener");
      // 宿泊税Bを保存したので収支も更新
      await this.loadSummary();
    } catch (e) {
      result.innerHTML = `<div class="alert alert-danger py-2 mb-0">生成失敗: ${this.escapeHtml(e.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
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
