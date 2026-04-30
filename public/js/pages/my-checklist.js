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
  // 上位タブ: schedule / checklist / photos / laundry / restock
  activeTopTab: "schedule",
  unsubscribe: null,
  saveTimers: {},
  presenceTimer: null,
  editingField: null,
  // キャッシュ: 次回予約・本日のシフトスタッフ
  _nextBooking: null,
  _todayStaffNames: [],

  async render(container, pathParams) {
    this.shiftId = (pathParams || [])[0];
    // shiftId なし → 一覧モード (今後・過去の全チェックリスト)
    if (!this.shiftId) {
      await this.renderList(container);
      return;
    }

    // .app-main の上下 padding を無効化 (チェックリスト画面はヘッダー fixed のため不要)
    document.body.classList.add("mcl-shift-active");
    container.innerHTML = `
      <div class="mcl-page-header" style="position:fixed;top:0;z-index:29;background:#fff;padding:8px 12px;box-shadow:0 1px 0 #eee;">
        <div class="d-flex align-items-center">
          <a href="#/my-checklist" class="btn btn-sm btn-outline-secondary me-2" title="一覧に戻る">
            <i class="bi bi-arrow-left"></i>
          </a>
          <h6 class="mb-0 flex-grow-1" id="mclHeader" style="display:flex;align-items:center;min-width:0;font-size:14px;">チェックリスト</h6>
          <span id="mclStatus" style="display:none;"></span>
        </div>
      </div>
      <div class="mcl-page-header-spacer"></div>
      <div id="mclBody"><div class="text-center text-muted py-5"><div class="spinner-border"></div></div></div>
    `;
    // ヘッダー位置合わせ (.app-main の left/width を反映)
    this._applyHeaderLayout();
    this._headerResizeHandler = () => this._applyHeaderLayout();
    window.addEventListener("resize", this._headerResizeHandler, { passive: true });

    await this.attach();
  },

  // ヘッダー HTML: 「日付 [#番号] 物件名」 (日付フル表示優先、物件名は番号付きで見切れ可)
  _buildHeaderHtml(c) {
    const dateStr = this.fmtDate(c.checkoutDate);
    const propName = c.propertyName || "";
    const meta = this._propertyMeta || {};
    const numBadge = meta.number
      ? `<span class="badge" style="background:${meta.color || "#6c757d"};color:#fff;min-width:22px;font-size:11px;">#${this.escapeHtml(String(meta.number))}</span>`
      : "";
    return `<span style="white-space:nowrap;flex-shrink:0;margin-right:8px;">${this.escapeHtml(dateStr)}</span>`
      + `<span style="display:inline-flex;align-items:center;gap:4px;overflow:hidden;text-overflow:ellipsis;min-width:0;">${numBadge}<span style="overflow:hidden;text-overflow:ellipsis;">${this.escapeHtml(propName)}</span></span>`;
  },

  _applyHeaderLayout() {
    const header = document.querySelector(".mcl-page-header");
    if (!header) return;
    const mainEl = document.querySelector(".app-main");
    const rect = mainEl ? mainEl.getBoundingClientRect() : { left: 0, width: window.innerWidth };
    header.style.left = rect.left + "px";
    header.style.width = rect.width + "px";
    const topbar = document.querySelector(".app-topbar");
    const topbarH = topbar ? topbar.getBoundingClientRect().height : 0;
    header.style.top = topbarH + "px";
    // fixed 化後の実レイアウト高さで spacer 計算
    requestAnimationFrame(() => {
      const headerH = header.getBoundingClientRect().height;
      // 上位タブ + 大カテゴリタブ (表示中のみ) の高さを合算
      const topTabsWrap = document.querySelector(".mcl-tabs-wrap");
      const topTabsH = topTabsWrap ? topTabsWrap.getBoundingClientRect().height : 0;
      const areaTabsWrap = document.querySelector(".mcl-area-tabs-wrap");
      const areaTabsH = (areaTabsWrap && areaTabsWrap.style.display !== "none")
        ? areaTabsWrap.getBoundingClientRect().height : 0;
      const spacer = document.querySelector(".mcl-page-header-spacer");
      // spacer は flow 内 (= topbar の後ろから start)、topbarH は二重計上になるので除外
      if (spacer) spacer.style.height = Math.max(0, headerH + topTabsH + areaTabsH) + "px";
    });
  },

  // ===== 一覧モード =====
  async renderList(container) {
    container.innerHTML = `
      <div class="page-header" style="position:sticky;top:0;z-index:20;background:#fff;padding:12px 0;margin:-12px 0 12px 0;border-bottom:1px solid #dee2e6;">
        <h2 class="mb-0"><i class="bi bi-clipboard-check"></i> チェックリスト履歴・予定</h2>
        <div class="d-flex gap-2 align-items-center">
          <button class="btn btn-sm btn-outline-primary" id="mclListToday">
            <i class="bi bi-calendar-day"></i> 今日
          </button>
        </div>
      </div>
      <div class="d-flex gap-2 flex-wrap mb-3 align-items-center">
        <label class="small text-muted mb-0">ソート:</label>
        <select class="form-select form-select-sm" id="mclListSort" style="max-width:180px;">
          <option value="date-desc">日付 (新しい順)</option>
          <option value="date-asc">日付 (古い順)</option>
          <option value="property">物件ごと</option>
          <option value="status">状態 (未完了 → 完了)</option>
        </select>
        <div class="form-check ms-2">
          <input class="form-check-input" type="checkbox" id="mclListShowPast">
          <label class="form-check-label small" for="mclListShowPast">完了済も表示</label>
        </div>
      </div>
      <div id="mclPropFilterBar" class="d-flex flex-wrap gap-1 mb-3"></div>
      <div id="mclListBody"><div class="text-center text-muted py-5"><div class="spinner-border"></div></div></div>
    `;

    const db = firebase.firestore();
    try {
      const [clSnap, propSnap] = await Promise.all([
        db.collection("checklists").get(),
        API.properties && API.properties.listMinpakuNumbered
          ? API.properties.listMinpakuNumbered()
          : db.collection("properties").where("active","==",true).get().then(s => s.docs.map(d => ({ id:d.id, ...d.data() }))),
      ]);
      const rawList = clSnap.docs.map(d => ({ id: d.id, ...d.data() })).map(c => {
        // checkoutDate は Timestamp / Date / "YYYY-MM-DD" のいずれか
        let ds = "";
        const co = c.checkoutDate;
        if (co) {
          if (typeof co === "string") ds = co.slice(0, 10);
          else if (co.toDate) ds = co.toDate().toLocaleDateString("sv-SE");
          else if (co instanceof Date) ds = co.toLocaleDateString("sv-SE");
        }
        return { ...c, _dateStr: ds };
      }).filter(c => c._dateStr);

      // 担当物件フィルタ: ロール問わず staff ドキュメントの assignedPropertyIds (物件オーナーは
      // ownedPropertyIds も考慮) で絞り込む。設定が無い場合のみフォールバックで全民泊物件を表示。
      let filteredProps = propSnap;
      try {
        const staffId = this._effectiveStaffId() || this.staffId;
        if (staffId) {
          const sd = await db.collection("staff").doc(staffId).get();
          if (sd.exists) {
            this.staffDoc = { id: sd.id, ...sd.data() };
            const sData = sd.data();
            const assigned = Array.isArray(sData.assignedPropertyIds) ? sData.assignedPropertyIds : [];
            const owned = Array.isArray(sData.ownedPropertyIds) ? sData.ownedPropertyIds : [];
            const myIds = [...new Set([...assigned, ...owned])];
            if (myIds.length > 0) {
              filteredProps = propSnap.filter(p => myIds.includes(p.id));
            }
          }
        }
      } catch (e) {
        console.warn("[my-checklist] assignedPropertyIds 取得失敗", e);
      }
      this._listProps = filteredProps;

      // 担当物件 (filteredProps) に含まれる checklists のみ _listData に保持
      const allowedIds = new Set((filteredProps || []).map(p => p.id));
      this._listData = rawList.filter(c => allowedIds.has(c.propertyId));

      // 物件ドロップダウンは目アイコン型フィルターに置き換えたため不要

      // 物件フィルター UI (目アイコン型トグル) - localStorage 永続化
      const visKey = `mclPropVisibility_${this.staffId || "anon"}`;
      let storedVis = {};
      try { storedVis = JSON.parse(localStorage.getItem(visKey) || "{}"); } catch (_) { storedVis = {}; }
      this._mclPropVisibility = {};
      filteredProps.forEach(p => {
        this._mclPropVisibility[p.id] = storedVis[p.id] !== false; // 既定 true
      });
      const renderPropFilterBar = () => {
        const bar = document.getElementById("mclPropFilterBar");
        if (!bar) return;
        bar.innerHTML = filteredProps.map(p => {
          const visible = this._mclPropVisibility[p.id] !== false;
          const icon = visible ? "bi-eye" : "bi-eye-slash";
          const opacity = visible ? "1" : "0.35";
          const color = p._color || "#6c757d";
          const num = p._num || "";
          const name = this.escapeHtml((p.name || "").slice(0, 10));
          return `
            <button type="button" class="prop-vis-toggle" data-prop-id="${p.id}"
              style="border:1px solid #ced4da;background:#fff;border-radius:6px;padding:3px 8px;display:inline-flex;align-items:center;gap:4px;cursor:pointer;opacity:${opacity};">
              <i class="bi ${icon}"></i>
              <span class="badge" style="background:${color};color:#fff;">${this.escapeHtml(String(num))}</span>
              ${name}
            </button>`;
        }).join("");
        bar.querySelectorAll(".prop-vis-toggle").forEach(btn => {
          btn.addEventListener("click", () => {
            const pid2 = btn.getAttribute("data-prop-id");
            this._mclPropVisibility[pid2] = !this._mclPropVisibility[pid2];
            try { localStorage.setItem(visKey, JSON.stringify(this._mclPropVisibility)); } catch (_) {}
            renderPropFilterBar();
            this._renderListBody();
          });
        });
      };
      this._renderMclPropFilterBar = renderPropFilterBar;
      renderPropFilterBar();

      // 端末ごとの設定を localStorage から復元 (staffId 別 key)
      // 物件プルダウン (propId) は廃止、目アイコン型フィルターの状態は別 key で管理されている
      const lsKey = `mclList_${this.staffId || "anon"}`;
      try {
        const stored = JSON.parse(localStorage.getItem(lsKey) || "{}");
        if (stored.sort) document.getElementById("mclListSort").value = stored.sort;
        if (stored.showPast === true) document.getElementById("mclListShowPast").checked = true;
      } catch (_) { /* ignore */ }

      const persist = () => {
        try {
          localStorage.setItem(lsKey, JSON.stringify({
            sort: document.getElementById("mclListSort").value,
            showPast: document.getElementById("mclListShowPast").checked,
          }));
        } catch (_) { /* ignore */ }
      };

      const refresh = () => { persist(); this._renderListBody(); };
      document.getElementById("mclListShowPast").addEventListener("change", refresh);
      document.getElementById("mclListSort").addEventListener("change", refresh);
      document.getElementById("mclListToday").addEventListener("click", () => this._jumpToToday());

      this._listInitialScrollDone = false;
      this._renderListBody();
    } catch (e) {
      document.getElementById("mclListBody").innerHTML =
        `<div class="alert alert-danger">読み込みエラー: ${this.escapeHtml(e.message)}</div>`;
    }
  },

  _renderListBody() {
    const body = document.getElementById("mclListBody");
    const pid = ""; // 単一物件選択ドロップダウンは廃止 (目アイコンフィルターに一本化)
    const showPast = document.getElementById("mclListShowPast").checked;
    const sortMode = document.getElementById("mclListSort").value || "date-desc";
    const today = new Date().toLocaleDateString("sv-SE");

    const vis = this._mclPropVisibility || {};
    const hiddenIds = new Set(Object.entries(vis).filter(([, v]) => v === false).map(([k]) => k));
    let items = (this._listData || []).filter(c => !hiddenIds.has(c.propertyId));
    if (pid) items = items.filter(c => c.propertyId === pid);
    if (!showPast) {
      // 既定: 今日以降 + 今日より前で未完了 (status != completed)
      items = items.filter(c => c._dateStr >= today || c.status !== "completed");
    }

    if (!items.length) {
      body.innerHTML = `<div class="alert alert-secondary text-center">該当するチェックリストはありません</div>`;
      return;
    }

    // 各 checklist にカウントを付与
    items.forEach(c => {
      c._total = this._countListItems(c.templateSnapshot || []);
      c._done = this._countListDone(c.templateSnapshot || [], c.itemStates || {});
      c._isCompleted = c.status === "completed";
      c._isAllDone = c._total > 0 && c._done === c._total;
    });

    // カード HTML 生成ヘルパ (日付は出し入れで切替)
    // 物件ID → 物件番号/色 マップ (_listProps から構築)
    const propMeta = {};
    (this._listProps || []).forEach(p => {
      const num = p._num != null ? p._num : (p.propertyNumber != null ? p.propertyNumber : "");
      propMeta[p.id] = { num, color: p._color || p.color || "#6c757d" };
    });

    const card = (c, opts = {}) => {
      const pct = c._total > 0 ? Math.round(c._done / c._total * 100) : 0;
      const statusBadge = c._isCompleted
        ? `<span class="badge bg-success">完了</span>`
        : (c._isAllDone ? `<span class="badge bg-info">全項目済</span>` : `<span class="badge bg-warning text-dark">進行中</span>`);
      // 日付は横カレンダー等と共通の「YYYY年M月D日(曜)」形式 (utils.js の formatDateFull)
      const dateLabel = (typeof formatDateFull === "function") ? formatDateFull(c._dateStr) : this.fmtDate(c._dateStr);
      const dateHtml = opts.showDate
        ? `<span class="small ${c._dateStr === today ? 'text-primary fw-bold' : (c._dateStr < today ? 'text-muted' : '')}">${this.escapeHtml(dateLabel)}${c._dateStr === today ? ' (今日)' : ''}</span>`
        : "";
      // 物件名の前に番号バッジ (横カレンダーと同じ見た目)
      const meta = propMeta[c.propertyId] || {};
      const numBadge = meta.num !== undefined && meta.num !== ""
        ? `<span class="badge me-1" style="background:${this.escapeAttr ? this.escapeAttr(meta.color) : meta.color};color:#fff;min-width:22px;">${this.escapeHtml(String(meta.num))}</span>`
        : "";
      const propHtml = opts.showProp
        ? `${numBadge}<strong>${this.escapeHtml(c.propertyName || "(物件不明)")}</strong>`
        : "";
      return `
        <a href="#/my-checklist/${c.shiftId}" class="list-group-item list-group-item-action" data-checklist-id="${c.id}" data-date="${c._dateStr}">
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
      // 日付でソートしたフラット 1 行リスト (日付+物件名+ステータスを横並び)
      items.sort((a, b) => sortMode === "date-desc"
        ? b._dateStr.localeCompare(a._dateStr)
        : a._dateStr.localeCompare(b._dateStr));
      rows = `<div class="list-group">${items.map(c => card(c, { showDate: true, showProp: true })).join("")}</div>`;
    } else if (sortMode === "property") {
      // 物件でグルーピング。各物件内は日付降順 (新しい順)
      const byProp = {};
      items.forEach(c => {
        const key = c.propertyId || "";
        (byProp[key] = byProp[key] || { name: c.propertyName || "(物件不明)", items: [] }).items.push(c);
      });
      // 物件名で昇順
      const keys = Object.keys(byProp).sort((a, b) => byProp[a].name.localeCompare(byProp[b].name));
      rows = keys.map(k => {
        const grp = byProp[k];
        grp.items.sort((a, b) => b._dateStr.localeCompare(a._dateStr));
        const cards = grp.items.map(c => card(c, { showDate: true })).join("");
        return `
          <div class="mb-3" data-prop-block="${k}">
            <div class="fw-bold mb-1"><i class="bi bi-building"></i> ${this.escapeHtml(grp.name)}</div>
            <div class="list-group">${cards}</div>
          </div>`;
      }).join("");
    } else if (sortMode === "status") {
      // 状態でグルーピング: 未完了 → 完了
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

    // 初回のみ: 今日に一番近い未完了へスクロール
    if (!this._listInitialScrollDone) {
      this._listInitialScrollDone = true;
      this._scrollToNearestPending(items, today);
    }
  },

  _scrollToNearestPending(items, today) {
    const pending = items.filter(c => !c._isCompleted);
    if (!pending.length) return;
    // 今日以降で最も近い未完了
    const future = pending.filter(c => c._dateStr >= today).sort((a, b) => a._dateStr.localeCompare(b._dateStr));
    // 過去なら一番近い (最大日付)
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

  _jumpToToday() {
    const today = new Date().toLocaleDateString("sv-SE");
    // 物件ドロップダウンは廃止、目アイコンの非表示状態を filter に反映
    const vis = this._mclPropVisibility || {};
    const hiddenIds = new Set(Object.entries(vis).filter(([, v]) => v === false).map(([k]) => k));
    const todays = (this._listData || []).filter(c => c._dateStr === today && !hiddenIds.has(c.propertyId));
    if (todays.length === 0) {
      showToast("本日の清掃予定なし", "今日は清掃の予定が登録されていません。", "info");
      return;
    }
    if (todays.length === 1) {
      // 1件のみ → そのチェックリストへ直接遷移
      location.hash = `#/my-checklist/${todays[0].shiftId}`;
      return;
    }
    // 複数件 → 物件選択メッセージ + 今日の日付ブロックへスクロール
    showToast("本日の清掃予定", `${todays.length}件あります。物件を選んでください。`, "info");
    const block = document.querySelector(`[data-date-block="${today}"]`);
    if (block) {
      block.scrollIntoView({ behavior: "smooth", block: "start" });
      block.style.transition = "background 0.3s";
      block.style.background = "#fff3cd";
      setTimeout(() => { block.style.background = ""; }, 1500);
    }
  },

  _countListItems(areas) {
    let n = 0;
    const walk = (node) => {
      (node.items || []).forEach(() => n++);
      (node.directItems || []).forEach(() => n++);
      (node.taskTypes || []).forEach(walk);
      (node.subCategories || []).forEach(walk);
      (node.subSubCategories || []).forEach(walk);
    };
    areas.forEach(walk);
    return n;
  },

  _countListDone(areas, states) {
    let n = 0;
    const walk = (node) => {
      (node.items || []).forEach(it => { if (states[it.id]?.checked) n++; });
      (node.directItems || []).forEach(it => { if (states[it.id]?.checked) n++; });
      (node.taskTypes || []).forEach(walk);
      (node.subCategories || []).forEach(walk);
      (node.subSubCategories || []).forEach(walk);
    };
    areas.forEach(walk);
    return n;
  },

  async attach() {
    const db = firebase.firestore();
    // viewAsStaff or 自分の staffDoc をロード (myIdentity / 書き込み identity 用)
    try {
      const sid = this._effectiveStaffId();
      if (sid) {
        const sd = await db.collection("staff").doc(sid).get();
        if (sd.exists) this.staffDoc = { id: sd.id, ...sd.data() };
      }
    } catch (_) {}
    this.checklistId = await this.resolveChecklistId();
    if (!this.checklistId) {
      // shift から propertyId を取得してテンプレ編集画面へのリンクを表示
      let propertyId = null;
      let propertyName = "";
      try {
        if (this.shiftId) {
          const sDoc = await db.collection("shifts").doc(this.shiftId).get();
          if (sDoc.exists) {
            propertyId = sDoc.data().propertyId || null;
            propertyName = sDoc.data().propertyName || "";
            if (propertyId && !propertyName) {
              const pDoc = await db.collection("properties").doc(propertyId).get();
              if (pDoc.exists) propertyName = pDoc.data().name || "";
            }
          }
        }
      } catch (_) { /* noop */ }

      const tmplLink = propertyId
        ? `<div class="mt-3"><a href="#/property-checklist/${propertyId}" class="btn btn-primary btn-sm">
             <i class="bi bi-pencil-square"></i> ${propertyName ? `「${this.escapeHtml(propertyName)}」の` : ""}チェックリストテンプレートを編集
           </a></div>`
        : `<div class="mt-3"><a href="#/properties" class="btn btn-outline-primary btn-sm">
             <i class="bi bi-building"></i> 物件管理画面へ
           </a></div>`;

      document.getElementById("mclBody").innerHTML = `
        <div class="alert alert-warning">
          このシフトのチェックリストがまだ作成されていません。<br>
          物件にチェックリストテンプレートが登録されているか確認してください。
          ${tmplLink}
        </div>
      `;
      return;
    }

    // 物件の cleaningFlow と提出先マスターをキャッシュ (renderFooter で使用)
    try {
      const firstSnap = await db.collection("checklists").doc(this.checklistId).get();
      const pid = firstSnap.exists ? firstSnap.data().propertyId : null;
      if (pid) {
        const p = await db.collection("properties").doc(pid).get();
        this._propertyCleaningFlow = (p.exists && p.data().cleaningFlow) || {};
        this._propertyMeta = p.exists
          ? { number: p.data().propertyNumber || "", color: p.data().color || "#6c757d" }
          : { number: "", color: "#6c757d" };
      }
      const d = await db.collection("settings").doc("laundryDepots").get();
      this._depotMasterCache = (d.exists && Array.isArray(d.data().items)) ? d.data().items : [];
    } catch (_) {}

    // リアルタイム購読 (差分更新で微振動回避)
    this.unsubscribe = db.collection("checklists").doc(this.checklistId)
      .onSnapshot(snap => {
        if (!snap.exists) return;
        const old = this.checklist;
        this.checklist = { id: snap.id, ...snap.data() };
        if (!this.activeAreaId && this.checklist.templateSnapshot?.length) {
          this.activeAreaId = this.checklist.templateSnapshot[0].id;
        }
        // templateSnapshot のタブ構造 (エリア数・各エリアID) が変わった場合のみ全体再構築
        // エリア数と ID 配列のみ比較し、itemStates 等の細かな変化では再構築しない
        // hasPendingWrites ガードを外し、ローカル即時反映を許可 (チェック操作での UX 向上)
        const oldIds = (old?.templateSnapshot || []).map(a => a.id).join(",");
        const newIds = (this.checklist.templateSnapshot || []).map(a => a.id).join(",");
        const templateChanged = !old || oldIds !== newIds;
        if (templateChanged) {
          this.renderTree();
        } else {
          // 差分更新: スクロール位置を保持しながらバッジ・コンテンツ・タブスタイルを一括更新
          // requestAnimationFrame 1回にまとめて余分な reflow を最小化
          const prevScrollY = window.scrollY;
          const mainEl = document.querySelector(".app-main");
          const prevMainScroll = mainEl ? mainEl.scrollTop : 0;
          const savedActiveTopTab = this.activeTopTab;

          this._updateHeaderStatus();
          // バッジ更新 + アクティブタブコンテンツ再描画 + タブスタイル確定を 1 rAF にまとめる
          requestAnimationFrame(() => {
            this._updateTabBadges();
            this._renderActiveTopTab();
            if (this.activeTopTab !== savedActiveTopTab) {
              this.activeTopTab = savedActiveTopTab;
            }
            // スクロール位置を復元
            window.scrollTo({ top: prevScrollY, behavior: "instant" });
            if (mainEl) mainEl.scrollTop = prevMainScroll;
          });
        }
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
    if (this._headerResizeHandler) {
      window.removeEventListener("resize", this._headerResizeHandler);
      this._headerResizeHandler = null;
    }
    if (this._tabsResizeHandler) {
      window.removeEventListener("resize", this._tabsResizeHandler);
      this._tabsResizeHandler = null;
    }
    if (this._hashHandler) {
      window.removeEventListener("hashchange", this._hashHandler);
      this._hashHandler = null;
    }
    this.clearEditingMark();
    document.body.classList.remove("mcl-shift-active");
    this._debugShown = false;
    this.checklistId = null;
    this.checklist = null;
    this.activeAreaId = null;
    this.activeTopTab = "schedule";
    this._nextBooking = null;
    this._todayStaffNames = [];
    this._noteSelectedFiles = [];
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

    // 大カテゴリタブの横スクロール位置を保存
    const _prevBody = document.getElementById("mclBody");
    const _prevNav = _prevBody?.querySelector(".mcl-area-tabs-wrap .nav-pills");
    const _prevTabScroll = _prevNav?.scrollLeft || 0;

    document.getElementById("mclHeader").innerHTML = this._buildHeaderHtml(c);
    const totalItems = this.countItems(areas);
    const doneItems = this.countDone(areas, c.itemStates || {});
    const statusEl = document.getElementById("mclStatus");
    statusEl.textContent = `${doneItems}/${totalItems}`;
    statusEl.className = `badge ${totalItems > 0 && doneItems === totalItems ? "bg-success" : "bg-secondary"} small`;

    // 要補充件数バッジ用
    const restockCount = this._countRestockItems(areas, c.itemStates || {});

    const body = document.getElementById("mclBody");

    // 大カテゴリタブ HTML (清掃チェックリストタブ内でのみ表示)
    const areaTabs = areas.map(a => {
      const isActive = a.id === this.activeAreaId;
      const done = this.countItemsDone(a, c.itemStates || {});
      const total = this.countItems([a]);
      const allDone = total > 0 && done === total;
      const inProgress = done > 0 && done < total;
      const tabStyle = isActive
        ? 'background:#0d6efd !important;border:1px solid #0d6efd !important;color:#fff !important;'
        : (allDone
          ? 'background:#d1f5d6;border:1px solid #74c786;color:#0b5d24;'
          : (inProgress
            ? 'background:#fff3cd;border:1px solid #ffc107;color:#664d03;'
            : 'background:#f1f3f5;border:1px solid #ced4da;color:#495057;'));
      const badgeCls = isActive ? 'bg-light text-dark'
        : (allDone ? 'bg-success' : (inProgress ? 'bg-warning text-dark' : 'bg-secondary'));
      return `
        <li class="nav-item">
          <a class="nav-link ${isActive ? "active" : ""}" href="#" data-area-id="${a.id}"
             style="${tabStyle}font-weight:600;">
            ${this.escapeHtml(a.name)}
            <span class="badge ${badgeCls} ms-1">${done}/${total}</span>
          </a>
        </li>
      `;
    }).join("");

    // 上位タブ定義
    const topTabs = [
      { id: "schedule",  icon: "bi-calendar-event",  label: "次回予約情報" },
      { id: "checklist", icon: "bi-check2-square",   label: "清掃チェックリスト" },
      { id: "photos",    icon: "bi-camera",           label: "写真撮影" },
      { id: "laundry",   icon: "bi-basket3",          label: "ランドリー" },
      { id: "restock",   icon: "bi-box-seam",         label: "要補充リスト" },
    ];
    // アイコン大型タブ (等幅・アイコンのみ)
    const inactiveStyle = "flex:1;background:#fff;border:1px solid #dee2e6;color:#6c757d;padding:5px 0;border-radius:8px;font-size:22px;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s,border-color .15s;position:relative;";
    const activeStyle   = "flex:1;background:#2c3e50;border:1px solid #2c3e50;color:#fff;padding:5px 0;border-radius:8px;font-size:22px;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s,border-color .15s;position:relative;";
    const topTabsHtml = topTabs.map(t => {
      const isActive = t.id === this.activeTopTab;
      let badge = "";
      if (t.id === "restock" && restockCount > 0) {
        badge = `<span class="badge bg-warning text-dark" style="position:absolute;top:4px;right:4px;font-size:10px;">${restockCount}</span>`;
      }
      // checklist タブのカウンターは見出し側にあるので非表示
      return `<button type="button" class="mcl-top-tab" data-top-tab="${t.id}"
        title="${t.label}" style="${isActive ? activeStyle : inactiveStyle}">
        <i class="bi ${t.icon}"></i>${badge}
      </button>`;
    }).join("");

    body.innerHTML = `
      <div class="mcl-tabs-wrap" style="background:#fff;border-bottom:1px solid #dee2e6;padding:8px 8px 0;">
        <div style="display:flex;gap:6px;">
          ${topTabsHtml}
        </div>
      </div>
      <div id="mclChecklistTopComplete" class="px-2 pt-2" style="background:#fff;${this.activeTopTab === 'checklist' ? '' : 'display:none;'}"></div>
      <div class="mcl-area-tabs-wrap" style="background:#f8f9fa;border-bottom:1px solid #dee2e6;padding:4px 4px;${this.activeTopTab === 'checklist' ? '' : 'display:none;'}">
        <ul class="nav nav-pills flex-nowrap overflow-auto mb-0" style="white-space:nowrap;gap:8px;">
          ${areaTabs}
        </ul>
      </div>
      <div id="mclTopTabContent"></div>
    `;

    this._setupTopTabStickyObserver(body);
    requestAnimationFrame(() => this._applyHeaderLayout());

    // 大カテゴリタブの横スクロール位置を復元
    const _newNav = body.querySelector(".mcl-area-tabs-wrap .nav-pills");
    if (_newNav && _prevTabScroll) {
      _newNav.scrollLeft = _prevTabScroll;
    }

    // 上位タブのクリックイベント
    body.querySelectorAll(".mcl-top-tab").forEach(el => {
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        this.activeTopTab = el.dataset.topTab;
        this._updateTopTabStyles();
        this._renderActiveTopTab();
      });
    });

    // 大カテゴリタブのクリックイベント
    body.querySelectorAll("[data-area-id]").forEach(el => {
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        this.activeAreaId = el.dataset.areaId;
        this._updateAreaTabStyles();
        this.renderTabChecklist();
      });
    });

    this._renderActiveTopTab();
  },

  // 上位タブのスタイル更新
  _updateTopTabStyles() {
    const body = document.getElementById("mclBody");
    if (!body) return;
    const c = this.checklist;
    const areas = c?.templateSnapshot || [];
    const totalItems = this.countItems(areas);
    const doneItems = this.countDone(areas, c?.itemStates || {});
    const restockCount = this._countRestockItems(areas, c?.itemStates || {});

    const inactiveTabStyle = "flex:1;background:#fff;border:1px solid #dee2e6;color:#6c757d;padding:5px 0;border-radius:8px;font-size:22px;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s,border-color .15s;position:relative;";
    const activeTabStyle   = "flex:1;background:#2c3e50;border:1px solid #2c3e50;color:#fff;padding:5px 0;border-radius:8px;font-size:22px;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s,border-color .15s;position:relative;";
    body.querySelectorAll(".mcl-top-tab").forEach(n => {
      const tid = n.dataset.topTab;
      const isActive = tid === this.activeTopTab;
      // スタイルが変わっていない場合は setAttribute をスキップして不要な reflow を防ぐ
      const newStyle = isActive ? activeTabStyle : inactiveTabStyle;
      if (n.getAttribute("style") !== newStyle) n.setAttribute("style", newStyle);
      // バッジ更新
      let badge = n.querySelector(".badge");
      if (tid === "restock") {
        if (!badge) {
          badge = document.createElement("span");
          badge.style.cssText = "position:absolute;top:4px;right:4px;font-size:10px;";
          n.appendChild(badge);
        }
        if (restockCount > 0) {
          badge.className = "badge bg-warning text-dark";
          badge.textContent = restockCount;
          badge.style.display = "";
        } else {
          badge.style.display = "none";
        }
      } else if (tid === "checklist") {
        if (!badge) {
          badge = document.createElement("span");
          badge.style.cssText = "position:absolute;top:4px;right:4px;font-size:10px;";
          n.appendChild(badge);
        }
        badge.className = `badge ${isActive ? 'bg-light text-dark' : 'bg-secondary'}`;
        badge.textContent = `${doneItems}/${totalItems}`;
      }
    });

    // 大カテゴリタブの表示/非表示
    const areaTabsWrap = body.querySelector(".mcl-area-tabs-wrap");
    if (areaTabsWrap) {
      areaTabsWrap.style.display = this.activeTopTab === "checklist" ? "" : "none";
    }
    // 清掃完了ボタン上部スロットの表示/非表示 (チェックリストタブ時のみ)
    const completeTopSlot = document.getElementById("mclChecklistTopComplete");
    if (completeTopSlot) {
      completeTopSlot.style.display = this.activeTopTab === "checklist" ? "" : "none";
    }
    // spacer 再計算
    requestAnimationFrame(() => this._applyHeaderLayout());
  },

  // アクティブな上位タブのコンテンツを描画
  _renderActiveTopTab() {
    switch (this.activeTopTab) {
      case "schedule":  this.renderTabSchedule(); break;
      case "checklist": this.renderTabChecklist(); break;
      case "photos":    this.renderTabPhotos(); break;
      case "laundry":   this.renderTabLaundry(); break;
      case "restock":   this.renderTabRestock(); break;
    }
  },

  // ===== タブ1: 次回予約情報 =====
  async renderTabSchedule() {
    const el = document.getElementById("mclTopTabContent");
    if (!el) return;
    el.innerHTML = `<div class="text-center text-muted py-4"><div class="spinner-border spinner-border-sm"></div></div>`;

    try {
      const db = firebase.firestore();
      const c = this.checklist;
      if (!c) return;

      // 同 checkoutDate × 同 propertyId のシフトを取得して清掃スタッフ名を取得
      const checkoutDateStr = typeof c.checkoutDate === "string"
        ? c.checkoutDate.slice(0, 10)
        : (c.checkoutDate?.toDate ? c.checkoutDate.toDate().toLocaleDateString("sv-SE") : "");

      let staffNames = [];
      try {
        const shiftsSnap = await db.collection("shifts")
          .where("propertyId", "==", c.propertyId)
          .where("date", "==", c.checkoutDate)
          .get();
        const staffIds = new Set();
        shiftsSnap.docs.forEach(d => {
          const s = d.data();
          (s.staffIds || (s.staffId ? [s.staffId] : [])).forEach(id => staffIds.add(id));
        });
        if (staffIds.size > 0) {
          const staffSnaps = await Promise.all(
            Array.from(staffIds).map(id => db.collection("staff").doc(id).get())
          );
          staffNames = staffSnaps.filter(d => d.exists).map(d => d.data().name || "不明");
        }
      } catch (_) {}

      // Timestamp/Date/文字列を YYYY-MM-DD に正規化するヘルパ
      const toDateStr = (v) => {
        if (!v) return "";
        if (typeof v === "string") return v.length >= 10 ? v.slice(0, 10) : v;
        const d = v.toDate ? v.toDate() : (v instanceof Date ? v : new Date(v));
        if (isNaN(d.getTime())) return "";
        // JSTで日付取得（タイムゾーンずれ防止）
        const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
        return jst.toISOString().slice(0, 10);
      };

      const coDateStr = toDateStr(c.checkoutDate);

      // 次回予約を全件取得して in-memory フィルタ (Timestamp型不一致回避)
      let nextBooking = null;
      let nextGuest = {};
      let propDoc = {};
      try {
        const [bkSnap, grSnap, propSnap] = await Promise.all([
          db.collection("bookings").where("propertyId", "==", c.propertyId).get(),
          db.collection("guestRegistrations").where("propertyId", "==", c.propertyId).limit(60).get(),
          db.collection("properties").doc(c.propertyId).get(),
        ]);
        propDoc = propSnap.exists ? propSnap.data() : {};

        // 次の予約: 同物件 × 異なる bookingId × キャンセル除外 × CI >= checkoutDate で昇順先頭
        const allBookings = bkSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        nextBooking = allBookings
          .filter(nb => {
            if (nb.id === c.bookingId) return false;
            const s = String(nb.status || "").toLowerCase();
            if (s.includes("cancel") || nb.status === "キャンセル" || nb.status === "キャンセル済み") return false;
            const nbCi = toDateStr(nb.checkIn);
            return nbCi && coDateStr && nbCi >= coDateStr;
          })
          .sort((a, b) => {
            const aci = toDateStr(a.checkIn) || "";
            const bci = toDateStr(b.checkIn) || "";
            return aci < bci ? -1 : aci > bci ? 1 : 0;
          })[0] || null;

        // guestMap 構築: {propertyId}_{CI日} → 名簿データ
        const guestMap = {};
        grSnap.docs.forEach(d => {
          const g = d.data();
          const ci = toDateStr(g.checkIn);
          if (!ci) return;
          const key = g.propertyId ? `${g.propertyId}_${ci}` : ci;
          guestMap[key] = g;
        });

        if (nextBooking) {
          const nbCiStr = toDateStr(nextBooking.checkIn);
          const gk = nextBooking.propertyId && nbCiStr ? `${nextBooking.propertyId}_${nbCiStr}` : null;
          nextGuest = (gk && guestMap[gk]) || (nbCiStr && guestMap[nbCiStr]) || {};
        }
      } catch (_) {}

      this._nextBooking = nextBooking;
      this._todayStaffNames = staffNames;

      // チェックイン日付を「YYYY年M月D日(曜)」形式に整形
      const fmtDateFull = (v) => {
        if (!v) return "-";
        const dateStr = toDateStr(v);
        if (!dateStr) return "-";
        const [y, m, d] = dateStr.split("-").map(Number);
        const days = ["日","月","火","水","木","金","土"];
        const dow = days[new Date(y, m - 1, d).getDay()];
        return `${y}年${m}月${d}日(${dow})`;
      };

      const staffHtml = staffNames.length > 0
        ? `<div class="alert alert-info py-2 small mb-3"><i class="bi bi-person-check"></i> 本日の清掃担当: <strong>${staffNames.map(n => this.escapeHtml(n)).join("、")}</strong></div>`
        : "";

      // 宿泊者名簿の表示/非表示判定ヘルパ (dashboard.js と同一仕様)
      const fieldOverrides = (propDoc.formFieldConfig && propDoc.formFieldConfig.overrides) || {};
      const secCfg = propDoc.formSectionConfig || {};
      const useCustomForm = propDoc.customFormEnabled === true && Array.isArray(propDoc.customFormFields) && propDoc.customFormFields.length > 0;
      const customMap = {};
      if (useCustomForm) {
        propDoc.customFormFields.forEach(f => { if (f && f.id) customMap[f.id] = f; });
      }
      const FIXED_FIELD_IDS = new Set([
        "checkOut","checkOutTime","guestCount","guestCountInfants","bookingSite",
        "transport","taxiAgree","carCount","neighborAgree","paidParking",
        "bbq","bbqRule1","bbqRule2","bbqRule3","bbqRule4","bbqRule5","bedChoice",
        "purpose","previousStay","nextStay",
        "emergencyName","emergencyPhone",
        "noiseAgree","houseRuleAgree",
      ]);
      const isFieldVisible = (fieldId, sectionId) => {
        if (sectionId && secCfg[sectionId] && secCfg[sectionId].hidden === true) return false;
        if (sectionId && fieldId) {
          const fh = secCfg[sectionId] && secCfg[sectionId].fieldHidden;
          if (fh && fh[fieldId] === true) return false;
        }
        if (fieldId && fieldOverrides[fieldId] && fieldOverrides[fieldId].hidden === true) return false;
        if (useCustomForm && fieldId && !FIXED_FIELD_IDS.has(fieldId)) {
          const f = customMap[fieldId];
          if (!f) return false;
          if (f.hidden === true) return false;
        }
        return true;
      };

      // BBQ表示ヘルパ
      const vb = (val) => {
        if (val === true || val === "Yes" || val === "あり" || val === "◎") return "◎";
        if (val === false || val === "No" || val === "なし" || val === "×") return "×";
        return "-";
      };

      const propName = c.propertyName || "";
      const src = nextBooking ? (nextBooking.source || nextBooking.bookingSite || "") : "";
      const srcBadge = src.toLowerCase().includes("airbnb")
        ? '<span class="badge" style="background:#FF5A5F;color:#fff">Airbnb</span>'
        : src.toLowerCase().includes("booking")
          ? '<span class="badge" style="background:#003580;color:#fff">Booking.com</span>'
          : src ? `<span class="badge bg-secondary">${this.escapeHtml(src)}</span>` : "";
      // 物件名はヘッダーで表示済みなのでここでは非表示
      const propBadge = "";

      let nextHtml = "";
      if (nextBooking) {
        const nb = nextBooking;
        const nbCiDate = fmtDateFull(nb.checkIn);
        const ciDisplay = nextGuest.checkInTime
          ? `${nbCiDate} <strong>${this.escapeHtml(nextGuest.checkInTime)}</strong>`
          : nbCiDate;
        nextHtml = `
          <div class="card">
            <div class="card-body">
              <div class="d-flex align-items-center gap-2 mb-2 flex-wrap">
                <h6 class="card-title mb-0"><i class="bi bi-arrow-right-circle text-primary"></i> 次の予約</h6>
                ${propBadge}
                ${srcBadge}
              </div>
              <table class="table table-sm table-borderless mb-0">
                <tr><th class="text-muted" style="width:130px;">チェックイン</th><td>${ciDisplay}</td></tr>
                <tr><th class="text-muted">宿泊人数</th><td>${nb.guestCount ? this.escapeHtml(String(nb.guestCount)) + "名" : "-"}</td></tr>
                ${isFieldVisible("bbq", "facility") ? `<tr><th class="text-muted">BBQ</th><td>${vb(nextGuest.bbq)}</td></tr>` : ""}
                ${isFieldVisible("bedChoice", "facility") ? `<tr><th class="text-muted">ベッド数（2名宿泊時）</th><td>${nextGuest.bedChoice ? this.escapeHtml(String(nextGuest.bedChoice)) : "-"}</td></tr>` : ""}
                ${isFieldVisible("transport", "facility") ? `<tr><th class="text-muted">交通手段</th><td>${nextGuest.transport ? this.escapeHtml(nextGuest.transport) : "-"}</td></tr>` : ""}
                ${isFieldVisible("carCount", "facility") ? `<tr><th class="text-muted">車台数</th><td>${nextGuest.carCount ? this.escapeHtml(String(nextGuest.carCount)) + "台" : "-"}</td></tr>` : ""}
                ${isFieldVisible("paidParking", "facility") ? `<tr><th class="text-muted">有料駐車場</th><td>${nextGuest.paidParking ? this.escapeHtml(nextGuest.paidParking) : "-"}</td></tr>` : ""}
              </table>
            </div>
          </div>`;
      } else {
        nextHtml = `<div class="alert alert-secondary">次の予約はまだ入っていません</div>`;
      }

      if (!el.isConnected || this.activeTopTab !== "schedule") return;
      el.innerHTML = `
        <div class="pt-2">
          ${staffHtml}
          ${nextHtml}
        </div>`;
    } catch (e) {
      if (el.isConnected) {
        el.innerHTML = `<div class="alert alert-danger m-3">読み込みエラー: ${this.escapeHtml(e.message)}</div>`;
      }
    }
  },

  // ===== タブ2: 清掃チェックリスト =====
  renderTabChecklist() {
    const el = document.getElementById("mclTopTabContent");
    if (!el || !this.checklist) return;
    const areas = this.checklist.templateSnapshot || [];
    const area = areas.find(a => a.id === this.activeAreaId);
    if (!area) return;
    const states = this.checklist.itemStates || {};
    const total = this.countItems([area]);
    const done = this.countItemsDone(area, states);
    const allChecked = total > 0 && done === total;
    el.innerHTML = `
      <div id="mclAreaContent">
        <div class="d-flex gap-2 mb-1 mt-1 flex-wrap">
          <button type="button" class="btn btn-sm btn-outline-primary mcl-toggle-all-check" data-all-checked="${allChecked ? '1' : '0'}">
            <i class="bi bi-check2-square"></i> ${allChecked ? '全チェック外し' : '全チェック'}
          </button>
          <button type="button" class="btn btn-sm btn-outline-secondary mcl-toggle-all-expand">
            <i class="bi bi-arrows-expand"></i> 全展開/全折りたたみ
          </button>
          <span class="ms-auto small text-muted align-self-center">${done}/${total} チェック済</span>
        </div>
        ${this.renderChildren(area)}
      </div>
      <div id="mclChecklistNotes" class="mt-4 px-1"></div>
      <div id="mclFooter" class="mt-3 px-1"></div>
    `;
    this.wireChildren(el);
    el.querySelector(".mcl-toggle-all-check")?.addEventListener("click", () => this.toggleAllCheckInArea(area, allChecked));
    el.querySelector(".mcl-toggle-all-expand")?.addEventListener("click", () => this.toggleAllExpandInArea(el));

    this._renderChecklistNotes();
    this.renderFooter();
  },

  // ===== タブ3: 写真撮影 =====
  renderTabPhotos() {
    const el = document.getElementById("mclTopTabContent");
    if (!el || !this.checklist) return;
    el.innerHTML = `
      <div id="mclSamplePhotoSection" class="pt-2"></div>
      <div id="mclPhotoSection" class="pt-2"></div>
    `;
    this.renderSamplePhotoSection();
    this.renderPhotoSection();
  },

  // ===== 見本写真セクション (スタッフ用・読み取り専用) =====
  renderSamplePhotoSection() {
    const el = document.getElementById("mclSamplePhotoSection");
    if (!el || !this.checklist) return;
    const areas = this.checklist.templateSnapshot || [];

    // 全ノードから見本写真を再帰収集
    const allSamples = [];  // { label, url }[]
    const walk = (node, pathParts) => {
      // sampleImages 配列 (複数枚対応)
      const imgs = node.sampleImages || [];
      // 後方互換: sampleImageUrl が存在し sampleImages が空なら使用
      if (!imgs.length && node.sampleImageUrl) {
        allSamples.push({ label: pathParts.join(" › "), url: node.sampleImageUrl });
      }
      imgs.forEach(img => {
        allSamples.push({ label: pathParts.join(" › "), url: img.url });
      });
      // 再帰探索
      (node.taskTypes || []).forEach(tt => walk(tt, [...pathParts, tt.name]));
      (node.subCategories || []).forEach(sc => walk(sc, [...pathParts, sc.name]));
      (node.subSubCategories || []).forEach(ss => walk(ss, [...pathParts, ss.name]));
      // item の見本写真
      [...(node.directItems || []), ...(node.items || [])].forEach(it => {
        const itImgs = it.sampleImages || [];
        if (!itImgs.length && it.sampleImageUrl) {
          allSamples.push({ label: [...pathParts, it.name].join(" › "), url: it.sampleImageUrl });
        }
        itImgs.forEach(img => {
          allSamples.push({ label: [...pathParts, it.name].join(" › "), url: img.url });
        });
      });
    };
    areas.forEach(a => walk(a, [a.name]));

    if (!allSamples.length) {
      // 見本写真がない場合は何も表示しない
      el.innerHTML = "";
      return;
    }

    // グループ化: 同一ラベルをまとめる
    const grouped = [];
    for (const s of allSamples) {
      const last = grouped[grouped.length - 1];
      if (last && last.label === s.label) {
        last.urls.push(s.url);
      } else {
        grouped.push({ label: s.label, urls: [s.url] });
      }
    }

    const rows = grouped.map(g => {
      const thumbs = g.urls.map((u, i) => {
        const absIdx = allSamples.findIndex(s => s.url === u);
        return `
          <img src="${this.escapeHtml(u)}" alt="見本" loading="lazy"
               style="width:80px;height:80px;object-fit:cover;border-radius:6px;cursor:pointer;border:1px solid #dee2e6;"
               class="mcl-sample-thumb"
               data-sample-url="${this.escapeHtml(u)}"
               data-sample-label="${this.escapeHtml(g.label)}">
        `;
      }).join("");
      return `
        <div class="mb-2">
          <div class="small text-muted mb-1" style="font-size:11px;">${this.escapeHtml(g.label)}</div>
          <div class="d-flex flex-wrap gap-1">${thumbs}</div>
        </div>
      `;
    }).join("");

    el.innerHTML = `
      <div class="card mb-3">
        <div class="card-body pb-2">
          <h6 class="card-title mb-2">
            <i class="bi bi-camera"></i> 見本写真
            <span class="badge bg-secondary ms-1">${allSamples.length}</span>
          </h6>
          ${rows}
        </div>
      </div>
    `;

    // サムネイルタップ → ライトボックス
    el.querySelectorAll(".mcl-sample-thumb").forEach(img => {
      img.addEventListener("click", () => {
        // 全サムネイル URL リストを渡してスライドできるようにする
        const thumbs = Array.from(el.querySelectorAll(".mcl-sample-thumb"));
        const allUrls = thumbs.map(t => t.dataset.sampleUrl);
        const allLabels = thumbs.map(t => t.dataset.sampleLabel);
        const startIdx = thumbs.indexOf(img);
        this._openSampleLightbox(allUrls, allLabels, startIdx);
      });
    });
  },

  /**
   * 見本写真ライトボックス (複数枚スライド)
   * allUrls: string[]  全画像URL
   * allLabels: string[] 各画像のラベル
   * startIdx: 最初に表示するインデックス
   */
  _openSampleLightbox(allUrls, allLabels, startIdx) {
    const existing = document.getElementById("mclSampleLightbox");
    if (existing) existing.remove();

    let currentIdx = startIdx;
    const total = allUrls.length;

    const overlay = document.createElement("div");
    overlay.id = "mclSampleLightbox";
    overlay.style.cssText = [
      "position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9999;",
      "display:flex;flex-direction:column;align-items:center;justify-content:center;",
      "user-select:none;"
    ].join("");

    overlay.innerHTML = `
      <button id="mclSampleLbClose"
              style="position:absolute;top:12px;right:16px;background:none;border:none;color:#fff;font-size:2rem;line-height:1;cursor:pointer;">&times;</button>
      <div id="mclSampleLbLabel"
           style="color:#ccc;font-size:12px;margin-bottom:8px;max-width:90vw;text-align:center;"></div>
      <img id="mclSampleLbImg"
           style="max-width:95vw;max-height:75vh;border-radius:8px;object-fit:contain;">
      <div style="display:flex;align-items:center;gap:16px;margin-top:12px;">
        <button id="mclSampleLbPrev"
                style="background:rgba(255,255,255,0.15);border:none;color:#fff;font-size:1.6rem;border-radius:50%;width:44px;height:44px;cursor:pointer;display:flex;align-items:center;justify-content:center;">&lsaquo;</button>
        <span id="mclSampleLbCounter" style="color:#fff;font-size:13px;min-width:50px;text-align:center;"></span>
        <button id="mclSampleLbNext"
                style="background:rgba(255,255,255,0.15);border:none;color:#fff;font-size:1.6rem;border-radius:50%;width:44px;height:44px;cursor:pointer;display:flex;align-items:center;justify-content:center;">&rsaquo;</button>
      </div>
    `;

    document.body.appendChild(overlay);

    const imgEl      = document.getElementById("mclSampleLbImg");
    const labelEl    = document.getElementById("mclSampleLbLabel");
    const counterEl  = document.getElementById("mclSampleLbCounter");
    const prevBtn    = document.getElementById("mclSampleLbPrev");
    const nextBtn    = document.getElementById("mclSampleLbNext");
    const closeBtn   = document.getElementById("mclSampleLbClose");

    const showSlide = (idx) => {
      currentIdx = (idx + total) % total;
      imgEl.src = allUrls[currentIdx];
      labelEl.textContent = allLabels[currentIdx] || "";
      counterEl.textContent = `${currentIdx + 1} / ${total}`;
      // 1枚のみの場合は前後ボタンを薄く
      prevBtn.style.opacity = total > 1 ? "1" : "0.3";
      nextBtn.style.opacity = total > 1 ? "1" : "0.3";
    };

    showSlide(currentIdx);

    prevBtn.addEventListener("click", (e) => { e.stopPropagation(); showSlide(currentIdx - 1); });
    nextBtn.addEventListener("click", (e) => { e.stopPropagation(); showSlide(currentIdx + 1); });
    closeBtn.addEventListener("click", () => overlay.remove());

    // オーバーレイ背景タップで閉じる (ボタン以外)
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    // キーボード操作
    const onKey = (e) => {
      if (e.key === "ArrowLeft")  { showSlide(currentIdx - 1); }
      if (e.key === "ArrowRight") { showSlide(currentIdx + 1); }
      if (e.key === "Escape")     { overlay.remove(); document.removeEventListener("keydown", onKey); }
    };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("remove", () => document.removeEventListener("keydown", onKey));

    // タッチスワイプ
    let touchStartX = null;
    overlay.addEventListener("touchstart", (e) => {
      touchStartX = e.touches[0].clientX;
    }, { passive: true });
    overlay.addEventListener("touchend", (e) => {
      if (touchStartX === null) return;
      const deltaX = e.changedTouches[0].clientX - touchStartX;
      touchStartX = null;
      if (Math.abs(deltaX) < 40) return;
      if (deltaX < 0) showSlide(currentIdx + 1);  // 左スワイプ → 次
      else            showSlide(currentIdx - 1);  // 右スワイプ → 前
    }, { passive: true });
  },

  // ===== タブ4: ランドリー =====
  renderTabLaundry() {
    const el = document.getElementById("mclTopTabContent");
    if (!el || !this.checklist) return;
    el.innerHTML = `<div id="mclFooter" class="pt-2"></div>`;
    this.renderFooter();
  },

  // ===== タブ5: 要補充リスト =====
  renderTabRestock() {
    const el = document.getElementById("mclTopTabContent");
    if (!el || !this.checklist) return;
    const c = this.checklist;
    const areas = c.templateSnapshot || [];
    const states = c.itemStates || {};

    // supplyItem=true の全項目を収集 (物件内パス付き)
    const supplyItems = [];
    const walk = (node, path) => {
      const items = [...(node.directItems || []), ...(node.items || [])];
      items.forEach(it => {
        if (it.supplyItem) {
          supplyItems.push({ it, path: [...path, it.name] });
        }
      });
      (node.taskTypes || []).forEach(c => walk(c, [...path, c.name]));
      (node.subCategories || []).forEach(c => walk(c, [...path, c.name]));
      (node.subSubCategories || []).forEach(c => walk(c, [...path, c.name]));
    };
    areas.forEach(a => walk(a, [a.name]));

    if (!supplyItems.length) {
      el.innerHTML = `<div class="alert alert-secondary mt-2">要補充項目がありません</div>`;
      return;
    }

    const rows = supplyItems.map(({ it, path }) => {
      const checked = !!states[it.id]?.needsRestock;
      const pathStr = path.slice(0, -1).join(" &rsaquo; ");
      return `
        <div class="card mb-2 ${checked ? 'border-warning' : ''} restock-card" style="cursor:pointer;" data-restock-item-id="${it.id}">
          <div class="card-body py-2 px-3">
            <div class="d-flex align-items-center gap-2">
              <input class="form-check-input restock-tab-chk" type="checkbox" id="rst-${it.id}"
                     ${checked ? "checked" : ""} style="width:20px;height:20px;flex-shrink:0;pointer-events:none;">
              <div class="flex-grow-1">
                <div style="font-size:15px;">${this.escapeHtml(it.name)}</div>
                ${pathStr ? `<div class="small text-muted">${pathStr}</div>` : ""}
              </div>
            </div>
          </div>
        </div>`;
    }).join("");

    el.innerHTML = `
      <div class="pt-2">
        <div class="d-flex align-items-center mb-3 gap-2">
          <span class="fw-bold"><i class="bi bi-exclamation-triangle text-warning"></i> 要補充リスト</span>
          <span class="badge bg-secondary">${supplyItems.length}項目</span>
        </div>
        ${rows}
      </div>`;

    // カード全体タップでチェック状態をトグル (checkbox は pointer-events:none で視覚表示のみ)
    el.querySelectorAll(".restock-card").forEach(card => {
      card.addEventListener("click", () => {
        const itemId = card.dataset.restockItemId;
        const cb = card.querySelector(".restock-tab-chk");
        if (!cb) return;
        const newVal = !cb.checked;
        cb.checked = newVal;
        // ボーダー色もリアルタイムに切り替え
        card.classList.toggle("border-warning", newVal);
        this.updateItemState(itemId, { needsRestock: newVal });
      });
    });
  },

  // 要補充件数カウント
  _countRestockItems(areas, states) {
    let n = 0;
    const walk = (node) => {
      const items = [...(node.directItems || []), ...(node.items || [])];
      items.forEach(it => { if (it.supplyItem && states[it.id]?.needsRestock) n++; });
      (node.taskTypes || []).forEach(walk);
      (node.subCategories || []).forEach(walk);
      (node.subSubCategories || []).forEach(walk);
    };
    areas.forEach(walk);
    return n;
  },

  // ヘッダーの物件名・進捗バッジ更新 (body 再構築なし)
  _updateHeaderStatus() {
    const c = this.checklist;
    if (!c) return;
    const headerEl = document.getElementById("mclHeader");
    if (headerEl) headerEl.innerHTML = this._buildHeaderHtml(c);
    const total = this.countItems(c.templateSnapshot || []);
    const done = this.countDone(c.templateSnapshot || [], c.itemStates || {});
    const statusEl = document.getElementById("mclStatus");
    if (statusEl) {
      statusEl.textContent = `${done}/${total}`;
      statusEl.className = `badge ${total > 0 && done === total ? "bg-success" : "bg-secondary"} small`;
    }
  },

  // 上位タブバッジ + 大カテゴリタブバッジを更新 (DOM 再生成なし)
  _updateTabBadges() {
    this._updateTopTabStyles();
    this._updateAreaTabStyles();
  },

  // 大カテゴリタブのスタイル更新
  _updateAreaTabStyles() {
    const c = this.checklist;
    if (!c) return;
    const body = document.getElementById("mclBody");
    if (!body) return;
    const areas = c.templateSnapshot || [];
    body.querySelectorAll(".nav-link[data-area-id]").forEach(n => {
      const aid = n.dataset.areaId;
      const area = areas.find(a => a.id === aid);
      if (!area) return;
      const done = this.countItemsDone(area, c.itemStates || {});
      const total = this.countItems([area]);
      const allDone = total > 0 && done === total;
      const inProgress = done > 0 && done < total;
      // active クラスを activeAreaId と同期させる
      const isActive = aid === this.activeAreaId;
      n.classList.toggle("active", isActive);
      // active=青 / 完了=緑 / 進行中=黄 / 未着手=灰
      const newAreaStyle = isActive
        ? "background:#0d6efd !important;border:1px solid #0d6efd !important;color:#fff !important;font-weight:600;"
        : (allDone
          ? "background:#d1f5d6;border:1px solid #74c786;color:#0b5d24;font-weight:600;"
          : (inProgress
            ? "background:#fff3cd;border:1px solid #ffc107;color:#664d03;font-weight:600;"
            : "background:#f1f3f5;border:1px solid #ced4da;color:#495057;font-weight:600;"));
      if (n.getAttribute("style") !== newAreaStyle) n.setAttribute("style", newAreaStyle);
      const badge = n.querySelector(".badge");
      if (badge) {
        const badgeCls = isActive ? "bg-light text-dark"
          : (allDone ? "bg-success" : (inProgress ? "bg-warning text-dark" : "bg-secondary"));
        badge.className = `badge ${badgeCls} ms-1`;
        badge.textContent = `${done}/${total}`;
      }
    });
  },

  // 上位タブバー + 大カテゴリタブバーを fixed 化する
  _setupTopTabStickyObserver(body) {
    const topWrap = body.querySelector(".mcl-tabs-wrap");
    const areaWrap = body.querySelector(".mcl-area-tabs-wrap");
    if (!topWrap) return;

    const applyLayout = () => {
      const mainEl = document.querySelector(".app-main");
      const rect = mainEl ? mainEl.getBoundingClientRect() : { left: 0, width: window.innerWidth };
      const topbar = document.querySelector(".app-topbar");
      const topbarH = topbar ? topbar.getBoundingClientRect().height : 0;
      const header = document.querySelector(".mcl-page-header");
      const headerH = header ? header.getBoundingClientRect().height : 0;

      // 上位タブバーを固定
      topWrap.style.position = "fixed";
      topWrap.style.top = (topbarH + headerH) + "px";
      topWrap.style.left = rect.left + "px";
      topWrap.style.width = rect.width + "px";
      topWrap.style.zIndex = "28";
      topWrap.style.background = "#fff";
      topWrap.style.boxShadow = "0 1px 0 #dee2e6";

      // 大カテゴリタブバーを上位タブの真下に固定
      if (areaWrap) {
        areaWrap.style.position = "fixed";
        areaWrap.style.left = rect.left + "px";
        areaWrap.style.width = rect.width + "px";
        areaWrap.style.zIndex = "27";
        areaWrap.style.background = "#f8f9fa";
        areaWrap.style.boxShadow = "0 2px 6px rgba(0,0,0,0.06)";
      }

      requestAnimationFrame(() => {
        const topH = topWrap.getBoundingClientRect().height;
        const areaH = (areaWrap && areaWrap.style.display !== "none")
          ? areaWrap.getBoundingClientRect().height : 0;

        if (areaWrap) {
          areaWrap.style.top = (topbarH + headerH + topH) + "px";
        }

        const spacer = document.querySelector(".mcl-page-header-spacer");
        // spacer は flow 内 (= topbar の後ろから start)、topbarH は二重計上になるので除外
        if (spacer) spacer.style.height = Math.max(0, headerH + topH + areaH) + "px";
      });
    };

    if (this._tabsResizeHandler) window.removeEventListener("resize", this._tabsResizeHandler);
    this._tabsResizeHandler = applyLayout;
    window.addEventListener("resize", applyLayout, { passive: true });
    requestAnimationFrame(applyLayout);

    // アイコン大型タブは等幅・横スクロール不要のためスクロール処理なし
    // 大カテゴリタブクリック時にそのタブを左端へスクロール
    if (areaWrap) {
      const areaList = areaWrap.querySelector(".nav-pills");
      if (areaList) {
        areaWrap.querySelectorAll("[data-area-id]").forEach(el => {
          el.addEventListener("click", () => {
            setTimeout(() => {
              areaList.scrollTo({ left: Math.max(0, el.offsetLeft - 4), behavior: "smooth" });
            }, 0);
          });
        });
      }
    }
  },

  // ===== フッター: タブ2では清掃完了のみ / タブ4ではランドリーのみ =====
  renderFooter() {
    const el = document.getElementById("mclFooter");
    if (!el || !this.checklist) return;
    const c = this.checklist;
    const isCompleted = c.status === "completed";
    const total = this.countItems(c.templateSnapshot || []);
    const done = this.countDone(c.templateSnapshot || [], c.itemStates || {});
    const allDone = total > 0 && done === total;
    const laundry = c.laundry || {};
    const fmtTs = (ts) => {
      if (!ts) return "";
      const d = ts.toDate ? ts.toDate() : new Date(ts);
      return d.toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    };
    // laundry 値は {at, by} 形式。旧データ (Timestamp 直接) も互換対応
    const extractLaundry = (v) => {
      if (!v) return { active: false };
      if (v.at || v.by) return { active: true, ts: v.at, byName: v.by?.name || "" };
      // 旧形式: Timestamp
      return { active: true, ts: v, byName: "" };
    };
    const putOutInfo = extractLaundry(laundry.putOut);
    const collectedInfo = extractLaundry(laundry.collected);
    const storedInfo = extractLaundry(laundry.stored);
    // 順序強制: putOut → collected → stored の順でしか押せない
    // 取消しは「実施済ボタンを再度押す」ことで可能 (その後ろのアクションも連動して取消)
    // 清掃完了後でもランドリーは独立して記録/修正可能
    const laundryEnabled = {
      putOut: true,
      collected: collectedInfo.active || putOutInfo.active,
      stored: storedInfo.active || collectedInfo.active,
    };
    const lBtn = (key, label, icon, info) => {
      const enabled = laundryEnabled[key];
      // ランドリー実施済は 青(primary) で、清掃完了ボタンの 緑(success) と識別
      const cls = info.active ? 'btn-primary' : 'btn-outline-secondary';
      return `
        <button type="button" class="btn ${cls} mcl-laundry" data-key="${key}" ${enabled ? '' : 'disabled'} style="flex:1;min-width:140px;padding:10px;">
          <div><i class="bi ${icon}"></i> ${label}</div>
          ${info.active
            ? `<div class="small mt-1" style="opacity:0.9;">${fmtTs(info.ts)} 済${info.byName ? `<br>${this.escapeHtml(info.byName)}` : ""}</div>`
            : `<div class="small mt-1 text-muted">${enabled ? '未実施' : '前の手順が先'}</div>`}
        </button>`;
    };

    // 清掃フロー構成でランドリー提出先が空なら非表示
    const cf = this.checklist?.propertyCleaningFlow || this._propertyCleaningFlow || {};
    const laundryEnabledByFlow = Array.isArray(cf.laundryDepotIds) ? cf.laundryDepotIds.length > 0 : true;
    // 選択された提出先がすべて linen_shop kind なら回収/収納ボタンを非表示
    const allLinenShop = laundryEnabledByFlow && Array.isArray(cf.laundryDepotIds) && Array.isArray(this._depotMasterCache)
      ? cf.laundryDepotIds.every(id => {
          const d = this._depotMasterCache.find(x => (x.id || x.name) === id);
          return d && d.kind === "linen_shop";
        })
      : false;
    const laundrySection = !laundryEnabledByFlow ? "" : `
      <div class="card mb-3" id="laundrySection">
        <div class="card-body">
          <h6 class="card-title mb-1"><i class="bi bi-basket3"></i> ランドリー</h6>
          <div class="small text-muted mb-3">
            <i class="bi bi-info-circle"></i> チェックリストが途中でも、ランドリーは独立して記録できます。
            ${allLinenShop ? '<br><span class="text-primary">リネン屋利用の物件: 「出した」を押すと完了扱いになります。</span>' : ''}
          </div>
          <div class="d-flex gap-2 flex-wrap">
            ${lBtn('putOut', '① 洗濯物を出した', 'bi-arrow-up-circle', putOutInfo)}
            ${allLinenShop ? '' : lBtn('collected', '② 洗濯物を回収した', 'bi-arrow-down-circle', collectedInfo)}
            ${allLinenShop ? '' : lBtn('stored', '③ 洗濯物を収納した', 'bi-check2-circle', storedInfo)}
          </div>
        </div>
      </div>`;

    const completeSection = isCompleted
      ? `
        <div class="card" style="background:#0d6efd;border-color:#0d6efd;color:#fff;">
          <div class="card-body text-center">
            <i class="bi bi-check-circle-fill" style="font-size:2.4rem;color:#fff;"></i>
            <h5 class="mb-1 mt-2" style="color:#fff;">清掃完了済み</h5>
            <div class="small" style="color:rgba(255,255,255,0.9);">
              ${this.escapeHtml(c.completedBy?.name || "")} ${fmtTs(c.completedAt)}
            </div>
            <div class="mt-3 d-flex gap-2 justify-content-center flex-wrap">
              <a href="#/my-checklist" class="btn btn-sm btn-light">一覧へ戻る</a>
              <button type="button" class="btn btn-sm btn-outline-light" id="mclRevertBtn">
                <i class="bi bi-arrow-counterclockwise"></i> 未完了に戻す
              </button>
            </div>
          </div>
        </div>`
      : `
        <div class="card ${allDone ? 'border-success' : ''}">
          <div class="card-body p-2">
            ${allDone ? `
              <div class="alert alert-success py-2 small mb-2">
                <i class="bi bi-check-circle"></i> 全項目チェック済み (${done}/${total})。完了処理を行えます。
              </div>` : ''}
            <button type="button" class="btn btn-success btn-lg w-100" id="mclCompleteBtn">
              <i class="bi bi-check2-circle"></i> 清掃完了にする
            </button>
          </div>
        </div>`;

    // タブに応じて表示切替:
    //  - タブ2 (清掃チェックリスト) → 清掃完了ボタンを上部スロット (mclChecklistTopComplete) に表示
    //    大カテゴリタブの上に常時表示し、最下部までスクロールしなくてもアクセス可能にする
    //  - タブ4 (ランドリー) → mclFooter にランドリーのみ
    //  - 旧構造互換 (どちらも取れる場合) → 両方を mclFooter に
    const elTop = document.getElementById("mclChecklistTopComplete");
    if (this.activeTopTab === "laundry") {
      if (elTop) elTop.innerHTML = "";
      el.innerHTML = laundrySection || `<div class="alert alert-secondary">ランドリー設定がありません</div>`;
    } else if (this.activeTopTab === "checklist") {
      if (elTop) elTop.innerHTML = completeSection;
      el.innerHTML = "";
    } else {
      if (elTop) elTop.innerHTML = "";
      el.innerHTML = completeSection + laundrySection;
    }

    // #/my-laundry エイリアス経由のスクロール復元
    if (sessionStorage.getItem("pclScrollToLaundry") === "1") {
      sessionStorage.removeItem("pclScrollToLaundry");
      // ランドリータブへ切替してスクロール
      this.activeTopTab = "laundry";
      this._updateTopTabStyles();
      this.renderTabLaundry();
    }

    el.querySelectorAll('.mcl-laundry').forEach(b => {
      b.addEventListener('click', () => this.toggleLaundry(b.dataset.key));
    });
    document.getElementById('mclCompleteBtn')?.addEventListener('click', () => this.completeChecklist(allDone, total - done));
    document.getElementById('mclRevertBtn')?.addEventListener('click', () => this.revertChecklist());
  },

  async revertChecklist() {
    if (!this.checklistId) return;
    const ok = await showConfirm(
      "清掃完了を取消して「進行中」に戻しますか？\n既に送信された通知は取消されません。",
      { title: "未完了に戻す", okLabel: "戻す", okClass: "btn-warning" }
    );
    if (!ok) return;
    try {
      await firebase.firestore().collection("checklists").doc(this.checklistId).update({
        status: "in_progress",
        completedAt: null,
        completedBy: null,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      // シフトも completed 状態なら戻す
      const shiftId = this.checklist?.shiftId;
      if (shiftId) {
        try {
          await firebase.firestore().collection("shifts").doc(shiftId).update({
            status: "confirmed",
            completedAt: null,
          });
        } catch (e) { /* ignore: シフト側エラーは非致命 */ }
      }
      showToast("未完了に戻しました", "引き続きチェックや編集ができます", "success");
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  async toggleLaundry(key) {
    if (!this.checklistId) return;
    const current = (this.checklist?.laundry || {})[key];
    const user = firebase.auth().currentUser;
    const by = {
      uid: user?.uid || "",
      staffId: this.staffDoc?.id || "",
      name: this.staffDoc?.name || user?.displayName || "",
    };
    const patch = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    if (current) {
      // 解除権限: ボタンを押した本人 / Webアプリ管理者 / 物件オーナーのみ可
      const role = (Auth.currentUser && Auth.currentUser.role) || "staff";
      const isPrivileged = role === "owner" || role === "sub_owner";
      const isAuthor = current?.by?.uid && current.by.uid === user?.uid;
      if (!isAuthor && !isPrivileged) {
        showToast("解除不可", `この記録は「${current?.by?.name || "前のスタッフ"}」のものです。本人かWebアプリ管理者/物件オーナーのみ解除できます。`, "error");
        return;
      }
      // 取消: この key 以降 (putOut → collected → stored の順) も連動クリア
      const order = ["putOut", "collected", "stored"];
      const idx = order.indexOf(key);
      for (let i = idx; i < order.length; i++) {
        patch[`laundry.${order[i]}`] = null;
      }
    } else if (key === "putOut") {
      // 出した: 提出先/支払方法/金額を入力させる
      const info = await this.askLaundryPutOutInfo();
      if (info === null) return; // キャンセル
      patch[`laundry.${key}`] = {
        at: firebase.firestore.FieldValue.serverTimestamp(),
        by,
        depot: info.depot || "",
        depotOther: info.depotOther || "",
        depotKind: info.depotKind || "",
        paymentMethod: info.paymentMethod || "",
        prepaidId: info.prepaidId || "",
        prepaidLabel: info.prepaidLabel || "",
        rateLabel: info.rateLabel || "",
        amount: Number(info.amount) || 0,
        note: info.note || "",
      };
      // 物件の提出先がすべてリネン屋の場合のみ自動完了 (混在運用での誤動作を防ぐ)
      const cf = this._propertyCleaningFlow || {};
      const allLinen = Array.isArray(cf.laundryDepotIds) && Array.isArray(this._depotMasterCache)
        && cf.laundryDepotIds.length > 0
        && cf.laundryDepotIds.every(id => {
          const d = this._depotMasterCache.find(x => (x.id || x.name) === id);
          return d && d.kind === "linen_shop";
        });
      if (allLinen) {
        patch[`laundry.collected`] = { at: firebase.firestore.FieldValue.serverTimestamp(), by, auto: true, reason: "all_linen_shop" };
        patch[`laundry.stored`] = { at: firebase.firestore.FieldValue.serverTimestamp(), by, auto: true, reason: "all_linen_shop" };
      }
      // プリカ残高を自動減算 (複数プリカ対応) + 購入処理
      if (info.paymentMethod === "prepaid") {
        try {
          const doc = await firebase.firestore().collection("settings").doc("prepaidCards").get();
          const existing = doc.exists ? (doc.data().items || []) : [];
          const allocMap = {};
          (info.prepaidAllocations || []).forEach(a => { allocMap[a.cardId] = a.amount; });
          let items = existing.map(c => {
            if (allocMap[c.id]) {
              return { ...c, balance: Math.max(0, (Number(c.balance) || 0) - Number(allocMap[c.id])) };
            }
            return c;
          });
          // 購入フロー: 新規カード作成(チャージ残高 - 使用額 = 残高)
          if (info.prepaidPurchase) {
            const pp = info.prepaidPurchase;
            // チャージ額ルール (depotId+chargeAmount で店舗別) から実残高を計算
            const chargeRules = doc.exists ? (doc.data().chargeRules || []) : [];
            const resolveChargeBalance = (amount, depotId) => {
              // 1. depotId + chargeAmount 一致
              let r = chargeRules.find(x => Number(x.chargeAmount) === Number(amount) && (x.depotId || "") === (depotId || ""));
              if (r && r.balance) return Number(r.balance);
              // 2. 全店共通
              if (depotId) {
                r = chargeRules.find(x => Number(x.chargeAmount) === Number(amount) && !x.depotId);
                if (r && r.balance) return Number(r.balance);
              }
              // 3. 旧データ互換 (depotId フィールド無し)
              r = chargeRules.find(x => x.depotId === undefined && Number(x.chargeAmount) === Number(amount));
              if (r && r.balance) return Number(r.balance);
              return Number(amount) || 0;
            };
            const chargeBalance = resolveChargeBalance(pp.purchaseAmount, pp.depotId);
            const newBalance = Math.max(0, chargeBalance - (pp.useAmount || 0));
            const newId = "prepaid_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

            // カード番号自動採番: 店舗頭文字 + 3桁連番 (prepaid-cards.js のルールと整合)
            // 頭文字は「提出先名そのまま」を使用
            const depotPrefixes = (doc.exists && doc.data().depotPrefixes) || {};
            let prefix = depotPrefixes[pp.depotId] || "";
            if (!prefix && pp.depotId) {
              // depotMaster から提出先名そのままを頭文字として使用
              try {
                const depotSnap = await firebase.firestore().collection("settings").doc("laundryDepots").get();
                if (depotSnap.exists) {
                  const allDepots = depotSnap.data().items || [];
                  const depot = allDepots.find(d => (d.id || d.name) === pp.depotId);
                  if (depot && depot.name) prefix = depot.name.trim();
                }
              } catch (_) {}
            }
            if (!prefix) prefix = "CARD";
            // 2. 同 depotId 配下の既存カードから最大連番を取得して +1
            const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d{3})$`);
            let max = 0;
            items.forEach(c => {
              if (c.depotId !== pp.depotId) return;
              const m = (c.cardNumber || "").match(pattern);
              if (m) max = Math.max(max, parseInt(m[1], 10));
            });
            // 既存の cardNumber 手入力があればそれを優先、無ければ自動採番
            const autoCardNumber = `${prefix}${String(max + 1).padStart(3, "0")}`;
            const finalCardNumber = pp.cardNumber || autoCardNumber;

            // 店舗頭文字を depotPrefixes にキャッシュ (次回以降も使える)
            this._pendingDepotPrefixes = { ...depotPrefixes };
            if (pp.depotId && !this._pendingDepotPrefixes[pp.depotId]) {
              this._pendingDepotPrefixes[pp.depotId] = prefix;
            }

            items.push({
              id: newId,
              cardNumber: finalCardNumber,
              balance: newBalance,
              depotId: pp.depotId || "",
              propertyIds: this.checklist?.propertyId ? [this.checklist.propertyId] : [],
              memo: `${(this.staffDoc?.name || "スタッフ")}が購入 (立替 ¥${pp.purchaseAmount.toLocaleString()})`,
              purchasedBy: this.staffDoc?.id || "",
              purchasedAt: new Date().toISOString(),
            });
            // 購入分は「立替金」として laundry にも記録 (isReimbursable=true)
            try {
              await firebase.firestore().collection("laundry").add({
                date: new Date(),
                staffId: this.staffDoc?.id || "",
                propertyId: this.checklist?.propertyId || "",
                amount: pp.purchaseAmount,
                depot: info.depot || "",
                paymentMethod: "cash",  // 立替扱い
                isReimbursable: true,
                memo: `プリカ購入 (立替) - ${pp.cardNumber || "新規"} / ¥${pp.purchaseAmount.toLocaleString()}`,
                checklistId: this.checklistId,
                prepaidPurchase: true,
                prepaidCardId: newId,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
              });
            } catch (e) { console.warn("プリカ購入の立替記録失敗:", e.message); }
          }
          await firebase.firestore().collection("settings").doc("prepaidCards").set({
            items,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        } catch (e) { console.warn("プリカ残高/購入処理失敗:", e.message); }
      }
      // laundry コレクションにも記録 (請求書自動集計用)
      // 立替金フラグ: cash/credit はスタッフ立替、prepaid/invoice はWebアプリ管理者支払(請求書除外)
      const isReimbursable = info.paymentMethod === "cash" || info.paymentMethod === "credit";
      try {
        await firebase.firestore().collection("laundry").add({
          date: new Date(),
          staffId: this.staffDoc?.id || "",
          propertyId: this.checklist?.propertyId || "",
          amount: Number(info.amount) || 0,
          depot: info.depot || "",
          depotOther: info.depotOther || "",
          paymentMethod: info.paymentMethod || "",
          isReimbursable,  // 請求書集計時にこのフラグで立替金のみ加算
          memo: info.note || "",
          checklistId: this.checklistId,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) { console.warn("laundry 集計追加失敗:", e.message); }
    } else {
      patch[`laundry.${key}`] = { at: firebase.firestore.FieldValue.serverTimestamp(), by };
    }
    try {
      await firebase.firestore().collection("checklists").doc(this.checklistId).update(patch);
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  // ランドリー「出した」時の入力モーダル (Promise<{depot, paymentMethod, amount} | null>)
  async askLaundryPutOutInfo() {
    // 提出先マスターを読み込み (settings/laundryDepots.items: [{id,kind,name,rates}])
    let depotMaster = [];
    try {
      const doc = await firebase.firestore().collection("settings").doc("laundryDepots").get();
      if (doc.exists && Array.isArray(doc.data().items)) depotMaster = doc.data().items;
    } catch (_) {}
    if (!depotMaster.length) {
      depotMaster = [
        { id: "default_coin", kind: "coin_laundry", name: "コインランドリー", rates: [{ label: "標準", amount: 1000 }] },
        { id: "default_linen", kind: "linen_shop", name: "リネン屋", rates: [{ label: "1泊分", amount: 3000 }] },
      ];
    }
    // 該当物件の cleaningFlow.laundryDepotIds があれば絞り込み
    const propertyId = this.checklist?.propertyId;
    if (propertyId) {
      try {
        const p = await firebase.firestore().collection("properties").doc(propertyId).get();
        const cf = (p.exists && p.data().cleaningFlow) || {};
        if (Array.isArray(cf.laundryDepotIds) && cf.laundryDepotIds.length) {
          depotMaster = depotMaster.filter(d => cf.laundryDepotIds.includes(d.id || d.name));
        }
      } catch (_) {}
    }
    // プリカ管理 (settings/prepaidCards.items) を読込
    let prepaidCards = [];
    try {
      const doc = await firebase.firestore().collection("settings").doc("prepaidCards").get();
      if (doc.exists && Array.isArray(doc.data().items)) prepaidCards = doc.data().items;
    } catch (_) {}
    return new Promise((resolve) => {
      const existing = document.getElementById("laundryPutOutModal");
      if (existing) existing.remove();
      const modalEl = document.createElement("div");
      modalEl.className = "modal fade";
      modalEl.id = "laundryPutOutModal";
      modalEl.tabIndex = -1;
      const depotOptions = depotMaster.map((d, i) =>
        `<option value="${i}">${(d.name || "").replace(/"/g, "&quot;")}</option>`
      ).join("");
      modalEl.innerHTML = `
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-arrow-up-circle"></i> 洗濯物を出した</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <!-- ステップ1: 提出先 -->
              <div class="mb-3">
                <label class="form-label">① 提出先 <span class="text-danger">*</span></label>
                <select class="form-select" id="lpoDepot">
                  <option value="">-- 選択 --</option>
                  ${depotOptions}
                  <option value="__other__">その他 (手入力)</option>
                </select>
                <input type="text" class="form-control mt-2 d-none" id="lpoDepotOther" placeholder="提出先名を入力">
              </div>
              <!-- ステップ2: 支払方法 -->
              <div class="mb-3">
                <label class="form-label">② 支払方法 <span class="text-danger">*</span></label>
                <select class="form-select" id="lpoPayment">
                  <option value="">-- 選択 --</option>
                  <option value="cash">現金(立替)</option>
                  <option value="credit">クレジットカード(立替)</option>
                  <option value="prepaid">プリペイド(プリカ)</option>
                  <option value="invoice">店舗請求(後払い)</option>
                </select>
              </div>
              <!-- ステップ3以降: プリカ選択 (支払方法=prepaid 時のみ) -->
              <div class="mb-3 d-none" id="lpoPrepaidWrap">
                <label class="form-label">③ 使用するプリカを選択 <span class="text-danger">*</span></label>
                <div class="small text-muted mb-2">複数のカードを組み合わせて支払できます。各カードに使用する金額を入力してください。</div>
                <div id="lpoPrepaidCardsList" class="border rounded p-2" style="max-height:260px;overflow-y:auto;">
                  <div class="text-muted small">プリカを読み込み中...</div>
                </div>

                <!-- プリカ購入フロー (使用可能なカードが無い/不足時) - ④支払総額の上に配置 -->
                <div class="alert alert-info mt-3 p-2 small" id="lpoPrepaidPurchaseWrap" style="display:none;">
                  <strong><i class="bi bi-cart-plus"></i> プリカを新規購入する</strong>
                  <div class="mb-1 mt-1">使用可能なプリカが無い/残高不足の場合、新しく購入した金額を記録できます。購入金額は請求書の立替として自動計上されます。</div>
                  <div class="form-check mb-2">
                    <input class="form-check-input" type="checkbox" id="lpoPrepaidPurchaseChk">
                    <label class="form-check-label small" for="lpoPrepaidPurchaseChk">プリカを購入する (立替)</label>
                  </div>
                  <div id="lpoPrepaidPurchaseFields" class="d-none">
                    <div class="row g-2 align-items-end">
                      <div class="col-6">
                        <label class="form-label small mb-0">購入金額 (円)</label>
                        <input type="number" class="form-control form-control-sm" id="lpoPrepaidPurchaseAmount" min="0" value="2000">
                      </div>
                      <div class="col-6">
                        <label class="form-label small mb-0">カード番号 (任意)</label>
                        <input type="text" class="form-control form-control-sm" id="lpoPrepaidPurchaseCardNumber" placeholder="自動採番">
                      </div>
                    </div>
                    <div class="form-text small">チェックすると今回の使用分は新カードから充当され、残金があれば次回以降も使えます。立替金として請求書に自動追加されます。</div>
                  </div>
                </div>

                <label class="form-label mt-3">④ 支払総額 <span class="text-danger">*</span></label>
                <select class="form-select" id="lpoPrepaidAmount">
                  <option value="">-- 金額を選択 --</option>
                </select>
                <input type="number" class="form-control mt-2 d-none" id="lpoPrepaidAmountOther" min="0" placeholder="金額を手入力(円)">
                <div class="d-flex justify-content-between mt-2">
                  <button type="button" class="btn btn-sm btn-outline-secondary" id="lpoAutoAllocate">
                    <i class="bi bi-magic"></i> 自動配分 (残高の少ない順)
                  </button>
                  <div class="small">
                    配分済: <strong id="lpoAllocatedSum">¥0</strong> /
                    目標: <span id="lpoAllocatedTarget">¥0</span>
                  </div>
                </div>
              </div>
              <!-- ステップ3': 金額 (支払方法=cash/credit/invoice 時) -->
              <div class="mb-3 d-none" id="lpoRateWrap">
                <label class="form-label">③ 金額 <span class="text-danger">*</span></label>
                <select class="form-select" id="lpoRate"></select>
                <input type="number" class="form-control mt-2 d-none" id="lpoRateOther" min="0" placeholder="金額を手入力(円)">
              </div>
              <!-- ステップ5: メモ (プリペイド時) / ステップ4: メモ (cash/credit/invoice時) / ステップ3: メモ (未選択時) -->
              <div class="mb-3">
                <label class="form-label" id="lpoNoteLabel">③ メモ</label>
                <input type="text" class="form-control" id="lpoNote">
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal" id="lpoCancel">キャンセル</button>
              <button type="button" class="btn btn-primary" id="lpoSubmit"><i class="bi bi-check-lg"></i> 記録する</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modalEl);
      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      let decided = false;

      const depotSel = modalEl.querySelector("#lpoDepot");
      const otherInput = modalEl.querySelector("#lpoDepotOther");
      const rateWrap = modalEl.querySelector("#lpoRateWrap");
      const rateSel = modalEl.querySelector("#lpoRate");
      const rateOther = modalEl.querySelector("#lpoRateOther");
      const paySel = modalEl.querySelector("#lpoPayment");
      const prepaidWrap = modalEl.querySelector("#lpoPrepaidWrap");
      const prepaidSel = modalEl.querySelector("#lpoPrepaid");
      const prepaidAmountSel = modalEl.querySelector("#lpoPrepaidAmount");
      const prepaidAmountOther = modalEl.querySelector("#lpoPrepaidAmountOther");

      depotSel.addEventListener("change", () => {
        const v = depotSel.value;
        otherInput.classList.toggle("d-none", v !== "__other__");
        if (v === "__other__") { otherInput.focus(); }
        updateStep3();
      });

      paySel.addEventListener("change", () => updateStep3());

      function updateStep3() {
        const depotV = depotSel.value;
        const payV = paySel.value;
        // メモラベルを支払方法で切替 (prepaid → ⑤、それ以外 → ④)
        const noteLbl = modalEl.querySelector("#lpoNoteLabel");
        // prepaid: ③プリカ→④支払総額→⑤メモ
        // cash/credit/invoice: ③金額→④メモ
        // 未選択: ③メモ
        if (noteLbl) {
          if (payV === "prepaid") noteLbl.textContent = "⑤ メモ";
          else if (payV) noteLbl.textContent = "④ メモ";
          else noteLbl.textContent = "③ メモ";
        }
        // ステップ3の表示: 支払方法で分岐
        if (payV === "prepaid") {
          rateWrap.classList.add("d-none");
          prepaidWrap.classList.remove("d-none");
          // プリカをフィルタ (該当 depot に紐づくカードのみ、残高0除外)
          let filtered = prepaidCards;
          if (depotV !== "" && depotV !== "__other__") {
            const depotObj = depotMaster[+depotV];
            const depotId = depotObj?.id || depotObj?.name;
            const byDepot = prepaidCards.filter(c => c.depotId === depotId);
            if (byDepot.length) filtered = byDepot;
          }
          filtered = filtered.filter(c => (Number(c.balance) || 0) > 0);
          modalEl._prepaidAvailable = filtered;
          // 使用可能カードが無い or 不足時の購入フロー表示
          const purchaseWrap = modalEl.querySelector("#lpoPrepaidPurchaseWrap");
          if (purchaseWrap) {
            purchaseWrap.style.display = "block";
            const chk = modalEl.querySelector("#lpoPrepaidPurchaseChk");
            const fields = modalEl.querySelector("#lpoPrepaidPurchaseFields");
            if (!filtered.length) { chk.checked = true; fields.classList.remove("d-none"); }
            chk.onchange = () => {
              fields.classList.toggle("d-none", !chk.checked);
            };
          }

          // 金額プルダウン
          const depot = depotV === "__other__" ? null : depotMaster[+depotV];
          const rates = (depot && depot.rates) || [];
          prepaidAmountSel.innerHTML = `<option value="">-- 金額を選択 --</option>` +
            rates.map((r, ri) => `<option value="${ri}" data-amount="${r.amount||0}" data-label="${(r.label||'').replace(/"/g,'&quot;')}">${(r.label||"").replace(/</g,"&lt;")} ¥${(r.amount||0).toLocaleString()}</option>`).join("") +
            `<option value="__other__">その他 (金額手入力)</option>`;
          prepaidAmountSel.onchange = () => {
            prepaidAmountOther.classList.toggle("d-none", prepaidAmountSel.value !== "__other__");
            if (prepaidAmountSel.value === "__other__") prepaidAmountOther.focus();
            renderPrepaidCards();
            updateAllocationTarget();
          };
          prepaidAmountOther.oninput = () => { updateAllocationTarget(); };

          // プリカ一覧を描画
          const listEl = modalEl.querySelector("#lpoPrepaidCardsList");
          // アロー関数内の this が undefined になる問題を回避するため escapeHtml をローカル定義
          const _esc = (s) => { const d = document.createElement("div"); d.textContent = String(s || ""); return d.innerHTML; };
          const renderPrepaidCards = () => {
            if (!filtered.length) {
              listEl.innerHTML = `<div class="text-muted small">使用可能なプリカがありません</div>`;
              return;
            }
            listEl.innerHTML = filtered.map(c => `
              <div class="d-flex align-items-center gap-2 mb-1 p-1 border rounded">
                <input type="checkbox" class="form-check-input prepaid-use" data-card-id="${c.id}" data-balance="${c.balance}">
                <span class="flex-grow-1 small">${_esc(c.cardNumber || c.id)} <span class="text-muted">(残高 ¥${(c.balance||0).toLocaleString()})</span></span>
                <input type="number" class="form-control form-control-sm prepaid-use-amount" data-card-id="${c.id}" min="0" max="${c.balance}" placeholder="使用額" style="width:110px;" disabled>
              </div>
            `).join("");
            // チェック時に入力欄を有効化
            listEl.querySelectorAll(".prepaid-use").forEach(cb => {
              cb.addEventListener("change", () => {
                const amt = listEl.querySelector(`.prepaid-use-amount[data-card-id="${cb.dataset.cardId}"]`);
                if (amt) {
                  amt.disabled = !cb.checked;
                  if (!cb.checked) amt.value = "";
                }
                updateAllocationSum();
              });
            });
            listEl.querySelectorAll(".prepaid-use-amount").forEach(inp => {
              inp.addEventListener("input", () => {
                const maxBal = Number(inp.max) || 0;
                if (Number(inp.value) > maxBal) inp.value = maxBal;
                updateAllocationSum();
              });
            });
          };
          renderPrepaidCards();

          const updateAllocationTarget = () => {
            const t = _getPrepaidTargetAmount();
            modalEl.querySelector("#lpoAllocatedTarget").textContent = `¥${t.toLocaleString()}`;
          };
          const updateAllocationSum = () => {
            const sum = [...listEl.querySelectorAll(".prepaid-use-amount")]
              .reduce((s, i) => s + (Number(i.value) || 0), 0);
            const target = _getPrepaidTargetAmount();
            const el = modalEl.querySelector("#lpoAllocatedSum");
            el.textContent = `¥${sum.toLocaleString()}`;
            el.style.color = sum === target && target > 0 ? "#198754" : (sum > target ? "#dc3545" : "#6c757d");
          };
          const _getPrepaidTargetAmount = () => {
            const v = prepaidAmountSel.value;
            if (v === "__other__") return Number(prepaidAmountOther.value) || 0;
            if (v) {
              const opt = prepaidAmountSel.options[prepaidAmountSel.selectedIndex];
              return Number(opt?.dataset?.amount) || 0;
            }
            return 0;
          };

          // 自動配分ボタン: 残高の少ない順に充当していき、目標金額になるよう配分
          modalEl.querySelector("#lpoAutoAllocate").onclick = () => {
            const target = _getPrepaidTargetAmount();
            if (!target) { showToast("エラー", "先に金額を選択してください", "error"); return; }
            const sorted = [...filtered].sort((a, b) => (a.balance || 0) - (b.balance || 0));
            let remaining = target;
            const allocations = {};
            sorted.forEach(c => {
              if (remaining <= 0) return;
              const use = Math.min(remaining, Number(c.balance) || 0);
              if (use > 0) { allocations[c.id] = use; remaining -= use; }
            });
            if (remaining > 0) {
              showToast("残高不足", `全カード合計でも ¥${(target - remaining).toLocaleString()} しか充当できません。`, "error");
            }
            // UI に反映
            listEl.querySelectorAll(".prepaid-use").forEach(cb => {
              const cid = cb.dataset.cardId;
              const amt = listEl.querySelector(`.prepaid-use-amount[data-card-id="${cid}"]`);
              if (allocations[cid]) {
                cb.checked = true;
                if (amt) { amt.disabled = false; amt.value = allocations[cid]; }
              } else {
                cb.checked = false;
                if (amt) { amt.disabled = true; amt.value = ""; }
              }
            });
            updateAllocationSum();
          };
        } else if (payV === "cash" || payV === "credit" || payV === "invoice") {
          prepaidWrap.classList.add("d-none");
          rateWrap.classList.remove("d-none");
          const depot = depotV === "__other__" ? null : depotMaster[+depotV];
          const rates = (depot && depot.rates) || [];
          rateSel.innerHTML = `<option value="">-- 金額を選択 --</option>` +
            rates.map((r, ri) => `<option value="${ri}" data-amount="${r.amount||0}" data-label="${(r.label||'').replace(/"/g,'&quot;')}">${(r.label||"").replace(/</g,"&lt;")} ¥${(r.amount||0).toLocaleString()}</option>`).join("") +
            `<option value="__other__">その他 (金額手入力)</option>`;
          rateSel.onchange = () => {
            rateOther.classList.toggle("d-none", rateSel.value !== "__other__");
            if (rateSel.value === "__other__") rateOther.focus();
          };
        } else {
          rateWrap.classList.add("d-none");
          prepaidWrap.classList.add("d-none");
        }
      }

      modalEl.querySelector("#lpoSubmit").addEventListener("click", () => {
        const depotIdx = depotSel.value;
        const paymentMethod = paySel.value;
        if (!depotIdx) { showToast("入力エラー", "提出先を選択してください", "error"); return; }
        if (!paymentMethod) { showToast("入力エラー", "支払方法を選択してください", "error"); return; }

        let depotName = "";
        if (depotIdx === "__other__") {
          depotName = otherInput.value.trim();
          if (!depotName) { showToast("入力エラー", "提出先名を入力してください", "error"); return; }
        } else {
          depotName = depotMaster[+depotIdx]?.name || "";
        }

        let amount = 0, rateLabel = "", prepaidId = "", prepaidLabel = "";
        if (paymentMethod === "prepaid") {
          // 金額(目標): プルダウン or 手入力
          const av = prepaidAmountSel.value;
          if (!av) { showToast("入力エラー", "支払総額を選択してください", "error"); return; }
          if (av === "__other__") {
            amount = Number(prepaidAmountOther.value) || 0;
            if (!amount) { showToast("入力エラー", "金額を入力してください", "error"); return; }
            rateLabel = "その他";
          } else {
            const aopt = prepaidAmountSel.options[prepaidAmountSel.selectedIndex];
            amount = Number(aopt?.dataset?.amount) || 0;
            rateLabel = aopt?.dataset?.label || "";
          }
          // 複数プリカの使用額を収集
          const listEl = modalEl.querySelector("#lpoPrepaidCardsList");
          const allocs = [];
          listEl.querySelectorAll(".prepaid-use:checked").forEach(cb => {
            const cid = cb.dataset.cardId;
            const amtEl = listEl.querySelector(`.prepaid-use-amount[data-card-id="${cid}"]`);
            const use = Number(amtEl?.value) || 0;
            if (use > 0) allocs.push({ cardId: cid, amount: use });
          });
          // プリカ購入フロー (新規購入した金額で残金をカバー)
          const purchaseChk = modalEl.querySelector("#lpoPrepaidPurchaseChk");
          const usePurchase = purchaseChk?.checked;
          let purchaseInfo = null;
          const allocsSum = allocs.reduce((s, a) => s + a.amount, 0);
          const shortfall = amount - allocsSum;
          if (usePurchase) {
            const purchaseAmt = Number(modalEl.querySelector("#lpoPrepaidPurchaseAmount")?.value) || 0;
            if (purchaseAmt <= 0) { showToast("入力エラー", "購入金額を入力してください", "error"); return; }
            if (purchaseAmt < shortfall) {
              showToast("入力エラー", `購入金額 ¥${purchaseAmt.toLocaleString()} では不足額 ¥${shortfall.toLocaleString()} を賄えません`, "error");
              return;
            }
            purchaseInfo = {
              purchaseAmount: purchaseAmt,
              useAmount: Math.max(0, shortfall),
              cardNumber: modalEl.querySelector("#lpoPrepaidPurchaseCardNumber")?.value.trim() || "",
              depotId: depotIdx === "__other__" ? "" : (depotMaster[+depotIdx]?.id || depotMaster[+depotIdx]?.name || ""),
            };
          } else {
            if (!allocs.length) { showToast("入力エラー", "使用するプリカを1枚以上選択するか、プリカを購入してください", "error"); return; }
            if (allocsSum !== amount) {
              showToast("金額不一致", `配分合計 ¥${allocsSum.toLocaleString()} が支払総額 ¥${amount.toLocaleString()} と一致しません`, "error");
              return;
            }
          }
          // 既存カードの残高チェック
          for (const a of allocs) {
            const card = (modalEl._prepaidAvailable || []).find(c => c.id === a.cardId);
            if (!card || (Number(card.balance) || 0) < a.amount) {
              showToast("残高不足", `カード「${card?.cardNumber || a.cardId}」の残高が不足しています`, "error");
              return;
            }
          }
          prepaidId = allocs.map(a => a.cardId).join(",") + (usePurchase ? ",__purchased__" : "");
          const labels = allocs.map(a => {
            const c = (modalEl._prepaidAvailable || []).find(x => x.id === a.cardId);
            return `${c?.cardNumber || a.cardId}(¥${a.amount.toLocaleString()})`;
          });
          if (usePurchase) labels.push(`新規購入(¥${purchaseInfo.purchaseAmount.toLocaleString()})`);
          prepaidLabel = labels.join(" + ");
          modalEl._prepaidAllocations = allocs;
          modalEl._prepaidPurchase = purchaseInfo;
        } else {
          const rv = rateSel.value;
          if (!rv) { showToast("入力エラー", "金額を選択してください", "error"); return; }
          if (rv === "__other__") {
            amount = Number(rateOther.value) || 0;
            if (!amount) { showToast("入力エラー", "金額を入力してください", "error"); return; }
            rateLabel = "その他";
          } else {
            const opt = rateSel.options[rateSel.selectedIndex];
            amount = Number(opt?.dataset?.amount) || 0;
            rateLabel = opt?.dataset?.label || "";
          }
        }

        decided = true;
        const depotKind = depotIdx === "__other__" ? "other" : (depotMaster[+depotIdx]?.kind || "other");
        const info = {
          depot: depotName,
          depotOther: depotIdx === "__other__" ? depotName : "",
          depotKind,
          paymentMethod,
          prepaidId,
          prepaidLabel,
          prepaidAllocations: modalEl._prepaidAllocations || null,  // 複数プリカ分散情報
          prepaidPurchase: modalEl._prepaidPurchase || null,        // 新規購入情報
          rateLabel,
          amount,
          note: modalEl.querySelector("#lpoNote").value.trim(),
        };
        modal.hide();
        modalEl.addEventListener("hidden.bs.modal", () => { modalEl.remove(); resolve(info); }, { once: true });
      });
      modalEl.addEventListener("hidden.bs.modal", () => {
        if (!decided) { modalEl.remove(); resolve(null); }
      });
      modal.show();
    });
  },

  async completeChecklist(allDone, unchecked) {
    if (!this.checklistId) return;
    // 1. 未チェック確認
    if (!allDone) {
      const ok = await showConfirm(
        `未チェックの項目が ${unchecked} 件あります。それでも清掃完了にしますか？`,
        { title: "清掃完了の確認", okLabel: "完了にする", okClass: "btn-success" }
      );
      if (!ok) return;
    }
    // 2. 写真ゼロ確認
    const c = this.checklist || {};
    const hasPhotos = (c.beforePhotos && c.beforePhotos.length > 0)
                   || (c.afterPhotos && c.afterPhotos.length > 0);
    if (!hasPhotos) {
      const okPhoto = await showConfirm(
        "清掃前・後の写真がまだ1枚もアップロードされていません。\n写真なしで清掃完了にしますか？",
        { title: "写真なしで完了", okLabel: "このまま完了にする", okClass: "btn-warning" }
      );
      if (!okPhoto) return;
    }
    // 3. ゲスト評価モーダル
    const rating = await this._askGuestRating();
    if (rating === null) return; // キャンセル

    const btn = document.getElementById('mclCompleteBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 処理中...'; }
    try {
      const user = firebase.auth().currentUser;
      const staffId = this._effectiveStaffId() || "";
      const staffName = this.staffDoc?.name || user?.displayName || "";

      // 評価を booking に保存
      if (rating > 0 || rating === 0) {
        try {
          // bookingId は checklist.bookingId → shift.bookingId の順で取得
          let bookingId = c.bookingId || null;
          if (!bookingId && c.shiftId) {
            const sDoc = await firebase.firestore().collection("shifts").doc(c.shiftId).get();
            if (sDoc.exists) bookingId = sDoc.data().bookingId || null;
          }
          if (bookingId) {
            await firebase.firestore().collection("bookings").doc(bookingId).update({
              cleanlinessRating: rating,
              cleanlinessRatedBy: staffId,
              cleanlinessRatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
          }
        } catch (e) {
          console.warn("[completeChecklist] 評価保存失敗 (続行):", e.message);
        }
      }

      await firebase.firestore().collection("checklists").doc(this.checklistId).update({
        status: "completed",
        completedAt: firebase.firestore.FieldValue.serverTimestamp(),
        completedBy: {
          uid: user?.uid || "",
          name: staffName,
        },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      showToast("清掃完了", "お疲れさまでした！ Webアプリ管理者に通知しました。", "success");
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-check2-circle"></i> 清掃完了にする'; }
      showToast("エラー", e.message, "error");
    }
  },

  // ゲスト評価モーダル (Promise<number|null>: 0-5 or null=キャンセル)
  _askGuestRating() {
    return new Promise((resolve) => {
      const existing = document.getElementById("mclGuestRatingModal");
      if (existing) existing.remove();

      let selectedRating = 0;
      const labels = ["未評価", "とても汚い", "汚い", "普通", "綺麗", "とても綺麗"];

      const modalEl = document.createElement("div");
      modalEl.className = "modal fade";
      modalEl.id = "mclGuestRatingModal";
      modalEl.tabIndex = -1;
      modalEl.innerHTML = `
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-star-half"></i> ゲストの利用状態を評価してください</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body text-center">
              <div class="mb-3" id="mclRatingStars" style="font-size:2.5rem;cursor:pointer;letter-spacing:4px;">
                <span class="mcl-star" data-val="1">☆</span>
                <span class="mcl-star" data-val="2">☆</span>
                <span class="mcl-star" data-val="3">☆</span>
                <span class="mcl-star" data-val="4">☆</span>
                <span class="mcl-star" data-val="5">☆</span>
              </div>
              <div id="mclRatingLabel" class="fw-bold mb-2" style="min-height:1.5em;">未評価</div>
              <div class="small text-muted mb-3">
                1=とても汚い / 2=汚い / 3=普通 / 4=綺麗 / 5=とても綺麗 / 0=未評価
              </div>
              <div class="small text-muted">星を選択してから送信してください（未評価のまま送信も可）</div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">キャンセル</button>
              <button type="button" class="btn btn-success" id="mclRatingSubmit">
                <i class="bi bi-check2-circle"></i> 評価して完了送信
              </button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(modalEl);

      const updateStars = (val) => {
        modalEl.querySelectorAll(".mcl-star").forEach(s => {
          s.textContent = Number(s.dataset.val) <= val ? "★" : "☆";
          s.style.color = Number(s.dataset.val) <= val ? "#f4c430" : "#aaa";
        });
        const label = document.getElementById("mclRatingLabel");
        if (label) label.textContent = labels[val] || "未評価";
      };
      updateStars(0);

      modalEl.querySelectorAll(".mcl-star").forEach(s => {
        s.addEventListener("click", () => {
          const v = Number(s.dataset.val);
          selectedRating = selectedRating === v ? 0 : v; // 同じ星をもう一度クリックで解除
          updateStars(selectedRating);
        });
      });

      let decided = false;
      document.getElementById("mclRatingSubmit").addEventListener("click", () => {
        decided = true;
        modal.hide();
        modalEl.addEventListener("hidden.bs.modal", () => { modalEl.remove(); resolve(selectedRating); }, { once: true });
      });
      modalEl.addEventListener("hidden.bs.modal", () => {
        if (!decided) { modalEl.remove(); resolve(null); }
      });

      const modal = new bootstrap.Modal(modalEl);
      modal.show();
    });
  },

  // 後方互換: タブ2の大カテゴリエリア内容を更新
  renderActiveArea() {
    // 新構造では renderTabChecklist() 経由で描画するが、
    // 大カテゴリタブ切替時は mclAreaContent のみ差し替える
    const el = document.getElementById("mclAreaContent");
    if (!el || !this.checklist) return;
    const areas = this.checklist.templateSnapshot || [];
    const area = areas.find(a => a.id === this.activeAreaId);
    if (!area) return;
    const states = this.checklist.itemStates || {};
    const total = this.countItems([area]);
    const done = this.countItemsDone(area, states);
    const allChecked = total > 0 && done === total;
    el.innerHTML = `
      <div class="d-flex gap-2 mb-1 mt-1 flex-wrap">
        <button type="button" class="btn btn-sm btn-outline-primary mcl-toggle-all-check" data-all-checked="${allChecked ? '1' : '0'}">
          <i class="bi bi-check2-square"></i> ${allChecked ? '全チェック外し' : '全チェック'}
        </button>
        <button type="button" class="btn btn-sm btn-outline-secondary mcl-toggle-all-expand">
          <i class="bi bi-arrows-expand"></i> 全展開/全折りたたみ
        </button>
        <span class="ms-auto small text-muted align-self-center">${done}/${total} チェック済</span>
      </div>
      ${this.renderChildren(area)}
    `;
    this.wireChildren(el);
    el.querySelector(".mcl-toggle-all-check")?.addEventListener("click", () => this.toggleAllCheckInArea(area, allChecked));
    el.querySelector(".mcl-toggle-all-expand")?.addEventListener("click", () => this.toggleAllExpandInArea(el));
  },

  // area 内の全項目をまとめてチェック/チェック外し
  async toggleAllCheckInArea(area, currentlyAllChecked) {
    // area 内の全項目 ID を収集
    const ids = [];
    const walk = (node) => {
      (node.items || node.directItems || []).forEach(it => ids.push(it.id));
      (node.taskTypes || []).forEach(walk);
      (node.subCategories || []).forEach(walk);
      (node.subSubCategories || []).forEach(walk);
    };
    walk(area);
    if (!ids.length) return;

    const newChecked = !currentlyAllChecked;
    const patch = {};
    const checker = newChecked ? {
      name: this.staffDoc?.name || "",
      uid: this.myUid(),
    } : null;
    ids.forEach(id => {
      patch[`itemStates.${id}.checked`] = newChecked;
      if (newChecked) {
        patch[`itemStates.${id}.checkedBy`] = checker;
        patch[`itemStates.${id}.checkedAt`] = firebase.firestore.FieldValue.serverTimestamp();
      } else {
        patch[`itemStates.${id}.checkedBy`] = firebase.firestore.FieldValue.delete();
        patch[`itemStates.${id}.checkedAt`] = firebase.firestore.FieldValue.delete();
      }
    });
    patch.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    try {
      await firebase.firestore().collection("checklists").doc(this.checklistId).update(patch);
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  // area 内のアコーディオンを全展開 or 全折りたたみ (どれか畳まれていれば全展開、全開ならば全畳む)
  toggleAllExpandInArea(el) {
    const collapses = el.querySelectorAll(".accordion-collapse");
    if (!collapses.length) return;
    const anyClosed = Array.from(collapses).some(c => !c.classList.contains("show"));
    collapses.forEach(c => {
      const inst = bootstrap.Collapse.getOrCreateInstance(c, { toggle: false });
      if (anyClosed) inst.show(); else inst.hide();
    });
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
    const editingBy = st.editingBy;
    const othersEditing = editingBy && editingBy.uid && editingBy.uid !== this.myUid() &&
                          (Date.now() - (editingBy.at || 0) < 45000);

    // カード全体がタップ可能: mcl-item-tap クラスで JS からチェックを切り替える
    // 要補充チェック・アコーディオンボタンはバブリングを止めて誤作動を防ぐ
    return `
      <div class="mcl-item card mb-2 ${checked ? 'bg-success bg-opacity-10' : ''} mcl-item-tap" data-item-id="${it.id}"
           style="cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;">
        <div class="card-body" style="padding:12px 14px;">
          <div class="d-flex align-items-start gap-3">
            <!-- チェックボックス: ラベルは item-tap 側でハンドルするため pointer-events:none にして二重発火を防ぐ -->
            <input class="form-check-input mcl-check flex-shrink-0" type="checkbox" id="chk-${it.id}"
                   ${checked ? "checked" : ""}
                   style="width:22px;height:22px;margin-top:2px;pointer-events:none;">
            <div class="flex-grow-1 lh-base">
              <span style="font-size:15px;">${this.escapeHtml(it.name)}</span>
              ${it.memo ? `<div class="small text-muted mt-1">${this.escapeHtml(it.memo)}</div>` : ""}
              ${othersEditing ? `<div class="small text-info mt-1"><i class="bi bi-person"></i> ${this.escapeHtml(editingBy.name||"他のスタッフ")}が編集中...</div>` : ""}
              ${st.checkedBy ? `<div class="small text-muted mt-1">✓ ${this.escapeHtml(st.checkedBy.name||"")} ${this.fmtTime(st.checkedAt)}</div>` : ""}
            </div>
          </div>
          ${it.supplyItem ? `
            <div class="d-flex align-items-center mt-2" onclick="event.stopPropagation()">
              <input class="form-check-input mcl-restock flex-shrink-0" type="checkbox" id="sup-${it.id}"
                     ${needsRestock ? "checked" : ""} style="width:20px;height:20px;margin:0;">
              <label class="text-warning ms-2 mb-0" for="sup-${it.id}" style="cursor:pointer;">
                <i class="bi bi-exclamation-triangle"></i> 要補充
              </label>
            </div>
          ` : ""}
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
    // デフォルトは展開状態: チェック入力・再描画・タブ切替のたびに閉じられないよう
    // accordion-button から "collapsed" を外し、collapse に "show" を付ける
    return `
      <div class="mcl-cat accordion mb-2" data-cat-id="${cat.id}">
        <div class="accordion-item">
          <h2 class="accordion-header">
            <button class="accordion-button ${allDone ? 'bg-success bg-opacity-10' : ''}" type="button" data-bs-toggle="collapse" data-bs-target="#${collapseId}">
              ${this.escapeHtml(cat.name)}
              <span class="badge ${allDone ? 'bg-success' : 'bg-secondary'} ms-2">${done}/${tot}</span>
            </button>
          </h2>
          <div id="${collapseId}" class="accordion-collapse collapse show">
            <div class="accordion-body p-2">
              ${this.renderChildren(cat)}
            </div>
          </div>
        </div>
      </div>
    `;
  },

  wireChildren(el) {
    // チェックボックスは pointer-events:none にしてあるため change イベントは発火しない
    // カード全体タップ (mcl-item-tap) でチェック状態を切り替える
    el.querySelectorAll(".mcl-item-tap").forEach(card => {
      // タッチ操作で active 視覚フィードバック
      card.addEventListener("touchstart", () => {
        card.style.opacity = "0.75";
      }, { passive: true });
      card.addEventListener("touchend", () => {
        card.style.opacity = "";
      }, { passive: true });
      card.addEventListener("touchcancel", () => {
        card.style.opacity = "";
      }, { passive: true });

      card.addEventListener("click", (ev) => {
        // 要補充チェックボックス (mcl-restock) と label のクリックはここに到達しない
        // (stopPropagation 済み)
        const itemId = card.dataset.itemId;
        const cb = card.querySelector(".mcl-check");
        if (!cb) return;
        const newVal = !cb.checked;
        cb.checked = newVal;
        this.updateItemState(itemId, { checked: newVal });
        // キャラクター演出は削除済み
      });
    });

    // 要補充チェックボックス
    el.querySelectorAll(".mcl-restock").forEach(cb => {
      cb.addEventListener("change", () => {
        const itemId = cb.closest("[data-item-id]").dataset.itemId;
        this.updateItemState(itemId, { needsRestock: cb.checked });
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
    // viewAsStaff 中は そのスタッフ名で記録 (presence・編集マーカー)
    const vid = this._effectiveStaffId();
    if (vid && this.staffDoc) {
      return { uid: user.uid || "", name: this.staffDoc.name || "スタッフ", asStaffId: vid };
    }
    return { uid: user.uid || "", name: user.displayName || user.email || "スタッフ" };
  },
  myUid() { return Auth?.currentUser?.uid || ""; },

  /** viewAsStaff (管理者の特定スタッフ視点閲覧) を考慮した staffId 取得 */
  _effectiveStaffId() {
    const v = (typeof App !== "undefined" && App.getViewAsStaffId) ? App.getViewAsStaffId() : null;
    if (v) return v;
    return Auth?.currentUser?.staffId || "";
  },

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
  },

  // ===== 写真セクション =====
  MAX_PHOTOS: 20,
  MAX_PHOTO_BYTES: 5 * 1024 * 1024, // 5MB (リサイズ後の上限)
  PHOTO_LONG_SIDE: 1920,             // リサイズ時の長辺 px

  /** 写真セクション全体を描画 */
  renderPhotoSection() {
    const el = document.getElementById("mclPhotoSection");
    if (!el || !this.checklist) return;
    const c = this.checklist;
    const isCompleted = c.status === "completed";
    const before = c.beforePhotos || [];
    const after = c.afterPhotos || [];

    const makeGrid = (kind, photos) => {
      const label = kind === "before" ? "清掃前" : "清掃後";
      const count = photos.length;
      const canAdd = !isCompleted && count < this.MAX_PHOTOS;
      const thumbs = photos.map((p, i) => `
        <div class="mcl-photo-thumb" style="position:relative;width:100px;height:100px;flex-shrink:0;">
          <img src="${this.escapeHtml(p.url)}" alt="${label}" loading="lazy"
               style="width:100%;height:100%;object-fit:cover;border-radius:6px;cursor:pointer;"
               data-photo-url="${this.escapeHtml(p.url)}" class="mcl-photo-preview">
          ${isCompleted ? "" : `
            <button type="button" class="btn btn-sm btn-danger mcl-photo-del"
                    data-kind="${kind}" data-idx="${i}"
                    style="position:absolute;top:2px;right:2px;padding:1px 5px;font-size:12px;border-radius:10px;opacity:0.85;">
              ×
            </button>
          `}
        </div>
      `).join("");

      return `
        <div class="card mb-3">
          <div class="card-body pb-2">
            <div class="d-flex align-items-center justify-content-between mb-2">
              <h6 class="card-title mb-0">
                <i class="bi bi-camera"></i> ${label}
                <span class="badge bg-secondary ms-1">${count}/${this.MAX_PHOTOS}</span>
              </h6>
              ${canAdd ? `
                <div class="d-flex gap-1">
                  <label class="btn btn-sm btn-outline-primary mb-0" style="cursor:pointer;" title="カメラで撮影">
                    <i class="bi bi-camera-fill"></i>
                    <input type="file" accept="image/*" capture="environment"
                           class="d-none mcl-photo-input" data-kind="${kind}">
                  </label>
                  <label class="btn btn-sm btn-outline-secondary mb-0" style="cursor:pointer;" title="ギャラリーから選択">
                    <i class="bi bi-images"></i>
                    <input type="file" accept="image/*" multiple
                           class="d-none mcl-photo-input" data-kind="${kind}">
                  </label>
                </div>
              ` : (!isCompleted ? `<span class="small text-muted">最大${this.MAX_PHOTOS}枚</span>` : "")}
            </div>
            <div class="d-flex gap-2 flex-wrap">
              ${thumbs || `<div class="text-muted small">まだ写真はありません</div>`}
              ${!isCompleted && !canAdd && count >= this.MAX_PHOTOS
                ? `<div class="small text-warning mt-1 w-100"><i class="bi bi-exclamation-triangle"></i> 最大枚数に達しました</div>`
                : ""}
            </div>
          </div>
        </div>
      `;
    };

    el.innerHTML = `
      <div class="px-1">
        <div class="d-flex align-items-center mb-2 gap-2">
          <span class="fw-bold"><i class="bi bi-images"></i> 清掃写真</span>
          <span class="small text-muted">前後の写真を記録できます（30日保持）</span>
        </div>
        ${makeGrid("before", before)}
        ${makeGrid("after", after)}
      </div>
    `;

    // ファイル選択イベント
    el.querySelectorAll(".mcl-photo-input").forEach(inp => {
      inp.addEventListener("change", (ev) => {
        const kind = inp.dataset.kind;
        const files = Array.from(ev.target.files || []);
        if (!files.length) return;
        inp.value = ""; // 同一ファイル再選択を可能にする
        this._handlePhotoFiles(kind, files);
      });
    });

    // 削除ボタン
    el.querySelectorAll(".mcl-photo-del").forEach(btn => {
      btn.addEventListener("click", () => {
        this.deletePhoto(btn.dataset.kind, parseInt(btn.dataset.idx, 10));
      });
    });

    // プレビュー拡大
    el.querySelectorAll(".mcl-photo-preview").forEach(img => {
      img.addEventListener("click", () => this._previewPhotoUrl(img.dataset.photoUrl));
    });
  },

  /** ファイルを受け取ってリサイズ→アップロード */
  async _handlePhotoFiles(kind, files) {
    const c = this.checklist;
    if (!c) return;
    const current = (kind === "before" ? c.beforePhotos : c.afterPhotos) || [];
    const remaining = this.MAX_PHOTOS - current.length;
    if (remaining <= 0) {
      showToast("上限に達しています", `${kind === "before" ? "清掃前" : "清掃後"}写真は最大${this.MAX_PHOTOS}枚です`, "error");
      return;
    }
    const targets = files.slice(0, remaining);
    if (files.length > remaining) {
      showToast("一部スキップ", `上限のため ${files.length - remaining} 枚はスキップしました`, "info");
    }

    // アップロード中バナーを表示
    const el = document.getElementById("mclPhotoSection");
    let banner = el?.querySelector(`.mcl-upload-banner[data-kind="${kind}"]`);
    if (!banner && el) {
      banner = document.createElement("div");
      banner.className = "alert alert-info py-2 small mcl-upload-banner";
      banner.dataset.kind = kind;
      banner.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> アップロード中...`;
      el.prepend(banner);
    }

    let uploaded = 0;
    for (const file of targets) {
      try {
        await this.uploadPhoto(kind, file);
        uploaded++;
      } catch (e) {
        console.error("写真アップロードエラー:", e.message);
        showToast("アップロード失敗", e.message, "error");
      }
    }

    if (banner) banner.remove();
    if (uploaded > 0) {
      showToast("アップロード完了", `${uploaded} 枚の写真を保存しました`, "success");
    }
  },

  /** 1枚アップロード: リサイズ → Storage → Firestore */
  async uploadPhoto(kind, file) {
    const c = this.checklist;
    if (!c || !this.checklistId) return;

    // リサイズ
    const blob = await this._resizeImage(file, this.PHOTO_LONG_SIDE);

    // Storage パス
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 7);
    const ext = "jpg";
    const path = `checklist-photos/${c.propertyId}/${this.checklistId}/${kind}/${ts}_${rand}.${ext}`;

    // Firebase Storage へアップロード
    const storageRef = firebase.storage().ref(path);
    const user = firebase.auth().currentUser;
    const metadata = {
      contentType: "image/jpeg",
      customMetadata: {
        uploadedBy: user?.uid || "",
        uploadedAt: new Date().toISOString(),
        checklistId: this.checklistId,
        kind,
      },
    };
    await storageRef.put(blob, metadata);
    const url = await storageRef.getDownloadURL();

    // Firestore の配列に追加
    // serverTimestamp() は arrayUnion 内では使用不可 → Timestamp.now() (クライアント時刻) を使用
    const field = kind === "before" ? "beforePhotos" : "afterPhotos";
    await firebase.firestore().collection("checklists").doc(this.checklistId).update({
      [field]: firebase.firestore.FieldValue.arrayUnion({
        url,
        uploadedAt: firebase.firestore.Timestamp.now(),
        uploadedBy: user?.uid || "",
        kind,
        path,
      }),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  },

  /** 写真を削除 (Firestore array 除去 + Storage 削除) */
  async deletePhoto(kind, idx) {
    const c = this.checklist;
    if (!c || !this.checklistId) return;

    const photos = (kind === "before" ? c.beforePhotos : c.afterPhotos) || [];
    const photo = photos[idx];
    if (!photo) return;

    const ok = await showConfirm(
      "この写真を削除しますか？削除後は元に戻せません。",
      { title: "写真の削除", okLabel: "削除する", okClass: "btn-danger" }
    );
    if (!ok) return;

    // Firestore から除去
    const field = kind === "before" ? "beforePhotos" : "afterPhotos";
    try {
      await firebase.firestore().collection("checklists").doc(this.checklistId).update({
        [field]: firebase.firestore.FieldValue.arrayRemove(photo),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      showToast("エラー", `Firestore 更新失敗: ${e.message}`, "error");
      return;
    }

    // Storage から削除 (失敗しても Firestore 側はすでに除去済み)
    try {
      const storagePath = photo.path || this._extractPhotoPath(photo.url);
      if (storagePath) {
        await firebase.storage().ref(storagePath).delete();
      }
    } catch (e) {
      console.warn("Storage 削除失敗 (無視):", e.message);
    }
  },

  /** URL から Storage パスを抽出 (フロントエンド版) */
  _extractPhotoPath(url) {
    if (!url) return null;
    try {
      const m = url.match(/\/o\/([^?#]+)/);
      if (m) return decodeURIComponent(m[1]);
    } catch (_) {}
    return null;
  },

  /** HTML5 Canvas で長辺 maxPx にリサイズして JPEG Blob を返す */
  _resizeImage(file, maxPx) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        // リサイズ不要なら品質圧縮のみ
        if (w > maxPx || h > maxPx) {
          if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx; }
          else { w = Math.round(w * maxPx / h); h = maxPx; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(blob => {
          if (blob) resolve(blob);
          else reject(new Error("canvas.toBlob failed"));
        }, "image/jpeg", 0.85);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画像の読み込みに失敗しました")); };
      img.src = url;
    });
  },

  // ===== チェックリストメモ (タブ2の末尾) =====
  _renderChecklistNotes() {
    const el = document.getElementById("mclChecklistNotes");
    if (!el || !this.checklist) return;
    const c = this.checklist;
    const notes = Array.isArray(c.notes) ? c.notes : [];

    const fmtTs = (at) => {
      if (!at) return "";
      const d = typeof at === "number" ? new Date(at) : (at.toDate ? at.toDate() : new Date(at));
      return d.toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    };

    const noteCards = notes.map(n => `
      <div class="card mb-2" data-note-id="${this.escapeHtml(n.id)}">
        <div class="card-body py-2 px-3">
          <div class="d-flex align-items-start gap-2">
            <div class="flex-grow-1">
              <div class="small text-muted mb-1">
                <i class="bi bi-person-circle"></i> ${this.escapeHtml(n.by || "不明")}
                <span class="ms-1">${this.escapeHtml(fmtTs(n.at))}</span>
              </div>
              ${n.text ? `<div style="white-space:pre-wrap;">${this.escapeHtml(n.text)}</div>` : ""}
              ${(n.photoUrls || []).length > 0 ? `
                <div class="d-flex flex-wrap gap-1 mt-2">
                  ${n.photoUrls.map(u => `
                    <img src="${this.escapeHtml(u)}" loading="lazy"
                         style="width:80px;height:80px;object-fit:cover;border-radius:6px;cursor:pointer;"
                         class="mcl-note-preview" data-url="${this.escapeHtml(u)}">
                  `).join("")}
                </div>` : ""}
            </div>
            <button type="button" class="btn btn-sm btn-outline-danger mcl-note-del flex-shrink-0"
                    data-note-id="${this.escapeHtml(n.id)}" style="padding:1px 6px;">×</button>
          </div>
        </div>
      </div>`).join("");

    el.innerHTML = `
      <div class="card">
        <div class="card-header py-2" style="background:#fff3cd;color:#664d03;border-color:#ffe69c;">
          <span class="fw-bold"><i class="bi bi-chat-left-text"></i> メモ</span>
          <span class="badge bg-warning text-dark ms-1">${notes.length}</span>
        </div>
        <div class="card-body pb-2">
          ${noteCards || `<div class="text-muted small mb-2">まだメモはありません</div>`}
          <div class="border-top pt-2 mt-2">
            <textarea class="form-control form-control-sm mb-2" id="mclNoteText" rows="2"
                      placeholder="メモを入力..."></textarea>
            <div class="d-flex gap-2 align-items-center">
              <label class="btn btn-sm btn-outline-secondary mb-0" style="cursor:pointer;">
                <i class="bi bi-image"></i> 写真
                <input type="file" accept="image/*" multiple class="d-none" id="mclNotePhotoInput">
              </label>
              <span id="mclNotePhotoCount" class="small text-muted"></span>
              <button type="button" class="btn btn-sm btn-primary ms-auto" id="mclNoteSubmit">
                <i class="bi bi-send"></i> 登録
              </button>
            </div>
            <div id="mclNotePhotoPreview" class="d-flex flex-wrap gap-1 mt-1"></div>
          </div>
        </div>
      </div>`;

    // 写真選択
    this._noteSelectedFiles = [];
    const photoInput = document.getElementById("mclNotePhotoInput");
    if (photoInput) {
      photoInput.addEventListener("change", (ev) => {
        this._noteSelectedFiles = Array.from(ev.target.files || []);
        const countEl = document.getElementById("mclNotePhotoCount");
        if (countEl) countEl.textContent = this._noteSelectedFiles.length > 0
          ? `${this._noteSelectedFiles.length}枚選択中` : "";
        // サムネイルプレビュー
        const preview = document.getElementById("mclNotePhotoPreview");
        if (preview) {
          preview.innerHTML = "";
          this._noteSelectedFiles.forEach(f => {
            const url = URL.createObjectURL(f);
            const img = document.createElement("img");
            img.src = url;
            img.style.cssText = "width:60px;height:60px;object-fit:cover;border-radius:4px;";
            img.addEventListener("load", () => URL.revokeObjectURL(url));
            preview.appendChild(img);
          });
        }
      });
    }

    // 登録ボタン
    document.getElementById("mclNoteSubmit")?.addEventListener("click", () => this._submitChecklistNote());

    // 削除ボタン
    el.querySelectorAll(".mcl-note-del").forEach(btn => {
      btn.addEventListener("click", () => this._deleteChecklistNote(btn.dataset.noteId));
    });

    // 写真プレビュー
    el.querySelectorAll(".mcl-note-preview").forEach(img => {
      img.addEventListener("click", () => this._previewPhotoUrl(img.dataset.url));
    });
  },

  async _submitChecklistNote() {
    const textEl = document.getElementById("mclNoteText");
    const text = textEl?.value.trim() || "";
    const files = this._noteSelectedFiles || [];
    if (!text && !files.length) {
      showToast("入力エラー", "テキストか写真を入力してください", "error");
      return;
    }
    if (!this.checklistId || !this.checklist) return;

    const submitBtn = document.getElementById("mclNoteSubmit");
    if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>'; }

    try {
      const c = this.checklist;
      const user = firebase.auth().currentUser;
      const staffName = this.staffDoc?.name || user?.displayName || "スタッフ";
      const staffId = this._effectiveStaffId() || user?.uid || "";
      const noteId = "note_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

      // 写真アップロード
      const photoUrls = [];
      for (const file of files) {
        try {
          const blob = await this._resizeImage(file, this.PHOTO_LONG_SIDE);
          const ts = Date.now();
          const rand = Math.random().toString(36).slice(2, 7);
          const path = `checklist-photos/${c.propertyId}/${this.checklistId}/notes/${noteId}/${ts}_${rand}.jpg`;
          const ref = firebase.storage().ref(path);
          await ref.put(blob, { contentType: "image/jpeg" });
          const url = await ref.getDownloadURL();
          photoUrls.push(url);
        } catch (e) {
          console.warn("[メモ写真アップ失敗]", e.message);
        }
      }

      const note = {
        id: noteId,
        text,
        photoUrls,
        by: staffName,
        byId: staffId,
        at: Date.now(), // serverTimestamp は配列内不可のため number
      };

      await firebase.firestore().collection("checklists").doc(this.checklistId).update({
        notes: firebase.firestore.FieldValue.arrayUnion(note),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      // 入力欄クリア
      if (textEl) textEl.value = "";
      this._noteSelectedFiles = [];
      const countEl = document.getElementById("mclNotePhotoCount");
      if (countEl) countEl.textContent = "";
      const preview = document.getElementById("mclNotePhotoPreview");
      if (preview) preview.innerHTML = "";
      showToast("メモ登録", "メモを登録しました", "success");
    } catch (e) {
      showToast("エラー", e.message, "error");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="bi bi-send"></i> 登録';
      }
    }
  },

  async _deleteChecklistNote(noteId) {
    if (!noteId || !this.checklistId || !this.checklist) return;
    const ok = await showConfirm("このメモを削除しますか？", { title: "メモの削除", okLabel: "削除", okClass: "btn-danger" });
    if (!ok) return;

    const notes = Array.isArray(this.checklist.notes) ? this.checklist.notes : [];
    const note = notes.find(n => n.id === noteId);
    if (!note) return;

    try {
      await firebase.firestore().collection("checklists").doc(this.checklistId).update({
        notes: firebase.firestore.FieldValue.arrayRemove(note),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  /** 写真をフルスクリーンプレビュー */
  _previewPhotoUrl(url) {
    const existing = document.getElementById("mclPhotoPreviewModal");
    if (existing) existing.remove();
    const div = document.createElement("div");
    div.id = "mclPhotoPreviewModal";
    div.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;";
    div.innerHTML = `
      <img src="${this.escapeHtml(url)}" style="max-width:95vw;max-height:90vh;border-radius:8px;">
      <button style="position:absolute;top:12px;right:16px;background:none;border:none;color:#fff;font-size:2rem;line-height:1;cursor:pointer;">&times;</button>
    `;
    div.addEventListener("click", () => div.remove());
    document.body.appendChild(div);
  },
};
