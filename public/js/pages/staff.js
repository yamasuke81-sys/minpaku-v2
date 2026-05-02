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
      <div id="propEyeFilterHost-staff"></div>

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
      this.selectedPropertyIds = minpaku.map(p => p.id);
      this._allActivePropertyIds = minpaku.map(p => p.id); // 孤児 ID 判定用 (フィルタ ON/OFF と独立)

      // 物件フィルタ描画 (目アイコン型で統一)
      this._propEyeCtrl = PropertyEyeFilter.render({
        containerId: "propEyeFilterHost-staff",
        tabKey: "staff",
        properties: minpaku,
        onChange: (visibleIds) => {
          this.selectedPropertyIds = visibleIds;
          this.renderTable();
        },
      });

      this.renderHeader();
      this.renderTable();
      // this.renderCalendar();  // 横カレンダーは清掃スケジュールタブに統合
      // 物件画面から「このスタッフの請求書表示内容を編集」で遷移してきた場合の自動オープン
      this._openFromSession();
    } catch (e) {
      showToast("エラー", `データ読み込み失敗: ${e.message}`, "error");
    }
  },

  async loadStaff(activeOnly) {
    try {
      this.staffList = await API.staff.list(activeOnly);
      // サブオーナー本人ログイン: 自所有物件を担当しているスタッフのみ表示
      if (Auth.isSubOwner()) {
        const owned = Array.isArray(Auth.currentUser?.ownedPropertyIds)
          ? Auth.currentUser.ownedPropertyIds : [];
        const ownedSet = new Set(owned);
        this.staffList = this.staffList.filter(s => {
          const assigned = Array.isArray(s.assignedPropertyIds) ? s.assignedPropertyIds : [];
          return assigned.some(pid => ownedSet.has(pid));
        });
        // スタッフ登録ボタンを非表示 (新規スタッフ作成はオーナーのみ)
        const btnAdd = document.getElementById("btnAddStaff");
        if (btnAdd) btnAdd.style.display = "none";
      }
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
    // 孤児 ID (削除済み物件) のみ持つスタッフも「担当なし扱い」で常に表示
    const activeIdSet = new Set(this.selectedPropertyIds || []);
    // 全アクティブ民泊物件 ID (存在確認用)。selectedPropertyIds は表示 ON/OFF 状態のため別途保持
    const knownPropertyIds = new Set((this._allActivePropertyIds || this.selectedPropertyIds || []));
    const sorted = this.getSortedList().filter(s => {
      if (!this.selectedPropertyIds || this.selectedPropertyIds.length === 0) return false;
      const assigned = Array.isArray(s.assignedPropertyIds) ? s.assignedPropertyIds : [];
      if (assigned.length === 0) return true; // 担当物件未設定 = 常に表示
      // 存在する物件 ID のみで再判定 (孤児 ID を無視)
      const validAssigned = assigned.filter(pid => knownPropertyIds.has(pid));
      if (validAssigned.length === 0) return true; // 有効な担当が 0 件 = 担当なし扱いで表示
      return validAssigned.some(pid => activeIdSet.has(pid));
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
          ${s.isSubOwner ? '<span class="badge bg-purple ms-1" style="background:#7c3aed;color:#fff;" title="物件オーナー">SO</span>' : ""}
          ${s.skills && s.skills.length ? `<br><small class="text-muted">${s.skills.join(", ")}</small>` : ""}
        </td>
        <td class="d-none d-md-table-cell">${this.escapeHtml(s.email || "-")}</td>
        <td class="d-none d-md-table-cell">${this.escapeHtml(s.phone || "-")}</td>
        <td>${this.renderAssignedPropertyBadges(s.assignedPropertyIds || [], propMap)}</td>
        <td>
          <span class="badge ${s.active ? "bg-success" : "bg-secondary"} staff-status-badge">
            ${s.active ? "有効" : "無効"}
          </span>
          ${(!s.active && s.inactiveReason && /15回|直近\d+回|募集について回答がなかった/.test(s.inactiveReason))
            ? `<span class="badge bg-warning text-dark ms-1" title="${this.escapeHtml(s.inactiveReason)}"><i class="bi bi-clock-history"></i> 15回非表示</span>`
            : ""}
          ${s.lineUserId ? '<span class="badge bg-success ms-1" title="LINE連携済み"><i class="bi bi-line"></i></span>' : ""}
          ${s.authUid ? '<span class="badge bg-info ms-1" title="アプリ認証済み"><i class="bi bi-person-check"></i></span>' : ""}
        </td>
        <td>
          <div class="btn-group btn-group-sm">
            <button class="btn btn-outline-primary btn-edit" title="編集">
              <i class="bi bi-pencil"></i>
            </button>
            ${s.isSubOwner ? `<button class="btn btn-outline-purple btn-impersonate" title="代理ログイン" style="color:#7c3aed;border-color:#7c3aed;" data-staff-id="${s.id}" data-staff-name="${this.escapeHtml(s.name)}">
              <i class="bi bi-person-badge"></i>
            </button>` : ""}
            ${!s.active ? `<button class="btn btn-outline-success btn-reactivate" title="非アクティブ解除">
              <i class="bi bi-arrow-counterclockwise"></i>
            </button>` : ""}
            <button class="btn btn-outline-danger btn-delete" title="${s.active === false ? "完全削除" : "無効化"}">
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

    // 代理ログインボタン（Webアプリ管理者のみ表示）
    tbody.querySelectorAll(".btn-impersonate").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const staffId = btn.dataset.staffId;
        const staffName = btn.dataset.staffName;
        const ok = await showConfirm(`${staffName} の物件オーナー視点で代理閲覧しますか？\n\n画面上部にバナーが表示されます。「解除」ボタンで元の表示に戻ります。`, "代理閲覧");
        if (!ok) return;
        localStorage.setItem("impersonateAs", staffId);
        window.location.reload();
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
      return `<span class="badge me-1" style="background:${p._color};color:#fff;min-width:24px;" title="${this.escapeHtml(p.name)}">${p._num}</span>`;
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

  // 所有物件チェックボックス (物件オーナー用)
  async renderOwnedPropertyCheckboxes(ownedIds) {
    const el = document.getElementById("staffOwnedProperties");
    if (!el) return;
    const minpaku = await API.properties.listMinpakuNumbered();
    if (minpaku.length === 0) {
      el.innerHTML = `<small class="text-muted">有効な民泊物件がありません</small>`;
      return;
    }
    const set = new Set(ownedIds || []);
    el.innerHTML = minpaku.map(p => `
      <div class="form-check">
        <input class="form-check-input" type="checkbox" value="${p.id}" id="oprop_${p.id}" ${set.has(p.id) ? "checked" : ""}>
        <label class="form-check-label" for="oprop_${p.id}">
          <span class="badge me-1" style="background:${p._color};color:#fff;">${p._num}</span>${this.escapeHtml(p.name)}
        </label>
      </div>
    `).join("");
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

    // 請求書表示内容 (複数名義)
    // 初期値: billingProfiles[] があればそれを使う / 無ければ旧 companyName/zipCode/address を 1 エントリに変換
    let initProfiles = Array.isArray(staff?.billingProfiles) ? staff.billingProfiles.slice() : [];
    if (initProfiles.length === 0) {
      const hasLegacy = (staff?.companyName || staff?.zipCode || staff?.address);
      if (hasLegacy) {
        initProfiles = [{
          id: this._genProfileId(),
          label: "メイン",
          companyName: staff?.companyName || "",
          zipCode: staff?.zipCode || "",
          address: staff?.address || "",
        }];
      }
    }
    this._billingProfiles = initProfiles.map(p => ({
      id: p.id || this._genProfileId(),
      label: p.label || "",
      companyName: p.companyName || "",
      zipCode: p.zipCode || "",
      address: p.address || "",
    }));
    this._renderBillingProfiles();
    // 旧フィールド (hidden) のミラー初期化
    const companyEl = document.getElementById("staffCompanyName");
    if (companyEl) companyEl.value = staff?.companyName || "";
    const zipEl = document.getElementById("staffZipCode");
    if (zipEl) zipEl.value = staff?.zipCode || "";
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

    // 物件オーナーセクション（編集時のみ表示・オーナー本人のみ操作可）
    // サブオーナー本人ログイン時は他人をサブオーナー化する操作を一切禁止する
    const subOwnerSection = document.getElementById("staffSubOwnerSection");
    if (isEdit && !Auth.isSubOwner()) {
      subOwnerSection.classList.remove("d-none");
      const isSubOwnerEl = document.getElementById("staffIsSubOwner");
      isSubOwnerEl.checked = !!staff?.isSubOwner;
      // 所有物件チェックボックス
      this.renderOwnedPropertyCheckboxes(staff?.ownedPropertyIds || []);
      document.getElementById("staffSubOwnerLineUserId").value = staff?.subOwnerLineUserId || "";
      document.getElementById("staffSubOwnerEmail").value = staff?.subOwnerEmail || "";
      // 物件オーナーON/OFFで詳細を表示切替
      const subOwnerDetails = document.getElementById("subOwnerDetails");
      subOwnerDetails.classList.toggle("d-none", !isSubOwnerEl.checked);
      isSubOwnerEl.onchange = () => {
        subOwnerDetails.classList.toggle("d-none", !isSubOwnerEl.checked);
      };
    } else {
      subOwnerSection.classList.add("d-none");
    }

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

    // 請求書表示内容: UI から収集 → 空エントリ除外
    const billingProfiles = this._collectBillingProfiles();
    // 後方互換ミラー: 先頭エントリを旧フィールドにコピー
    const firstBp = billingProfiles[0] || { companyName: "", zipCode: "", address: "" };

    const data = {
      name,
      email: document.getElementById("staffEmail").value.trim(),
      phone: document.getElementById("staffPhone").value.trim(),
      billingProfiles,
      companyName: firstBp.companyName || "",
      zipCode: firstBp.zipCode || "",
      address: firstBp.address || "",
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

      // 物件オーナー設定
      const isSubOwnerEl = document.getElementById("staffIsSubOwner");
      if (isSubOwnerEl) {
        data.isSubOwner = isSubOwnerEl.checked;
        if (isSubOwnerEl.checked) {
          const ownedPropertyIds = [];
          document.querySelectorAll("#staffOwnedProperties input[type=checkbox]:checked").forEach(cb => {
            ownedPropertyIds.push(cb.value);
          });
          data.ownedPropertyIds = ownedPropertyIds;
          data.subOwnerLineUserId = (document.getElementById("staffSubOwnerLineUserId")?.value || "").trim() || null;
          data.subOwnerEmail = (document.getElementById("staffSubOwnerEmail")?.value || "").trim() || null;
        } else {
          data.ownedPropertyIds = [];
          data.subOwnerLineUserId = null;
          data.subOwnerEmail = null;
        }
      }
    }

    try {
      if (id) {
        await API.staff.update(id, data);
        // Firebase Auth カスタムクレームもサーバー側で更新
        if (data.isSubOwner !== undefined) {
          try {
            await API.callFunction("POST", "/auth/set-sub-owner", {
              staffId: id,
              isSubOwner: data.isSubOwner,
              ownedPropertyIds: data.ownedPropertyIds || [],
              subOwnerLineUserId: data.subOwnerLineUserId,
              subOwnerEmail: data.subOwnerEmail,
            });
          } catch (claimErr) {
            // クレーム更新失敗はトーストで警告するが保存は続行
            showToast("警告", `カスタムクレーム更新失敗（再ログインで反映）: ${claimErr.message}`, "error");
          }
        }
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
    // 既に無効化済みのスタッフ → 完全削除（Firestore document を物理削除）
    // まだ有効なスタッフ → 論理削除（active=false にするだけ）
    const isAlreadyInactive = staff.active === false;

    if (isAlreadyInactive) {
      const ok = await showConfirm(
        "完全削除",
        `${staff.name} を完全に削除します。\n\nこの操作は元に戻せません。\n（過去の募集回答・シフト・請求書の履歴に残っている staffId は孤児になります）\n\n本当に削除しますか？`,
        { okLabel: "完全削除", okClass: "btn-danger" }
      );
      if (!ok) return;
      try {
        await API.staff.hardDelete(staff.id);
        showToast("完了", `${staff.name} を完全に削除しました`, "success");
        await this.loadData();
      } catch (e) {
        showToast("エラー", `削除に失敗しました: ${e.message}`, "error");
      }
    } else {
      const ok = await showConfirm("無効化確認", `${staff.name} を無効化しますか？\n（後で『無効スタッフ表示』から再有効化できます）`);
      if (!ok) return;
      try {
        await API.staff.delete(staff.id);
        showToast("完了", `${staff.name} を無効化しました`, "success");
        await this.loadData();
      } catch (e) {
        showToast("エラー", `無効化に失敗しました: ${e.message}`, "error");
      }
    }
  },

  // ---- 請求書表示内容: 複数名義 UI ----

  _billingProfiles: [],

  // ユニークな名義 ID を生成 (UUID 簡易版)
  _genProfileId() {
    return "bp_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  },

  // 現在の this._billingProfiles を基にリストを描画
  _renderBillingProfiles() {
    const container = document.getElementById("staffBillingProfilesList");
    if (!container) return;
    const escape = (s) => this.escapeHtml(String(s || ""));
    if (!this._billingProfiles.length) {
      container.innerHTML = `<p class="text-muted small mb-0">名義が登録されていません。「+ 名義を追加」で作成してください。</p>`;
    } else {
      container.innerHTML = this._billingProfiles.map((bp, i) => `
        <div class="card mb-2 border-secondary-subtle" data-bp-idx="${i}">
          <div class="card-header d-flex justify-content-between align-items-center py-1 px-3 bg-light">
            <span class="fw-semibold small">名義 #${i + 1}</span>
            <button type="button" class="btn btn-sm btn-outline-danger btn-bp-remove py-0 px-2" data-idx="${i}" title="削除">
              <i class="bi bi-x-lg"></i>
            </button>
          </div>
          <div class="card-body py-2 px-3">
            <div class="row g-2">
              <div class="col-md-6">
                <label class="form-label mb-1 small">ラベル</label>
                <input type="text" class="form-control form-control-sm bp-label" data-idx="${i}" placeholder="例: 個人名義 / 株式会社A" value="${escape(bp.label)}">
              </div>
              <div class="col-md-6">
                <label class="form-label mb-1 small">屋号 <small class="text-muted">(空欄=個人)</small></label>
                <input type="text" class="form-control form-control-sm bp-companyName" data-idx="${i}" value="${escape(bp.companyName)}">
              </div>
              <div class="col-md-4">
                <label class="form-label mb-1 small">〒</label>
                <input type="text" class="form-control form-control-sm bp-zipCode" data-idx="${i}" placeholder="例: 736-0061" value="${escape(bp.zipCode)}">
              </div>
              <div class="col-md-8">
                <label class="form-label mb-1 small">住所</label>
                <input type="text" class="form-control form-control-sm bp-address" data-idx="${i}" value="${escape(bp.address)}">
              </div>
            </div>
          </div>
        </div>
      `).join("");
    }
    this._bindBillingProfileEvents();

    // 「+ 名義を追加」ボタンイベント (1 回だけ)
    const addBtn = document.getElementById("btnAddBillingProfile");
    if (addBtn && !addBtn.dataset.bound) {
      addBtn.dataset.bound = "1";
      addBtn.addEventListener("click", () => {
        const n = this._billingProfiles.length + 1;
        this._billingProfiles.push({
          id: this._genProfileId(),
          label: `名義 ${n}`,
          companyName: "",
          zipCode: "",
          address: "",
        });
        this._renderBillingProfiles();
      });
    }
  },

  // 入力/削除イベントを紐付け
  _bindBillingProfileEvents() {
    const container = document.getElementById("staffBillingProfilesList");
    if (!container) return;
    // 削除
    container.querySelectorAll(".btn-bp-remove").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const i = Number(e.currentTarget.dataset.idx);
        if (!isNaN(i)) {
          this._billingProfiles.splice(i, 1);
          this._renderBillingProfiles();
        }
      });
    });
    // 各入力 → state 同期
    const syncField = (selector, field) => {
      container.querySelectorAll(selector).forEach(el => {
        el.addEventListener("input", (e) => {
          const i = Number(e.currentTarget.dataset.idx);
          if (!isNaN(i) && this._billingProfiles[i]) {
            this._billingProfiles[i][field] = e.currentTarget.value;
          }
        });
      });
    };
    syncField(".bp-label", "label");
    syncField(".bp-companyName", "companyName");
    syncField(".bp-zipCode", "zipCode");
    syncField(".bp-address", "address");
  },

  // 保存用に billingProfiles を収集 (空エントリを除外)
  _collectBillingProfiles() {
    return (this._billingProfiles || [])
      .map(bp => ({
        id: bp.id || this._genProfileId(),
        label: (bp.label || "").trim(),
        companyName: (bp.companyName || "").trim(),
        zipCode: (bp.zipCode || "").trim(),
        address: (bp.address || "").trim(),
      }))
      // ラベルと 3 項目全てが空のエントリは除外
      .filter(bp => bp.label || bp.companyName || bp.zipCode || bp.address);
  },

  // 他画面 (物件モーダル) から遷移してきた場合の自動編集対応
  _openFromSession() {
    try {
      const targetId = sessionStorage.getItem("openStaffEdit");
      if (!targetId) return;
      sessionStorage.removeItem("openStaffEdit");
      const staff = this.staffList.find(s => s.id === targetId);
      if (staff) {
        // loadData 直後はレンダリング完了直後なので少し遅延
        setTimeout(() => this.openModal(staff), 100);
      }
    } catch (e) {
      console.warn("[staff _openFromSession]", e.message);
    }
  },

  escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  },
};
