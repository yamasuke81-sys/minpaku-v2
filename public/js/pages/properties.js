/**
 * 物件管理ページ
 * 一覧・登録・編集・無効化（BEDS24物件IDフィールド付き）
 */
const PropertiesPage = {
  propertyList: [],
  modal: null,

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-buildings"></i> 物件管理</h2>
        <button class="btn btn-primary" id="btnAddProperty">
          <i class="bi bi-plus-lg"></i> 物件登録
        </button>
      </div>

      <div class="row g-3" id="propertyCards">
        <div class="col-12 text-center py-4">読み込み中...</div>
      </div>
    `;

    this.modal = new bootstrap.Modal(document.getElementById("propertyModal"));
    this.bindEvents();
    await this.loadProperties();
  },

  bindEvents() {
    document.getElementById("btnAddProperty").addEventListener("click", () => {
      this.openModal();
    });

    document.getElementById("btnSaveProperty").addEventListener("click", () => {
      this.saveProperty();
    });
  },

  async loadProperties() {
    try {
      this.propertyList = await API.properties.list(false);
      this.renderCards();
    } catch (e) {
      showToast("エラー", `物件読み込み失敗: ${e.message}`, "error");
    }
  },

  renderCards() {
    const container = document.getElementById("propertyCards");
    if (!this.propertyList.length) {
      container.innerHTML = `
        <div class="col-12">
          <div class="empty-state">
            <i class="bi bi-buildings"></i>
            <p>物件が登録されていません</p>
          </div>
        </div>
      `;
      return;
    }

    const typeLabel = { minpaku: "民泊", rental: "収益不動産", other: "その他" };
    const typeColor = { minpaku: "primary", rental: "info", other: "secondary" };

    container.innerHTML = this.propertyList.map((p) => `
      <div class="col-md-6 col-lg-4">
        <div class="card h-100 ${p.active ? "" : "border-secondary opacity-50"}">
          <div class="card-body">
            <div class="d-flex justify-content-between align-items-start mb-1">
              <h5 class="card-title mb-0">${this.escapeHtml(p.name)}</h5>
              <div>
                <span class="badge bg-${typeColor[p.type] || "secondary"} me-1">${typeLabel[p.type] || "不明"}</span>
                <span class="badge ${p.active ? "bg-success" : "bg-secondary"}">${p.active ? "有効" : "無効"}</span>
              </div>
            </div>
            ${p.area ? `<small class="text-muted"><i class="bi bi-pin-map"></i> ${this.escapeHtml(p.area)}</small><br>` : ""}
            ${p.address ? `<p class="card-text text-muted small mb-1"><i class="bi bi-geo-alt"></i> ${this.escapeHtml(p.address)}</p>` : ""}
            <div class="mb-2">
              <small class="text-muted">
                ${p.capacity ? `<i class="bi bi-people"></i> ${p.type === "rental" ? p.capacity + "戸" : "定員" + p.capacity + "名"} | ` : ""}
                <i class="bi bi-clock"></i> 清掃 ${p.cleaningDuration || 90}分
                ${p.cleaningFee ? ` (${formatCurrency(p.cleaningFee)})` : ""}
                ${p.beds24PropertyId ? ` | <i class="bi bi-link-45deg"></i> BEDS24連携済` : ""}
              </small>
            </div>
            ${p.monthlyFixedCost ? `<div class="mb-1"><small class="text-muted"><i class="bi bi-cash-stack"></i> 月額固定費: ${formatCurrency(p.monthlyFixedCost)}</small></div>` : ""}
            ${p.purchasePrice ? `<div class="mb-1"><small class="text-muted"><i class="bi bi-building"></i> 取得: ${formatCurrency(p.purchasePrice)}</small></div>` : ""}
            ${p.requiredSkills && p.requiredSkills.length
              ? `<div class="mb-2">${p.requiredSkills.map((s) => `<span class="badge bg-light text-dark me-1">${this.escapeHtml(s)}</span>`).join("")}</div>`
              : ""}
            ${p.notes ? `<p class="card-text small">${this.escapeHtml(p.notes)}</p>` : ""}
          </div>
          <div class="card-footer bg-transparent">
            <button class="btn btn-sm btn-outline-primary btn-edit-property" data-id="${p.id}">
              <i class="bi bi-pencil"></i> 編集
            </button>
            ${p.type === "minpaku" ? `
              <a href="#/property-checklist/${p.id}" class="btn btn-sm btn-outline-success ms-1">
                <i class="bi bi-list-check"></i> チェックリスト
              </a>` : ""}
            ${p.active === true ? `
              <button class="btn btn-sm btn-outline-danger btn-delete-property float-end" data-id="${p.id}">
                <i class="bi bi-trash"></i> 無効化
              </button>
            ` : `
              <button class="btn btn-sm btn-success btn-activate-property float-end" data-id="${p.id}">
                <i class="bi bi-check2-circle"></i> 有効化
              </button>
            `}
          </div>
        </div>
      </div>
    `).join("");

    // イベント
    container.querySelectorAll(".btn-edit-property").forEach((btn) => {
      btn.addEventListener("click", () => {
        const prop = this.propertyList.find((p) => p.id === btn.dataset.id);
        if (prop) this.openModal(prop);
      });
    });

    container.querySelectorAll(".btn-delete-property").forEach((btn) => {
      btn.addEventListener("click", () => {
        const prop = this.propertyList.find((p) => p.id === btn.dataset.id);
        if (prop) this.deleteProperty(prop);
      });
    });

    container.querySelectorAll(".btn-activate-property").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const prop = this.propertyList.find((p) => p.id === btn.dataset.id);
        if (!prop) return;
        try {
          await API.properties.activate(prop.id);
          showToast("完了", `${prop.name} を有効化しました`, "success");
          await this.loadProperties();
        } catch (e) {
          showToast("エラー", `有効化失敗: ${e.message}`, "error");
        }
      });
    });
  },

  openModal(property = null) {
    const isEdit = !!property;
    document.getElementById("propertyModalTitle").textContent = isEdit ? "物件編集" : "物件登録";
    document.getElementById("propertyEditId").value = isEdit ? property.id : "";

    document.getElementById("propertyName").value = property?.name || "";
    document.getElementById("propertyType").value = property?.type || "minpaku";
    document.getElementById("propertyCapacity").value = property?.capacity || 0;
    document.getElementById("propertyBeds24Id").value = property?.beds24PropertyId || "";
    document.getElementById("propertyArea").value = property?.area || "";
    document.getElementById("propertyAddress").value = property?.address || "";
    document.getElementById("propertyCleaningDuration").value = property?.cleaningDuration || 90;
    document.getElementById("propertyCleaningStartTime").value = property?.cleaningStartTime || "10:30";
    document.getElementById("propertyInspectionStartTime").value = property?.inspectionStartTime || "10:00";
    document.getElementById("propertyBaseWorkTimeStart").value = property?.baseWorkTime?.start || "10:30";
    document.getElementById("propertyBaseWorkTimeEnd").value = property?.baseWorkTime?.end || "14:30";
    document.getElementById("propertyCleaningFee").value = property?.cleaningFee || 0;
    document.getElementById("propertyMonthlyCost").value = property?.monthlyFixedCost || 0;
    document.getElementById("propertyPurchasePrice").value = property?.purchasePrice || 0;
    document.getElementById("propertyPurchaseDate").value = property?.purchaseDate
      ? new Date(property.purchaseDate.seconds ? property.purchaseDate.seconds * 1000 : property.purchaseDate).toISOString().split("T")[0]
      : "";
    document.getElementById("propertySkills").value = (property?.requiredSkills || []).join(",");
    document.getElementById("propertySelectionMethod").value = property?.selectionMethod || "ownerConfirm";
    document.getElementById("propertyCleaningRequiredCount").value = property?.cleaningRequiredCount || 1;
    document.getElementById("propertyNumber").value = property?.propertyNumber || "";
    document.getElementById("propertyColor").value = property?.color || "#0d6efd";

    // 直前点検設定
    const inspection = property?.inspection || {};
    document.getElementById("propertyInspectionEnabled").checked = !!inspection.enabled;
    document.getElementById("propertyInspectionRequiredCount").value = inspection.requiredCount || 1;
    document.getElementById("propertyInspectionPeriodStart").value = inspection.periodStart || "";
    document.getElementById("propertyInspectionPeriodEnd").value = inspection.periodEnd || "";

    // 繰り返しモード
    const recur = !!inspection.recurYearly;
    const recurCb = document.getElementById("propertyInspectionRecurYearly");
    recurCb.checked = recur;
    this.populateMonthDaySelects();
    const recurStart = inspection.recurStart || "";  // "MM-DD"
    const recurEnd = inspection.recurEnd || "";
    const [rsm, rsd] = recurStart.split("-");
    const [rem, red] = recurEnd.split("-");
    document.getElementById("propertyInspectionRecurStartMonth").value = rsm || "5";
    document.getElementById("propertyInspectionRecurStartDay").value = rsd || "1";
    document.getElementById("propertyInspectionRecurEndMonth").value = rem || "10";
    document.getElementById("propertyInspectionRecurEndDay").value = red || "31";
    this.toggleInspectionPeriodBlocks(recur);
    recurCb.onchange = () => this.toggleInspectionPeriodBlocks(recurCb.checked);

    document.getElementById("propertyNotes").value = property?.notes || "";

    this.modal.show();
  },

  async saveProperty() {
    const id = document.getElementById("propertyEditId").value;
    const name = document.getElementById("propertyName").value.trim();

    if (!name) {
      showToast("入力エラー", "物件名は必須です", "error");
      return;
    }

    const requiredSkills = document.getElementById("propertySkills").value
      .split(",").map((s) => s.trim()).filter(Boolean);

    const data = {
      name,
      type: document.getElementById("propertyType").value,
      capacity: Number(document.getElementById("propertyCapacity").value) || 0,
      beds24PropertyId: document.getElementById("propertyBeds24Id").value.trim(),
      area: document.getElementById("propertyArea").value.trim(),
      address: document.getElementById("propertyAddress").value.trim(),
      cleaningDuration: Number(document.getElementById("propertyCleaningDuration").value) || 90,
      cleaningStartTime: document.getElementById("propertyCleaningStartTime").value || "10:30",
      inspectionStartTime: document.getElementById("propertyInspectionStartTime").value || "10:00",
      baseWorkTime: {
        start: document.getElementById("propertyBaseWorkTimeStart").value || "10:30",
        end: document.getElementById("propertyBaseWorkTimeEnd").value || "14:30",
      },
      cleaningFee: Number(document.getElementById("propertyCleaningFee").value) || 0,
      monthlyFixedCost: Number(document.getElementById("propertyMonthlyCost").value) || 0,
      purchasePrice: Number(document.getElementById("propertyPurchasePrice").value) || 0,
      purchaseDate: document.getElementById("propertyPurchaseDate").value || null,
      requiredSkills,
      selectionMethod: document.getElementById("propertySelectionMethod").value || "ownerConfirm",
      cleaningRequiredCount: Number(document.getElementById("propertyCleaningRequiredCount").value) || 1,
      propertyNumber: Number(document.getElementById("propertyNumber").value) || null,
      color: document.getElementById("propertyColor").value || null,
      inspection: (() => {
        const recur = !!document.getElementById("propertyInspectionRecurYearly").checked;
        const pad = (v) => String(v).padStart(2, "0");
        const rsm = document.getElementById("propertyInspectionRecurStartMonth").value;
        const rsd = document.getElementById("propertyInspectionRecurStartDay").value;
        const rem = document.getElementById("propertyInspectionRecurEndMonth").value;
        const red = document.getElementById("propertyInspectionRecurEndDay").value;
        return {
          enabled: !!document.getElementById("propertyInspectionEnabled").checked,
          requiredCount: Number(document.getElementById("propertyInspectionRequiredCount").value) || 1,
          recurYearly: recur,
          // 繰り返し時は recurStart/End を MM-DD 形式で保存
          recurStart: recur ? `${pad(rsm)}-${pad(rsd)}` : null,
          recurEnd: recur ? `${pad(rem)}-${pad(red)}` : null,
          // 通常期間は recur=false 時のみ有効
          periodStart: recur ? null : (document.getElementById("propertyInspectionPeriodStart").value || null),
          periodEnd: recur ? null : (document.getElementById("propertyInspectionPeriodEnd").value || null),
        };
      })(),
      notes: document.getElementById("propertyNotes").value.trim(),
    };

    try {
      if (id) {
        await API.properties.update(id, data);
        showToast("完了", "物件情報を更新しました", "success");
      } else {
        await API.properties.create(data);
        showToast("完了", "物件を登録しました", "success");
      }
      this.modal.hide();
      await this.loadProperties();
    } catch (e) {
      showToast("エラー", `保存に失敗しました: ${e.message}`, "error");
    }
  },

  async deleteProperty(property) {
    const ok = await showConfirm(`${property.name} を無効化しますか？`, "物件を無効化");
    if (!ok) return;

    try {
      await API.properties.delete(property.id);
      showToast("完了", `${property.name} を無効化しました`, "success");
      await this.loadProperties();
    } catch (e) {
      showToast("エラー", `無効化に失敗しました: ${e.message}`, "error");
    }
  },

  populateMonthDaySelects() {
    const monthSels = ["propertyInspectionRecurStartMonth", "propertyInspectionRecurEndMonth"];
    const daySels = ["propertyInspectionRecurStartDay", "propertyInspectionRecurEndDay"];
    monthSels.forEach(id => {
      const el = document.getElementById(id);
      if (el && !el.options.length) {
        el.innerHTML = Array.from({length:12},(_,i)=>`<option value="${i+1}">${i+1}月</option>`).join("");
      }
    });
    daySels.forEach(id => {
      const el = document.getElementById(id);
      if (el && !el.options.length) {
        el.innerHTML = Array.from({length:31},(_,i)=>`<option value="${i+1}">${i+1}日</option>`).join("");
      }
    });
  },

  toggleInspectionPeriodBlocks(recur) {
    document.getElementById("inspectionPeriodFull")?.classList.toggle("d-none", recur);
    document.getElementById("inspectionPeriodRecur")?.classList.toggle("d-none", !recur);
  },

  escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  },
};
