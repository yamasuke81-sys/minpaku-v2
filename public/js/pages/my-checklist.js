/**
 * スタッフ用 清掃チェックリスト画面 (v2 ツリー構造対応)
 * ルート: #/my-checklist/:shiftId
 *
 * 特徴:
 * - checklists/{checklistId} を shiftId で検索して onSnapshot 購読
 * - 複数スタッフが同時操作 → リアルタイムで相互反映
 * - 項目: ☑完了 + (supplyItem時) ☐要補充 + メモ
 * - 「誰が今編集中か」presence (editingBy) を表示
 * - 編集はデバウンス書き込み (500ms)
 */
const MyChecklistPage = {
  shiftId: null,
  checklistId: null,
  checklist: null,
  activeAreaId: null,
  unsubscribe: null,
  saveTimers: {},
  presenceTimer: null,
  editingField: null,

  async render(container, pathParams) {
    this.shiftId = (pathParams || [])[0];
    if (!this.shiftId) {
      container.innerHTML = `<div class="alert alert-danger">シフトIDが未指定です</div>`;
      return;
    }

    container.innerHTML = `
      <div class="d-flex align-items-center mb-3">
        <a href="#/my-dashboard" class="btn btn-sm btn-outline-secondary me-2">
          <i class="bi bi-arrow-left"></i>
        </a>
        <h5 class="mb-0 flex-grow-1" id="mclHeader">チェックリスト</h5>
        <span id="mclStatus" class="badge bg-secondary small"></span>
      </div>
      <div id="mclBody"><div class="text-center text-muted py-5"><div class="spinner-border"></div></div></div>
    `;

    await this.attach();
  },

  async attach() {
    const db = firebase.firestore();
    this.checklistId = await this.resolveChecklistId();
    if (!this.checklistId) {
      document.getElementById("mclBody").innerHTML = `
        <div class="alert alert-warning">
          このシフトのチェックリストがまだ作成されていません。<br>
          物件にチェックリストテンプレートが登録されているか確認してください。
        </div>
      `;
      return;
    }

    // リアルタイム購読
    this.unsubscribe = db.collection("checklists").doc(this.checklistId)
      .onSnapshot(snap => {
        if (!snap.exists) return;
        this.checklist = { id: snap.id, ...snap.data() };
        if (!this.activeAreaId && this.checklist.templateSnapshot?.length) {
          this.activeAreaId = this.checklist.templateSnapshot[0].id;
        }
        this.renderTree();
      }, err => {
        console.error("onSnapshot error:", err);
        document.getElementById("mclBody").innerHTML =
          `<div class="alert alert-danger">購読エラー: ${this.escapeHtml(err.message)}</div>`;
      });

    // 30秒ごとに presence を延命
    this.presenceTimer = setInterval(() => this.touchPresence(), 30000);

    // 離脱時クリーンアップ
    this._hashHandler = () => this.detach();
    window.addEventListener("hashchange", this._hashHandler, { once: true });
  },

  detach() {
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
    if (this.presenceTimer) { clearInterval(this.presenceTimer); this.presenceTimer = null; }
    this.clearEditingMark();
    this.checklistId = null;
    this.checklist = null;
    this.activeAreaId = null;
  },

  async resolveChecklistId() {
    const db = firebase.firestore();
    for (let i = 0; i < 3; i++) {
      const snap = await db.collection("checklists")
        .where("shiftId", "==", this.shiftId).limit(1).get();
      if (!snap.empty) return snap.docs[0].id;
      await new Promise(r => setTimeout(r, 1000));
    }
    return null;
  },

  renderTree() {
    const c = this.checklist;
    const areas = c.templateSnapshot || [];

    document.getElementById("mclHeader").textContent =
      `${c.propertyName || ""}  ${this.fmtDate(c.checkoutDate)}`;
    const totalItems = this.countItems(areas);
    const doneItems = this.countDone(areas, c.itemStates || {});
    const statusEl = document.getElementById("mclStatus");
    statusEl.textContent = `${doneItems}/${totalItems}`;
    statusEl.className = `badge ${totalItems > 0 && doneItems === totalItems ? "bg-success" : "bg-secondary"} small`;

    const body = document.getElementById("mclBody");
    const tabs = areas.map(a => `
      <li class="nav-item">
        <a class="nav-link ${a.id === this.activeAreaId ? "active" : ""}" href="#" data-area-id="${a.id}">
          ${this.escapeHtml(a.name)}
          <span class="badge bg-light text-dark ms-1">${this.countItemsDone(a, c.itemStates||{})}/${this.countItems([a])}</span>
        </a>
      </li>
    `).join("");

    body.innerHTML = `
      <ul class="nav nav-pills flex-nowrap overflow-auto pb-2 mb-3" style="white-space:nowrap;">
        ${tabs}
      </ul>
      <div id="mclAreaContent"></div>
    `;

    body.querySelectorAll("[data-area-id]").forEach(el => {
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        this.activeAreaId = el.dataset.areaId;
        this.renderTree();
      });
    });

    this.renderActiveArea();
  },

  renderActiveArea() {
    const areas = this.checklist.templateSnapshot || [];
    const area = areas.find(a => a.id === this.activeAreaId);
    if (!area) return;
    const el = document.getElementById("mclAreaContent");
    el.innerHTML = this.renderChildren(area);
    this.wireChildren(el);
  },

  renderChildren(parent) {
    const items = (parent.items || parent.directItems || []).map(it => ({ kind:"item", sortOrder: it.sortOrder||0, data: it }));
    const catField = parent.taskTypes ? "taskTypes"
                  : parent.subCategories ? "subCategories"
                  : parent.subSubCategories ? "subSubCategories"
                  : null;
    const cats = catField ? (parent[catField]||[]).map(c => ({ kind:"cat", sortOrder: c.sortOrder||0, data: c })) : [];
    const merged = [...items, ...cats].sort((a,b) => a.sortOrder - b.sortOrder);
    return `<div class="mcl-children">
      ${merged.map(m => m.kind === "item" ? this.renderItem(m.data) : this.renderCat(m.data)).join("")}
    </div>`;
  },

  renderItem(it) {
    const st = (this.checklist.itemStates || {})[it.id] || {};
    const checked = !!st.checked;
    const needsRestock = !!st.needsRestock;
    const note = st.note || "";
    const editingBy = st.editingBy;
    const othersEditing = editingBy && editingBy.uid && editingBy.uid !== this.myUid() &&
                          (Date.now() - (editingBy.at || 0) < 45000);

    return `
      <div class="mcl-item card mb-2 ${checked ? 'bg-success bg-opacity-10' : ''}" data-item-id="${it.id}">
        <div class="card-body p-2">
          <div class="form-check">
            <input class="form-check-input mcl-check" type="checkbox" id="chk-${it.id}" ${checked ? "checked" : ""}>
            <label class="form-check-label" for="chk-${it.id}">
              ${this.escapeHtml(it.name)}
              ${it.memo ? `<div class="small text-muted">${this.escapeHtml(it.memo)}</div>` : ""}
            </label>
          </div>
          ${it.supplyItem ? `
            <div class="form-check ms-4 mt-1">
              <input class="form-check-input mcl-restock" type="checkbox" id="sup-${it.id}" ${needsRestock ? "checked" : ""}>
              <label class="form-check-label text-warning" for="sup-${it.id}">
                <i class="bi bi-exclamation-triangle"></i> 要補充
              </label>
            </div>
          ` : ""}
          <textarea class="form-control form-control-sm mcl-note mt-2"
                    rows="1" placeholder="メモ（任意）"
                    data-item-id="${it.id}">${this.escapeHtml(note)}</textarea>
          ${othersEditing ? `<div class="small text-info mt-1"><i class="bi bi-person"></i> ${this.escapeHtml(editingBy.name||"他のスタッフ")}が編集中...</div>` : ""}
          ${st.checkedBy ? `<div class="small text-muted mt-1">✓ ${this.escapeHtml(st.checkedBy.name||"")} ${this.fmtTime(st.checkedAt)}</div>` : ""}
        </div>
      </div>
    `;
  },

  renderCat(cat) {
    const collapseId = `c-${cat.id}`;
    const st = this.checklist.itemStates || {};
    const done = this.countItemsDone(cat, st);
    const tot = this.countItems([cat]);
    const allDone = tot > 0 && done === tot;
    return `
      <div class="mcl-cat accordion mb-2" data-cat-id="${cat.id}">
        <div class="accordion-item">
          <h2 class="accordion-header">
            <button class="accordion-button ${allDone ? 'bg-success bg-opacity-10' : ''} collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#${collapseId}">
              ${this.escapeHtml(cat.name)}
              <span class="badge ${allDone ? 'bg-success' : 'bg-secondary'} ms-2">${done}/${tot}</span>
            </button>
          </h2>
          <div id="${collapseId}" class="accordion-collapse collapse">
            <div class="accordion-body p-2">
              ${this.renderChildren(cat)}
            </div>
          </div>
        </div>
      </div>
    `;
  },

  wireChildren(el) {
    el.querySelectorAll(".mcl-check").forEach(cb => {
      cb.addEventListener("change", () => {
        const itemId = cb.closest("[data-item-id]").dataset.itemId;
        this.updateItemState(itemId, { checked: cb.checked });
      });
    });
    el.querySelectorAll(".mcl-restock").forEach(cb => {
      cb.addEventListener("change", () => {
        const itemId = cb.closest("[data-item-id]").dataset.itemId;
        this.updateItemState(itemId, { needsRestock: cb.checked });
      });
    });
    el.querySelectorAll(".mcl-note").forEach(ta => {
      ta.addEventListener("focus", () => this.markEditing(ta.dataset.itemId, "note"));
      ta.addEventListener("input", () => {
        const itemId = ta.dataset.itemId;
        clearTimeout(this.saveTimers[itemId]);
        this.saveTimers[itemId] = setTimeout(() => {
          this.updateItemState(itemId, { note: ta.value });
        }, 500);
      });
      ta.addEventListener("blur", () => {
        const itemId = ta.dataset.itemId;
        clearTimeout(this.saveTimers[itemId]);
        this.updateItemState(itemId, { note: ta.value });
        this.clearEditingMark();
      });
    });
  },

  async updateItemState(itemId, patch) {
    const db = firebase.firestore();
    const me = this.myIdentity();
    const prev = (this.checklist.itemStates || {})[itemId] || {};
    const next = { ...prev, ...patch, editingBy: null };
    if ("checked" in patch) {
      if (patch.checked) {
        next.checkedBy = me;
        next.checkedAt = firebase.firestore.FieldValue.serverTimestamp();
      } else {
        next.checkedBy = null;
        next.checkedAt = null;
      }
    }

    // 楽観更新
    this.checklist.itemStates = this.checklist.itemStates || {};
    this.checklist.itemStates[itemId] = next;

    try {
      await db.collection("checklists").doc(this.checklistId).update({
        [`itemStates.${itemId}`]: next,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) {
      console.error("updateItemState error:", e);
      if (typeof showToast === "function") showToast("保存失敗", e.message || "", "error");
    }
  },

  async markEditing(itemId, field) {
    this.editingField = { itemId, field };
    if (!this.checklistId) return;
    const db = firebase.firestore();
    try {
      await db.collection("checklists").doc(this.checklistId).update({
        [`itemStates.${itemId}.editingBy`]: { ...this.myIdentity(), at: Date.now(), field }
      });
    } catch (e) { /* ignore */ }
  },

  async clearEditingMark() {
    const prev = this.editingField;
    this.editingField = null;
    if (!prev || !this.checklistId) return;
    const db = firebase.firestore();
    try {
      await db.collection("checklists").doc(this.checklistId).update({
        [`itemStates.${prev.itemId}.editingBy`]: null
      });
    } catch (e) { /* ignore */ }
  },

  async touchPresence() {
    if (!this.editingField || !this.checklistId) return;
    const db = firebase.firestore();
    try {
      await db.collection("checklists").doc(this.checklistId).update({
        [`itemStates.${this.editingField.itemId}.editingBy`]: { ...this.myIdentity(), at: Date.now(), field: this.editingField.field }
      });
    } catch (e) { /* ignore */ }
  },

  myIdentity() {
    const user = Auth?.currentUser || {};
    return { uid: user.uid || "", name: user.displayName || user.email || "スタッフ" };
  },
  myUid() { return Auth?.currentUser?.uid || ""; },

  countItems(nodes) {
    let n = 0;
    const walk = (arr) => arr.forEach(node => {
      n += (node.directItems || []).length + (node.items || []).length;
      (node.taskTypes || []).forEach(c => walk([c]));
      (node.subCategories || []).forEach(c => walk([c]));
      (node.subSubCategories || []).forEach(c => walk([c]));
    });
    walk(nodes);
    return n;
  },
  countDone(nodes, states) {
    let n = 0;
    const walk = (arr) => arr.forEach(node => {
      const items = [...(node.directItems||[]), ...(node.items||[])];
      items.forEach(it => { if (states[it.id]?.checked) n++; });
      (node.taskTypes || []).forEach(c => walk([c]));
      (node.subCategories || []).forEach(c => walk([c]));
      (node.subSubCategories || []).forEach(c => walk([c]));
    });
    walk(nodes);
    return n;
  },
  countItemsDone(node, states) { return this.countDone([node], states); },

  fmtDate(d) {
    if (!d) return "";
    if (typeof d === "string") return d;
    const dt = d.toDate ? d.toDate() : new Date(d);
    const days = ["日","月","火","水","木","金","土"];
    return `${dt.getFullYear()}/${dt.getMonth()+1}/${dt.getDate()}(${days[dt.getDay()]})`;
  },
  fmtTime(t) {
    if (!t) return "";
    const dt = t.toDate ? t.toDate() : new Date(t);
    return `${String(dt.getHours()).padStart(2,"0")}:${String(dt.getMinutes()).padStart(2,"0")}`;
  },

  escapeHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }
};
