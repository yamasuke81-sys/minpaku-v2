/**
 * 報酬単価管理ページ (物件×作業項目×スタッフ の3軸)
 * ルート: #/rates
 *
 * データ: propertyWorkItems/{propertyId}
 *   items: [{id, name, sortOrder, commonRate, timeeHourlyRate, staffRates: {[staffId]:rate}}]
 *
 * UI:
 *   物件選択 → 作業項目一覧 (アコーディオン)
 *   各作業項目: 共通単価 / タイミー時給 / スタッフ別単価
 */
const RatesPage = {
  properties: [],
  staffList: [],
  currentPropertyId: null,
  workItems: [],         // 現在の物件の作業項目
  dirty: false,

  async render(container, pathParams) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-currency-yen"></i> 報酬単価設定</h2>
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <button class="btn btn-outline-primary" id="ratesBtnImport">
            <i class="bi bi-box-arrow-in-down"></i> 他施設からインポート
          </button>
          <button class="btn btn-primary" id="ratesBtnAdd">
            <i class="bi bi-plus-lg"></i> 作業項目追加
          </button>
          <button class="btn btn-success" id="ratesBtnSave" disabled>
            <i class="bi bi-check2"></i> 保存
          </button>
        </div>
      </div>

      <!-- 物件選定 (清掃フローと同じボタン群方式) -->
      <div id="ratesPropertySelector" class="mb-3"></div>

      <div class="alert alert-info small py-2">
        <i class="bi bi-info-circle"></i>
        「共通単価」はスタッフ個別単価が未設定の場合に使用されます。タイミー用の時給は別枠です。
      </div>

      <div id="ratesBody">
        <div class="text-center text-muted py-5"><div class="spinner-border"></div></div>
      </div>
    `;

    document.getElementById("ratesBtnAdd").addEventListener("click", () => this.addWorkItem());
    document.getElementById("ratesBtnSave").addEventListener("click", () => this.save());
    document.getElementById("ratesBtnImport").addEventListener("click", () => this.openImportModal());

    await this.loadData();
  },

  async loadData() {
    try {
      const [minpaku, staff] = await Promise.all([
        API.properties.listMinpakuNumbered(),
        API.staff.list(true),
      ]);
      this.properties = minpaku;
      // impersonation 中: 物件オーナー所有物件のみ物件セレクタに表示
      if (typeof App !== "undefined" && App.impersonating && App.impersonatingData) {
        const owned = App.impersonatingData.ownedPropertyIds || [];
        this.properties = this.properties.filter(p => owned.includes(p.id));
      } else if (typeof Auth !== "undefined" && Auth.isSubOwner && Auth.isSubOwner()) {
        // サブオーナー本人ログイン: 自分の所有物件のみ表示
        const owned = Array.isArray(Auth.currentUser?.ownedPropertyIds) ? Auth.currentUser.ownedPropertyIds : [];
        this.properties = this.properties.filter(p => owned.includes(p.id));
      }
      this.staffList = staff.sort((a, b) => (a.displayOrder||0) - (b.displayOrder||0));

      if (this.properties.length === 0) {
        document.getElementById("ratesBody").innerHTML =
          `<div class="alert alert-warning">有効な民泊物件がありません。物件管理で有効化してください。</div>`;
        return;
      }

      // URL パラメータ ?propertyId=xxx があれば初期選択に使用
      const hashParts = location.hash.split("?");
      const params = new URLSearchParams(hashParts[1] || "");
      const targetPropertyId = params.get("propertyId");
      const matched = targetPropertyId && this.properties.find(p => p.id === targetPropertyId);

      this.currentPropertyId = matched ? matched.id : this.properties[0].id;
      this.renderPropertySelector();
      await this.loadWorkItems();
    } catch (e) {
      console.error(e);
      document.getElementById("ratesBody").innerHTML =
        `<div class="alert alert-danger">読み込み失敗: ${this.esc(e.message)}</div>`;
    }
  },

  // 物件選定 UI を清掃フロー (cleaning-flow.js の _renderPropertySelector) と同じ番号バッジ付きボタン群方式で描画
  renderPropertySelector() {
    const wrap = document.getElementById("ratesPropertySelector");
    if (!wrap) return;
    if (!this.properties.length) { wrap.innerHTML = ""; return; }

    wrap.innerHTML = `
      <div class="d-flex align-items-center gap-2 flex-wrap">
        <label class="form-label mb-0 small fw-semibold">物件:</label>
        ${this.properties.map(p => `
          <button class="btn btn-sm ${p.id === this.currentPropertyId ? "btn-primary" : "btn-outline-secondary"} rates-prop-btn"
            data-pid="${p.id}" style="font-size:0.78rem;">
            <span class="badge me-1" style="background:${p._color || "#6c757d"};color:#fff;min-width:22px;">${p._num || "-"}</span>
            ${this.esc(p.name)}
          </button>
        `).join("")}
      </div>
    `;

    wrap.querySelectorAll(".rates-prop-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const pid = btn.dataset.pid;
        if (pid === this.currentPropertyId) return;
        if (this.dirty) {
          const ok = await this.showConfirmDialog({
            title: "未保存の変更",
            message: "未保存の変更があります。物件を切り替えますか？",
            confirmLabel: "切り替える",
            danger: false,
          });
          if (!ok) return;
        }
        this.currentPropertyId = pid;
        this.renderPropertySelector();
        this.loadWorkItems();
      });
    });
  },

  async loadWorkItems() {
    const body = document.getElementById("ratesBody");
    body.innerHTML = `<div class="text-center text-muted py-3"><div class="spinner-border spinner-border-sm"></div></div>`;
    try {
      const res = await API.properties.getWorkItems(this.currentPropertyId);
      const items = res.items || [];
      // 後方互換: 旧 commonRate(scalar) → commonRates(object)
      items.forEach(wi => {
        if (typeof wi.commonRate === "number" && !wi.commonRates) {
          wi.commonRates = { 1: wi.commonRate, 2: wi.commonRate, 3: wi.commonRate };
        }
        wi.commonRates = wi.commonRates || {};
        if (wi.staffRates) {
          Object.keys(wi.staffRates).forEach(sid => {
            const v = wi.staffRates[sid];
            if (typeof v === "number") wi.staffRates[sid] = { 1: v, 2: v, 3: v };
          });
        }
        if (!wi.type) wi.type = "other";
        if (!wi.rateMode) {
          // 旧データ: staffRatesが設定されていればperStaff、そうでなければcommon
          wi.rateMode = (wi.staffRates && Object.keys(wi.staffRates).length > 0) ? "perStaff" : "common";
        }
        wi.specialRates = Array.isArray(wi.specialRates) ? wi.specialRates : [];
      });
      this.workItems = items;
      this.workItems.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      this.dirty = false;
      this.updateSaveButton();
      this.renderWorkItems();
    } catch (e) {
      body.innerHTML = `<div class="alert alert-danger">読み込み失敗: ${this.esc(e.message)}</div>`;
    }
  },

  renderWorkItems() {
    const body = document.getElementById("ratesBody");
    if (!this.workItems.length) {
      body.innerHTML = `
        <div class="empty-state text-center py-5">
          <i class="bi bi-clipboard-plus display-3 text-muted"></i>
          <p class="mt-3 text-muted">この物件の作業項目がまだありません</p>
          <button class="btn btn-primary" onclick="RatesPage.addWorkItem()">
            <i class="bi bi-plus-lg"></i> 最初の作業項目を追加
          </button>
        </div>
      `;
      return;
    }

    body.innerHTML = `
      <div class="accordion" id="ratesAccordion">
        ${this.workItems.map((w, i) => this.renderWorkItemCard(w, i)).join("")}
      </div>
    `;

    // イベント（input & change）
    const handler = (el) => {
      const wi = this.workItems.find(w => w.id === el.dataset.itemId);
      if (!wi) return;
      const field = el.dataset.field;
      const staffId = el.dataset.staffId;
      const count = el.dataset.count;

      if (field === "type") {
        wi.type = el.value;
      } else if (field === "rateMode") {
        wi.rateMode = el.value;
        this.markDirty();
        this.renderWorkItems();  // モード切替で再描画
        // アコーディオンを開いた状態で再描画
        setTimeout(() => {
          const col = document.getElementById(`rates-col-${wi.id}`);
          if (col) new bootstrap.Collapse(col, { toggle: false }).show();
        }, 50);
        return;
      } else if (field === "timeeHourlyRate") {
        wi.timeeHourlyRate = el.value === "" ? 0 : Number(el.value);
      } else if (field === "commonRate") {
        wi.commonRates = wi.commonRates || {};
        const v = el.value === "" ? null : Number(el.value);
        if (v === null) delete wi.commonRates[count];
        else wi.commonRates[count] = v;
      } else if (field === "staffRate") {
        wi.staffRates = wi.staffRates || {};
        wi.staffRates[staffId] = wi.staffRates[staffId] || {};
        const v = el.value === "" ? null : Number(el.value);
        if (v === null) delete wi.staffRates[staffId][count];
        else wi.staffRates[staffId][count] = v;
        if (Object.keys(wi.staffRates[staffId]).length === 0) delete wi.staffRates[staffId];
      } else if (field === "name") {
        wi.name = el.value;
      }
      this.markDirty();
    };
    body.querySelectorAll(".rates-input").forEach(el => {
      const ev = (el.tagName === "SELECT" || el.type === "radio") ? "change" : "input";
      el.addEventListener(ev, () => handler(el));
    });

    // 特別料金編集ボタン
    body.querySelectorAll("[data-act='edit-special']").forEach(btn => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const wi = this.workItems.find(w => w.id === btn.dataset.itemId);
        if (!wi) return;
        const updated = await this.openSpecialRatesModal(wi);
        if (updated !== null) {
          wi.specialRates = updated;
          this.markDirty();
          this.renderWorkItems();
          setTimeout(() => {
            const col = document.getElementById(`rates-col-${wi.id}`);
            if (col) new bootstrap.Collapse(col, { toggle: false }).show();
          }, 50);
        }
      });
    });

    // 名前変更ボタン
    body.querySelectorAll("[data-act='rename']").forEach(btn => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const id = btn.dataset.itemId;
        const wi = this.workItems.find(w => w.id === id);
        if (!wi) return;
        const r = await this.showFormDialog({
          title: "作業項目名を変更",
          fields: [{ name: "name", label: "作業項目名", type: "text", value: wi.name }],
          submitLabel: "変更"
        });
        if (!r || !r.name) return;
        wi.name = r.name;
        this.markDirty();
        this.renderWorkItems();
      });
    });

    // 削除ボタン
    body.querySelectorAll("[data-act='delete']").forEach(btn => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const id = btn.dataset.itemId;
        const wi = this.workItems.find(w => w.id === id);
        if (!wi) return;
        const ok = await this.showConfirmDialog({
          title: "作業項目の削除",
          message: `「${wi.name}」を削除します。よろしいですか？`,
          confirmLabel: "削除", danger: true
        });
        if (!ok) return;
        this.workItems = this.workItems.filter(w => w.id !== id);
        this.markDirty();
        this.renderWorkItems();
      });
    });
  },

  // 特別加算料金の編集モーダル
  openSpecialRatesModal(wi) {
    return new Promise(resolve => {
      const modalId = "ratesSpecial_" + Date.now().toString(36);
      const rows = (wi.specialRates || []).slice();

      // 1行を描画: recur=true なら月日セレクト、false なら日付入力
      const renderOne = (sr, i) => {
        const isRecur = !!sr.recurYearly;
        const pad = (v) => String(v||"").padStart(2,"0");
        const [rsm, rsd] = (sr.recurStart||"").split("-");
        const [rem, red] = (sr.recurEnd||"").split("-");
        const monthOpts = Array.from({length:12},(_,k)=>`<option value="${k+1}">${k+1}月</option>`).join("");
        const dayOpts = Array.from({length:31},(_,k)=>`<option value="${k+1}">${k+1}日</option>`).join("");
        return `
        <div class="border rounded p-2 mb-2 special-row" data-idx="${i}">
          <div class="row g-2 align-items-center">
            <div class="col-md-3"><input type="text" class="form-control form-control-sm sr-input" data-field="name" placeholder="項目名 (例: お盆)" value="${this.esc(sr.name||"")}"></div>
            <div class="col-md-2">
              <div class="input-group input-group-sm">
                <input type="number" class="form-control sr-input" data-field="addAmount" min="0" step="100" placeholder="加算円" value="${sr.addAmount||""}">
                <span class="input-group-text">円</span>
              </div>
            </div>
            <div class="col-md-3">
              <div class="form-check form-check-inline">
                <input class="form-check-input sr-recur" type="checkbox" data-field="recurYearly" ${isRecur?"checked":""}>
                <label class="form-check-label small">毎年繰り返し</label>
              </div>
            </div>
            <div class="col-md-3 text-end">
              <button type="button" class="btn btn-sm btn-link text-danger sr-remove"><i class="bi bi-x-circle"></i> 削除</button>
            </div>
          </div>
          <div class="row g-2 mt-1 sr-period-full ${isRecur?"d-none":""}">
            <div class="col-md-3">
              <label class="form-label small mb-0">開始日</label>
              <input type="date" class="form-control form-control-sm sr-input" data-field="start" value="${this.esc(sr.start||"")}">
            </div>
            <div class="col-md-3">
              <label class="form-label small mb-0">終了日</label>
              <input type="date" class="form-control form-control-sm sr-input" data-field="end" value="${this.esc(sr.end||"")}">
            </div>
          </div>
          <div class="row g-2 mt-1 sr-period-recur ${isRecur?"":"d-none"}">
            <div class="col-md-2">
              <label class="form-label small mb-0">開始月</label>
              <select class="form-select form-select-sm sr-input" data-field="recurStartMonth">${monthOpts.replace(`value="${rsm||"12"}"`, `value="${rsm||"12"}" selected`)}</select>
            </div>
            <div class="col-md-2">
              <label class="form-label small mb-0">開始日</label>
              <select class="form-select form-select-sm sr-input" data-field="recurStartDay">${dayOpts.replace(`value="${rsd||"29"}"`, `value="${rsd||"29"}" selected`)}</select>
            </div>
            <div class="col-md-2">
              <label class="form-label small mb-0">終了月</label>
              <select class="form-select form-select-sm sr-input" data-field="recurEndMonth">${monthOpts.replace(`value="${rem||"1"}"`, `value="${rem||"1"}" selected`)}</select>
            </div>
            <div class="col-md-2">
              <label class="form-label small mb-0">終了日</label>
              <select class="form-select form-select-sm sr-input" data-field="recurEndDay">${dayOpts.replace(`value="${red||"3"}"`, `value="${red||"3"}" selected`)}</select>
            </div>
            <div class="col-md-4 align-self-end"><small class="text-muted">例: 12/29〜1/3 で正月、年跨ぎも可</small></div>
          </div>
        </div>
        `;
      };
      const renderRows = () => rows.map((sr, i) => renderOne(sr, i)).join("");

      const html = `
        <div class="modal fade" id="${modalId}" tabindex="-1">
          <div class="modal-dialog modal-lg modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title">特別加算料金 — ${this.esc(wi.name)}</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
              </div>
              <div class="modal-body">
                <div class="small text-muted mb-2">指定期間内の作業に、通常料金+加算額が適用されます。</div>
                <div id="${modalId}_rows">${renderRows()}</div>
                <button type="button" class="btn btn-sm btn-outline-primary mt-2" id="${modalId}_add">
                  <i class="bi bi-plus"></i> 行を追加
                </button>
              </div>
              <div class="modal-footer">
                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">キャンセル</button>
                <button type="button" class="btn btn-primary" id="${modalId}_save">保存</button>
              </div>
            </div>
          </div>
        </div>
      `;
      document.body.insertAdjacentHTML("beforeend", html);
      const modalEl = document.getElementById(modalId);
      const modal = new bootstrap.Modal(modalEl);

      const rowsContainer = modalEl.querySelector(`#${modalId}_rows`);

      const pad = (v) => String(v).padStart(2, "0");
      const collect = () => {
        const collected = [];
        rowsContainer.querySelectorAll(".special-row").forEach(row => {
          const q = (f) => row.querySelector(`[data-field="${f}"]`)?.value || "";
          const recurYearly = !!row.querySelector(".sr-recur")?.checked;
          const amt = Number(q("addAmount")) || 0;
          const name = q("name") || "";
          const r = { name, addAmount: amt, recurYearly };
          if (recurYearly) {
            const sm = q("recurStartMonth");
            const sd = q("recurStartDay");
            const em = q("recurEndMonth");
            const ed = q("recurEndDay");
            if (sm && sd && em && ed) {
              r.recurStart = `${pad(sm)}-${pad(sd)}`;
              r.recurEnd = `${pad(em)}-${pad(ed)}`;
            }
            r.start = null; r.end = null;
          } else {
            r.start = q("start") || null;
            r.end = q("end") || null;
            r.recurStart = null; r.recurEnd = null;
          }
          if (r.name || r.addAmount || r.start || r.end || r.recurStart) collected.push(r);
        });
        return collected;
      };

      rowsContainer.addEventListener("click", (e) => {
        const rm = e.target.closest(".sr-remove");
        if (rm) rm.closest(".special-row")?.remove();
      });

      // 繰り返しチェックのトグル → 対応フィールド表示切替
      rowsContainer.addEventListener("change", (e) => {
        if (e.target.classList.contains("sr-recur")) {
          const row = e.target.closest(".special-row");
          row.querySelector(".sr-period-full")?.classList.toggle("d-none", e.target.checked);
          row.querySelector(".sr-period-recur")?.classList.toggle("d-none", !e.target.checked);
        }
      });

      document.getElementById(`${modalId}_add`).addEventListener("click", () => {
        const idx = rowsContainer.querySelectorAll(".special-row").length;
        // デフォルトで繰り返しモード(毎年使う想定が多いため)
        const blankSr = { name: "", addAmount: "", recurYearly: true, recurStart: "", recurEnd: "" };
        rowsContainer.insertAdjacentHTML("beforeend", renderOne(blankSr, idx));
      });

      let saved = null;
      document.getElementById(`${modalId}_save`).addEventListener("click", () => {
        saved = collect();
        modal.hide();
      });
      modalEl.addEventListener("hidden.bs.modal", () => {
        modalEl.remove();
        resolve(saved);
      });
      modal.show();
    });
  },

  renderWorkItemCard(wi, idx) {
    const headerId = `rates-hd-${wi.id}`;
    const collapseId = `rates-col-${wi.id}`;
    const commonRates = wi.commonRates || {};
    const timee = wi.timeeHourlyRate || 0;
    const type = wi.type || "other";
    const rateMode = wi.rateMode || "common";    // common | perStaff
    const specialRates = wi.specialRates || [];
    const typeLabels = {
      cleaning_by_count: "清掃(人数制)",
      pre_inspection: "直前点検",
      other: "その他"
    };
    const shortLabel = Object.entries(commonRates)
      .sort((a,b) => Number(a[0]) - Number(b[0]))
      .map(([n, v]) => `${n}名:${Number(v||0).toLocaleString()}円`)
      .slice(0, 3).join(" / ");

    return `
      <div class="accordion-item" data-wi-id="${wi.id}">
        <h2 class="accordion-header" id="${headerId}">
          <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#${collapseId}">
            <div class="flex-grow-1 d-flex align-items-center">
              <strong>${this.esc(wi.name)}</strong>
              <span class="badge bg-light text-dark ms-2 border">${typeLabels[type] || type}</span>
              ${rateMode === "common"
                ? (shortLabel ? `<span class="badge bg-secondary ms-1">共通 ${shortLabel}</span>` : "")
                : `<span class="badge bg-primary ms-1">スタッフ別</span>`}
              ${timee > 0 ? `<span class="badge bg-info ms-1">タイミー ${timee.toLocaleString()}円/時</span>` : ""}
              ${specialRates.length ? `<span class="badge bg-warning text-dark ms-1">特別料金 ${specialRates.length}件</span>` : ""}
            </div>
            <div>
              <span class="btn btn-sm btn-link text-primary me-1" role="button" data-act="rename" data-item-id="${wi.id}" title="名前変更">
                <i class="bi bi-pencil"></i>
              </span>
              <span class="btn btn-sm btn-link text-danger me-3" role="button" data-act="delete" data-item-id="${wi.id}" title="削除">
                <i class="bi bi-trash"></i>
              </span>
            </div>
          </button>
        </h2>
        <div id="${collapseId}" class="accordion-collapse collapse">
          <div class="accordion-body">
            <div class="row g-3 mb-3">
              <div class="col-md-4">
                <label class="form-label">種類</label>
                <select class="form-select rates-input" data-field="type" data-item-id="${wi.id}">
                  <option value="cleaning_by_count" ${type==="cleaning_by_count"?"selected":""}>清掃(人数制)</option>
                  <option value="pre_inspection" ${type==="pre_inspection"?"selected":""}>直前点検</option>
                  <option value="other" ${type==="other"?"selected":""}>その他</option>
                </select>
              </div>
              <div class="col-md-4">
                <label class="form-label">タイミー時給 (円/時)</label>
                <div class="input-group">
                  <input type="number" class="form-control rates-input" min="0" step="50"
                    data-field="timeeHourlyRate" data-item-id="${wi.id}" value="${timee || ""}">
                  <span class="input-group-text">円/時</span>
                </div>
              </div>
              <div class="col-md-4">
                <label class="form-label">単価モード</label>
                <div class="btn-group w-100" role="group">
                  <input type="radio" class="btn-check rates-input" name="rateMode-${wi.id}" id="rm-common-${wi.id}" value="common" data-field="rateMode" data-item-id="${wi.id}" ${rateMode === "common" ? "checked" : ""}>
                  <label class="btn btn-outline-secondary" for="rm-common-${wi.id}">共通単価</label>
                  <input type="radio" class="btn-check rates-input" name="rateMode-${wi.id}" id="rm-staff-${wi.id}" value="perStaff" data-field="rateMode" data-item-id="${wi.id}" ${rateMode === "perStaff" ? "checked" : ""}>
                  <label class="btn btn-outline-secondary" for="rm-staff-${wi.id}">スタッフ別</label>
                </div>
              </div>
            </div>

            ${rateMode === "common" ? `
              <h6 class="mt-3 mb-2">共通単価（階段制: 人数に応じた単価）</h6>
              <div class="row g-2 mb-3">
                ${[1,2,3].map(n => `
                  <div class="col-md-4">
                    <label class="form-label small">${n}名作業時</label>
                    <div class="input-group input-group-sm">
                      <input type="number" class="form-control rates-input" min="0" step="100"
                        data-field="commonRate" data-count="${n}" data-item-id="${wi.id}"
                        value="${commonRates[n] || ""}">
                      <span class="input-group-text">円</span>
                    </div>
                  </div>
                `).join("")}
              </div>
            ` : `
              <h6 class="mt-3 mb-2">スタッフ別単価 <small class="text-muted">(タイミーは除外されます)</small></h6>
              <div class="table-responsive">
                <table class="table table-sm align-middle">
                  <thead class="table-light">
                    <tr>
                      <th>スタッフ名</th>
                      <th class="text-center">1名作業時</th>
                      <th class="text-center">2名作業時</th>
                      <th class="text-center">3名作業時</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${this.staffList.filter(s => !s.isTimee).filter(s => {
                      // 該当物件を担当するスタッフのみ表示 (assignedPropertyIds に currentPropertyId を含む)
                      // Webアプリ管理者 (isOwner=true) は常に表示
                      if (s.isOwner) return true;
                      const assigned = Array.isArray(s.assignedPropertyIds) ? s.assignedPropertyIds : [];
                      return assigned.includes(this.currentPropertyId);
                    }).map(s => {
                      const r = (wi.staffRates || {})[s.id] || {};
                      return `
                        <tr>
                          <td>${this.esc(s.name)}${s.isOwner ? ' <span class="badge bg-info">OWN</span>' : ""}</td>
                          ${[1,2,3].map(n => `
                            <td>
                              <div class="input-group input-group-sm">
                                <input type="number" class="form-control rates-input" min="0" step="100"
                                  placeholder="未設定"
                                  data-field="staffRate" data-count="${n}" data-item-id="${wi.id}" data-staff-id="${s.id}"
                                  value="${r[n] ?? ""}">
                                <span class="input-group-text">円</span>
                              </div>
                            </td>
                          `).join("")}
                        </tr>
                      `;
                    }).join("")}
                  </tbody>
                </table>
              </div>
            `}

            <hr class="my-3">
            <div class="d-flex align-items-center mb-2">
              <h6 class="mb-0"><i class="bi bi-calendar-event"></i> 特別加算料金</h6>
              <small class="text-muted ms-2">特定期間の作業に一律加算される追加料金</small>
              <button class="btn btn-sm btn-outline-warning ms-auto" data-act="edit-special" data-item-id="${wi.id}">
                <i class="bi bi-pencil"></i> 編集
              </button>
            </div>
            ${specialRates.length === 0 ? `
              <div class="small text-muted">特別加算料金は設定されていません</div>
            ` : `
              <ul class="list-group list-group-flush">
                ${specialRates.map(sr => {
                  const period = sr.recurYearly
                    ? `毎年 ${(sr.recurStart||"?/?").replace("-","/")} 〜 ${(sr.recurEnd||"?/?").replace("-","/")}`
                    : `${sr.start || "?"} 〜 ${sr.end || "?"}`;
                  return `
                  <li class="list-group-item small">
                    <strong>${this.esc(sr.name || "(無題)")}</strong>
                    ${sr.recurYearly ? '<span class="badge bg-info text-dark ms-1">毎年</span>' : ""}
                    <span class="text-muted ms-2">${period}</span>
                    <span class="badge bg-warning text-dark float-end">+${Number(sr.addAmount || 0).toLocaleString()}円</span>
                  </li>
                  `;
                }).join("")}
              </ul>
            `}
          </div>
        </div>
      </div>
    `;
  },

  async addWorkItem() {
    const r = await this.showFormDialog({
      title: "作業項目を追加",
      fields: [
        { name: "name", label: "作業項目名", type: "text", placeholder: "例: 清掃、直前点検、ランドリー受取" },
        { name: "type", label: "種類", type: "select", options: [
          { value: "cleaning_by_count", label: "清掃(人数制)" },
          { value: "pre_inspection", label: "直前点検" },
          { value: "other", label: "その他" }
        ], value: "other" }
      ],
      submitLabel: "追加"
    });
    if (!r || !r.name) return;
    this.workItems.push({
      id: `wi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`,
      name: r.name,
      type: r.type || "other",
      rateMode: "common",
      sortOrder: this.workItems.length + 1,
      commonRates: { 1: 0, 2: 0, 3: 0 },
      timeeHourlyRate: 0,
      staffRates: {},
      specialRates: []
    });
    this.markDirty();
    this.renderWorkItems();
  },

  // === モーダルヘルパー（property-checklist.js と同設計） ===
  showFormDialog({ title, fields, submitLabel = "保存", danger = false }) {
    return new Promise(resolve => {
      const modalId = "ratesDialog_" + Date.now().toString(36);
      const body = fields.map((f, i) => {
        const id = `${modalId}_f${i}`;
        if (f.type === "select") {
          return `
            <div class="mb-3">
              <label for="${id}" class="form-label">${this.esc(f.label)}</label>
              <select class="form-select" id="${id}" name="${f.name}">
                ${(f.options||[]).map(o =>
                  `<option value="${this.esc(o.value)}" ${o.value === f.value ? "selected" : ""}>${this.esc(o.label)}</option>`
                ).join("")}
              </select>
            </div>
          `;
        }
        if (f.type === "checkbox") {
          return `
            <div class="form-check mb-3">
              <input type="checkbox" class="form-check-input" id="${id}" name="${f.name}" ${f.value ? "checked" : ""}>
              <label class="form-check-label" for="${id}">${this.esc(f.label)}</label>
            </div>
          `;
        }
        if (f.type === "textarea") {
          return `
            <div class="mb-3">
              <label for="${id}" class="form-label">${this.esc(f.label)}</label>
              <textarea class="form-control" id="${id}" name="${f.name}" rows="2" placeholder="${this.esc(f.placeholder||"")}">${this.esc(f.value||"")}</textarea>
            </div>
          `;
        }
        return `
          <div class="mb-3">
            <label for="${id}" class="form-label">${this.esc(f.label)}</label>
            <input type="text" class="form-control" id="${id}" name="${f.name}"
                   value="${this.esc(f.value||"")}"
                   placeholder="${this.esc(f.placeholder||"")}">
          </div>
        `;
      }).join("");

      const submitClass = danger ? "btn-danger" : "btn-primary";
      const html = `
        <div class="modal fade" id="${modalId}" tabindex="-1">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title">${this.esc(title)}</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
              </div>
              <form id="${modalId}_form">
                <div class="modal-body">${body}</div>
                <div class="modal-footer">
                  <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">キャンセル</button>
                  <button type="submit" class="btn ${submitClass}">${this.esc(submitLabel)}</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      `;
      document.body.insertAdjacentHTML("beforeend", html);
      const modalEl = document.getElementById(modalId);
      const modal = new bootstrap.Modal(modalEl);

      let result = null;
      modalEl.querySelector("form").addEventListener("submit", (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        result = {};
        fields.forEach(f => {
          if (f.type === "checkbox") result[f.name] = fd.get(f.name) === "on";
          else result[f.name] = String(fd.get(f.name) || "");
        });
        modal.hide();
      });
      modalEl.addEventListener("hidden.bs.modal", () => {
        modalEl.remove();
        resolve(result);
      });
      modal.show();
      setTimeout(() => modalEl.querySelector("input[type=text],textarea,select")?.focus(), 200);
    });
  },

  showConfirmDialog({ title, message, confirmLabel = "OK", danger = false }) {
    return new Promise(resolve => {
      const modalId = "ratesConfirm_" + Date.now().toString(36);
      const btnClass = danger ? "btn-danger" : "btn-primary";
      const html = `
        <div class="modal fade" id="${modalId}" tabindex="-1">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title">${this.esc(title)}</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
              </div>
              <div class="modal-body">${this.esc(message)}</div>
              <div class="modal-footer">
                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">キャンセル</button>
                <button type="button" class="btn ${btnClass}" id="${modalId}_ok">${this.esc(confirmLabel)}</button>
              </div>
            </div>
          </div>
        </div>
      `;
      document.body.insertAdjacentHTML("beforeend", html);
      const modalEl = document.getElementById(modalId);
      const modal = new bootstrap.Modal(modalEl);
      let confirmed = false;
      modalEl.querySelector(`#${modalId}_ok`).addEventListener("click", () => {
        confirmed = true; modal.hide();
      });
      modalEl.addEventListener("hidden.bs.modal", () => {
        modalEl.remove(); resolve(confirmed);
      });
      modal.show();
    });
  },

  markDirty() {
    this.dirty = true;
    this.updateSaveButton();
    // 自動保存 (800ms debounce)
    this._queueAutoSave();
  },
  _queueAutoSave() {
    if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
    this._showAutoSaveStatus("saving");
    this._autoSaveTimer = setTimeout(() => {
      this.save({ silent: true }).then(() => this._showAutoSaveStatus("saved"))
        .catch((e) => this._showAutoSaveStatus("error", e?.message));
    }, 800);
  },
  _showAutoSaveStatus(kind, msg) {
    let el = document.getElementById("ratesAutoSaveStatus");
    if (!el) {
      const header = document.querySelector(".page-header");
      if (header) {
        el = document.createElement("span");
        el.id = "ratesAutoSaveStatus";
        el.className = "small ms-2";
        header.querySelector(".d-flex")?.prepend(el);
      }
    }
    if (!el) return;
    if (kind === "saving") el.innerHTML = `<i class="bi bi-arrow-repeat text-muted"></i> <span class="text-muted">保存中...</span>`;
    else if (kind === "saved") {
      el.innerHTML = `<span class="text-success"><i class="bi bi-check-circle-fill"></i> 保存済み</span>`;
      setTimeout(() => { if (el.innerHTML.includes("保存済み")) el.innerHTML = ""; }, 2000);
    } else if (kind === "error") el.innerHTML = `<span class="text-danger">保存失敗: ${msg || ""}</span>`;
  },
  updateSaveButton() {
    const btn = document.getElementById("ratesBtnSave");
    if (!btn) return;
    // 自動保存化したため、保存ボタンは非表示
    btn.style.display = "none";
  },

  // === 他施設からインポート ===
  async openImportModal() {
    if (this.dirty && !await this.showConfirmDialog({
      title: "未保存の変更があります",
      message: "インポートすると未保存の変更は失われます。続行しますか？",
      confirmLabel: "続行", danger: true,
    })) return;

    // 他物件を抽出（現在の物件を除外）
    const others = this.properties.filter(p => p.id !== this.currentPropertyId);
    if (others.length === 0) {
      showToast("情報", "他の民泊物件がありません", "info");
      return;
    }

    // 他物件の workItems を並列取得し、空でないものだけ候補に
    const results = await Promise.all(others.map(async p => ({
      property: p,
      items: (await API.properties.getWorkItems(p.id)).items || []
    })));
    const candidates = results.filter(r => r.items.length > 0);

    if (candidates.length === 0) {
      showToast("情報", "インポート元となる作業項目を持つ物件がありません", "info");
      return;
    }

    const r = await this.showFormDialog({
      title: "他施設から単価設定をインポート",
      fields: [
        {
          name: "sourcePropertyId",
          label: "コピー元の物件",
          type: "select",
          options: candidates.map(c => ({
            value: c.property.id,
            label: `${c.property._num}. ${c.property.name} (${c.items.length}項目)`
          })),
          value: candidates[0].property.id
        },
        {
          name: "mergeMode",
          label: "マージ方法",
          type: "select",
          options: [
            { value: "replace", label: "現在の設定を全て置き換え" },
            { value: "append", label: "現在の設定に追加（同名項目はスキップ）" }
          ],
          value: "replace"
        },
        {
          name: "includeStaffRates",
          label: "スタッフ別単価もコピーする (OFFなら共通単価のみ)",
          type: "checkbox",
          value: true
        }
      ],
      submitLabel: "インポート"
    });
    if (!r || !r.sourcePropertyId) return;

    const src = candidates.find(c => c.property.id === r.sourcePropertyId);
    if (!src) return;

    // コピー用に deep clone + 新しい ID を採番
    const cloneItem = (wi) => {
      const copy = JSON.parse(JSON.stringify(wi));
      copy.id = `wi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
      if (!r.includeStaffRates) copy.staffRates = {};
      return copy;
    };

    if (r.mergeMode === "replace") {
      this.workItems = src.items.map(cloneItem);
    } else {
      const existingNames = new Set(this.workItems.map(w => w.name));
      src.items.forEach(wi => {
        if (!existingNames.has(wi.name)) {
          const copy = cloneItem(wi);
          copy.sortOrder = this.workItems.length + 1;
          this.workItems.push(copy);
        }
      });
    }
    this.markDirty();
    this.renderWorkItems();
    showToast("インポート完了",
      `${src.property.name} から ${src.items.length}項目 を取り込みました。保存してください。`,
      "success");
  },

  async save(opts = {}) {
    const btn = document.getElementById("ratesBtnSave");
    if (btn && !opts.silent) {
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> 保存中...`;
    }
    try {
      await API.properties.saveWorkItems(this.currentPropertyId, this.workItems);
      this.dirty = false;
      this.updateSaveButton();
      if (!opts.silent) showToast("保存完了", "報酬単価を保存しました", "success");
    } catch (e) {
      if (!opts.silent) showToast("エラー", "保存失敗: " + e.message, "error");
      if (btn) btn.disabled = false;
      throw e;
    }
  },

  esc(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }
};
