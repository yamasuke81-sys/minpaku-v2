/**
 * オーナー用 チェックリスト管理ページ (#/checklist)
 *
 * 構成:
 *  A. 上部: マスタ編集エリア (物件選択 + マスタを開く + 他物件からインポート)
 *  B. 下部: 全物件のチェックリスト履歴・予定一覧 (my-checklist の履歴 UI を流用)
 *
 * スタッフからのアクセスは #/my-checklist にリダイレクト。
 */
const ChecklistPage = {
  properties: [],       // 民泊物件 (番号付き)
  templates: {},        // propertyId → checklistTemplates ドキュメント
  listData: [],         // checklists 全件 (民泊のみ)
  listInitialScrollDone: false,
  propVisibility: {},

  async render(container) {
    // 権限チェック: スタッフならマイ画面へリダイレクト
    if (typeof Auth !== "undefined" && Auth.currentUser) {
      const isOwner = Auth.isOwner && Auth.isOwner();
      const isSubOwner = Auth.isSubOwner && Auth.isSubOwner();
      if (!isOwner && !isSubOwner) {
        location.hash = "#/my-checklist";
        return;
      }
    }

    container.innerHTML = `
      <div class="page-header">
        <h2 class="mb-0"><i class="bi bi-clipboard-check"></i> チェックリスト管理</h2>
      </div>

      <!-- A. マスタ編集エリア -->
      <div class="card mb-3">
        <div class="card-body">
          <h6 class="card-title mb-3"><i class="bi bi-pencil-square"></i> チェックリストマスタ編集</h6>
          <div class="d-flex flex-wrap gap-2 align-items-center">
            <select class="form-select" id="chkPropSelect" style="max-width:320px;">
              <option value="">-- 物件を選択 --</option>
            </select>
            <button class="btn btn-primary" id="chkBtnOpenMaster" disabled>
              <i class="bi bi-clipboard2-pulse"></i> マスタを開く
            </button>
            <button class="btn btn-outline-secondary" id="chkBtnImport" disabled>
              <i class="bi bi-box-arrow-in-down"></i> 他物件からインポート
            </button>
            <span class="ms-2 small text-muted" id="chkMasterStatus"></span>
          </div>
        </div>
      </div>

      <hr class="my-3">

      <!-- B. 履歴・予定一覧 -->
      <div class="d-flex align-items-center mb-2">
        <h5 class="mb-0 flex-grow-1"><i class="bi bi-list-ul"></i> 全物件のチェックリスト履歴・予定</h5>
        <button class="btn btn-sm btn-outline-primary" id="chkListToday">
          <i class="bi bi-calendar-day"></i> 今日
        </button>
      </div>
      <div class="d-flex gap-2 flex-wrap mb-3 align-items-center">
        <label class="small text-muted mb-0">ソート:</label>
        <select class="form-select form-select-sm" id="chkListSort" style="max-width:180px;">
          <option value="date-desc">日付 (新しい順)</option>
          <option value="date-asc">日付 (古い順)</option>
          <option value="property">物件ごと</option>
          <option value="status">状態 (未完了 → 完了)</option>
        </select>
        <div class="form-check ms-2">
          <input class="form-check-input" type="checkbox" id="chkListShowPast">
          <label class="form-check-label small" for="chkListShowPast">完了済も表示</label>
        </div>
      </div>
      <div id="chkPropFilterBar" class="d-flex flex-wrap gap-1 mb-3"></div>
      <div id="chkListBody"><div class="text-center text-muted py-5"><div class="spinner-border"></div></div></div>

      <!-- インポートモーダル -->
      <div class="modal fade" id="chkImportModal" tabindex="-1">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-box-arrow-in-down"></i> 他物件からインポート</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="mb-2 small text-muted">
                コピー元の物件のマスタを、現在選択中の物件 <strong id="chkImportTargetName"></strong> にコピーします。
              </div>
              <label class="form-label small">コピー元の物件</label>
              <select class="form-select" id="chkImportSourceSelect">
                <option value="">-- コピー元を選択 --</option>
              </select>
              <div class="alert alert-warning small mt-3 d-none" id="chkImportWarning">
                <i class="bi bi-exclamation-triangle"></i> コピー先には既にマスタがあります。実行すると上書きされます。
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">キャンセル</button>
              <button type="button" class="btn btn-primary" id="chkImportRun">
                <i class="bi bi-check2"></i> インポート実行
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    await this.loadAll();
    this.bindEvents();
  },

  async loadAll() {
    const db = firebase.firestore();
    try {
      const [props, tmplSnap, clSnap] = await Promise.all([
        API.properties.listMinpakuNumbered(),
        db.collection("checklistTemplates").get(),
        db.collection("checklists").get(),
      ]);
      this.properties = props || [];
      // impersonation 中: サブオーナー所有物件のみに絞り込み (マスタ編集+履歴一覧ともに)
      if (typeof App !== "undefined" && App.impersonating && App.impersonatingData) {
        const owned = App.impersonatingData.ownedPropertyIds || [];
        this.properties = this.properties.filter(p => owned.includes(p.id));
      }
      this.templates = {};
      tmplSnap.docs.forEach(d => { this.templates[d.id] = d.data(); });

      // 民泊物件のみのチェックリスト
      const allowedIds = new Set(this.properties.map(p => p.id));
      this.listData = clSnap.docs.map(d => ({ id: d.id, ...d.data() })).map(c => {
        let ds = "";
        const co = c.checkoutDate;
        if (co) {
          if (typeof co === "string") ds = co.slice(0, 10);
          else if (co.toDate) ds = co.toDate().toLocaleDateString("sv-SE");
          else if (co instanceof Date) ds = co.toLocaleDateString("sv-SE");
        }
        return { ...c, _dateStr: ds };
      }).filter(c => c._dateStr && allowedIds.has(c.propertyId));

      this.populatePropSelect();
      this.initPropFilterBar();
      this.restoreListPrefs();
      this.renderListBody();
      this.listInitialScrollDone = false;
    } catch (e) {
      console.error("[checklist] loadAll error", e);
      const body = document.getElementById("chkListBody");
      if (body) body.innerHTML = `<div class="alert alert-danger">読み込みエラー: ${this.esc(e.message)}</div>`;
    }
  },

  populatePropSelect() {
    const sel = document.getElementById("chkPropSelect");
    if (!sel) return;
    sel.innerHTML = `<option value="">-- 物件を選択 --</option>` + this.properties.map(p => {
      const num = p._num != null ? p._num : (p.propertyNumber != null ? p.propertyNumber : "");
      const label = num !== "" ? `${num}  ${p.name || ""}` : (p.name || "");
      return `<option value="${this.escAttr(p.id)}">${this.esc(label)}</option>`;
    }).join("");
  },

  initPropFilterBar() {
    const key = "chkPropVisibility_owner";
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(key) || "{}"); } catch (_) {}
    this.propVisibility = {};
    this.properties.forEach(p => { this.propVisibility[p.id] = stored[p.id] !== false; });

    const render = () => {
      const bar = document.getElementById("chkPropFilterBar");
      if (!bar) return;
      bar.innerHTML = this.properties.map(p => {
        const visible = this.propVisibility[p.id] !== false;
        const icon = visible ? "bi-eye" : "bi-eye-slash";
        const opacity = visible ? "1" : "0.35";
        const color = p._color || p.color || "#6c757d";
        const num = p._num != null ? p._num : (p.propertyNumber != null ? p.propertyNumber : "");
        const name = this.esc((p.name || "").slice(0, 10));
        return `
          <button type="button" class="chk-prop-vis-toggle" data-prop-id="${this.escAttr(p.id)}"
            style="border:1px solid #ced4da;background:#fff;border-radius:6px;padding:3px 8px;display:inline-flex;align-items:center;gap:4px;cursor:pointer;opacity:${opacity};">
            <i class="bi ${icon}"></i>
            <span class="badge" style="background:${color};color:#fff;">${this.esc(String(num))}</span>
            ${name}
          </button>`;
      }).join("");
      bar.querySelectorAll(".chk-prop-vis-toggle").forEach(btn => {
        btn.addEventListener("click", () => {
          const pid = btn.getAttribute("data-prop-id");
          this.propVisibility[pid] = !this.propVisibility[pid];
          try { localStorage.setItem(key, JSON.stringify(this.propVisibility)); } catch (_) {}
          render();
          this.renderListBody();
        });
      });
    };
    render();
  },

  restoreListPrefs() {
    const lsKey = "chkList_owner";
    try {
      const stored = JSON.parse(localStorage.getItem(lsKey) || "{}");
      if (stored.sort) document.getElementById("chkListSort").value = stored.sort;
      if (stored.showPast === true) document.getElementById("chkListShowPast").checked = true;
    } catch (_) {}
  },

  persistListPrefs() {
    try {
      localStorage.setItem("chkList_owner", JSON.stringify({
        sort: document.getElementById("chkListSort").value,
        showPast: document.getElementById("chkListShowPast").checked,
      }));
    } catch (_) {}
  },

  bindEvents() {
    const sel = document.getElementById("chkPropSelect");
    const btnOpen = document.getElementById("chkBtnOpenMaster");
    const btnImport = document.getElementById("chkBtnImport");
    const status = document.getElementById("chkMasterStatus");

    sel.addEventListener("change", () => {
      const pid = sel.value;
      btnOpen.disabled = !pid;
      btnImport.disabled = !pid;
      if (!pid) { status.textContent = ""; return; }
      const tmpl = this.templates[pid];
      if (tmpl) {
        const cnt = this.countTemplateItems(tmpl.areas || []);
        status.textContent = `マスタ登録済 (${cnt}項目)`;
        status.className = "ms-2 small text-success";
      } else {
        status.textContent = "マスタ未作成 — 開くと新規作成できます";
        status.className = "ms-2 small text-warning";
      }
    });

    btnOpen.addEventListener("click", () => {
      const pid = sel.value;
      if (!pid) return;
      location.hash = `#/property-checklist/${pid}`;
    });

    btnImport.addEventListener("click", () => this.openImportModal());
    document.getElementById("chkImportRun").addEventListener("click", () => this.runImport());

    document.getElementById("chkListSort").addEventListener("change", () => { this.persistListPrefs(); this.renderListBody(); });
    document.getElementById("chkListShowPast").addEventListener("change", () => { this.persistListPrefs(); this.renderListBody(); });
    document.getElementById("chkListToday").addEventListener("click", () => this.jumpToToday());
  },

  countTemplateItems(areas) {
    let n = 0;
    const walk = (node) => {
      (node.items || []).forEach(() => n++);
      (node.directItems || []).forEach(() => n++);
      (node.taskTypes || []).forEach(walk);
      (node.subCategories || []).forEach(walk);
      (node.subSubCategories || []).forEach(walk);
    };
    (areas || []).forEach(walk);
    return n;
  },

  openImportModal() {
    const targetPid = document.getElementById("chkPropSelect").value;
    if (!targetPid) return;
    const target = this.properties.find(p => p.id === targetPid);
    document.getElementById("chkImportTargetName").textContent = target ? (target.name || "") : "";

    // 既存マスタ警告
    const warn = document.getElementById("chkImportWarning");
    if (this.templates[targetPid]) warn.classList.remove("d-none");
    else warn.classList.add("d-none");

    // コピー元候補 = 自分以外でマスタがある物件
    const srcSel = document.getElementById("chkImportSourceSelect");
    const candidates = this.properties.filter(p => p.id !== targetPid && this.templates[p.id]);
    if (!candidates.length) {
      srcSel.innerHTML = `<option value="">-- 他にマスタがある物件がありません --</option>`;
    } else {
      srcSel.innerHTML = `<option value="">-- コピー元を選択 --</option>` + candidates.map(p => {
        const num = p._num != null ? p._num : (p.propertyNumber != null ? p.propertyNumber : "");
        const label = num !== "" ? `${num}  ${p.name || ""}` : (p.name || "");
        const cnt = this.countTemplateItems((this.templates[p.id] || {}).areas || []);
        return `<option value="${this.escAttr(p.id)}">${this.esc(label)} (${cnt}項目)</option>`;
      }).join("");
    }
    srcSel.value = "";

    bootstrap.Modal.getOrCreateInstance(document.getElementById("chkImportModal")).show();
  },

  async runImport() {
    const targetPid = document.getElementById("chkPropSelect").value;
    const sourcePid = document.getElementById("chkImportSourceSelect").value;
    if (!targetPid || !sourcePid) {
      showToast("入力エラー", "コピー元を選択してください", "warning");
      return;
    }

    // 上書き確認
    if (this.templates[targetPid]) {
      const ok = window.showConfirm
        ? await window.showConfirm("選択中の物件のマスタを上書きします。よろしいですか?", "マスタ上書き確認")
        : true;
      if (!ok) return;
    }

    const btn = document.getElementById("chkImportRun");
    btn.disabled = true;
    try {
      await API.checklist.copyTemplate(targetPid, "template", sourcePid);
      showToast("成功", "マスタをコピーしました", "success");
      bootstrap.Modal.getInstance(document.getElementById("chkImportModal")).hide();
      await this.loadAll();
      // 選択を維持
      document.getElementById("chkPropSelect").value = targetPid;
      document.getElementById("chkPropSelect").dispatchEvent(new Event("change"));
    } catch (e) {
      console.error("[checklist] import error", e);
      showToast("エラー", e.message || "インポートに失敗しました", "error");
    } finally {
      btn.disabled = false;
    }
  },

  // ===== 履歴一覧描画 (my-checklist から流用) =====
  renderListBody() {
    const body = document.getElementById("chkListBody");
    if (!body) return;
    const showPast = document.getElementById("chkListShowPast").checked;
    const sortMode = document.getElementById("chkListSort").value || "date-desc";
    const today = new Date().toLocaleDateString("sv-SE");

    const vis = this.propVisibility || {};
    const hiddenIds = new Set(Object.entries(vis).filter(([, v]) => v === false).map(([k]) => k));
    let items = (this.listData || []).filter(c => !hiddenIds.has(c.propertyId));
    if (!showPast) {
      items = items.filter(c => c._dateStr >= today || c.status !== "completed");
    }

    if (!items.length) {
      body.innerHTML = `<div class="alert alert-secondary text-center">該当するチェックリストはありません</div>`;
      return;
    }

    items.forEach(c => {
      c._total = this.countListItems(c.templateSnapshot || []);
      c._done = this.countListDone(c.templateSnapshot || [], c.itemStates || {});
      c._isCompleted = c.status === "completed";
      c._isAllDone = c._total > 0 && c._done === c._total;
    });

    const propMeta = {};
    (this.properties || []).forEach(p => {
      const num = p._num != null ? p._num : (p.propertyNumber != null ? p.propertyNumber : "");
      propMeta[p.id] = { num, color: p._color || p.color || "#6c757d" };
    });

    const card = (c, opts = {}) => {
      const pct = c._total > 0 ? Math.round(c._done / c._total * 100) : 0;
      const statusBadge = c._isCompleted
        ? `<span class="badge bg-success">完了</span>`
        : (c._isAllDone ? `<span class="badge bg-info">全項目済</span>` : `<span class="badge bg-warning text-dark">進行中</span>`);
      const dateLabel = (typeof formatDateFull === "function") ? formatDateFull(c._dateStr) : c._dateStr;
      const dateHtml = opts.showDate
        ? `<span class="small ${c._dateStr === today ? 'text-primary fw-bold' : (c._dateStr < today ? 'text-muted' : '')}">${this.esc(dateLabel)}${c._dateStr === today ? ' (今日)' : ''}</span>`
        : "";
      const meta = propMeta[c.propertyId] || {};
      const numBadge = meta.num !== undefined && meta.num !== ""
        ? `<span class="badge me-1" style="background:${meta.color};color:#fff;min-width:22px;">${this.esc(String(meta.num))}</span>`
        : "";
      const propHtml = opts.showProp
        ? `${numBadge}<strong>${this.esc(c.propertyName || "(物件不明)")}</strong>`
        : "";
      return `
        <a href="#/my-checklist/${this.escAttr(c.shiftId || "")}" class="list-group-item list-group-item-action" data-checklist-id="${this.escAttr(c.id)}" data-date="${this.escAttr(c._dateStr)}">
          <div class="d-flex align-items-center gap-2 flex-wrap">
            ${dateHtml}
            ${propHtml}
            ${statusBadge}
            <span class="text-muted small ms-auto">${c._done}/${c._total} (${pct}%)</span>
          </div>
        </a>`;
    };

    let rows = "";
    if (sortMode === "date-desc" || sortMode === "date-asc") {
      items.sort((a, b) => sortMode === "date-desc"
        ? b._dateStr.localeCompare(a._dateStr)
        : a._dateStr.localeCompare(b._dateStr));
      rows = `<div class="list-group">${items.map(c => card(c, { showDate: true, showProp: true })).join("")}</div>`;
    } else if (sortMode === "property") {
      const byProp = {};
      items.forEach(c => {
        const key = c.propertyId || "";
        (byProp[key] = byProp[key] || { name: c.propertyName || "(物件不明)", items: [] }).items.push(c);
      });
      const keys = Object.keys(byProp).sort((a, b) => byProp[a].name.localeCompare(byProp[b].name));
      rows = keys.map(k => {
        const grp = byProp[k];
        grp.items.sort((a, b) => b._dateStr.localeCompare(a._dateStr));
        const cards = grp.items.map(c => card(c, { showDate: true })).join("");
        return `
          <div class="mb-3" data-prop-block="${this.escAttr(k)}">
            <div class="fw-bold mb-1"><i class="bi bi-building"></i> ${this.esc(grp.name)}</div>
            <div class="list-group">${cards}</div>
          </div>`;
      }).join("");
    } else if (sortMode === "status") {
      const pending = items.filter(c => !c._isCompleted).sort((a, b) => b._dateStr.localeCompare(a._dateStr));
      const done = items.filter(c => c._isCompleted).sort((a, b) => b._dateStr.localeCompare(a._dateStr));
      const block = (title, arr, color) => arr.length ? `
        <div class="mb-3">
          <div class="fw-bold mb-1" style="color:${color};">${title} <span class="badge bg-secondary ms-1">${arr.length}</span></div>
          <div class="list-group">${arr.map(c => card(c, { showDate: true, showProp: true })).join("")}</div>
        </div>` : "";
      rows = block("未完了", pending, "#fd7e14") + block("完了", done, "#198754");
    }

    body.innerHTML = rows;

    if (!this.listInitialScrollDone) {
      this.listInitialScrollDone = true;
      this.scrollToNearestPending(items, today);
    }
  },

  scrollToNearestPending(items, today) {
    const pending = items.filter(c => !c._isCompleted);
    if (!pending.length) return;
    const future = pending.filter(c => c._dateStr >= today).sort((a, b) => a._dateStr.localeCompare(b._dateStr));
    const past = pending.filter(c => c._dateStr < today).sort((a, b) => b._dateStr.localeCompare(a._dateStr));
    const target = future[0] || past[0];
    if (!target) return;
    const el = document.querySelector(`[data-checklist-id="${target.id}"]`);
    if (el) {
      setTimeout(() => {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.style.transition = "background 0.3s";
        el.style.background = "#e7f1ff";
        setTimeout(() => { el.style.background = ""; }, 1500);
      }, 50);
    }
  },

  jumpToToday() {
    const today = new Date().toLocaleDateString("sv-SE");
    const vis = this.propVisibility || {};
    const hiddenIds = new Set(Object.entries(vis).filter(([, v]) => v === false).map(([k]) => k));
    const todays = (this.listData || []).filter(c => c._dateStr === today && !hiddenIds.has(c.propertyId));
    if (todays.length === 0) {
      showToast("本日の清掃予定なし", "今日は清掃の予定が登録されていません。", "info");
      return;
    }
    if (todays.length === 1) {
      location.hash = `#/my-checklist/${todays[0].shiftId}`;
      return;
    }
    showToast("本日の清掃予定", `${todays.length}件あります。`, "info");
    // 最初のカードへスクロール
    const first = document.querySelector(`[data-date="${today}"]`);
    if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
  },

  countListItems(areas) {
    let n = 0;
    const walk = (node) => {
      (node.items || []).forEach(() => n++);
      (node.directItems || []).forEach(() => n++);
      (node.taskTypes || []).forEach(walk);
      (node.subCategories || []).forEach(walk);
      (node.subSubCategories || []).forEach(walk);
    };
    (areas || []).forEach(walk);
    return n;
  },

  countListDone(areas, states) {
    let n = 0;
    const walk = (node) => {
      (node.items || []).forEach(it => { if (states[it.id]?.checked) n++; });
      (node.directItems || []).forEach(it => { if (states[it.id]?.checked) n++; });
      (node.taskTypes || []).forEach(walk);
      (node.subCategories || []).forEach(walk);
      (node.subSubCategories || []).forEach(walk);
    };
    (areas || []).forEach(walk);
    return n;
  },

  esc(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  },

  escAttr(s) {
    return this.esc(s);
  },
};
