/**
 * ランドリー管理ページ
 * コインランドリーの使用記録入力・月間集計・スタッフ別表示
 */
const LaundryPage = {
  records: [],
  staffList: [],
  currentYearMonth: null,

  async render(container) {
    const now = new Date();
    this.currentYearMonth = this.currentYearMonth || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-basket3"></i> ランドリー</h2>
        <button class="btn btn-primary" id="btnNewLaundry"><i class="bi bi-plus-lg"></i> 記録追加</button>
      </div>

      <!-- 月選択 -->
      <div class="d-flex align-items-center gap-2 mb-3">
        <button class="btn btn-sm btn-outline-secondary" id="laundryPrevMonth"><i class="bi bi-chevron-left"></i></button>
        <input type="month" class="form-control" style="max-width:180px" id="laundryMonth" value="${this.currentYearMonth}">
        <button class="btn btn-sm btn-outline-secondary" id="laundryNextMonth"><i class="bi bi-chevron-right"></i></button>
      </div>

      <!-- 集計 -->
      <div class="laundry-summary" id="laundrySummary"></div>

      <!-- 記録一覧 -->
      <div class="card">
        <div class="card-body p-0">
          <div class="table-responsive">
            <table class="table table-hover table-sm align-middle mb-0">
              <thead class="table-light">
                <tr><th>日付</th><th>スタッフ</th><th>枚数</th><th class="text-end">金額</th><th>メモ</th><th style="width:60px"></th></tr>
              </thead>
              <tbody id="laundryTableBody">
                <tr><td colspan="6" class="text-center py-3 text-muted">読み込み中...</td></tr>
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
                <div class="col-md-6"><label class="form-label">枚数</label><input type="number" class="form-control" id="laundrySheets" min="0" value="1"></div>
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
      const [records, staffList] = await Promise.all([
        API.laundry.list({ yearMonth: this.currentYearMonth }),
        API.staff.list(),
      ]);
      this.records = records;
      this.staffList = staffList;
      this.renderTable();
      this.renderSummary();
      this.populateStaffSelect();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  renderSummary() {
    const totalAmount = this.records.reduce((s, r) => s + (r.amount || 0), 0);
    const totalSheets = this.records.reduce((s, r) => s + (r.sheets || 0), 0);
    const el = document.getElementById("laundrySummary");
    el.innerHTML = `
      <div class="summary-item"><div class="summary-value">${this.records.length}</div><div class="summary-label">利用回数</div></div>
      <div class="summary-item"><div class="summary-value">${totalSheets}</div><div class="summary-label">合計枚数</div></div>
      <div class="summary-item"><div class="summary-value">${formatCurrency(totalAmount)}</div><div class="summary-label">合計金額</div></div>
    `;
  },

  renderTable() {
    const tbody = document.getElementById("laundryTableBody");
    if (!this.records.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-muted"><i class="bi bi-basket3 fs-3 d-block mb-2"></i>この月の記録はありません</td></tr>`;
      return;
    }
    const staffMap = Object.fromEntries(this.staffList.map(s => [s.id, s.name]));
    tbody.innerHTML = this.records.map(r => {
      const d = r.date && r.date.toDate ? r.date.toDate() : new Date(r.date);
      return `<tr>
        <td>${d.getMonth()+1}/${d.getDate()}</td>
        <td>${staffMap[r.staffId] || "-"}</td>
        <td>${r.sheets || 0}枚</td>
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
    if (!confirm("この記録を削除しますか？")) return;
    try {
      await API.laundry.delete(id);
      showToast("成功", "記録を削除しました", "success");
      await this.loadData();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },
};
