/**
 * 物件別チェックリスト編集ページ
 * ルート: #/property-checklist/:propertyId
 *
 * UI: L1エリアをタブ化、L2以下はアコーディオン
 * 機能: CRUD、D&D並び替え、要補充トグル、別の宿からコピー
 * 見本画像は後続タスク（Cloud Storage 連携後に実装）
 */
const PropertyChecklistPage = {
  propertyId: null,
  property: null,
  template: null,            // { areas: [...], version, ... }
  activeAreaId: null,
  dirty: false,              // 未保存変更あり?
  sortables: [],             // Sortable インスタンスのキャッシュ

  async render(container, pathParams) {
    this.propertyId = (pathParams || [])[0];
    if (!this.propertyId) {
      container.innerHTML = `<div class="alert alert-danger">物件IDが未指定です</div>`;
      return;
    }

    container.innerHTML = `
      <div class="d-flex align-items-center mb-3">
        <a href="#/properties" class="btn btn-sm btn-outline-secondary me-2">
          <i class="bi bi-arrow-left"></i> 物件一覧
        </a>
        <h4 class="mb-0 flex-grow-1" id="pclHeader">チェックリスト編集</h4>
        <button class="btn btn-outline-info btn-sm me-2" id="btnCopyFrom">
          <i class="bi bi-clipboard"></i> 別の宿からコピー
        </button>
        <button class="btn btn-success btn-sm" id="btnSave" disabled>
          <i class="bi bi-check2"></i> 保存
        </button>
      </div>
      <div id="pclBody"><div class="text-center text-muted py-5"><div class="spinner-border"></div></div></div>
    `;

    document.getElementById("btnSave").addEventListener("click", () => this.save());
    document.getElementById("btnCopyFrom").addEventListener("click", () => this.openCopyModal());
    window.addEventListener("beforeunload", this._beforeUnloadHandler = (e) => {
      if (this.dirty) { e.preventDefault(); e.returnValue = ""; }
    });

    await this.loadData();
  },

  async loadData() {
    try {
      const [prop, tmpl] = await Promise.all([
        this.fetchProperty(),
        this.fetchTemplate()
      ]);
      this.property = prop;
      this.template = tmpl;

      document.getElementById("pclHeader").textContent =
        `チェックリスト編集: ${this.property?.name || this.propertyId}`;

      if (!tmpl) {
        this.renderEmptyState();
        return;
      }

      // アクティブタブ初期値
      if (!this.activeAreaId || !tmpl.areas.find(a => a.id === this.activeAreaId)) {
        this.activeAreaId = tmpl.areas[0]?.id || null;
      }
      this.renderTree();
    } catch (e) {
      console.error(e);
      document.getElementById("pclBody").innerHTML =
        `<div class="alert alert-danger">読み込み失敗: ${this.escapeHtml(e.message)}</div>`;
    }
  },

  async fetchProperty() {
    try {
      return await API.properties.get(this.propertyId);
    } catch (e) {
      return null;
    }
  },

  async fetchTemplate() {
    return await API.checklist.getTemplateTree(this.propertyId);
  },

  renderEmptyState() {
    document.getElementById("pclBody").innerHTML = `
      <div class="empty-state fade-in text-center py-5">
        <i class="bi bi-list-check display-3 text-muted"></i>
        <p class="mt-3">この物件にはチェックリストがまだありません</p>
        <button class="btn btn-primary me-2" id="btnInitFromMaster">
          <i class="bi bi-download"></i> マスタからコピーして新規作成
        </button>
        <button class="btn btn-outline-primary" id="btnInitFromOther">
          <i class="bi bi-clipboard"></i> 別の宿からコピー
        </button>
      </div>
    `;
    document.getElementById("btnInitFromMaster").addEventListener("click", () => this.copyFrom("master"));
    document.getElementById("btnInitFromOther").addEventListener("click", () => this.openCopyModal());
  },

  renderTree() {
    const body = document.getElementById("pclBody");
    const areas = this.template.areas || [];

    const tabs = areas.map((a, i) => `
      <li class="nav-item">
        <a class="nav-link ${a.id === this.activeAreaId ? "active" : ""}" href="#" data-area-id="${a.id}">
          ${this.escapeHtml(a.name)}
          <span class="badge bg-light text-dark ms-1">${this.countLeaves(a)}</span>
        </a>
      </li>
    `).join("");

    body.innerHTML = `
      <div class="mb-3">
        <ul class="nav nav-pills flex-nowrap overflow-auto pb-2" id="areaTabs" style="white-space:nowrap;">
          ${tabs}
          <li class="nav-item">
            <a class="nav-link text-success" href="#" id="btnAddArea"><i class="bi bi-plus"></i> エリア追加</a>
          </li>
        </ul>
      </div>
      <div id="areaContent"></div>
    `;

    body.querySelectorAll("[data-area-id]").forEach(el => {
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        this.activeAreaId = el.dataset.areaId;
        this.renderTree();
      });
    });
    document.getElementById("btnAddArea").addEventListener("click", (ev) => {
      ev.preventDefault();
      this.addArea();
    });

    this.renderAreaContent();
  },

  renderAreaContent() {
    const area = this.template.areas.find(a => a.id === this.activeAreaId);
    const content = document.getElementById("areaContent");
    if (!area) { content.innerHTML = ""; return; }

    content.innerHTML = `
      <div class="card">
        <div class="card-header d-flex align-items-center">
          <strong>エリア: ${this.escapeHtml(area.name)}</strong>
          <button class="btn btn-sm btn-link ms-2" data-act="rename-area"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm btn-link text-danger" data-act="delete-area"><i class="bi bi-trash"></i></button>
          <div class="ms-auto">
            <button class="btn btn-sm btn-outline-primary" data-act="add-item"><i class="bi bi-plus"></i> 項目</button>
            <button class="btn btn-sm btn-outline-primary" data-act="add-tt"><i class="bi bi-plus"></i> 掃除種類</button>
          </div>
        </div>
        <div class="card-body" id="areaInner">
          ${this.renderChildrenContainer(area, "area")}
        </div>
      </div>
    `;

    content.querySelector(`[data-act="rename-area"]`).addEventListener("click", () => this.renameNode(area, "エリア名"));
    content.querySelector(`[data-act="delete-area"]`).addEventListener("click", () => this.deleteArea(area));
    content.querySelector(`[data-act="add-item"]`).addEventListener("click", () => this.addItem(area, "directItems"));
    content.querySelector(`[data-act="add-tt"]`).addEventListener("click", () => this.addTaskType(area));

    this.wireNodeHandlers(content);
    this.makeSortables();
  },

  // === 階層ごとの「子」配列を sortOrder で統合して描画 ===
  // 各ノード(area/tt/sc/ss)は "children コンテナ" を1つ持ち、そこに
  // 項目行 と カテゴリ行 を sortOrder 順で並べる
  renderChildrenContainer(parent, parentType) {
    // parentType: "area" | "tt" | "sc" | "ss"
    const itemsField = parentType === "ss" ? "items" : "directItems";
    const catField = parentType === "area" ? "taskTypes"
                   : parentType === "tt"   ? "subCategories"
                   : parentType === "sc"   ? "subSubCategories"
                   : null;  // ss は子カテゴリなし

    const items = (parent[itemsField] || []).map(it => ({
      __kind: "item", sortOrder: it.sortOrder || 0, data: it
    }));
    const cats = catField ? (parent[catField] || []).map(c => ({
      __kind: "cat", sortOrder: c.sortOrder || 0, data: c
    })) : [];
    const children = [...items, ...cats].sort((a, b) => a.sortOrder - b.sortOrder);

    const containerId = `children-${parentType}-${parent.id}`;
    const rowsHtml = children.length === 0
      ? `<div class="text-muted small p-2">（項目なし）</div>`
      : children.map(c =>
          c.__kind === "item"
            ? this.renderItemRow(c.data, parentType, parent.id)
            : this.renderCategoryRow(c.data, parentType, parent.id)
        ).join("");

    return `
      <div class="pcl-children"
           id="${containerId}"
           data-parent-type="${parentType}"
           data-parent-id="${parent.id}">
        ${rowsHtml}
      </div>
    `;
  },

  // 項目行（list-group-item 相当）
  renderItemRow(it, parentType, parentId) {
    return `
      <div class="pcl-row pcl-row-item list-group-item d-flex align-items-center mb-1"
           data-kind="item"
           data-item-id="${it.id}"
           data-parent-type="${parentType}"
           data-parent-id="${parentId}">
        <i class="bi bi-grip-vertical text-muted me-2 handle" style="cursor:grab;"></i>
        <div class="flex-grow-1">
          <div>${this.escapeHtml(it.name)}</div>
          <div class="small text-muted">
            ${it.supplyItem ? '<span class="badge bg-warning text-dark">要補充</span>' : ""}
            ${it.memo ? `<span class="ms-2">メモ: ${this.escapeHtml(it.memo)}</span>` : ""}
          </div>
        </div>
        <button class="btn btn-sm btn-link" data-act="edit-item"><i class="bi bi-pencil"></i></button>
        <button class="btn btn-sm btn-link text-danger" data-act="delete-item"><i class="bi bi-trash"></i></button>
      </div>
    `;
  },

  // カテゴリ行（アコーディオン1要素）
  renderCategoryRow(cat, parentType, parentId) {
    // parentType で自分のレベルを決定
    const level = parentType === "area" ? "tt"
                : parentType === "tt"   ? "sc"
                : parentType === "sc"   ? "ss"
                : null;
    if (!level) return "";  // ss 配下にはカテゴリなし
    const labels = {
      tt: { name: "掃除種類名", addItem: "add-item-tt", addChild: "add-sub", addChildLabel: "サブ分類", rename: "rename-tt", delete: "delete-tt", ml: "" },
      sc: { name: "サブ分類名", addItem: "add-item-sc", addChild: "add-ss",  addChildLabel: "サブサブ", rename: "rename-sc", delete: "delete-sc", ml: "ms-3" },
      ss: { name: "サブサブ分類名", addItem: "add-item-ss", addChild: null,     addChildLabel: null,     rename: "rename-ss", delete: "delete-ss", ml: "ms-3" }
    };
    const l = labels[level];
    const collapseId = `c-${level}-${cat.id}`;
    const headerBg = level === "sc" ? "bg-light" : "";

    return `
      <div class="pcl-row pcl-row-cat accordion ${l.ml} mb-1"
           data-kind="cat"
           data-cat-level="${level}"
           data-cat-id="${cat.id}"
           data-parent-type="${parentType}"
           data-parent-id="${parentId}">
        <div class="accordion-item">
          <h2 class="accordion-header">
            <button class="accordion-button collapsed ${headerBg}" type="button" data-bs-toggle="collapse" data-bs-target="#${collapseId}">
              <i class="bi bi-grip-vertical text-muted me-2 handle" style="cursor:grab;"></i>
              ${this.escapeHtml(cat.name)}
              <span class="badge bg-secondary ms-2">${this.countLeaves(cat)}</span>
            </button>
          </h2>
          <div id="${collapseId}" class="accordion-collapse collapse">
            <div class="accordion-body">
              <div class="d-flex mb-2">
                <button class="btn btn-sm btn-link" data-act="${l.rename}"><i class="bi bi-pencil"></i> 名前</button>
                <button class="btn btn-sm btn-link text-danger" data-act="${l.delete}"><i class="bi bi-trash"></i> 削除</button>
                <div class="ms-auto">
                  <button class="btn btn-sm btn-outline-primary" data-act="${l.addItem}"><i class="bi bi-plus"></i> 項目</button>
                  ${l.addChild ? `<button class="btn btn-sm btn-outline-primary" data-act="${l.addChild}"><i class="bi bi-plus"></i> ${l.addChildLabel}</button>` : ""}
                </div>
              </div>
              ${this.renderChildrenContainer(cat, level)}
            </div>
          </div>
        </div>
      </div>
    `;
  },

  // === イベント紐付け（委譲方式） ===
  wireNodeHandlers(root) {
    root.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      const area = this.template.areas.find(a => a.id === this.activeAreaId);
      if (!area) return;

      // カテゴリ行 / 項目行を起点に現在のノードを解決
      const catRow = btn.closest(".pcl-row-cat");
      const itemRow = btn.closest(".pcl-row-item");

      if (act === "edit-item" || act === "delete-item") {
        const itemId = itemRow?.dataset.itemId;
        const parentType = itemRow?.dataset.parentType;
        const parentId = itemRow?.dataset.parentId;
        const { container } = this.resolveContainer(parentType, parentId, area);
        const item = (container || []).find(x => x.id === itemId);
        if (!item) return;
        if (act === "edit-item") this.editItem(item, container);
        else this.deleteItem(item, container);
        return;
      }

      // カテゴリ行の操作: このカテゴリ自身を解決
      const catLevel = catRow?.dataset.catLevel;  // "tt"|"sc"|"ss"
      const catId = catRow?.dataset.catId;
      const { node: cat, parentArray } = catLevel ? this.resolveCategory(catLevel, catId, area) : {};

      if (act === "rename-tt" || act === "rename-sc" || act === "rename-ss") {
        const label = act === "rename-tt" ? "掃除種類名" : act === "rename-sc" ? "サブ分類名" : "サブサブ分類名";
        this.renameNode(cat, label);
      } else if (act === "delete-tt" || act === "delete-sc" || act === "delete-ss") {
        this.deleteNode(parentArray, cat);
      } else if (act === "add-item-tt" || act === "add-item-sc") {
        this.addItem(cat, "directItems");
      } else if (act === "add-item-ss") {
        this.addItem(cat, "items");
      } else if (act === "add-sub") {
        this.addSubCategory(cat);
      } else if (act === "add-ss") {
        this.addSubSubCategory(cat);
      }
    });
  },

  // parentType / parentId からその項目配列を解決
  resolveContainer(parentType, parentId, area) {
    if (parentType === "area" && parentId === area.id) {
      area.directItems = area.directItems || [];
      return { container: area.directItems, field: "directItems", parent: area };
    }
    for (const tt of area.taskTypes || []) {
      if (parentType === "tt" && tt.id === parentId) {
        tt.directItems = tt.directItems || [];
        return { container: tt.directItems, field: "directItems", parent: tt };
      }
      for (const sc of tt.subCategories || []) {
        if (parentType === "sc" && sc.id === parentId) {
          sc.directItems = sc.directItems || [];
          return { container: sc.directItems, field: "directItems", parent: sc };
        }
        for (const ss of sc.subSubCategories || []) {
          if (parentType === "ss" && ss.id === parentId) {
            ss.items = ss.items || [];
            return { container: ss.items, field: "items", parent: ss };
          }
        }
      }
    }
    return { container: null, field: null, parent: null };
  },

  // カテゴリ level+id から自身ノードと親配列を解決
  resolveCategory(level, id, area) {
    if (level === "tt") {
      const arr = area.taskTypes || [];
      const node = arr.find(x => x.id === id);
      return { node, parentArray: arr };
    }
    for (const tt of area.taskTypes || []) {
      if (level === "sc") {
        const arr = tt.subCategories || [];
        const node = arr.find(x => x.id === id);
        if (node) return { node, parentArray: arr };
      }
      for (const sc of tt.subCategories || []) {
        if (level === "ss") {
          const arr = sc.subSubCategories || [];
          const node = arr.find(x => x.id === id);
          if (node) return { node, parentArray: arr };
        }
      }
    }
    return { node: null, parentArray: null };
  },

  // === モーダルヘルパー ===
  // showFormDialog: 任意のフォーム入力モーダル。Promise<formValues | null>
  // fields: [{name, label, type: "text"|"textarea"|"checkbox", value, placeholder}]
  showFormDialog({ title, fields, submitLabel = "保存", danger = false }) {
    return new Promise(resolve => {
      const modalId = "pclDialog_" + Date.now().toString(36);
      const body = fields.map((f, i) => {
        const id = `${modalId}_f${i}`;
        if (f.type === "checkbox") {
          return `
            <div class="form-check mb-3">
              <input type="checkbox" class="form-check-input" id="${id}" name="${f.name}" ${f.value ? "checked" : ""}>
              <label class="form-check-label" for="${id}">${this.escapeHtml(f.label)}</label>
            </div>
          `;
        }
        if (f.type === "textarea") {
          return `
            <div class="mb-3">
              <label for="${id}" class="form-label">${this.escapeHtml(f.label)}</label>
              <textarea class="form-control" id="${id}" name="${f.name}" rows="2" placeholder="${this.escapeHtml(f.placeholder||"")}">${this.escapeHtml(f.value||"")}</textarea>
            </div>
          `;
        }
        return `
          <div class="mb-3">
            <label for="${id}" class="form-label">${this.escapeHtml(f.label)}</label>
            <input type="text" class="form-control" id="${id}" name="${f.name}"
                   value="${this.escapeHtml(f.value||"")}"
                   placeholder="${this.escapeHtml(f.placeholder||"")}">
          </div>
        `;
      }).join("");

      const submitClass = danger ? "btn-danger" : "btn-primary";
      const html = `
        <div class="modal fade" id="${modalId}" tabindex="-1">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title">${this.escapeHtml(title)}</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
              </div>
              <form id="${modalId}_form">
                <div class="modal-body">${body}</div>
                <div class="modal-footer">
                  <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">キャンセル</button>
                  <button type="submit" class="btn ${submitClass}">${this.escapeHtml(submitLabel)}</button>
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
      // オートフォーカス: 最初のテキスト入力
      setTimeout(() => modalEl.querySelector("input[type=text],textarea")?.focus(), 200);
    });
  },

  // showConfirmDialog: 確認モーダル。Promise<boolean>
  showConfirmDialog({ title, message, confirmLabel = "OK", danger = false }) {
    return new Promise(resolve => {
      const modalId = "pclConfirm_" + Date.now().toString(36);
      const btnClass = danger ? "btn-danger" : "btn-primary";
      const html = `
        <div class="modal fade" id="${modalId}" tabindex="-1">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title">${this.escapeHtml(title)}</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
              </div>
              <div class="modal-body">${this.escapeHtml(message)}</div>
              <div class="modal-footer">
                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">キャンセル</button>
                <button type="button" class="btn ${btnClass}" id="${modalId}_ok">${this.escapeHtml(confirmLabel)}</button>
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
        confirmed = true;
        modal.hide();
      });
      modalEl.addEventListener("hidden.bs.modal", () => {
        modalEl.remove();
        resolve(confirmed);
      });
      modal.show();
    });
  },

  // === CRUD ===
  async addArea() {
    const r = await this.showFormDialog({
      title: "エリア追加",
      fields: [{ name: "name", label: "エリア名", type: "text", placeholder: "例: 1階トイレ" }],
      submitLabel: "追加"
    });
    if (!r || !r.name) return;
    this.template.areas.push({
      id: this.genId("a"), name: r.name, sortOrder: this.template.areas.length + 1,
      sampleImageUrl: "", directItems: [], taskTypes: []
    });
    this.activeAreaId = this.template.areas[this.template.areas.length - 1].id;
    this.markDirty();
    this.renderTree();
  },

  async addTaskType(area) {
    const r = await this.showFormDialog({
      title: "掃除種類を追加",
      fields: [{ name: "name", label: "掃除種類名", type: "text", placeholder: "例: 灰皿" }],
      submitLabel: "追加"
    });
    if (!r || !r.name) return;
    (area.taskTypes = area.taskTypes || []).push({
      id: this.genId("t"), name: r.name, sortOrder: area.taskTypes.length + 1,
      sampleImageUrl: "", directItems: [], subCategories: []
    });
    this.markDirty();
    this.renderAreaContent();
  },

  async addSubCategory(tt) {
    const r = await this.showFormDialog({
      title: "サブ分類を追加",
      fields: [{ name: "name", label: "サブ分類名", type: "text", placeholder: "例: A、○○のとき" }],
      submitLabel: "追加"
    });
    if (!r || !r.name) return;
    (tt.subCategories = tt.subCategories || []).push({
      id: this.genId("s"), name: r.name, sortOrder: tt.subCategories.length + 1,
      sampleImageUrl: "", directItems: [], subSubCategories: []
    });
    this.markDirty();
    this.renderAreaContent();
  },

  async addSubSubCategory(sc) {
    const r = await this.showFormDialog({
      title: "サブサブ分類を追加",
      fields: [{ name: "name", label: "サブサブ分類名", type: "text" }],
      submitLabel: "追加"
    });
    if (!r || !r.name) return;
    (sc.subSubCategories = sc.subSubCategories || []).push({
      id: this.genId("ss"), name: r.name, sortOrder: sc.subSubCategories.length + 1,
      sampleImageUrl: "", items: []
    });
    this.markDirty();
    this.renderAreaContent();
  },

  async addItem(parent, field) {
    const r = await this.showFormDialog({
      title: "項目を追加",
      fields: [
        { name: "name", label: "項目名", type: "text", placeholder: "例: ゴミ拾い" },
        { name: "supplyItem", label: "要補充の対象項目にする", type: "checkbox", value: false },
        { name: "memo", label: "メモ（任意）", type: "textarea", placeholder: "補足説明など" }
      ],
      submitLabel: "追加"
    });
    if (!r || !r.name) return;
    const arr = parent[field] = parent[field] || [];
    arr.push({
      id: this.genId("it"), name: r.name,
      sortOrder: arr.length + 1,
      supplyItem: !!r.supplyItem, memo: r.memo || ""
    });
    this.markDirty();
    this.renderAreaContent();
  },

  async editItem(item, container) {
    const r = await this.showFormDialog({
      title: "項目を編集",
      fields: [
        { name: "name", label: "項目名", type: "text", value: item.name },
        { name: "supplyItem", label: "要補充の対象項目にする", type: "checkbox", value: item.supplyItem },
        { name: "memo", label: "メモ（任意）", type: "textarea", value: item.memo || "" }
      ],
      submitLabel: "保存"
    });
    if (!r || !r.name) return;
    item.name = r.name;
    item.supplyItem = !!r.supplyItem;
    item.memo = r.memo || "";
    this.markDirty();
    this.renderAreaContent();
  },

  async deleteItem(item, container) {
    const ok = await this.showConfirmDialog({
      title: "項目の削除",
      message: `「${item.name}」を削除します。よろしいですか？`,
      confirmLabel: "削除", danger: true
    });
    if (!ok) return;
    const idx = container.indexOf(item);
    if (idx >= 0) container.splice(idx, 1);
    this.markDirty();
    this.renderAreaContent();
  },

  async renameNode(node, label) {
    if (!node) return;
    const r = await this.showFormDialog({
      title: `${label}の変更`,
      fields: [{ name: "name", label, type: "text", value: node.name }],
      submitLabel: "変更"
    });
    if (!r || !r.name) return;
    node.name = r.name;
    this.markDirty();
    this.renderTree();
  },

  async deleteArea(area) {
    const ok = await this.showConfirmDialog({
      title: "エリアの削除",
      message: `エリア「${area.name}」と配下全てを削除します。よろしいですか？`,
      confirmLabel: "削除", danger: true
    });
    if (!ok) return;
    const idx = this.template.areas.indexOf(area);
    if (idx >= 0) this.template.areas.splice(idx, 1);
    this.activeAreaId = this.template.areas[0]?.id || null;
    this.markDirty();
    this.renderTree();
  },

  async deleteNode(arr, node) {
    if (!arr || !node) return;
    const ok = await this.showConfirmDialog({
      title: "削除",
      message: `「${node.name}」を削除します。よろしいですか？`,
      confirmLabel: "削除", danger: true
    });
    if (!ok) return;
    const idx = arr.indexOf(node);
    if (idx >= 0) arr.splice(idx, 1);
    this.markDirty();
    this.renderAreaContent();
  },

  // === D&D 並び替え (SortableJS) ===
  // 各階層の children コンテナ(pcl-children)を SortableJS で結合
  // group: "children-L<N>" で「同じ階層の親同士」に項目を跨いで移動可能
  // 例: L1エリア直下の項目を、別のエリア直下や L2/L3/L4 直下へ D&D で移動
  makeSortables() {
    if (typeof Sortable === "undefined") return;
    this.sortables.forEach(s => { try { s.destroy(); } catch {} });
    this.sortables = [];

    // 全階層の children コンテナを1つのグループに統合
    // → カテゴリ行も項目行も混在して sortable、
    //   カテゴリはアイテムと異なり put/pull が必要だが、現状は同一グループで OK
    //   (カテゴリが別階層へ落ちないよう put ガードで制御)
    document.querySelectorAll(".pcl-children").forEach(el => {
      const s = Sortable.create(el, {
        handle: ".handle",
        animation: 120,
        group: {
          name: "pcl",
          // pull: 項目は常に、カテゴリは同一親の範囲内のみ
          pull: (to, from, dragEl) => {
            if (dragEl.dataset.kind === "item") return true;
            // カテゴリは同一親(同じ parent-type + parent-id)の中でしか移動させない
            return dragEl.dataset.parentType === to.el.dataset.parentType
                && dragEl.dataset.parentId === to.el.dataset.parentId;
          },
          put: (to, from, dragEl) => {
            if (dragEl.dataset.kind === "item") return true;
            // カテゴリは元親の中にしか入れない
            return dragEl.dataset.parentType === to.dataset.parentType
                && dragEl.dataset.parentId === to.dataset.parentId;
          }
        },
        onEnd: (evt) => this.onChildrenDragEnd(evt)
      });
      this.sortables.push(s);
    });
  },

  // D&D 後: 移動元 & 移動先の両コンテナから DOM を読んでデータ再構築
  onChildrenDragEnd(evt) {
    const fromEl = evt.from;  // 移動元コンテナ
    const toEl = evt.to;      // 移動先コンテナ
    const area = this.template.areas.find(a => a.id === this.activeAreaId);
    if (!area) return;

    // 移動元と移動先が同じならシンプルに並び替えだけ
    this.rebuildContainer(toEl, area);
    if (fromEl !== toEl) this.rebuildContainer(fromEl, area);

    // 移動したアイテムの data-parent-type/id を更新 (DOM 側)
    if (evt.item.dataset.kind === "item") {
      evt.item.dataset.parentType = toEl.dataset.parentType;
      evt.item.dataset.parentId = toEl.dataset.parentId;
    }

    this.markDirty();
  },

  // あるコンテナ(.pcl-children) の DOM 現状を読み、対応する親ノードの
  // 項目配列＋子カテゴリ配列を DOM 順に再構築
  rebuildContainer(containerEl, area) {
    const parentType = containerEl.dataset.parentType;
    const parentId = containerEl.dataset.parentId;
    const { parent, field: itemsField } = this.resolveContainer(parentType, parentId, area);
    if (!parent) return;

    const catField = parentType === "area" ? "taskTypes"
                   : parentType === "tt"   ? "subCategories"
                   : parentType === "sc"   ? "subSubCategories"
                   : null;

    const rows = [...containerEl.children];
    const newItems = [];
    const newCats = [];

    rows.forEach((row, idx) => {
      const kind = row.dataset.kind;
      if (kind === "item") {
        const id = row.dataset.itemId;
        // まず全ツリーから探す (移動してきた可能性あり)
        const it = this.findItemGlobally(id);
        if (it) {
          it.sortOrder = idx + 1;
          newItems.push(it);
        }
      } else if (kind === "cat") {
        const level = row.dataset.catLevel;
        const id = row.dataset.catId;
        const { node } = this.resolveCategory(level, id, area);
        if (node) {
          node.sortOrder = idx + 1;
          newCats.push(node);
        }
      }
    });

    parent[itemsField] = newItems;
    if (catField) parent[catField] = newCats;
  },

  // 全ツリーから itemId で項目オブジェクトを見つけて(1つだけ)返す
  // ※ 見つけた元親配列からは除去しない — rebuildContainer が両側を書き換える時点で DOM が正
  findItemGlobally(itemId) {
    for (const area of this.template.areas) {
      const found = this._findItemIn(area, itemId);
      if (found) return found;
    }
    return null;
  },
  _findItemIn(parent, itemId) {
    const lists = [parent.directItems, parent.items].filter(Boolean);
    for (const list of lists) {
      const hit = list.find(x => x.id === itemId);
      if (hit) return hit;
    }
    const subs = [].concat(parent.taskTypes || [], parent.subCategories || [], parent.subSubCategories || []);
    for (const sub of subs) {
      const hit = this._findItemIn(sub, itemId);
      if (hit) return hit;
    }
    return null;
  },

  // === 保存 ===
  async save() {
    const btn = document.getElementById("btnSave");
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> 保存中...`;
    try {
      await API.checklist.saveTemplateTree(this.propertyId, this.template);
      this.dirty = false;
      btn.innerHTML = `<i class="bi bi-check2"></i> 保存`;
      btn.classList.remove("btn-warning");
      btn.classList.add("btn-success");
      showToast("保存完了", "チェックリストを保存しました", "success");
    } catch (e) {
      console.error(e);
      btn.innerHTML = `<i class="bi bi-exclamation"></i> 失敗`;
      btn.disabled = false;
      showToast("エラー", "保存失敗: " + (e.message || ""), "error");
    }
  },

  markDirty() {
    this.dirty = true;
    const btn = document.getElementById("btnSave");
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("btn-success");
      btn.classList.add("btn-warning");
      btn.innerHTML = `<i class="bi bi-save"></i> 保存（未保存）`;
    }
  },

  // === コピー機能 ===
  async openCopyModal() {
    const properties = (await API.properties.list(true)).filter(p => p.type === "minpaku" && p.id !== this.propertyId);
    // 既存テンプレートを持つ物件のみに絞る
    const withTmpl = [];
    for (const p of properties) {
      const t = await API.checklist.getTemplateTree(p.id);
      if (t && t.areas?.length) withTmpl.push(p);
    }

    const html = `
      <div class="modal fade" id="copyModal" tabindex="-1">
        <div class="modal-dialog"><div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">チェックリストをコピー</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <p class="text-muted small">現在のチェックリストは上書きされます。よろしければコピー元を選んでください。</p>
            <div class="list-group">
              <button class="list-group-item list-group-item-action" data-src="master">
                <strong><i class="bi bi-star"></i> マスタ（全項目の原本）</strong>
                <div class="small text-muted">561項目・20エリア</div>
              </button>
              ${withTmpl.map(p => `
                <button class="list-group-item list-group-item-action" data-src="template" data-pid="${p.id}">
                  <strong>${this.escapeHtml(p.name)}</strong>
                </button>
              `).join("")}
              ${withTmpl.length === 0 ? `<div class="list-group-item text-muted small">コピー可能な他物件のテンプレートがありません</div>` : ""}
            </div>
          </div>
        </div></div>
      </div>
    `;
    document.getElementById("copyModal")?.remove();
    document.body.insertAdjacentHTML("beforeend", html);
    const modal = new bootstrap.Modal(document.getElementById("copyModal"));
    modal.show();
    document.getElementById("copyModal").querySelectorAll("[data-src]").forEach(btn => {
      btn.addEventListener("click", async () => {
        modal.hide();
        await this.copyFrom(btn.dataset.src, btn.dataset.pid);
      });
    });
  },

  async copyFrom(sourceType, sourcePropertyId = null) {
    const ok = await this.showConfirmDialog({
      title: "チェックリストをコピー",
      message: `${sourceType === "master" ? "マスタ" : "他物件"}からコピーします。現在の内容は上書きされます。よろしいですか？`,
      confirmLabel: "コピーする", danger: true
    });
    if (!ok) return;
    try {
      const res = await API.checklist.copyTemplate(this.propertyId, sourceType, sourcePropertyId);
      this.template = res;
      this.activeAreaId = this.template.areas[0]?.id || null;
      this.dirty = false;
      this.renderTree();
      showToast("コピー完了", "チェックリストをコピーしました", "success");
    } catch (e) {
      console.error(e);
      showToast("エラー", "コピー失敗: " + (e.message || ""), "error");
    }
  },

  // === ユーティリティ ===
  countLeaves(node) {
    let n = (node.directItems || []).length + (node.items || []).length;
    (node.taskTypes || []).forEach(x => { n += this.countLeaves(x); });
    (node.subCategories || []).forEach(x => { n += this.countLeaves(x); });
    (node.subSubCategories || []).forEach(x => { n += this.countLeaves(x); });
    return n;
  },

  genId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;
  },

  escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
};
