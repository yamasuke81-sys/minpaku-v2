/**
 * スタッフ管理ページ
 * 一覧・登録・編集・無効化 + ソート + 列リサイズ + 横スクロール回答カレンダー
 */
const StaffPage = {
  staffList: [],
  modal: null,
  sortKey: "displayOrder",
  sortAsc: true,
  showInactive: false,
  // 列リサイズ
  _resizing: null,
  // 横スクロールカレンダー
  _calMonth: null,
  _recruitments: [],

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-people"></i> スタッフ管理</h2>
        <div>
          <button class="btn btn-outline-secondary me-2" id="btnToggleInactive">
            <i class="bi bi-eye"></i> 無効スタッフ表示
          </button>
          <button class="btn btn-primary" id="btnAddStaff">
            <i class="bi bi-plus-lg"></i> スタッフ登録
          </button>
        </div>
      </div>

      <div class="table-responsive" id="staffTableWrapper">
        <table class="table table-hover align-middle" id="staffTable">
          <thead class="table-light" id="staffTableHead"></thead>
          <tbody id="staffTableBody">
            <tr><td colspan="7" class="text-center py-4">読み込み中...</td></tr>
          </tbody>
        </table>
      </div>

      <!-- 横スクロール回答カレンダー -->
      <div class="mt-4">
        <div class="d-flex align-items-center gap-2 mb-2">
          <h5 class="mb-0"><i class="bi bi-calendar3"></i> スタッフ回答一覧</h5>
          <input type="month" class="form-control form-control-sm" style="width:160px;" id="staffCalMonth">
          <button class="btn btn-sm btn-outline-primary" id="btnStaffCalToday">今日</button>
          <span class="badge bg-secondary" id="staffCalMonthOverlay" style="font-size:0.85rem;"></span>
        </div>
        <div class="d-flex gap-3 mb-2 small" id="staffCalLegend">
          <span><span style="color:#198754;font-weight:bold;">●</span> ◎</span>
          <span><span style="color:#cc9a06;font-weight:bold;">▲</span> △</span>
          <span><span style="color:#dc3545;font-weight:bold;">✖</span> ×</span>
          <span><span style="color:#adb5bd;">−</span> 未回答</span>
          <span><span style="display:inline-block;width:12px;height:12px;border:2px solid #dc3545;border-radius:2px;vertical-align:middle;"></span> 確定済み</span>
          <span><span style="display:inline-block;width:12px;height:12px;background:#e8f0fe;border:1px solid #dee2e6;border-radius:2px;vertical-align:middle;"></span> 今日</span>
        </div>
        <div id="staffCalContainer" style="overflow-x:auto;"></div>
      </div>
    `;

    this.modal = new bootstrap.Modal(document.getElementById("staffModal"));
    this.bindEvents();
    await this.loadData();
  },

  bindEvents() {
    document.getElementById("btnAddStaff").addEventListener("click", () => {
      this.openModal();
    });

    document.getElementById("btnToggleInactive").addEventListener("click", (e) => {
      this.showInactive = !this.showInactive;
      e.currentTarget.innerHTML = this.showInactive
        ? '<i class="bi bi-eye-slash"></i> 無効スタッフ非表示'
        : '<i class="bi bi-eye"></i> 無効スタッフ表示';
      this.loadStaff(!this.showInactive);
    });

    document.getElementById("btnSaveStaff").addEventListener("click", () => {
      this.saveStaff();
    });

    // カレンダー月変更
    const monthInput = document.getElementById("staffCalMonth");
    const now = new Date();
    this._calMonth = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    monthInput.value = this._calMonth;
    monthInput.addEventListener("change", () => {
      this._calMonth = monthInput.value;
      this.renderCalendar();
    });

    document.getElementById("btnStaffCalToday").addEventListener("click", () => {
      const now = new Date();
      const nowMonth = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
      monthInput.value = nowMonth;
      this._calMonth = nowMonth;
      this.renderCalendar();
    });
  },

  async loadData() {
    try {
      const [staff, recruitments] = await Promise.all([
        API.staff.list(!this.showInactive),
        API.recruitments.list(),
      ]);
      this.staffList = staff;
      this._recruitments = recruitments;
      this.renderHeader();
      this.renderTable();
      this.renderCalendar();
    } catch (e) {
      showToast("エラー", `データ読み込み失敗: ${e.message}`, "error");
    }
  },

  async loadStaff(activeOnly) {
    try {
      this.staffList = await API.staff.list(activeOnly);
      this.renderTable();
      this.renderCalendar();
    } catch (e) {
      showToast("エラー", `スタッフ読み込み失敗: ${e.message}`, "error");
    }
  },

  // === ソート ===
  columns: [
    { key: "name", label: "名前", resizable: true, minWidth: 100 },
    { key: "email", label: "メール", hideClass: "d-none d-md-table-cell", resizable: true, minWidth: 80 },
    { key: "phone", label: "電話", hideClass: "d-none d-md-table-cell", resizable: true, minWidth: 80 },
    { key: "availableDays", label: "稼働曜日", resizable: true, minWidth: 80, sortFn: (a, b) => (a.availableDays || []).length - (b.availableDays || []).length },
    { key: "ratePerJob", label: "報酬単価", align: "text-end", resizable: true, minWidth: 60 },
    { key: "active", label: "ステータス", resizable: false, minWidth: 60, sortFn: (a, b) => (a.active === b.active ? 0 : a.active ? -1 : 1) },
    { key: "_actions", label: "", resizable: false, sortable: false, minWidth: 60 },
  ],

  renderHeader() {
    const thead = document.getElementById("staffTableHead");
    const tr = document.createElement("tr");

    this.columns.forEach((col, i) => {
      const th = document.createElement("th");
      th.className = col.hideClass || "";
      if (col.align) th.classList.add(col.align);
      th.style.position = "relative";
      th.style.userSelect = "none";
      if (col.minWidth) th.style.minWidth = col.minWidth + "px";

      if (col.sortable !== false) {
        th.style.cursor = "pointer";
        const arrow = this.sortKey === col.key
          ? (this.sortAsc ? " ▲" : " ▼")
          : "";
        th.textContent = col.label + arrow;
        th.addEventListener("click", () => {
          if (this.sortKey === col.key) {
            this.sortAsc = !this.sortAsc;
          } else {
            this.sortKey = col.key;
            this.sortAsc = true;
          }
          this.renderHeader();
          this.renderTable();
        });
      } else {
        th.textContent = col.label;
      }

      // 列リサイズハンドル
      if (col.resizable) {
        const handle = document.createElement("div");
        handle.className = "col-resize-handle";
        handle.addEventListener("mousedown", (e) => this._startResize(e, th, i));
        handle.addEventListener("touchstart", (e) => this._startResize(e, th, i), { passive: false });
        th.appendChild(handle);
      }

      tr.appendChild(th);
    });

    thead.innerHTML = "";
    thead.appendChild(tr);
  },

  _startResize(e, th, colIdx) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.touches ? e.touches[0].clientX : e.clientX;
    const startW = th.offsetWidth;

    const onMove = (ev) => {
      const x = ev.touches ? ev.touches[0].clientX : ev.clientX;
      const newW = Math.max(this.columns[colIdx].minWidth || 40, startW + (x - startX));
      th.style.width = newW + "px";
      th.style.minWidth = newW + "px";
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onUp);
  },

  getSortedList() {
    const list = [...this.staffList];
    const col = this.columns.find(c => c.key === this.sortKey);
    if (!col || col.sortable === false) return list;

    if (col.sortFn) {
      list.sort((a, b) => this.sortAsc ? col.sortFn(a, b) : col.sortFn(b, a));
    } else {
      list.sort((a, b) => {
        let va = a[this.sortKey], vb = b[this.sortKey];
        if (va == null) va = "";
        if (vb == null) vb = "";
        if (typeof va === "number" && typeof vb === "number") {
          return this.sortAsc ? va - vb : vb - va;
        }
        const sa = String(va).toLowerCase(), sb = String(vb).toLowerCase();
        return this.sortAsc ? sa.localeCompare(sb) : sb.localeCompare(sa);
      });
    }
    return list;
  },

  renderTable() {
    const tbody = document.getElementById("staffTableBody");
    const sorted = this.getSortedList();

    if (!sorted.length) {
      tbody.innerHTML = `
        <tr><td colspan="7">
          <div class="empty-state">
            <i class="bi bi-people"></i>
            <p>スタッフが登録されていません</p>
          </div>
        </td></tr>
      `;
      return;
    }

    tbody.innerHTML = sorted.map((s) => `
      <tr data-id="${s.id}">
        <td>
          <strong>${this.escapeHtml(s.name)}</strong>
          ${s.skills && s.skills.length ? `<br><small class="text-muted">${s.skills.join(", ")}</small>` : ""}
        </td>
        <td class="d-none d-md-table-cell">${this.escapeHtml(s.email || "-")}</td>
        <td class="d-none d-md-table-cell">${this.escapeHtml(s.phone || "-")}</td>
        <td>${this.renderDayChips(s.availableDays || [])}</td>
        <td class="text-end">${formatCurrency(s.ratePerJob)}</td>
        <td>
          <span class="badge ${s.active ? "bg-success" : "bg-secondary"} staff-status-badge">
            ${s.active ? "有効" : "無効"}
          </span>
        </td>
        <td>
          <div class="btn-group btn-group-sm">
            <button class="btn btn-outline-primary btn-edit" title="編集">
              <i class="bi bi-pencil"></i>
            </button>
            <button class="btn btn-outline-danger btn-delete" title="無効化">
              <i class="bi bi-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `).join("");

    tbody.querySelectorAll(".btn-edit").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const id = e.currentTarget.closest("tr").dataset.id;
        const staff = this.staffList.find((s) => s.id === id);
        if (staff) this.openModal(staff);
      });
    });

    tbody.querySelectorAll(".btn-delete").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const id = e.currentTarget.closest("tr").dataset.id;
        const staff = this.staffList.find((s) => s.id === id);
        if (staff) this.deleteStaff(staff);
      });
    });
  },

  renderDayChips(days) {
    const allDays = ["月", "火", "水", "木", "金", "土", "日"];
    return allDays.map((d) =>
      `<span class="day-chip ${days.includes(d) ? "active" : ""}">${d}</span>`
    ).join("");
  },

  // === 横スクロール回答カレンダー ===
  renderCalendar() {
    const container = document.getElementById("staffCalContainer");
    if (!container) return;

    const recruitments = this._recruitments;
    const staffList = this.staffList;

    if (!staffList.length) {
      container.innerHTML = '<p class="text-muted small">スタッフデータがありません。</p>';
      return;
    }

    // 月パース
    const ym = (this._calMonth || "").split("-");
    let year, month;
    if (ym.length === 2) {
      year = parseInt(ym[0], 10);
      month = parseInt(ym[1], 10);
    } else {
      const now = new Date();
      year = now.getFullYear();
      month = now.getMonth() + 1;
    }

    const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
    const todayObj = new Date();
    const todayStr = todayObj.getFullYear() + "-" + String(todayObj.getMonth() + 1).padStart(2, "0") + "-" + String(todayObj.getDate()).padStart(2, "0");

    // 前月・当月・翌月
    const months = [];
    for (let mi = -1; mi <= 1; mi++) {
      const mDate = new Date(year, month - 1 + mi, 1);
      const mY = mDate.getFullYear();
      const mM = mDate.getMonth() + 1;
      const mDays = new Date(mY, mM, 0).getDate();
      months.push({ year: mY, month: mM, days: mDays });
    }

    // 募集データを日付マッピング
    const recruitByDate = {};
    recruitments.forEach((r) => {
      if (r.status === "キャンセル済み") return;
      const d = (r.checkoutDate || "").slice(0, 10);
      if (!recruitByDate[d] || recruitByDate[d].status === "キャンセル済み") {
        recruitByDate[d] = r;
      }
    });

    // カラーテーマ
    const C = {
      headerBg: "#f8f9fa", stickyBg: "#fff", stickyBorder: "#dee2e6",
      noRecruit: "#f5f5f5", cellBg: "", tableBorder: "#dee2e6",
      todayBg: "#e8f0fe",
      confirmedBorder: "#dc3545", confirmedBg: "#fff5f5",
      monthSepBg: "#e9ecef", monthSepColor: "#495057",
      symOk: "#198754", symHold: "#cc9a06", symNg: "#dc3545", symNone: "#adb5bd",
      sunColor: "#dc3545", satColor: "#0d6efd", dayColor: "",
    };

    // 全日付カラム
    const allDates = [];
    months.forEach((m) => {
      for (let d = 1; d <= m.days; d++) {
        allDates.push({
          year: m.year, month: m.month, day: d,
          dateStr: m.year + "-" + String(m.month).padStart(2, "0") + "-" + String(d).padStart(2, "0"),
          isCurrentMonth: m.month === month && m.year === year,
        });
      }
    });

    const totalCols = allDates.length;
    let html = `<table class="table table-sm mb-0 staff-cal-table" style="font-size:12px;white-space:nowrap;border-collapse:collapse;min-width:${100 + totalCols * 36}px;">`;

    // ヘッダー行1: 月ラベル
    html += `<thead><tr><th rowspan="2" class="staff-cal-sticky" style="background:${C.headerBg};min-width:80px;max-width:100px;vertical-align:middle;">スタッフ</th>`;
    months.forEach((m) => {
      const isCurrent = m.month === month && m.year === year;
      const bg = isCurrent ? C.headerBg : C.monthSepBg;
      const color = isCurrent ? "" : C.monthSepColor;
      html += `<th colspan="${m.days}" class="text-center staff-cal-month-hd" data-cal-month="${m.month}月" style="background:${bg};${color ? "color:" + color + ";" : ""}border:1px solid ${C.tableBorder};font-size:13px;">${m.month}月</th>`;
    });
    html += "</tr>";

    // ヘッダー行2: 日付+曜日
    html += "<tr>";
    allDates.forEach((dd) => {
      const dt = new Date(dd.year, dd.month - 1, dd.day);
      const dow = dt.getDay();
      const isToday = dd.dateStr === todayStr;
      const hasRecruit = !!recruitByDate[dd.dateStr];
      const dowColor = dow === 0 ? C.sunColor : (dow === 6 ? C.satColor : C.dayColor);
      const bgColor = isToday ? C.todayBg : (!dd.isCurrentMonth ? C.monthSepBg : (!hasRecruit ? C.noRecruit : C.headerBg));
      html += `<th class="text-center${hasRecruit ? " staff-cal-date-hd" : ""}" data-cal-date="${dd.dateStr}" style="min-width:34px;padding-top:6px;${dowColor ? "color:" + dowColor + ";" : ""}background:${bgColor};border:1px solid ${C.tableBorder};"><div>${dd.day}</div><div style="font-size:10px;">${dayNames[dow]}</div></th>`;
    });
    html += "</tr></thead><tbody>";

    // 各スタッフ行
    staffList.forEach((staff) => {
      const staffName = staff.name;
      html += `<tr><td class="staff-cal-sticky" style="background:${C.stickyBg};font-weight:bold;border:1px solid ${C.tableBorder};border-right:2px solid ${C.stickyBorder};max-width:100px;overflow:hidden;text-overflow:ellipsis;">${this.escapeHtml(staffName)}</td>`;

      allDates.forEach((dd) => {
        const isToday = dd.dateStr === todayStr;
        const recruit = recruitByDate[dd.dateStr];

        if (!recruit) {
          const emptyBg = isToday ? C.todayBg : (!dd.isCurrentMonth ? C.monthSepBg : C.noRecruit);
          html += `<td class="text-center" style="background:${emptyBg};border:1px solid ${C.tableBorder};color:${C.symNone};">-</td>`;
          return;
        }

        // このスタッフの回答を探す
        const responses = recruit.responses || [];
        let resp = "未回答";
        for (const r of responses) {
          if (r.staffName === staffName || (r.staffEmail && staff.email && r.staffEmail.toLowerCase() === staff.email.toLowerCase())) {
            resp = r.response || "未回答";
            break;
          }
        }

        let symbol = "", symColor = "";
        if (resp === "◎") { symbol = "●"; symColor = C.symOk; }
        else if (resp === "△") { symbol = "▲"; symColor = C.symHold; }
        else if (resp === "×") { symbol = "✖"; symColor = C.symNg; }
        else { symbol = "−"; symColor = C.symNone; }

        // 確定済みかどうか
        let isConfirmed = false;
        const selectedStaff = (recruit.selectedStaff || "").trim();
        if (selectedStaff && (recruit.status === "選定済" || recruit.status === "スタッフ確定済み")) {
          const confirmedNames = selectedStaff.split(/[,、\s]+/).map(s => s.trim());
          isConfirmed = confirmedNames.includes(staffName);
        }

        const cellBg = isConfirmed ? C.confirmedBg : (isToday ? C.todayBg : (!dd.isCurrentMonth ? C.monthSepBg : (C.cellBg || "")));
        const cellShadow = isConfirmed ? `box-shadow:inset 0 0 0 2px ${C.confirmedBorder};` : "";

        html += `<td class="text-center staff-cal-cell" data-cal-date="${dd.dateStr}" data-cal-staff="${this.escapeHtml(staffName)}" style="cursor:pointer;border:1px solid ${C.tableBorder};${cellShadow}background:${cellBg};color:${symColor};font-weight:bold;">${symbol}</td>`;
      });

      html += "</tr>";
    });

    html += "</tbody></table>";
    container.innerHTML = html;

    // セルクリック → 募集詳細を開く（ダッシュボードのモーダルを利用）
    container.querySelectorAll(".staff-cal-cell").forEach((td) => {
      td.addEventListener("click", () => {
        const dateStr = td.dataset.calDate;
        const recruit = recruitByDate[dateStr];
        if (!recruit) return;
        // ダッシュボードのモーダルか、募集管理ページに遷移
        window.location.hash = "#/recruitment";
        setTimeout(() => {
          if (typeof RecruitmentPage !== "undefined" && RecruitmentPage.openDetailModal) {
            RecruitmentPage.openDetailModal(recruit);
          }
        }, 300);
      });
    });

    // 日付ヘッダークリック → 同様
    container.querySelectorAll(".staff-cal-date-hd").forEach((th) => {
      th.addEventListener("click", () => {
        const dateStr = th.dataset.calDate;
        const recruit = recruitByDate[dateStr];
        if (!recruit) return;
        window.location.hash = "#/recruitment";
        setTimeout(() => {
          if (typeof RecruitmentPage !== "undefined" && RecruitmentPage.openDetailModal) {
            RecruitmentPage.openDetailModal(recruit);
          }
        }, 300);
      });
    });

    // 月名オーバーレイのスクロール追従
    this._setupMonthOverlay(container);

    // 今日の列まで自動スクロール
    this._scrollToToday(container);
  },

  _scrollToToday(container) {
    const todayObj = new Date();
    const todayStr = todayObj.getFullYear() + "-" + String(todayObj.getMonth() + 1).padStart(2, "0") + "-" + String(todayObj.getDate()).padStart(2, "0");
    const todayTh = container.querySelector(`[data-cal-date="${todayStr}"]`);
    const stickyTh = container.querySelector("thead th");
    const stickyWidth = stickyTh ? stickyTh.offsetWidth + 2 : 92;

    if (todayTh) {
      const colWidth = todayTh.offsetWidth || 34;
      container.scrollLeft = todayTh.offsetLeft - stickyWidth - colWidth;
    } else {
      // 今日が表示範囲外なら最初の募集日にスクロール
      const first = container.querySelector(".staff-cal-date-hd");
      if (first) container.scrollLeft = first.offsetLeft - stickyWidth;
    }
  },

  _setupMonthOverlay(container) {
    const overlay = document.getElementById("staffCalMonthOverlay");
    if (!overlay) return;

    const updateOverlay = () => {
      const headers = container.querySelectorAll(".staff-cal-month-hd");
      if (!headers.length) { overlay.style.display = "none"; return; }
      const stickyTh = container.querySelector("thead th");
      const stickyRight = stickyTh ? stickyTh.getBoundingClientRect().right : container.getBoundingClientRect().left + 90;
      let visibleMonth = "";
      headers.forEach((th) => {
        const rect = th.getBoundingClientRect();
        if (rect.right > stickyRight && (!visibleMonth || rect.left < stickyRight)) {
          visibleMonth = th.dataset.calMonth || "";
        }
      });
      if (!visibleMonth && headers.length) {
        visibleMonth = headers[headers.length - 1].dataset.calMonth || "";
      }
      overlay.textContent = visibleMonth;
      overlay.style.display = visibleMonth ? "" : "none";
    };

    container.addEventListener("scroll", updateOverlay);
    setTimeout(updateOverlay, 100);
  },

  // === モーダル ===
  openModal(staff = null) {
    const isEdit = !!staff;
    document.getElementById("staffModalTitle").textContent = isEdit ? "スタッフ編集" : "スタッフ登録";
    document.getElementById("staffEditId").value = isEdit ? staff.id : "";

    document.getElementById("staffName").value = staff?.name || "";
    document.getElementById("staffEmail").value = staff?.email || "";
    document.getElementById("staffPhone").value = staff?.phone || "";
    document.getElementById("staffRate").value = staff?.ratePerJob || 0;
    document.getElementById("staffTransport").value = staff?.transportationFee || 0;
    document.getElementById("staffContractDate").value = staff?.contractStartDate
      ? new Date(staff.contractStartDate.seconds ? staff.contractStartDate.seconds * 1000 : staff.contractStartDate).toISOString().split("T")[0]
      : "";
    document.getElementById("staffSkills").value = (staff?.skills || []).join(",");
    document.getElementById("staffBankName").value = staff?.bankName || "";
    document.getElementById("staffBranchName").value = staff?.branchName || "";
    document.getElementById("staffAccountType").value = staff?.accountType || "普通";
    document.getElementById("staffAccountNumber").value = staff?.accountNumber || "";
    document.getElementById("staffAccountHolder").value = staff?.accountHolder || "";
    document.getElementById("staffMemo").value = staff?.memo || "";

    const days = staff?.availableDays || [];
    document.querySelectorAll("#staffDays input[type=checkbox]").forEach((cb) => {
      cb.checked = days.includes(cb.value);
    });

    this.modal.show();
  },

  async saveStaff() {
    const id = document.getElementById("staffEditId").value;
    const name = document.getElementById("staffName").value.trim();

    if (!name) {
      showToast("入力エラー", "名前は必須です", "error");
      return;
    }

    const availableDays = [];
    document.querySelectorAll("#staffDays input[type=checkbox]:checked").forEach((cb) => {
      availableDays.push(cb.value);
    });

    const skills = document.getElementById("staffSkills").value
      .split(",").map((s) => s.trim()).filter(Boolean);

    const data = {
      name,
      email: document.getElementById("staffEmail").value.trim(),
      phone: document.getElementById("staffPhone").value.trim(),
      ratePerJob: Number(document.getElementById("staffRate").value) || 0,
      transportationFee: Number(document.getElementById("staffTransport").value) || 0,
      contractStartDate: document.getElementById("staffContractDate").value || null,
      availableDays,
      skills,
      bankName: document.getElementById("staffBankName").value.trim(),
      branchName: document.getElementById("staffBranchName").value.trim(),
      accountType: document.getElementById("staffAccountType").value,
      accountNumber: document.getElementById("staffAccountNumber").value.trim(),
      accountHolder: document.getElementById("staffAccountHolder").value.trim(),
      memo: document.getElementById("staffMemo").value.trim(),
    };

    try {
      if (id) {
        await API.staff.update(id, data);
        showToast("完了", "スタッフ情報を更新しました", "success");
      } else {
        await API.staff.create(data);
        showToast("完了", "スタッフを登録しました", "success");
      }
      this.modal.hide();
      await this.loadData();
    } catch (e) {
      showToast("エラー", `保存に失敗しました: ${e.message}`, "error");
    }
  },

  async deleteStaff(staff) {
    if (!confirm(`${staff.name} を無効化しますか？`)) return;

    try {
      await API.staff.delete(staff.id);
      showToast("完了", `${staff.name} を無効化しました`, "success");
      await this.loadData();
    } catch (e) {
      showToast("エラー", `無効化に失敗しました: ${e.message}`, "error");
    }
  },

  escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  },
};
