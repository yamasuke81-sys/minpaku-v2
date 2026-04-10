/**
 * シフト管理ページ
 * 月間カレンダー形式でシフト一覧を表示。作成・編集・削除・ステータス変更
 */
const ShiftsPage = {
  shifts: [],
  staffList: [],
  properties: [],
  currentMonth: null,

  async render(container) {
    const now = new Date();
    this.currentMonth = this.currentMonth || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-calendar-week"></i> シフト管理</h2>
        <button class="btn btn-primary" id="btnNewShift"><i class="bi bi-plus-lg"></i> シフト登録</button>
      </div>

      <!-- 月選択 -->
      <div class="d-flex align-items-center gap-2 mb-3">
        <button class="btn btn-sm btn-outline-secondary" id="shiftPrevMonth"><i class="bi bi-chevron-left"></i></button>
        <input type="month" class="form-control" style="max-width:180px" id="shiftMonth" value="${this.currentMonth}">
        <button class="btn btn-sm btn-outline-secondary" id="shiftNextMonth"><i class="bi bi-chevron-right"></i></button>
        <button class="btn btn-sm btn-outline-primary" id="shiftToday">今月</button>
        <div class="ms-auto d-flex gap-2 small">
          <span><span class="shift-tag unassigned">未割当</span></span>
          <span><span class="shift-tag assigned">割当済</span></span>
          <span><span class="shift-tag confirmed">確定</span></span>
          <span><span class="shift-tag completed">完了</span></span>
        </div>
      </div>

      <!-- 統計 -->
      <div class="row g-2 mb-3">
        <div class="col-3"><div class="card card-stat danger"><div class="card-body py-2"><div class="text-muted small">未割当</div><div class="fs-4 fw-bold" id="shiftStatUnassigned">0</div></div></div></div>
        <div class="col-3"><div class="card card-stat warning"><div class="card-body py-2"><div class="text-muted small">割当済</div><div class="fs-4 fw-bold" id="shiftStatAssigned">0</div></div></div></div>
        <div class="col-3"><div class="card card-stat success"><div class="card-body py-2"><div class="text-muted small">確定</div><div class="fs-4 fw-bold" id="shiftStatConfirmed">0</div></div></div></div>
        <div class="col-3"><div class="card card-stat primary"><div class="card-body py-2"><div class="text-muted small">完了</div><div class="fs-4 fw-bold" id="shiftStatCompleted">0</div></div></div></div>
      </div>

      <!-- シフト一覧テーブル -->
      <div class="card">
        <div class="card-body p-0">
          <div class="table-responsive">
            <table class="table table-hover table-sm align-middle mb-0">
              <thead class="table-light">
                <tr><th>日付</th><th>物件</th><th>スタッフ</th><th>時間</th><th>ステータス</th><th style="width:120px">操作</th></tr>
              </thead>
              <tbody id="shiftTableBody">
                <tr><td colspan="6" class="text-center py-3 text-muted">読み込み中...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
    await this.loadData();
  },

  bindEvents() {
    document.getElementById("btnNewShift").addEventListener("click", () => this.openModal());
    document.getElementById("shiftMonth").addEventListener("change", (e) => {
      this.currentMonth = e.target.value;
      this.loadData();
    });
    document.getElementById("shiftPrevMonth").addEventListener("click", () => this.changeMonth(-1));
    document.getElementById("shiftNextMonth").addEventListener("click", () => this.changeMonth(1));
    document.getElementById("shiftToday").addEventListener("click", () => {
      const now = new Date();
      this.currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      document.getElementById("shiftMonth").value = this.currentMonth;
      this.loadData();
    });
    document.getElementById("btnSaveShift").addEventListener("click", () => this.saveShift());
  },

  changeMonth(delta) {
    const [y, m] = this.currentMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    this.currentMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    document.getElementById("shiftMonth").value = this.currentMonth;
    this.loadData();
  },

  async loadData() {
    try {
      const [y, m] = this.currentMonth.split("-").map(Number);
      const from = new Date(y, m - 1, 1).toISOString();
      const to = new Date(y, m, 0, 23, 59, 59).toISOString();

      const [shifts, staffList, properties] = await Promise.all([
        API.shifts.list({ from, to }),
        API.staff.list(),
        API.properties.list(),
      ]);

      this.shifts = shifts;
      this.staffList = staffList;
      this.properties = properties;

      this.renderTable();
      this.renderStats();
      this.populateSelects();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  renderTable() {
    const tbody = document.getElementById("shiftTableBody");
    if (!this.shifts.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-muted"><i class="bi bi-calendar-x fs-3 d-block mb-2"></i>このの月のシフトはありません</td></tr>`;
      return;
    }

    const propMap = Object.fromEntries(this.properties.map(p => [p.id, p.name]));
    const today = new Date().toISOString().split("T")[0];

    tbody.innerHTML = this.shifts.map(s => {
      const d = s.date && s.date.toDate ? s.date.toDate() : new Date(s.date);
      const dateStr = d.toISOString().split("T")[0];
      const dayName = ["日","月","火","水","木","金","土"][d.getDay()];
      const isToday = dateStr === today;
      const statusClass = s.status || "unassigned";
      const statusLabels = { unassigned: "未割当", assigned: "割当済", confirmed: "確定", completed: "完了", cancelled: "キャンセル" };

      return `<tr class="${isToday ? "table-info" : ""}">
        <td><strong>${d.getMonth()+1}/${d.getDate()}</strong> <span class="text-muted">(${dayName})</span></td>
        <td>${propMap[s.propertyId] || "-"}</td>
        <td>${s.staffName || '<span class="text-danger">未割当</span>'}</td>
        <td>${s.startTime || ""} ${s.endTime ? "〜" + s.endTime : ""}</td>
        <td><span class="shift-tag ${statusClass}">${statusLabels[s.status] || s.status}</span></td>
        <td>
          <div class="btn-group btn-group-sm">
            <button class="btn btn-outline-secondary" onclick="ShiftsPage.openModal('${s.id}')" title="編集"><i class="bi bi-pencil"></i></button>
            ${s.status === "assigned" ? `<button class="btn btn-outline-success" onclick="ShiftsPage.updateStatus('${s.id}','confirmed')" title="確定"><i class="bi bi-check"></i></button>` : ""}
            ${s.status === "confirmed" ? `<button class="btn btn-outline-primary" onclick="ShiftsPage.updateStatus('${s.id}','completed')" title="完了"><i class="bi bi-check-all"></i></button>` : ""}
            <button class="btn btn-outline-danger" onclick="ShiftsPage.deleteShift('${s.id}')" title="削除"><i class="bi bi-trash"></i></button>
          </div>
        </td>
      </tr>`;
    }).join("");
  },

  renderStats() {
    const counts = { unassigned: 0, assigned: 0, confirmed: 0, completed: 0 };
    this.shifts.forEach(s => { if (counts[s.status] !== undefined) counts[s.status]++; });
    document.getElementById("shiftStatUnassigned").textContent = counts.unassigned;
    document.getElementById("shiftStatAssigned").textContent = counts.assigned;
    document.getElementById("shiftStatConfirmed").textContent = counts.confirmed;
    document.getElementById("shiftStatCompleted").textContent = counts.completed;
  },

  populateSelects() {
    const propSel = document.getElementById("shiftPropertyId");
    const staffSel = document.getElementById("shiftStaffId");
    propSel.innerHTML = `<option value="">-- 選択 --</option>` + this.properties.map(p => `<option value="${p.id}">${p.name}</option>`).join("");
    staffSel.innerHTML = `<option value="">-- 未割当 --</option>` + this.staffList.map(s => `<option value="${s.id}">${s.name}</option>`).join("");
  },

  openModal(editId = null) {
    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("shiftModal"));
    document.getElementById("shiftModalTitle").textContent = editId ? "シフト編集" : "シフト登録";
    document.getElementById("shiftEditId").value = editId || "";

    if (editId) {
      const s = this.shifts.find(x => x.id === editId);
      if (s) {
        const d = s.date && s.date.toDate ? s.date.toDate() : new Date(s.date);
        document.getElementById("shiftDate").value = d.toISOString().split("T")[0];
        document.getElementById("shiftPropertyId").value = s.propertyId || "";
        document.getElementById("shiftStaffId").value = s.staffId || "";
        document.getElementById("shiftStartTime").value = s.startTime || "10:30";
        document.getElementById("shiftEndTime").value = s.endTime || "";
        document.getElementById("shiftMemo").value = s.memo || "";
      }
    } else {
      document.getElementById("shiftDate").value = "";
      document.getElementById("shiftPropertyId").value = "";
      document.getElementById("shiftStaffId").value = "";
      document.getElementById("shiftStartTime").value = "10:30";
      document.getElementById("shiftEndTime").value = "";
      document.getElementById("shiftMemo").value = "";
    }
    modal.show();
  },

  async saveShift() {
    const editId = document.getElementById("shiftEditId").value;
    const staffId = document.getElementById("shiftStaffId").value;
    const staffName = staffId ? this.staffList.find(s => s.id === staffId)?.name || "" : "";
    const data = {
      date: document.getElementById("shiftDate").value,
      propertyId: document.getElementById("shiftPropertyId").value,
      staffId: staffId || null,
      staffName: staffName || null,
      startTime: document.getElementById("shiftStartTime").value,
      endTime: document.getElementById("shiftEndTime").value,
      memo: document.getElementById("shiftMemo").value,
    };

    if (!data.date) { showToast("エラー", "日付を入力してください", "error"); return; }

    try {
      if (editId) {
        data.status = staffId ? "assigned" : "unassigned";
        await API.shifts.update(editId, data);
        showToast("成功", "シフトを更新しました", "success");
      } else {
        await API.shifts.create(data);
        showToast("成功", "シフトを登録しました", "success");
      }
      bootstrap.Modal.getInstance(document.getElementById("shiftModal")).hide();
      await this.loadData();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  async updateStatus(id, status) {
    try {
      await API.shifts.update(id, { status });
      showToast("成功", `ステータスを「${status}」に変更しました`, "success");
      await this.loadData();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  async deleteShift(id) {
    if (!confirm("このシフトを削除しますか？")) return;
    try {
      await API.shifts.delete(id);
      showToast("成功", "シフトを削除しました", "success");
      await this.loadData();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },
};
