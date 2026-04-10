/**
 * 定期報告ページ（住宅宿泊事業法14条）
 * 民泊制度運営システムの入力画面に準拠したレイアウト
 */
const ReportsPage = {
  periods: [],
  currentPeriod: null,
  aggregateData: null,
  todokideNumber: "",

  // 政府フォーム準拠の国籍リスト（固定順序）
  NATIONALITY_GRID: [
    "日本", "韓国", "台湾", "香港", "中国", "タイ", "シンガポール",
    "マレーシア", "インドネシア", "フィリピン", "ベトナム", "インド", "英国", "ドイツ",
    "フランス", "イタリア", "スペイン", "ロシア", "米国", "カナダ", "オーストラリア",
    "その他",
  ],

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-file-earmark-bar-graph"></i> 定期報告（住宅宿泊事業法14条）</h2>
        <a href="https://www.minpaku.mlit.go.jp/jigyo/login" target="_blank" rel="noopener" class="btn btn-primary">
          <i class="bi bi-box-arrow-up-right"></i> 民泊制度運営システムへ
        </a>
      </div>

      <!-- 期限リマインダー -->
      <div id="reportReminder" class="d-none"></div>

      <!-- 報告期間一覧 -->
      <div class="card mb-4">
        <div class="card-header">
          <i class="bi bi-calendar-range"></i> 報告期間一覧
        </div>
        <div class="card-body p-0">
          <div class="table-responsive">
            <table class="table table-hover align-middle mb-0">
              <thead class="table-light">
                <tr>
                  <th>対象期間</th>
                  <th>提出期限</th>
                  <th>ステータス</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="periodTableBody">
                <tr><td colspan="4" class="text-center py-4">読み込み中...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 集計プレビュー（期間選択後に表示） -->
      <div id="reportPreview" class="d-none">
        <div class="card mb-4">
          <div class="card-header d-flex justify-content-between align-items-center">
            <span><i class="bi bi-bar-chart"></i> 事業実績報告</span>
            <div>
              <button class="btn btn-sm btn-outline-secondary me-1" id="btnPrintReport" title="印刷">
                <i class="bi bi-printer"></i> 印刷
              </button>
              <button class="btn btn-sm btn-success" id="btnSubmitReport">
                <i class="bi bi-check-circle"></i> 報告済みにする
              </button>
            </div>
          </div>
          <div class="card-body" id="reportContent">
            <div class="text-center py-4">
              <div class="spinner-border text-primary" role="status"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
    await this.loadTodokideNumber();
    await this.loadPeriods();
  },

  bindEvents() {
    document.getElementById("btnPrintReport").addEventListener("click", () => {
      window.print();
    });
    document.getElementById("btnSubmitReport").addEventListener("click", () => {
      this.submitReport();
    });
  },

  async loadTodokideNumber() {
    try {
      const doc = await db.collection("settings").doc("owner").get();
      if (doc.exists) this.todokideNumber = doc.data().todokideNumber || "";
    } catch (e) { /* 無視 */ }
  },

  async saveTodokideNumber(val) {
    this.todokideNumber = val;
    await db.collection("settings").doc("owner").set(
      { todokideNumber: val, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  },

  async loadPeriods() {
    try {
      this.periods = await API.reports.periods();
      this.renderPeriods();
      this.checkReminder();
    } catch (e) {
      showToast("エラー", `報告期間の取得失敗: ${e.message}`, "error");
    }
  },

  renderPeriods() {
    const tbody = document.getElementById("periodTableBody");
    const today = new Date().toISOString().slice(0, 10);

    tbody.innerHTML = this.periods.map((p) => {
      const isPast = p.deadline < today;
      const isUpcoming = !isPast && p.deadline <= this.addDays(today, 14);
      let statusBadge;
      if (p.submitted) {
        statusBadge = '<span class="badge bg-success"><i class="bi bi-check-circle"></i> 報告済み</span>';
      } else if (isPast) {
        statusBadge = '<span class="badge bg-danger"><i class="bi bi-exclamation-triangle"></i> 期限超過</span>';
      } else if (isUpcoming) {
        statusBadge = '<span class="badge bg-warning text-dark"><i class="bi bi-clock"></i> 期限間近</span>';
      } else {
        statusBadge = '<span class="badge bg-secondary">未提出</span>';
      }

      return `
        <tr data-period-id="${p.id}" class="${isPast && !p.submitted ? "table-danger" : isUpcoming && !p.submitted ? "table-warning" : ""}">
          <td><strong>${this.escapeHtml(p.label)}</strong></td>
          <td>${this.escapeHtml(p.deadline)}</td>
          <td>${statusBadge}</td>
          <td>
            <button class="btn btn-sm btn-outline-primary btn-preview-period" data-period-id="${p.id}">
              <i class="bi bi-eye"></i> 集計
            </button>
          </td>
        </tr>
      `;
    }).join("");

    tbody.querySelectorAll(".btn-preview-period").forEach((btn) => {
      btn.addEventListener("click", () => {
        const periodId = btn.dataset.periodId;
        const period = this.periods.find((p) => p.id === periodId);
        if (period) this.showPreview(period);
      });
    });
  },

  checkReminder() {
    const today = new Date().toISOString().slice(0, 10);
    const reminderEl = document.getElementById("reportReminder");

    const upcoming = this.periods.filter((p) => {
      if (p.submitted) return false;
      const daysLeft = Math.ceil((new Date(p.deadline) - new Date(today)) / (1000 * 60 * 60 * 24));
      return daysLeft >= 0 && daysLeft <= 14;
    });

    if (upcoming.length === 0) {
      reminderEl.classList.add("d-none");
      return;
    }

    reminderEl.classList.remove("d-none");
    reminderEl.innerHTML = upcoming.map((p) => {
      const daysLeft = Math.ceil((new Date(p.deadline) - new Date(today)) / (1000 * 60 * 60 * 24));
      const alertClass = daysLeft <= 3 ? "alert-danger" : "alert-warning";
      return `
        <div class="alert ${alertClass} d-flex align-items-center mb-2">
          <i class="bi bi-bell-fill me-2 fs-5"></i>
          <div>
            <strong>定期報告の期限が近づいています</strong><br>
            ${this.escapeHtml(p.label)} — 期限: ${p.deadline}（あと${daysLeft}日）
            <button class="btn btn-sm btn-outline-dark ms-2 btn-preview-period" data-period-id="${p.id}">
              集計を確認
            </button>
          </div>
        </div>
      `;
    }).join("");

    reminderEl.querySelectorAll(".btn-preview-period").forEach((btn) => {
      btn.addEventListener("click", () => {
        const periodId = btn.dataset.periodId;
        const period = this.periods.find((p) => p.id === periodId);
        if (period) this.showPreview(period);
      });
    });
  },

  async showPreview(period) {
    this.currentPeriod = period;
    const previewEl = document.getElementById("reportPreview");
    previewEl.classList.remove("d-none");

    const submitBtn = document.getElementById("btnSubmitReport");
    if (period.submitted) {
      submitBtn.innerHTML = '<i class="bi bi-arrow-counterclockwise"></i> 報告済みを取消';
      submitBtn.className = "btn btn-sm btn-outline-warning";
    } else {
      submitBtn.innerHTML = '<i class="bi bi-check-circle"></i> 報告済みにする';
      submitBtn.className = "btn btn-sm btn-success";
    }

    const contentEl = document.getElementById("reportContent");
    contentEl.innerHTML = `<div class="text-center py-4"><div class="spinner-border text-primary"></div><p class="mt-2 text-muted">集計中...</p></div>`;

    try {
      const tm = period.targetMonths;
      this.aggregateData = await API.reports.aggregate(
        tm[0].year, tm[0].month, tm[1].year, tm[1].month, period.id
      );
      this.renderPreview();
    } catch (e) {
      contentEl.innerHTML = `<div class="alert alert-danger">集計エラー: ${this.escapeHtml(e.message)}</div>`;
    }

    previewEl.scrollIntoView({ behavior: "smooth" });
  },

  // ===== メイン描画: 政府フォーム準拠 =====
  renderPreview() {
    const d = this.aggregateData;
    const contentEl = document.getElementById("reportContent");
    const tm1 = d.month1, tm2 = d.month2;

    // 宿泊日セットを構築（CI〜CO-1の各日を宿泊日とする）
    const stayDates = new Set();
    for (const row of d.details) {
      const ci = new Date(row.checkIn);
      const co = new Date(row.checkOut);
      for (let dt = new Date(ci); dt < co; dt.setDate(dt.getDate() + 1)) {
        stayDates.add(this.fmtDate(dt));
      }
    }

    // 国籍集計（政府フォームの固定国籍リストに合わせる）
    const natCounts = {};
    this.NATIONALITY_GRID.forEach(n => natCounts[n] = 0);
    for (const row of d.details) {
      const gc = row.guestCount || 1;
      const nat = this.mapNationality(row.nationality);
      natCounts[nat] = (natCounts[nat] || 0) + gc;
    }

    // 延べ人数 = 各宿泊者の泊数の合計
    let totalPersonNights = 0;
    for (const row of d.details) {
      totalPersonNights += (row.guestCount || 1) * (row.totalNights || 0);
    }

    contentEl.innerHTML = `
      <!-- 届出番号・報告期間 -->
      <div class="row g-3 mb-3 align-items-center">
        <div class="col-auto">
          <strong>届出番号</strong>
        </div>
        <div class="col-auto" id="todokideContainer">
          ${this.todokideNumber
            ? `<span class="fs-5 fw-bold" id="todokideDisplay">${this.escapeHtml(this.todokideNumber)}</span>
               <button class="btn btn-sm btn-outline-secondary ms-1" id="btnEditTodokide" title="編集"><i class="bi bi-pencil"></i></button>`
            : `<input type="text" class="form-control form-control-sm" id="todokideNumber"
                placeholder="第M340XXXXX号" style="width:200px">
               <button class="btn btn-sm btn-primary ms-1" id="btnSaveTodokide">保存</button>`
          }
        </div>
        <div class="col-auto">
          <strong>報告期間</strong>
        </div>
        <div class="col-auto">
          <span class="badge bg-dark fs-6">${tm1.year}年度${String(tm1.month).padStart(2,"0")}月〜${String(tm2.month).padStart(2,"0")}月</span>
        </div>
      </div>

      <!-- 宿泊日選択カレンダー（上下に並べる） -->
      <h6 class="mb-2">宿泊日選択</h6>
      <div class="mb-2">${this.renderCalendar(tm1.year, tm1.month, stayDates)}</div>
      <div class="mb-4">${this.renderCalendar(tm2.year, tm2.month, stayDates)}</div>
      <!-- (カレンダーは上に統合済み) -->

      <!-- 宿泊者数 国籍別内訳 -->
      <h6 class="mb-2">宿泊者数 国籍別内訳</h6>
      ${this.renderNatGrid(natCounts)}

      <!-- 集計サマリー（政府フォーム準拠） -->
      <div class="mt-3">
        <table class="table table-bordered" style="max-width:500px">
          <thead class="table-primary text-center">
            <tr><th>宿泊日数</th><th>宿泊者数</th><th>延べ人数</th></tr>
          </thead>
          <tbody class="text-center fs-5">
            <tr>
              <td><strong>${stayDates.size}</strong></td>
              <td><strong>${d.totalJapanese + d.totalForeign}</strong></td>
              <td><strong>${totalPersonNights}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>

      <hr>
      <!-- 個別明細（折りたたみ） -->
      <details class="mb-3">
        <summary class="fw-bold"><i class="bi bi-list-ul"></i> 個別明細（${d.details.length}件）
          <small class="text-muted ms-2">— クリックして展開。人数・国籍をクリックで編集（レポート専用）</small>
        </summary>
        <div class="table-responsive mt-2">
          <table class="table table-sm table-bordered table-hover">
            <thead class="table-light">
              <tr>
                <th>CI</th><th>CO</th><th>宿泊者名</th><th>国籍</th>
                <th>人数</th><th>${tm1.month}月泊</th><th>${tm2.month}月泊</th><th></th>
              </tr>
            </thead>
            <tbody id="reportDetailsBody">
              ${d.details.map((row, idx) => {
                const rowClass = row.source === "migrated" ? "table-danger" : row.overridden ? "table-info" : "";
                const sourceLabel = row.source === "migrated"
                  ? '<span class="badge bg-danger">未登録</span>'
                  : row.overridden
                    ? `<span class="badge bg-info">補正済</span> <button class="btn btn-outline-secondary btn-sm py-0 px-1 btn-reset-override" data-ci="${this.escapeHtml(row.checkIn)}" title="補正を取消"><i class="bi bi-arrow-counterclockwise"></i></button>`
                    : '';
                return `
                <tr class="${rowClass}" data-idx="${idx}" data-ci="${this.escapeHtml(row.checkIn)}">
                  <td>${this.escapeHtml(row.checkIn)}</td>
                  <td>${this.escapeHtml(row.checkOut)}</td>
                  <td class="editable-cell" data-field="guestName">${this.escapeHtml(row.guestName)}</td>
                  <td class="editable-cell" data-field="nationality">${this.escapeHtml(row.nationality)}</td>
                  <td class="editable-cell" data-field="guestCount">${row.guestCount}</td>
                  <td class="text-end">${row.nights1 || "-"}</td>
                  <td class="text-end">${row.nights2 || "-"}</td>
                  <td>${sourceLabel}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>
      </details>
    `;

    // イベント
    this.bindEditEvents();
    this.bindTodokideEvent();
  },

  // ===== 2ヶ月カレンダー描画 =====
  renderCalendar(year, month, stayDates) {
    const daysInMonth = new Date(year, month, 0).getDate();
    const firstDay = new Date(year, month - 1, 1).getDay(); // 0=日
    const dayNames = ["日", "月", "火", "水", "木", "金", "土"];

    let html = `<table class="table table-bordered table-sm text-center mb-0" style="table-layout:fixed">
      <thead><tr class="table-primary"><th colspan="7">${year}年${month}月</th></tr>
      <tr class="table-light">${dayNames.map((d, i) => `<th class="${i === 0 ? "text-danger" : i === 6 ? "text-primary" : ""}" style="width:14.28%">${d}</th>`).join("")}</tr></thead><tbody>`;

    let dayNum = 1;
    for (let week = 0; week < 6 && dayNum <= daysInMonth; week++) {
      html += "<tr>";
      for (let dow = 0; dow < 7; dow++) {
        if ((week === 0 && dow < firstDay) || dayNum > daysInMonth) {
          html += '<td class="bg-light"></td>';
        } else {
          const dateStr = `${year}-${String(month).padStart(2,"0")}-${String(dayNum).padStart(2,"0")}`;
          const isStay = stayDates.has(dateStr);
          const dayClass = isStay ? "bg-primary text-white fw-bold" : "";
          html += `<td class="${dayClass}" style="cursor:default">${dayNum}</td>`;
          dayNum++;
        }
      }
      html += "</tr>";
    }
    html += "</tbody></table>";
    return html;
  },

  // ===== 国籍別内訳グリッド（政府フォーム準拠 7列×行） =====
  renderNatGrid(natCounts) {
    const cols = 7;
    const nats = this.NATIONALITY_GRID;
    let html = '<table class="table table-bordered table-sm text-center" style="table-layout:fixed">';

    for (let i = 0; i < nats.length; i += cols) {
      const row = nats.slice(i, i + cols);
      // ヘッダー行
      html += '<tr class="table-primary">';
      for (const nat of row) {
        html += `<th style="width:${100/cols}%"><small>${this.escapeHtml(nat)}</small></th>`;
      }
      for (let j = row.length; j < cols; j++) html += "<th></th>";
      html += "</tr><tr>";
      // 値行（値>0のセルを強調表示）
      for (const nat of row) {
        const val = natCounts[nat] || 0;
        const cellClass = val > 0 ? "bg-warning fw-bold" : "";
        html += `<td class="${cellClass}">${val}</td>`;
      }
      for (let j = row.length; j < cols; j++) html += "<td></td>";
      html += "</tr>";
    }
    html += "</table>";
    return html;
  },

  // 国籍名を政府フォームの国名にマッピング
  mapNationality(nat) {
    if (!nat) return "日本";
    const n = nat.trim();
    const lower = n.toLowerCase();
    // 日本判定
    if (n.includes("日本") || lower === "japan") return "日本";
    // 英語→日本語マッピング
    const map = {
      "taiwan": "台湾", "korea": "韓国", "china": "中国",
      "hong kong": "香港", "thailand": "タイ", "singapore": "シンガポール",
      "malaysia": "マレーシア", "indonesia": "インドネシア", "philippines": "フィリピン",
      "vietnam": "ベトナム", "india": "インド", "uk": "英国", "united kingdom": "英国",
      "germany": "ドイツ", "france": "フランス", "italy": "イタリア",
      "spain": "スペイン", "russia": "ロシア", "usa": "米国", "united states": "米国",
      "america": "米国", "canada": "カナダ", "australia": "オーストラリア",
    };
    if (map[lower]) return map[lower];
    // 日本語名がグリッドにあればそのまま
    if (this.NATIONALITY_GRID.includes(n)) return n;
    // 部分一致チェック（TAIWAN→台湾 等）
    for (const [eng, jpn] of Object.entries(map)) {
      if (lower.includes(eng)) return jpn;
    }
    return "その他";
  },

  // ===== イベント =====
  bindTodokideEvent() {
    const container = document.getElementById("todokideContainer");
    if (!container) return;

    // 保存済み: 編集ボタンで入力欄に切替
    const editBtn = document.getElementById("btnEditTodokide");
    if (editBtn) {
      editBtn.addEventListener("click", () => {
        container.innerHTML = `
          <input type="text" class="form-control form-control-sm d-inline-block" id="todokideNumber"
            value="${this.escapeHtml(this.todokideNumber)}" style="width:200px">
          <button class="btn btn-sm btn-primary ms-1" id="btnSaveTodokide">保存</button>`;
        this._bindTodokideSave();
        document.getElementById("todokideNumber").focus();
      });
    }

    // 未保存: 保存ボタン
    this._bindTodokideSave();
  },

  _bindTodokideSave() {
    const saveBtn = document.getElementById("btnSaveTodokide");
    if (!saveBtn) return;
    saveBtn.addEventListener("click", async () => {
      const input = document.getElementById("todokideNumber");
      const val = input.value.trim();
      if (!val) { showToast("エラー", "届出番号を入力してください", "error"); return; }
      await this.saveTodokideNumber(val);
      showToast("保存", "届出番号を保存しました", "success");
      // 保存済み表示に切替
      const container = document.getElementById("todokideContainer");
      container.innerHTML = `
        <span class="fs-5 fw-bold" id="todokideDisplay">${this.escapeHtml(val)}</span>
        <button class="btn btn-sm btn-outline-secondary ms-1" id="btnEditTodokide" title="編集"><i class="bi bi-pencil"></i></button>`;
      this.bindTodokideEvent();
    });
  },

  bindEditEvents() {
    const tbody = document.getElementById("reportDetailsBody");
    if (!tbody) return;

    tbody.querySelectorAll(".editable-cell").forEach((cell) => {
      cell.style.cursor = "pointer";
      cell.title = "クリックして編集";
      cell.addEventListener("click", () => this.startEdit(cell));
    });

    tbody.querySelectorAll(".btn-reset-override").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const ci = btn.dataset.ci;
        if (!confirm(`${ci} の補正を取消して元の値に戻しますか？`)) return;
        try {
          await API.reports.removeOverride(this.currentPeriod.id, ci);
          showToast("完了", `${ci} の補正を取消しました`, "success");
          this.showPreview(this.currentPeriod);
        } catch (e2) {
          showToast("エラー", `取消失敗: ${e2.message}`, "error");
        }
      });
    });
  },

  startEdit(cell) {
    if (cell.querySelector("input")) return;
    const field = cell.dataset.field;
    const tr = cell.closest("tr");
    const ci = tr.dataset.ci;
    const idx = Number(tr.dataset.idx);
    const currentValue = this.aggregateData.details[idx][field] || "";

    const input = document.createElement("input");
    input.type = field === "guestCount" ? "number" : "text";
    input.className = "form-control form-control-sm";
    input.value = currentValue;
    if (field === "guestCount") input.min = "0";
    input.style.width = field === "guestCount" ? "60px" : "120px";

    cell.textContent = "";
    cell.appendChild(input);
    input.focus();
    input.select();

    let saving = false;
    const save = async () => {
      if (saving) return;
      saving = true;
      let newValue = input.value.trim();
      if (field === "guestCount") newValue = Number(newValue) || 0;

      try {
        await API.reports.saveOverride(this.currentPeriod.id, ci, { [field]: newValue });
        showToast("保存", `${ci} を更新`, "success");
        this.showPreview(this.currentPeriod);
      } catch (e) {
        showToast("エラー", `保存失敗: ${e.message}`, "error");
        cell.textContent = currentValue;
        saving = false;
      }
    };

    input.addEventListener("blur", save);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { cell.textContent = currentValue; input.removeEventListener("blur", save); }
    });
  },

  // ===== ユーティリティ =====
  async submitReport() {
    if (!this.currentPeriod) return;
    const isSubmitted = this.currentPeriod.submitted;
    const action = isSubmitted ? "報告済みを取消" : "報告済みとして記録";
    if (!confirm(`${this.currentPeriod.label} を${action}しますか？`)) return;

    try {
      if (isSubmitted) {
        await API.reports.unsubmit(this.currentPeriod.id);
        showToast("完了", "報告済みを取消しました", "success");
      } else {
        await API.reports.submit(this.currentPeriod.id, "");
        showToast("完了", "報告済みとして記録しました", "success");
      }
      await this.loadPeriods();
      const updated = this.periods.find((p) => p.id === this.currentPeriod.id);
      if (updated) {
        this.currentPeriod = updated;
        const submitBtn = document.getElementById("btnSubmitReport");
        if (updated.submitted) {
          submitBtn.innerHTML = '<i class="bi bi-arrow-counterclockwise"></i> 報告済みを取消';
          submitBtn.className = "btn btn-sm btn-outline-warning";
        } else {
          submitBtn.innerHTML = '<i class="bi bi-check-circle"></i> 報告済みにする';
          submitBtn.className = "btn btn-sm btn-success";
        }
      }
    } catch (e) {
      showToast("エラー", `操作失敗: ${e.message}`, "error");
    }
  },

  fmtDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  },

  addDays(dateStr, days) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return this.fmtDate(d);
  },

  escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  },
};
