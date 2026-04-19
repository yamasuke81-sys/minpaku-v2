/**
 * スタッフ管理ページ
 * 一覧・登録・編集・無効化 + ソート + 列リサイズ + 横スクロール回答カレンダー
 */
const StaffPage = {
  staffList: [],
  properties: [],           // 物件一覧
  selectedPropertyIds: [],  // フィルタ選択中の物件ID
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

      <!-- 物件フィルタ -->
      <div id="propertyFilterHost-staff"></div>

      <div class="table-responsive">
        <table class="table table-hover align-middle mb-0" id="staffTable">
          <thead class="table-light" id="staffTableHead"></thead>
          <tbody id="staffTableBody">
            <tr><td colspan="6" class="text-center py-4">読み込み中...</td></tr>
          </tbody>
        </table>
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

  },

  async loadData() {
    try {
      const [staff, recruitments, minpaku] = await Promise.all([
        API.staff.list(!this.showInactive),
        API.recruitments.list(),
        API.properties.listMinpakuNumbered(),
      ]);
      this.staffList = staff;
      this._recruitments = recruitments;
      this.properties = minpaku;
      this._propMap = {};
      minpaku.forEach(p => { this._propMap[p.id] = p; });
      this.selectedPropertyIds = PropertyFilter.getSelectedIds("staff", minpaku);

      // 物件フィルタ描画
      PropertyFilter.render({
        containerId: "propertyFilterHost-staff",
        tabKey: "staff",
        properties: minpaku,
        onChange: (ids) => {
          this.selectedPropertyIds = ids;
          this.renderTable();
        },
      });

      this.renderHeader();
      this.renderTable();
      // this.renderCalendar();  // 横カレンダーは清掃スケジュールタブに統合
    } catch (e) {
      showToast("エラー", `データ読み込み失敗: ${e.message}`, "error");
    }
  },

  async loadStaff(activeOnly) {
    try {
      this.staffList = await API.staff.list(activeOnly);
      this.renderTable();
      // this.renderCalendar();  // 横カレンダーは清掃スケジュールタブに統合
    } catch (e) {
      showToast("エラー", `スタッフ読み込み失敗: ${e.message}`, "error");
    }
  },

  // === ソート ===
  columns: [
    { key: "name", label: "名前", resizable: true, minWidth: 100 },
    { key: "email", label: "メール", hideClass: "d-none d-md-table-cell", resizable: true, minWidth: 80 },
    { key: "phone", label: "電話", hideClass: "d-none d-md-table-cell", resizable: true, minWidth: 80 },
    { key: "assignedPropertyIds", label: "担当物件", resizable: true, minWidth: 100, sortFn: (a, b) => (a.assignedPropertyIds || []).length - (b.assignedPropertyIds || []).length },
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
    // assignedPropertyIds にフィルタ対象物件が含まれるスタッフのみ表示
    // (担当物件未設定のスタッフは全物件担当として常に表示)
    const sorted = this.getSortedList().filter(s => {
      if (!this.selectedPropertyIds || this.selectedPropertyIds.length === 0) return false;
      const assigned = Array.isArray(s.assignedPropertyIds) ? s.assignedPropertyIds : [];
      if (assigned.length === 0) return true; // 担当物件未設定 = 常に表示
      return assigned.some(pid => this.selectedPropertyIds.includes(pid));
    });

    if (!sorted.length) {
      tbody.innerHTML = `
        <tr><td colspan="6">
          <div class="empty-state">
            <i class="bi bi-people"></i>
            <p>スタッフが登録されていません</p>
          </div>
        </td></tr>
      `;
      return;
    }

    const canDrag = this.sortKey === "displayOrder" && this.sortAsc;
    const propMap = this._propMap || {};
    tbody.innerHTML = sorted.map((s) => `
      <tr data-id="${s.id}">
        <td>
          ${canDrag ? '<i class="bi bi-grip-vertical text-muted me-1 staff-handle" style="cursor:grab;"></i>' : ''}
          <strong>${this.escapeHtml(s.name)}</strong>
          ${s.isTimee ? '<span class="badge bg-warning text-dark ms-1" title="タイミー">T</span>' : ""}
          ${s.skills && s.skills.length ? `<br><small class="text-muted">${s.skills.join(", ")}</small>` : ""}
        </td>
        <td class="d-none d-md-table-cell">${this.escapeHtml(s.email || "-")}</td>
        <td class="d-none d-md-table-cell">${this.escapeHtml(s.phone || "-")}</td>
        <td>${this.renderAssignedPropertyBadges(s.assignedPropertyIds || [], propMap)}</td>
        <td>
          <span class="badge ${s.active ? "bg-success" : "bg-secondary"} staff-status-badge">
            ${s.active ? "有効" : "無効"}
          </span>
          ${s.lineUserId ? '<span class="badge bg-success ms-1" title="LINE連携済み"><i class="bi bi-line"></i></span>' : ""}
          ${s.authUid ? '<span class="badge bg-info ms-1" title="アプリ認証済み"><i class="bi bi-person-check"></i></span>' : ""}
        </td>
        <td>
          <div class="btn-group btn-group-sm">
            <button class="btn btn-outline-primary btn-edit" title="編集">
              <i class="bi bi-pencil"></i>
            </button>
            ${!s.active ? `<button class="btn btn-outline-success btn-reactivate" title="非アクティブ解除">
              <i class="bi bi-arrow-counterclockwise"></i>
            </button>` : ""}
            <button class="btn btn-outline-danger btn-delete" title="無効化">
              <i class="bi bi-trash"></i>
            </button>
          </div>
          ${!s.active && s.inactiveReason ? `<div class="text-muted small mt-1"><i class="bi bi-info-circle"></i> ${this.escapeHtml(s.inactiveReason)}</div>` : ""}
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

    tbody.querySelectorAll(".btn-reactivate").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const id = e.currentTarget.closest("tr").dataset.id;
        const staff = this.staffList.find((s) => s.id === id);
        if (!staff) return;
        const ok = await showConfirm(`${staff.name} を再アクティブ化しますか？未回答カウントもリセットされます。`, "再アクティブ化");
        if (!ok) return;
        try {
          const token = await firebase.auth().currentUser.getIdToken();
          const res = await fetch(`https://api-5qrfx7ujcq-an.a.run.app/staff/${id}/reactivate`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || "失敗");
          }
          showToast("完了", `${staff.name} を再アクティブ化しました`, "success");
          await this.loadStaff(!this.showInactive);
        } catch (e) {
          showToast("エラー", `再アクティブ化失敗: ${e.message}`, "error");
        }
      });
    });

    // D&D 並び替え (displayOrder 昇順で表示中のみ有効)
    this.initSortable(tbody, canDrag);
  },

  initSortable(tbody, enabled) {
    if (this._sortable) { try { this._sortable.destroy(); } catch {} this._sortable = null; }
    if (!enabled || typeof Sortable === "undefined") return;
    this._sortable = Sortable.create(tbody, {
      handle: ".staff-handle",
      animation: 150,
      onEnd: async () => {
        const ids = [...tbody.querySelectorAll("tr")].map(r => r.dataset.id).filter(Boolean);
        try {
          // displayOrder を並び順で再採番
          const updates = ids.map((id, i) => {
            return API.staff.update(id, { displayOrder: i + 1 });
          });
          await Promise.all(updates);
          // ローカルも更新
          this.staffList.forEach(s => {
            const idx = ids.indexOf(s.id);
            if (idx >= 0) s.displayOrder = idx + 1;
          });
          showToast("保存", "並び順を保存しました", "success");
        } catch (e) {
          showToast("エラー", "並び順保存失敗: " + e.message, "error");
          await this.loadStaff(!this.showInactive);
        }
      }
    });
  },

  renderDayChips(days) {
    const allDays = ["月", "火", "水", "木", "金", "土", "日"];
    return allDays.map((d) =>
      `<span class="day-chip ${days.includes(d) ? "active" : ""}">${d}</span>`
    ).join("");
  },

  // 担当物件バッジ (番号+色+物件名、listMinpakuNumberedの結果を使用)
  renderAssignedPropertyBadges(ids, propMap) {
    if (!ids || !ids.length) return '<span class="text-muted small">未設定</span>';
    return ids.map(id => {
      const p = propMap[id];
      if (!p) return `<span class="badge bg-secondary me-1">?</span>`;
      return `<span class="badge me-1" style="background:${p._color};color:#fff;" title="${this.escapeHtml(p.name)}">${p._num} ${this.escapeHtml(p.name)}</span>`;
    }).join("");
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

        html += `<td class="text-center staff-cal-cell" data-cal-date="${dd.dateStr}" data-cal-staff="${this.escapeHtml(staffName)}" data-staff-id="${staff.id}" data-staff-email="${this.escapeHtml(staff.email || "")}" style="cursor:pointer;border:1px solid ${C.tableBorder};${cellShadow}background:${cellBg};color:${symColor};font-weight:bold;vertical-align:middle;">${symbol}</td>`;
      });

      html += "</tr>";
    });

    html += "</tbody></table>";
    container.innerHTML = html;

    // セルクリック → その場で代理回答ピッカー表示
    container.querySelectorAll(".staff-cal-cell").forEach((td) => {
      td.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const dateStr = td.dataset.calDate;
        const recruit = recruitByDate[dateStr];
        if (!recruit) return;
        if (recruit.status === "スタッフ確定済み") {
          // 確定後は編集不可、詳細モーダルに遷移のみ
          window.location.hash = "#/recruitment";
          setTimeout(() => {
            if (typeof RecruitmentPage !== "undefined" && RecruitmentPage.openDetailModal) {
              RecruitmentPage.openDetailModal(recruit);
            }
          }, 300);
          return;
        }
        this.openResponsePicker(td, recruit);
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

  // 担当物件チェックボックス描画 (民泊物件のみ、番号+色付きバッジ)
  async renderPropertyCheckboxes(assignedIds) {
    const el = document.getElementById("staffProperties");
    if (!el) return;
    const minpaku = await API.properties.listMinpakuNumbered();
    if (minpaku.length === 0) {
      el.innerHTML = `<small class="text-muted">有効な民泊物件がありません</small>`;
      return;
    }
    const set = new Set(assignedIds || []);
    el.innerHTML = minpaku.map(p => `
      <div class="form-check">
        <input class="form-check-input" type="checkbox" value="${p.id}" id="sprop_${p.id}" ${set.has(p.id) ? "checked" : ""}>
        <label class="form-check-label" for="sprop_${p.id}">
          <span class="badge me-1" style="background:${p._color};color:#fff;">${p._num}</span>${this.escapeHtml(p.name)}
        </label>
      </div>
    `).join("");
  },

  escapeHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  },

  // 横カレンダーのセルクリック時: 代理回答ピッカー
  openResponsePicker(td, recruit) {
    // 既存ピッカー除去
    document.querySelectorAll(".staff-cal-picker").forEach(p => p.remove());

    const staffId = td.dataset.staffId;
    const staffName = td.dataset.calStaff;
    const staffEmail = td.dataset.staffEmail;
    const dateStr = td.dataset.calDate;

    const picker = document.createElement("div");
    picker.className = "staff-cal-picker card shadow";
    picker.style.cssText = "position:absolute;z-index:1060;min-width:220px;";
    picker.innerHTML = `
      <div class="card-body p-2">
        <div class="small text-muted mb-1"><i class="bi bi-person"></i> ${this.escapeHtml(staffName)} / ${dateStr}</div>
        <div class="btn-group btn-group-sm w-100 mb-1">
          <button class="btn btn-success" data-resp="◎">◎</button>
          <button class="btn btn-warning" data-resp="△">△</button>
          <button class="btn btn-danger" data-resp="×">×</button>
          <button class="btn btn-secondary" data-resp="未回答">未回答</button>
        </div>
        <button class="btn btn-sm btn-outline-primary w-100 mt-1" data-act="detail">
          <i class="bi bi-box-arrow-up-right"></i> 募集の詳細を開く
        </button>
      </div>
    `;
    const rect = td.getBoundingClientRect();
    picker.style.top = (rect.bottom + window.scrollY + 4) + "px";
    picker.style.left = (rect.left + window.scrollX) + "px";
    document.body.appendChild(picker);

    // はみ出したら左に寄せる
    const pickerRect = picker.getBoundingClientRect();
    if (pickerRect.right > window.innerWidth - 8) {
      picker.style.left = (window.innerWidth - pickerRect.width - 8 + window.scrollX) + "px";
    }

    // 外側クリックで閉じる
    const closeOnOutside = (e) => {
      if (!picker.contains(e.target) && e.target !== td) {
        picker.remove();
        document.removeEventListener("click", closeOnOutside, true);
      }
    };
    setTimeout(() => document.addEventListener("click", closeOnOutside, true), 10);

    // 回答ボタン
    picker.querySelectorAll("[data-resp]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const resp = btn.dataset.resp;
        picker.remove();
        document.removeEventListener("click", closeOnOutside, true);
        try {
          await API.recruitments.respond(recruit.id, {
            staffId, staffName, staffEmail, response: resp
          });
          showToast("完了", `${staffName} の回答を ${resp} に設定しました`, "success");
          // 募集を再読込 → カレンダー再描画
          this._recruitments = await API.recruitments.list();
          // this.renderCalendar();  // 横カレンダーは清掃スケジュールタブに統合
        } catch (e) {
          showToast("エラー", `回答設定失敗: ${e.message}`, "error");
        }
      });
    });
    // 詳細に移動
    picker.querySelector('[data-act="detail"]').addEventListener("click", () => {
      picker.remove();
      document.removeEventListener("click", closeOnOutside, true);
      window.location.hash = "#/recruitment";
      setTimeout(() => {
        if (typeof RecruitmentPage !== "undefined" && RecruitmentPage.openDetailModal) {
          RecruitmentPage.openDetailModal(recruit);
        }
      }, 300);
    });
  },

  // === モーダル ===
  openModal(staff = null) {
    const isEdit = !!staff;
    document.getElementById("staffModalTitle").textContent = isEdit ? "スタッフ編集" : "スタッフ登録";
    document.getElementById("staffEditId").value = isEdit ? staff.id : "";

    document.getElementById("staffName").value = staff?.name || "";
    document.getElementById("staffEmail").value = staff?.email || "";
    document.getElementById("staffPhone").value = staff?.phone || "";
    const addrEl = document.getElementById("staffAddress");
    if (addrEl) addrEl.value = staff?.address || "";
    document.getElementById("staffContractDate").value = staff?.contractStartDate
      ? new Date(staff.contractStartDate.seconds ? staff.contractStartDate.seconds * 1000 : staff.contractStartDate).toISOString().split("T")[0]
      : "";
    const isTimeeEl = document.getElementById("staffIsTimee");
    if (isTimeeEl) isTimeeEl.checked = !!staff?.isTimee;
    document.getElementById("staffSkills").value = (staff?.skills || []).join(",");
    document.getElementById("staffBankName").value = staff?.bankName || "";
    document.getElementById("staffBranchName").value = staff?.branchName || "";
    document.getElementById("staffAccountType").value = staff?.accountType || "普通";
    document.getElementById("staffAccountNumber").value = staff?.accountNumber || "";
    document.getElementById("staffAccountHolder").value = staff?.accountHolder || "";
    document.getElementById("staffMemo").value = staff?.memo || "";

    // 担当物件チェックボックス(民泊物件のみ、デフォルト外れ)
    this.renderPropertyCheckboxes(staff?.assignedPropertyIds || []);

    // LINE連携セクション（編集時のみ表示）
    const lineSection = document.getElementById("staffLineSection");
    const lineUserIdEl = document.getElementById("staffLineUserId");
    const authStatusEl = document.getElementById("staffAuthStatus");
    const inviteResult = document.getElementById("inviteLinkResult");
    if (isEdit) {
      lineSection.classList.remove("d-none");
      lineUserIdEl.value = staff?.lineUserId || "";
      inviteResult.classList.add("d-none");
      // 認証状態表示
      if (staff?.authUid) {
        authStatusEl.classList.remove("d-none");
        authStatusEl.textContent = "認証済み";
        authStatusEl.className = "badge bg-success";
      } else {
        authStatusEl.classList.remove("d-none");
        authStatusEl.textContent = "未認証";
        authStatusEl.className = "badge bg-warning text-dark";
      }
      // 招待リンクボタン
      const btnInvite = document.getElementById("btnInviteStaff");
      btnInvite.onclick = async () => {
        try {
          btnInvite.disabled = true;
          btnInvite.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
          const result = await API.callFunction("POST", "/auth/invite", { staffId: staff.id });
          document.getElementById("inviteLinkUrl").value = result.inviteUrl;
          inviteResult.classList.remove("d-none");
          showToast("成功", "招待リンクを発行しました（7日間有効）", "success");
        } catch (e) {
          showToast("エラー", e.message, "error");
        } finally {
          btnInvite.disabled = false;
          btnInvite.innerHTML = '<i class="bi bi-link-45deg"></i> 招待リンク発行';
        }
      };
      // コピーボタン
      document.getElementById("btnCopyInviteLink").onclick = () => {
        const url = document.getElementById("inviteLinkUrl").value;
        navigator.clipboard.writeText(url).then(() => showToast("コピー", "リンクをコピーしました", "success"));
      };
      // LINEで共有ボタン
      const btnShareLine = document.getElementById("btnShareInviteLine");
      if (btnShareLine) {
        btnShareLine.onclick = () => {
          const url = document.getElementById("inviteLinkUrl").value;
          if (!url) { showToast("エラー", "先に招待リンクを発行してください", "error"); return; }
          const text = encodeURIComponent(`民泊管理アプリへの招待です。以下のリンクから参加してください:\n${url}`);
          window.open(`https://line.me/R/share?text=${text}`, "_blank");
        };
      }
    } else {
      lineSection.classList.add("d-none");
    }

    this.modal.show();
  },

  async saveStaff() {
    const id = document.getElementById("staffEditId").value;
    const name = document.getElementById("staffName").value.trim();

    if (!name) {
      showToast("入力エラー", "名前は必須です", "error");
      return;
    }

    const skills = document.getElementById("staffSkills").value
      .split(",").map((s) => s.trim()).filter(Boolean);

    const assignedPropertyIds = [];
    document.querySelectorAll("#staffProperties input[type=checkbox]:checked").forEach(cb => {
      assignedPropertyIds.push(cb.value);
    });

    const data = {
      name,
      email: document.getElementById("staffEmail").value.trim(),
      phone: document.getElementById("staffPhone").value.trim(),
      address: (document.getElementById("staffAddress")?.value || "").trim(),
      contractStartDate: document.getElementById("staffContractDate").value || null,
      isTimee: !!document.getElementById("staffIsTimee")?.checked,
      skills,
      assignedPropertyIds,
      bankName: document.getElementById("staffBankName").value.trim(),
      branchName: document.getElementById("staffBranchName").value.trim(),
      accountType: document.getElementById("staffAccountType").value,
      accountNumber: document.getElementById("staffAccountNumber").value.trim(),
      accountHolder: document.getElementById("staffAccountHolder").value.trim(),
      memo: document.getElementById("staffMemo").value.trim(),
    };

    // LINE User ID（編集時のみ）
    if (id) {
      const lineUserId = document.getElementById("staffLineUserId")?.value?.trim();
      if (lineUserId !== undefined) {
        data.lineUserId = lineUserId || null;
      }
    }

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
    const ok = await showConfirm("無効化確認", `${staff.name} を無効化しますか？`);
    if (!ok) return;

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
