/**
 * 物件管理ページ
 * 一覧・登録・編集・無効化（BEDS24物件IDフィールド付き）
 */
// LINE チャネル配列の上限（将来拡張しやすいよう定数化）
const LINE_CHANNELS_MAX = 2;

const PropertiesPage = {
  propertyList: [],
  modal: null,
  editingId: null,       // 現在編集中の物件ID (新規=null)
  _autoSaveTimer: null,  // 自動保存デバウンスタイマー
  // 現在モーダルに表示している LINE チャネル配列（保存済みトークンを保持するため）
  _lineChannels: [],

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
    // 現在編集中の物件IDを記録（自動保存・ナビゲーション用）
    this.editingId = isEdit ? property.id : null;
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
    const recurStart = inspection.recurStart || "";  // "MM-DD" (padding 付き保存)
    const recurEnd = inspection.recurEnd || "";
    const [rsm, rsd] = recurStart.split("-");
    const [rem, red] = recurEnd.split("-");
    // select の option value は padding なし ("1"〜"12") で生成されているため、
    // 保存値 "05" を Number 化してから set する (1〜9月の表示バグ対策)
    document.getElementById("propertyInspectionRecurStartMonth").value = rsm ? String(Number(rsm)) : "5";
    document.getElementById("propertyInspectionRecurStartDay").value = rsd ? String(Number(rsd)) : "1";
    document.getElementById("propertyInspectionRecurEndMonth").value = rem ? String(Number(rem)) : "10";
    document.getElementById("propertyInspectionRecurEndDay").value = red ? String(Number(red)) : "31";
    this.toggleInspectionPeriodBlocks(recur);
    recurCb.onchange = () => this.toggleInspectionPeriodBlocks(recurCb.checked);

    document.getElementById("propertyNotes").value = property?.notes || "";

    // LINE 連携フィールド
    document.getElementById("propertyLineEnabled").checked = !!property?.lineEnabled;
    document.getElementById("propertyLineChannelStrategy").value =
      property?.lineChannelStrategy || "fallback";

    // lineChannels 配列の構築（旧単一フィールドとの後方互換）
    let savedChannels = Array.isArray(property?.lineChannels) ? property.lineChannels : [];
    if (savedChannels.length === 0 && (property?.lineChannelToken || property?.lineGroupId)) {
      // 旧単一フィールドを lineChannels[0] として扱う
      savedChannels = [{
        token: property.lineChannelToken || "",
        groupId: property.lineGroupId || "",
        name: property.lineChannelName || "",
        enabled: true,
        _legacy: true,  // 旧フィールド由来であることを示す内部フラグ
      }];
    }
    // 内部状態を保存（既存トークンを保持するため）
    this._lineChannels = savedChannels.map(ch => ({ ...ch }));
    this._renderLineChannels();
    this._bindLineChannelEvents();

    // LINE連携セクションは常時展開 (折りたたみ機能なし)

    this.modal.show();

    // --- iCal セクション（編集時のみ読み込み）---
    if (isEdit) {
      this._loadPropertyIcal(property.id);
      this._bindPropertyIcalEvents(property.id);
    } else {
      // 新規登録時は iCal セクションを非表示
      const icalRow = document.getElementById("propertyIcalAddRow");
      const icalList = document.getElementById("propertyIcalList");
      if (icalList) icalList.innerHTML = '<p class="text-muted small">物件を保存してから iCal URLを登録してください。</p>';
      if (icalRow) icalRow.classList.add("d-none");
    }

    // --- タイミー時給ページへのリンクボタン ---
    // モーダルを閉じてから #/rates?propertyId=xxx へ遷移する
    const btnGoToRates = document.getElementById("btnGoToRates");
    if (btnGoToRates) {
      // 古いリスナを除去するためにクローン差し替え
      const fresh = btnGoToRates.cloneNode(true);
      btnGoToRates.parentNode.replaceChild(fresh, btnGoToRates);
      fresh.addEventListener("click", () => {
        const pid = document.getElementById("propertyEditId").value;
        const hash = pid ? `#/rates?propertyId=${pid}` : "#/rates";
        this.modal.hide();
        // モーダルが完全に閉じてから遷移（背景が残らないように）
        const modalEl = document.getElementById("propertyModal");
        const onHidden = () => {
          modalEl.removeEventListener("hidden.bs.modal", onHidden);
          location.hash = hash;
        };
        modalEl.addEventListener("hidden.bs.modal", onHidden);
      });
    }

    // --- 自動保存: 編集時のみ（新規作成は不可） ---
    if (isEdit) {
      const modalEl = document.getElementById("propertyModal");
      const inputs = modalEl.querySelectorAll("input, select, textarea");
      // モーダルを開くたびにタイマーをリセット
      if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
      inputs.forEach(el => {
        // 古いリスナを一掃するため、データ属性でフラグ管理
        if (!el.dataset.autoSaveBound) {
          el.dataset.autoSaveBound = "1";
          el.addEventListener("change", () => {
            if (!this.editingId) return;
            clearTimeout(this._autoSaveTimer);
            this._autoSaveTimer = setTimeout(() => this._autoSave(), 800);
          });
        }
      });
    }
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
      // LINE 連携フィールド
      lineEnabled: document.getElementById("propertyLineEnabled").checked,
      lineChannelStrategy: document.getElementById("propertyLineChannelStrategy").value || "fallback",
      lineChannels: this._collectLineChannels(),
    };
    // 後方互換: lineChannels[0] があれば旧単一フィールドにも反映
    const firstCh = data.lineChannels[0];
    if (firstCh) {
      if (firstCh.token) data.lineChannelToken = firstCh.token;
      data.lineGroupId = firstCh.groupId || "";
      data.lineChannelName = firstCh.name || "";
    } else {
      data.lineGroupId = "";
      data.lineChannelName = "";
    }

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

  // 自動保存: editingId がある場合のみ、saveProperty のコアロジックを実行
  async _autoSave() {
    if (!this.editingId) return;
    const id = document.getElementById("propertyEditId").value;
    if (!id) return;
    const name = document.getElementById("propertyName").value.trim();
    // 物件名が空のままなら自動保存しない
    if (!name) return;

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
          recurStart: recur ? `${pad(rsm)}-${pad(rsd)}` : null,
          recurEnd: recur ? `${pad(rem)}-${pad(red)}` : null,
          periodStart: recur ? null : (document.getElementById("propertyInspectionPeriodStart").value || null),
          periodEnd: recur ? null : (document.getElementById("propertyInspectionPeriodEnd").value || null),
        };
      })(),
      notes: document.getElementById("propertyNotes").value.trim(),
      lineEnabled: document.getElementById("propertyLineEnabled").checked,
      lineChannelStrategy: document.getElementById("propertyLineChannelStrategy").value || "fallback",
      lineChannels: this._collectLineChannels(),
    };
    // 後方互換: lineChannels[0] があれば旧単一フィールドにも反映
    const firstChA = data.lineChannels[0];
    if (firstChA) {
      if (firstChA.token) data.lineChannelToken = firstChA.token;
      data.lineGroupId = firstChA.groupId || "";
      data.lineChannelName = firstChA.name || "";
    } else {
      data.lineGroupId = "";
      data.lineChannelName = "";
    }

    try {
      await API.properties.update(id, data);
      this._showSavedToast();
    } catch (e) {
      console.warn("[物件自動保存] 失敗:", e.message);
    }
  },

  // 右下に「保存しました」の小さいトースト表示（showAlert は使わない）
  _showSavedToast() {
    let el = document.getElementById("propertySavedToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "propertySavedToast";
      el.style.cssText = [
        "position:fixed", "bottom:1.5rem", "right:1.5rem",
        "z-index:2000", "padding:.4rem .9rem",
        "background:rgba(25,135,84,.9)", "color:#fff",
        "border-radius:.5rem", "font-size:.85rem",
        "box-shadow:0 2px 8px rgba(0,0,0,.2)",
        "pointer-events:none", "opacity:0",
        "transition:opacity .3s"
      ].join(";");
      el.textContent = "✓ 保存しました";
      document.body.appendChild(el);
    }
    el.style.opacity = "1";
    clearTimeout(this._savedToastTimer);
    this._savedToastTimer = setTimeout(() => { el.style.opacity = "0"; }, 1800);
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

  // ---- LINE 複数チャネル UI ----

  /**
   * lineChannelsList コンテナを this._lineChannels の内容で再描画する
   */
  _renderLineChannels() {
    const container = document.getElementById("lineChannelsList");
    if (!container) return;

    if (this._lineChannels.length === 0) {
      container.innerHTML = `<p class="text-muted small">Bot が登録されていません。下の「Bot を追加」ボタンで追加してください。</p>`;
    } else {
      container.innerHTML = this._lineChannels.map((ch, i) => `
        <div class="card mb-2 border-secondary-subtle" data-ch-idx="${i}">
          <div class="card-header d-flex justify-content-between align-items-center py-1 px-3 bg-light">
            <span class="fw-semibold small">Bot #${i + 1}</span>
            <div class="d-flex align-items-center gap-2">
              <div class="form-check form-switch mb-0">
                <input class="form-check-input ch-enabled" type="checkbox" id="chEnabled_${i}"
                  ${ch.enabled !== false ? "checked" : ""}>
                <label class="form-check-label small" for="chEnabled_${i}">有効</label>
              </div>
              <button type="button" class="btn btn-sm btn-outline-danger btn-ch-remove py-0 px-2" data-idx="${i}">
                <i class="bi bi-x-lg"></i>
              </button>
            </div>
          </div>
          <div class="card-body py-2 px-3">
            <div class="row g-2">
              <div class="col-12">
                <label class="form-label small mb-1">チャネルアクセストークン</label>
                <input type="password" class="form-control form-control-sm ch-token" data-idx="${i}"
                  placeholder="${ch.token ? "（設定済み — 変更する場合のみ入力）" : "長いトークン文字列を貼り付け"}"
                  value="">
                <div class="form-text">LINE Developers Console → Messaging API設定 → チャネルアクセストークン</div>
              </div>
              <div class="col-md-6">
                <label class="form-label small mb-1">グループ ID / User ID</label>
                <input type="text" class="form-control form-control-sm ch-groupid" data-idx="${i}"
                  placeholder="C... または U..." value="${this.escapeHtml(ch.groupId || "")}">
              </div>
              <div class="col-md-6">
                <label class="form-label small mb-1">表示名（管理用）</label>
                <input type="text" class="form-control form-control-sm ch-name" data-idx="${i}"
                  placeholder="例: ○○物件 Bot #${i + 1}" value="${this.escapeHtml(ch.name || "")}">
              </div>
            </div>
          </div>
        </div>
      `).join("");
    }

    // 「追加」ボタンの状態を上限に合わせて更新
    const addBtn = document.getElementById("btnAddLineChannel");
    if (addBtn) {
      const reached = this._lineChannels.length >= LINE_CHANNELS_MAX;
      addBtn.disabled = reached;
      addBtn.title = reached ? `上限 ${LINE_CHANNELS_MAX} 件に達しています` : "";
    }
  },

  /**
   * LINE チャネルリストのイベントをバインドする（追加・削除・変更）
   * openModal のたびに呼び出す
   */
  _bindLineChannelEvents() {
    // 「Bot を追加」ボタン
    const addBtn = document.getElementById("btnAddLineChannel");
    if (addBtn && !addBtn.dataset.chBound) {
      addBtn.dataset.chBound = "1";
      addBtn.addEventListener("click", () => {
        if (this._lineChannels.length >= LINE_CHANNELS_MAX) return;
        this._lineChannels.push({ token: "", groupId: "", name: "", enabled: true });
        this._renderLineChannels();
        // 自動保存トリガー
        if (this.editingId) {
          clearTimeout(this._autoSaveTimer);
          this._autoSaveTimer = setTimeout(() => this._autoSave(), 800);
        }
      });
    }

    // リストコンテナへの委譲（削除・入力変更）
    const container = document.getElementById("lineChannelsList");
    if (container && !container.dataset.chBound) {
      container.dataset.chBound = "1";

      // 削除ボタン
      container.addEventListener("click", (e) => {
        const btn = e.target.closest(".btn-ch-remove");
        if (!btn) return;
        const idx = parseInt(btn.dataset.idx, 10);
        this._lineChannels.splice(idx, 1);
        this._renderLineChannels();
        if (this.editingId) {
          clearTimeout(this._autoSaveTimer);
          this._autoSaveTimer = setTimeout(() => this._autoSave(), 800);
        }
      });

      // 入力変更 → 内部配列を更新 + 自動保存
      container.addEventListener("change", (e) => {
        const el = e.target;
        const idx = parseInt(el.dataset.idx, 10);
        if (isNaN(idx) || !this._lineChannels[idx]) return;

        if (el.classList.contains("ch-token")) {
          const v = el.value.trim();
          if (v) this._lineChannels[idx].token = v;
          // 空欄は「変更なし」なのでそのまま（既存トークンを上書きしない）
        } else if (el.classList.contains("ch-groupid")) {
          this._lineChannels[idx].groupId = el.value.trim();
        } else if (el.classList.contains("ch-name")) {
          this._lineChannels[idx].name = el.value.trim();
        } else if (el.classList.contains("ch-enabled")) {
          this._lineChannels[idx].enabled = el.checked;
        }

        if (this.editingId) {
          clearTimeout(this._autoSaveTimer);
          this._autoSaveTimer = setTimeout(() => this._autoSave(), 800);
        }
      });
    }
  },

  /**
   * 現在のフォーム内容から lineChannels 配列を収集して返す
   * @returns {Array}
   */
  _collectLineChannels() {
    // DOM から最新の値を内部配列に反映してから返す
    const container = document.getElementById("lineChannelsList");
    if (!container) return this._lineChannels.map(ch => ({ ...ch }));

    this._lineChannels.forEach((ch, i) => {
      const tokenEl = container.querySelector(`.ch-token[data-idx="${i}"]`);
      const groupEl = container.querySelector(`.ch-groupid[data-idx="${i}"]`);
      const nameEl = container.querySelector(`.ch-name[data-idx="${i}"]`);
      const enabledEl = container.querySelector(`.ch-enabled[data-idx="${i}"]`);

      if (tokenEl && tokenEl.value.trim()) ch.token = tokenEl.value.trim();
      if (groupEl) ch.groupId = groupEl.value.trim();
      if (nameEl) ch.name = nameEl.value.trim();
      if (enabledEl) ch.enabled = enabledEl.checked;
    });

    // _legacy フラグは送信不要なので除去
    return this._lineChannels.map(({ _legacy, ...rest }) => rest);
  },

  // ---- iCal 管理（物件モーダル内） ----

  /**
   * この物件に紐付く syncSettings を読み込んでリスト表示する
   */
  async _loadPropertyIcal(propertyId) {
    const listEl = document.getElementById("propertyIcalList");
    const addRow = document.getElementById("propertyIcalAddRow");
    if (!listEl) return;
    if (addRow) addRow.classList.remove("d-none");

    try {
      const snap = await db.collection("syncSettings")
        .where("propertyId", "==", propertyId).get();

      if (snap.empty) {
        listEl.innerHTML = '<p class="text-muted small mb-1">iCal URLが未登録です。</p>';
        return;
      }

      let html = '<div class="list-group list-group-flush border rounded mb-2">';
      snap.forEach(doc => {
        const d = doc.data();
        const lastSync = d.lastSync
          ? new Date(d.lastSync.seconds * 1000).toLocaleString("ja-JP")
          : "未同期";
        const statusBadge = d.active === false
          ? '<span class="badge bg-secondary ms-1">無効</span>'
          : '<span class="badge bg-success ms-1">有効</span>';
        html += `
          <div class="list-group-item py-2 px-3">
            <div class="d-flex justify-content-between align-items-start">
              <div class="flex-grow-1 me-2">
                <strong>${this.escapeHtml(d.platform || "unknown")}</strong>${statusBadge}
                <br><small class="text-muted font-monospace">${this.escapeHtml((d.icalUrl || "").slice(0, 70))}${(d.icalUrl || "").length > 70 ? "…" : ""}</small>
                <br><small class="text-muted">最終同期: ${lastSync}</small>
                ${d.lastSyncResult ? `<br><small class="text-muted">結果: ${this.escapeHtml(d.lastSyncResult)}</small>` : ""}
              </div>
              <div class="btn-group btn-group-sm flex-shrink-0">
                <button class="btn btn-outline-${d.active === false ? "success" : "warning"} btnPropToggleIcal"
                  data-id="${doc.id}" data-pid="${propertyId}" data-active="${d.active !== false}">
                  <i class="bi bi-${d.active === false ? "play" : "pause"}"></i>
                </button>
                <button class="btn btn-outline-danger btnPropDeleteIcal" data-id="${doc.id}" data-pid="${propertyId}">
                  <i class="bi bi-trash"></i>
                </button>
              </div>
            </div>
          </div>`;
      });
      html += "</div>";
      listEl.innerHTML = html;

      // 有効/無効トグル
      listEl.querySelectorAll(".btnPropToggleIcal").forEach(btn => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.id;
          const isActive = btn.dataset.active === "true";
          await db.collection("syncSettings").doc(id).update({ active: !isActive });
          showToast("更新", isActive ? "iCal同期を無効化しました" : "iCal同期を有効化しました", "info");
          this._loadPropertyIcal(btn.dataset.pid);
        });
      });

      // 削除
      listEl.querySelectorAll(".btnPropDeleteIcal").forEach(btn => {
        btn.addEventListener("click", async () => {
          const ok = await showConfirm("このiCal URLを削除しますか？", "iCal URL削除");
          if (!ok) return;
          await db.collection("syncSettings").doc(btn.dataset.id).delete();
          showToast("削除", "iCal URLを削除しました", "info");
          this._loadPropertyIcal(btn.dataset.pid);
        });
      });

    } catch (e) {
      listEl.innerHTML = `<div class="alert alert-danger py-1 small">読み込みエラー: ${this.escapeHtml(e.message)}</div>`;
    }
  },

  /**
   * iCal 追加フォームのイベントをバインドする
   */
  _bindPropertyIcalEvents(propertyId) {
    // URL 入力でプラットフォーム自動検出
    const urlInput = document.getElementById("propertyNewIcalUrl");
    const platformInput = document.getElementById("propertyNewIcalPlatform");
    const addBtn = document.getElementById("btnAddPropertyIcal");

    if (urlInput && !urlInput.dataset.icalBound) {
      urlInput.dataset.icalBound = "1";
      urlInput.addEventListener("input", () => {
        const url = urlInput.value.trim().toLowerCase();
        let platform = "other";
        if (url.includes("airbnb")) platform = "Airbnb";
        else if (url.includes("booking.com")) platform = "Booking.com";
        else if (url.includes("beds24")) platform = "Beds24";
        else if (url.includes("vrbo") || url.includes("homeaway")) platform = "VRBO";
        else if (url.includes("agoda")) platform = "Agoda";
        else if (url.includes("expedia")) platform = "Expedia";
        else if (!url) platform = "";
        if (platformInput) platformInput.value = platform;
      });
    }

    // モーダルを開くたびに addBtn をクローン差し替えして古いリスナを除去
    if (addBtn) {
      const freshBtn = addBtn.cloneNode(true);
      addBtn.parentNode.replaceChild(freshBtn, addBtn);
      freshBtn.addEventListener("click", async () => {
        const url = urlInput?.value.trim() || "";
        const platform = platformInput?.value.trim() || "other";
        if (!url || !url.startsWith("http")) {
          showToast("エラー", "正しいiCal URLを入力してください", "error");
          return;
        }
        try {
          await db.collection("syncSettings").add({
            icalUrl: url,
            platform: platform || "other",
            propertyId,
            active: true,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
          if (urlInput) urlInput.value = "";
          if (platformInput) platformInput.value = "";
          showToast("追加", `${platform || "iCal"} URLを登録しました`, "success");
          this._loadPropertyIcal(propertyId);
        } catch (e) {
          showToast("エラー", `登録失敗: ${e.message}`, "error");
        }
      });
    }
  },

  // ---- 共通ユーティリティ ----

  escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  },
};
