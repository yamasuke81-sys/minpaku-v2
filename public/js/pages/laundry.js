/**
 * ランドリー月次ダッシュボード
 *   - 月別集計
 *   - 提出先別/支払方法別の集計
 *   - スタッフ別集計
 *   - チェックリスト由来のイベント(putOut/collected/stored)も統合表示
 */
const LaundryPage = {
  records: [],
  staffList: [],
  propertyList: [],
  currentYearMonth: null,

  async render(container) {
    const now = new Date();
    this.currentYearMonth = this.currentYearMonth || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-basket3"></i> ランドリー月次ダッシュボード</h2>
        <button class="btn btn-primary" id="btnNewLaundry"><i class="bi bi-plus-lg"></i> 記録追加</button>
      </div>

      <div class="d-flex align-items-center gap-2 mb-3">
        <button class="btn btn-sm btn-outline-secondary" id="laundryPrevMonth"><i class="bi bi-chevron-left"></i></button>
        <input type="month" class="form-control" style="max-width:180px" id="laundryMonth" value="${this.currentYearMonth}">
        <button class="btn btn-sm btn-outline-secondary" id="laundryNextMonth"><i class="bi bi-chevron-right"></i></button>
      </div>

      <!-- トップサマリー -->
      <div class="row g-2 mb-3" id="laundrySummaryCards"></div>

      <!-- ブレイクダウン -->
      <div class="row g-3 mb-3">
        <div class="col-md-4">
          <div class="card h-100"><div class="card-body">
            <h6 class="card-title"><i class="bi bi-shop"></i> 提出先別</h6>
            <div id="byDepot" class="small"></div>
          </div></div>
        </div>
        <div class="col-md-4">
          <div class="card h-100"><div class="card-body">
            <h6 class="card-title"><i class="bi bi-credit-card"></i> 支払方法別</h6>
            <div id="byPayment" class="small"></div>
          </div></div>
        </div>
        <div class="col-md-4">
          <div class="card h-100"><div class="card-body">
            <h6 class="card-title"><i class="bi bi-person"></i> スタッフ別</h6>
            <div id="byStaff" class="small"></div>
          </div></div>
        </div>
      </div>

      <!-- 記録一覧 -->
      <div class="card">
        <div class="card-body p-0">
          <div class="table-responsive">
            <table class="table table-hover table-sm align-middle mb-0">
              <thead class="table-light">
                <tr><th>日付</th><th>スタッフ</th><th>物件</th><th>提出先</th><th>支払</th><th class="text-end">金額</th><th>メモ</th><th style="width:60px"></th></tr>
              </thead>
              <tbody id="laundryTableBody">
                <tr><td colspan="8" class="text-center py-3 text-muted">読み込み中...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 追加モーダル -->
      <div class="modal fade" id="laundryModal" tabindex="-1">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header"><h5 class="modal-title">ランドリー記録追加</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
            <div class="modal-body">
              <div class="row g-3">
                <div class="col-12"><label class="form-label">日付 <span class="text-danger">*</span></label><input type="date" class="form-control" id="laundryDate" value="${now.toISOString().split("T")[0]}"></div>
                <div class="col-12"><label class="form-label">スタッフ</label><select class="form-select" id="laundryStaffId"><option value="">-- 選択 --</option></select></div>
                <div class="col-md-6"><label class="form-label">提出先</label>
                  <select class="form-select" id="laundryDepot">
                    <option value="">--</option>
                    <option value="coin_laundry">コインランドリー</option>
                    <option value="linen_shop">リネン屋</option>
                    <option value="other">その他</option>
                  </select>
                </div>
                <div class="col-md-6"><label class="form-label">支払方法</label>
                  <select class="form-select" id="laundryPayment">
                    <option value="">--</option>
                    <option value="cash">現金(立替)</option>
                    <option value="credit">クレジット(立替)</option>
                    <option value="prepaid">プリペイド</option>
                    <option value="invoice">店舗請求</option>
                  </select>
                </div>
                <div class="col-md-6"><label class="form-label">枚数</label><input type="number" class="form-control" id="laundrySheets" min="0" value="0"></div>
                <div class="col-md-6"><label class="form-label">金額（円）<span class="text-danger">*</span></label><input type="number" class="form-control" id="laundryAmount" min="0" value="0"></div>
                <div class="col-12"><label class="form-label">メモ</label><input type="text" class="form-control" id="laundryMemo"></div>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">キャンセル</button>
              <button type="button" class="btn btn-primary" id="btnSaveLaundry"><i class="bi bi-check-lg"></i> 保存</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
    await this.loadData();
  },

  bindEvents() {
    document.getElementById("btnNewLaundry").addEventListener("click", () => this.openModal());
    document.getElementById("btnSaveLaundry").addEventListener("click", () => this.saveLaundry());
    document.getElementById("laundryMonth").addEventListener("change", (e) => {
      this.currentYearMonth = e.target.value;
      this.loadData();
    });
    document.getElementById("laundryPrevMonth").addEventListener("click", () => this.changeMonth(-1));
    document.getElementById("laundryNextMonth").addEventListener("click", () => this.changeMonth(1));
  },

  changeMonth(delta) {
    const [y, m] = this.currentYearMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    this.currentYearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    document.getElementById("laundryMonth").value = this.currentYearMonth;
    this.loadData();
  },

  async loadData() {
    try {
      const [records, staffList, propertyList] = await Promise.all([
        API.laundry.list({ yearMonth: this.currentYearMonth }),
        API.staff.list(),
        API.properties.listMinpakuNumbered(),
      ]);
      this.records = records;
      this.staffList = staffList;
      this.propertyList = propertyList;
      this.renderSummary();
      this.renderBreakdowns();
      this.renderTable();
      this.populateStaffSelect();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  renderSummary() {
    const totalAmount = this.records.reduce((s, r) => s + (r.amount || 0), 0);
    const totalSheets = this.records.reduce((s, r) => s + (r.sheets || 0), 0);
    const el = document.getElementById("laundrySummaryCards");
    el.innerHTML = `
      <div class="col-6 col-md-3"><div class="card bg-light"><div class="card-body text-center p-3">
        <div class="fs-5 fw-bold">${this.records.length}</div><div class="small text-muted">利用回数</div>
      </div></div></div>
      <div class="col-6 col-md-3"><div class="card bg-light"><div class="card-body text-center p-3">
        <div class="fs-5 fw-bold">${totalSheets}</div><div class="small text-muted">合計枚数</div>
      </div></div></div>
      <div class="col-12 col-md-3"><div class="card bg-primary text-white"><div class="card-body text-center p-3">
        <div class="fs-5 fw-bold">${formatCurrency(totalAmount)}</div><div class="small">合計金額</div>
      </div></div></div>
      <div class="col-12 col-md-3"><div class="card bg-light"><div class="card-body text-center p-3">
        <div class="fs-6 fw-bold">${this.currentYearMonth}</div><div class="small text-muted">対象月</div>
      </div></div></div>
    `;
  },

  _label(kind, v) {
    const maps = {
      depot: { coin_laundry: "コインランドリー", linen_shop: "リネン屋", other: "その他" },
      payment: { cash: "現金(立替)", credit: "クレジット(立替)", prepaid: "プリペイド", invoice: "店舗請求" },
    };
    return (maps[kind] && maps[kind][v]) || v || "未指定";
  },

  renderBreakdowns() {
    const depot = {}, payment = {}, staff = {};
    const staffMap = Object.fromEntries(this.staffList.map(s => [s.id, s.name]));
    for (const r of this.records) {
      const dk = r.depot || "未指定";
      const pk = r.paymentMethod || "未指定";
      const sk = r.staffId || "未指定";
      depot[dk] = (depot[dk] || 0) + (r.amount || 0);
      payment[pk] = (payment[pk] || 0) + (r.amount || 0);
      staff[sk] = (staff[sk] || 0) + (r.amount || 0);
    }
    const render = (obj, kind) => Object.entries(obj)
      .sort((a,b) => b[1]-a[1])
      .map(([k,v]) => `<div class="d-flex justify-content-between"><span>${kind==="staff" ? (staffMap[k] || "(未指定)") : this._label(kind, k)}</span><span class="fw-bold">${formatCurrency(v)}</span></div>`)
      .join("") || "<div class='text-muted'>データなし</div>";
    document.getElementById("byDepot").innerHTML = render(depot, "depot");
    document.getElementById("byPayment").innerHTML = render(payment, "payment");
    document.getElementById("byStaff").innerHTML = render(staff, "staff");
  },

  renderTable() {
    const tbody = document.getElementById("laundryTableBody");
    if (!this.records.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-muted"><i class="bi bi-basket3 fs-3 d-block mb-2"></i>この月の記録はありません</td></tr>`;
      return;
    }
    const staffMap = Object.fromEntries(this.staffList.map(s => [s.id, s.name]));
    const propMap = Object.fromEntries(this.propertyList.map(p => [p.id, p.name]));
    tbody.innerHTML = this.records.map(r => {
      const d = r.date && r.date.toDate ? r.date.toDate() : new Date(r.date);
      return `<tr>
        <td>${d.getMonth()+1}/${d.getDate()}</td>
        <td>${staffMap[r.staffId] || "-"}</td>
        <td class="small">${propMap[r.propertyId] || "-"}</td>
        <td class="small">${this._label("depot", r.depot) + (r.depotOther ? ` (${r.depotOther})` : "")}</td>
        <td class="small">${this._label("payment", r.paymentMethod)}</td>
        <td class="text-end fw-bold">${formatCurrency(r.amount)}</td>
        <td class="text-muted small">${r.memo || ""}</td>
        <td><button class="btn btn-sm btn-outline-danger" onclick="LaundryPage.deleteRecord('${r.id}')"><i class="bi bi-trash"></i></button></td>
      </tr>`;
    }).join("");
  },

  populateStaffSelect() {
    const sel = document.getElementById("laundryStaffId");
    sel.innerHTML = `<option value="">-- 選択 --</option>` + this.staffList.map(s => `<option value="${s.id}">${s.name}</option>`).join("");
  },

  openModal() {
    bootstrap.Modal.getOrCreateInstance(document.getElementById("laundryModal")).show();
  },

  async saveLaundry() {
    const data = {
      date: document.getElementById("laundryDate").value,
      staffId: document.getElementById("laundryStaffId").value || null,
      depot: document.getElementById("laundryDepot").value || "",
      paymentMethod: document.getElementById("laundryPayment").value || "",
      sheets: parseInt(document.getElementById("laundrySheets").value) || 0,
      amount: parseInt(document.getElementById("laundryAmount").value) || 0,
      memo: document.getElementById("laundryMemo").value,
    };
    if (!data.date) { showToast("エラー", "日付を入力してください", "error"); return; }

    try {
      await API.laundry.create(data);
      showToast("成功", "記録を追加しました", "success");
      bootstrap.Modal.getInstance(document.getElementById("laundryModal")).hide();
      await this.loadData();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  async deleteRecord(id) {
    const ok = await showConfirm("この記録を削除しますか？", "削除確認");
    if (!ok) return;
    try {
      await API.laundry.delete(id);
      showToast("成功", "記録を削除しました", "success");
      await this.loadData();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },
};
