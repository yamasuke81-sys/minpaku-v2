/**
 * 清掃チェックリストページ
 * テンプレート管理 + チェックリスト記録の確認
 */
const ChecklistPage = {
  templates: [],
  records: [],
  properties: [],
  staffList: [],

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-clipboard-check"></i> チェックリスト</h2>
        <button class="btn btn-primary" id="btnNewTemplate"><i class="bi bi-plus-lg"></i> テンプレート作成</button>
      </div>

      <!-- タブ -->
      <ul class="nav nav-tabs mb-3" id="checklistTabs">
        <li class="nav-item"><a class="nav-link active" data-bs-toggle="tab" href="#tabTemplates">テンプレート</a></li>
        <li class="nav-item"><a class="nav-link" data-bs-toggle="tab" href="#tabRecords">清掃記録</a></li>
      </ul>

      <div class="tab-content">
        <!-- テンプレートタブ -->
        <div class="tab-pane fade show active" id="tabTemplates">
          <div id="templateList">
            <div class="text-center py-4 text-muted"><div class="spinner-border spinner-border-sm"></div> 読み込み中...</div>
          </div>
        </div>

        <!-- 記録タブ -->
        <div class="tab-pane fade" id="tabRecords">
          <div class="d-flex gap-2 mb-3">
            <select class="form-select" style="max-width:200px" id="recordFilterStaff">
              <option value="">全スタッフ</option>
            </select>
          </div>
          <div id="recordList">
            <div class="text-center py-4 text-muted"><div class="spinner-border spinner-border-sm"></div> 読み込み中...</div>
          </div>
        </div>
      </div>

      <!-- テンプレート作成モーダル -->
      <div class="modal fade" id="templateModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
          <div class="modal-content">
            <div class="modal-header"><h5 class="modal-title" id="templateModalTitle">テンプレート作成</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
            <div class="modal-body">
              <input type="hidden" id="templateEditId">
              <div class="row g-3 mb-3">
                <div class="col-md-6">
                  <label class="form-label">テンプレート名 <span class="text-danger">*</span></label>
                  <input type="text" class="form-control" id="templateName" placeholder="例: スタンダード清掃">
                </div>
                <div class="col-md-6">
                  <label class="form-label">対象物件</label>
                  <select class="form-select" id="templatePropertyId"><option value="">-- 全物件共通 --</option></select>
                </div>
              </div>
              <h6>チェック項目 <button class="btn btn-sm btn-outline-primary ms-2" id="btnAddCheckItem"><i class="bi bi-plus"></i> 追加</button></h6>
              <div id="checkItemList"></div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">キャンセル</button>
              <button type="button" class="btn btn-primary" id="btnSaveTemplate"><i class="bi bi-check-lg"></i> 保存</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
    await this.loadData();
  },

  bindEvents() {
    document.getElementById("btnNewTemplate").addEventListener("click", () => this.openTemplateModal());
    document.getElementById("btnAddCheckItem").addEventListener("click", () => this.addCheckItem());
    document.getElementById("btnSaveTemplate").addEventListener("click", () => this.saveTemplate());
    document.getElementById("recordFilterStaff").addEventListener("change", () => this.renderRecords());
  },

  async loadData() {
    try {
      const [templates, records, properties, staffList] = await Promise.all([
        API.checklist.templates(),
        API.checklist.records(),
        API.properties.list(),
        API.staff.list(),
      ]);
      this.templates = templates;
      this.records = records;
      this.properties = properties;
      this.staffList = staffList;

      this.renderTemplates();
      this.renderRecords();
      this.populateSelects();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  populateSelects() {
    const propSel = document.getElementById("templatePropertyId");
    propSel.innerHTML = `<option value="">-- 全物件共通 --</option>` + this.properties.map(p => `<option value="${p.id}">${p.name}</option>`).join("");

    const staffSel = document.getElementById("recordFilterStaff");
    staffSel.innerHTML = `<option value="">全スタッフ</option>` + this.staffList.map(s => `<option value="${s.id}">${s.name}</option>`).join("");
  },

  renderTemplates() {
    const el = document.getElementById("templateList");
    if (!this.templates.length) {
      el.innerHTML = `<div class="empty-state"><i class="bi bi-clipboard-plus"></i><p>テンプレートがありません</p><p class="small text-muted">「テンプレート作成」から清掃チェック項目を定義してください</p></div>`;
      return;
    }

    const propMap = Object.fromEntries(this.properties.map(p => [p.id, p.name]));

    el.innerHTML = this.templates.map(t => {
      const items = t.items || [];
      return `
        <div class="card mb-2">
          <div class="card-body py-3">
            <div class="d-flex justify-content-between align-items-start">
              <div>
                <h6 class="mb-1">${t.name || "名称未設定"}</h6>
                <div class="text-muted small">
                  物件: ${t.propertyId ? propMap[t.propertyId] || "-" : "全物件共通"} / ${items.length}項目
                </div>
                <div class="mt-1">${items.slice(0, 5).map(i => `<span class="badge bg-light text-dark me-1 mb-1">${i.name}</span>`).join("")}${items.length > 5 ? `<span class="text-muted small">他${items.length - 5}件</span>` : ""}</div>
              </div>
              <div class="btn-group btn-group-sm">
                <button class="btn btn-outline-secondary" onclick="ChecklistPage.openTemplateModal('${t.id}')"><i class="bi bi-pencil"></i></button>
                <button class="btn btn-outline-danger" onclick="ChecklistPage.deleteTemplate('${t.id}')"><i class="bi bi-trash"></i></button>
              </div>
            </div>
          </div>
        </div>`;
    }).join("");
  },

  renderRecords() {
    const el = document.getElementById("recordList");
    const staffFilter = document.getElementById("recordFilterStaff").value;
    let filtered = this.records;
    if (staffFilter) filtered = filtered.filter(r => r.staffId === staffFilter);

    if (!filtered.length) {
      el.innerHTML = `<div class="empty-state"><i class="bi bi-clipboard"></i><p>清掃記録はありません</p></div>`;
      return;
    }

    const staffMap = Object.fromEntries(this.staffList.map(s => [s.id, s.name]));
    const propMap = Object.fromEntries(this.properties.map(p => [p.id, p.name]));

    el.innerHTML = filtered.map(r => {
      const items = r.items || [];
      const checked = items.filter(i => i.checked).length;
      const pct = items.length ? Math.round(checked / items.length * 100) : 0;
      const statusColor = r.status === "completed" ? "success" : "warning";
      const statusLabel = r.status === "completed" ? "完了" : "進行中";
      const hasPhoto = items.some(i => i.photoUrl);

      return `
        <div class="card mb-2 cursor-pointer" style="cursor:pointer" onclick="location.hash='#/my-checklist/${r.shiftId || r.id}'">
          <div class="card-body py-3">
            <div class="d-flex justify-content-between align-items-center">
              <div>
                <h6 class="mb-1">
                  ${staffMap[r.staffId] || "-"}
                  ${hasPhoto ? `<i class="bi bi-camera-fill text-primary ms-1" title="写真あり"></i>` : ""}
                </h6>
                <div class="text-muted small">
                  ${r.propertyId ? (propMap[r.propertyId] || "-") : "全物件共通"}
                </div>
                <div class="text-muted small">
                  ${r.completedAt ? "完了: " + formatDate(r.completedAt) : "進行中"}
                </div>
              </div>
              <div class="text-end">
                <span class="badge bg-${statusColor}">${statusLabel}</span>
                <div class="small mt-1">${checked}/${items.length} (${pct}%)</div>
              </div>
            </div>
            <div class="progress mt-2" style="height:4px">
              <div class="progress-bar bg-${statusColor}" style="width:${pct}%"></div>
            </div>
          </div>
        </div>`;
    }).join("");
  },

  openTemplateModal(editId = null) {
    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("templateModal"));
    document.getElementById("templateModalTitle").textContent = editId ? "テンプレート編集" : "テンプレート作成";
    document.getElementById("templateEditId").value = editId || "";
    document.getElementById("checkItemList").innerHTML = "";

    if (editId) {
      const t = this.templates.find(x => x.id === editId);
      if (t) {
        document.getElementById("templateName").value = t.name || "";
        document.getElementById("templatePropertyId").value = t.propertyId || "";
        (t.items || []).forEach(item => this.addCheckItem(item));
      }
    } else {
      document.getElementById("templateName").value = "";
      document.getElementById("templatePropertyId").value = "";
      // デフォルト項目
      ["玄関の清掃","リビング掃除機","キッチン清掃","バスルーム清掃","トイレ清掃","ベッドメイク","ゴミ回収","備品チェック"].forEach(name => {
        this.addCheckItem({ name, required: true, photoRequired: false });
      });
    }
    modal.show();
  },

  addCheckItem(data = {}) {
    const list = document.getElementById("checkItemList");
    const idx = list.children.length;
    const div = document.createElement("div");
    div.className = "d-flex align-items-center gap-2 mb-2";
    div.innerHTML = `
      <input type="text" class="form-control form-control-sm check-item-name" placeholder="項目名" value="${data.name || ""}">
      <div class="form-check"><input class="form-check-input check-item-required" type="checkbox" ${data.required !== false ? "checked" : ""}><label class="form-check-label small">必須</label></div>
      <div class="form-check"><input class="form-check-input check-item-photo" type="checkbox" ${data.photoRequired ? "checked" : ""}><label class="form-check-label small">写真</label></div>
      <button class="btn btn-sm btn-outline-danger" onclick="this.parentElement.remove()"><i class="bi bi-x"></i></button>
    `;
    list.appendChild(div);
  },

  async saveTemplate() {
    const name = document.getElementById("templateName").value.trim();
    if (!name) { showToast("エラー", "テンプレート名を入力してください", "error"); return; }

    const items = [];
    document.querySelectorAll("#checkItemList > div").forEach(row => {
      const itemName = row.querySelector(".check-item-name").value.trim();
      if (itemName) {
        items.push({
          name: itemName,
          required: row.querySelector(".check-item-required").checked,
          photoRequired: row.querySelector(".check-item-photo").checked,
        });
      }
    });

    const data = {
      name,
      propertyId: document.getElementById("templatePropertyId").value || null,
      items,
    };

    const editId = document.getElementById("templateEditId").value;
    if (editId) data.id = editId;

    try {
      await API.checklist.saveTemplate(data);
      showToast("成功", "テンプレートを保存しました", "success");
      bootstrap.Modal.getInstance(document.getElementById("templateModal")).hide();
      await this.loadData();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  async deleteTemplate(id) {
    if (!confirm("このテンプレートを削除しますか？")) return;
    try {
      await db.collection("checklistTemplates").doc(id).delete();
      showToast("成功", "テンプレートを削除しました", "success");
      await this.loadData();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },
};
