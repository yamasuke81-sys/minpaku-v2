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
    // shiftId なし → 一覧モード (今後・過去の全チェックリスト)
    if (!this.shiftId) {
      await this.renderList(container);
      return;
    }

    container.innerHTML = `
      <div class="mcl-page-header" style="position:fixed;top:0;z-index:29;background:#fff;padding:8px 12px;box-shadow:0 1px 0 #eee;">
        <div class="d-flex align-items-center">
          <a href="#/my-checklist" class="btn btn-sm btn-outline-secondary me-2" title="一覧に戻る">
            <i class="bi bi-arrow-left"></i>
          </a>
          <h6 class="mb-0 flex-grow-1" id="mclHeader" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">チェックリスト</h6>
          <span id="mclStatus" class="badge bg-secondary small"></span>
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

  _applyHeaderLayout() {
    const header = document.querySelector(".mcl-page-header");
    if (!header) return;
    const mainEl = document.querySelector(".app-main");
    const rect = mainEl ? mainEl.getBoundingClientRect() : { left: 0, width: window.innerWidth };
    header.style.left = rect.left + "px";
    header.style.width = rect.width + "px";
    // app-topbar の高さを計算し、その下に配置(topbar と重ならないようにする)
    const topbar = document.querySelector(".app-topbar");
    const topbarH = topbar ? topbar.getBoundingClientRect().height : 0;
    header.style.top = topbarH + "px";
    // fixed 化後の実レイアウト高さで spacer 計算
    requestAnimationFrame(() => {
      const headerH = header.getBoundingClientRect().height;
      const tabsWrap = document.querySelector(".mcl-tabs-wrap");
      const tabsH = tabsWrap ? tabsWrap.getBoundingClientRect().height : 0;
      const spacer = document.querySelector(".mcl-page-header-spacer");
      if (spacer) spacer.style.height = (topbarH + headerH + tabsH) + "px";
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
        <label class="small text-muted mb-0 ms-2">物件:</label>
        <select class="form-select form-select-sm" id="mclListProp" style="max-width:260px;">
          <option value="">すべての物件</option>
        </select>
        <div class="form-check ms-2">
          <input class="form-check-input" type="checkbox" id="mclListShowPast">
          <label class="form-check-label small" for="mclListShowPast">完了済も表示</label>
        </div>
      </div>
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
      this._listData = clSnap.docs.map(d => ({ id: d.id, ...d.data() })).map(c => {
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
      this._listProps = propSnap;

      const propSelect = document.getElementById("mclListProp");
      propSnap.forEach(p => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = (p._num ? `${p._num} ` : "") + (p.name || "");
        propSelect.appendChild(opt);
      });

      // 端末ごとの設定を localStorage から復元 (staffId 別 key)
      const lsKey = `mclList_${this.staffId || "anon"}`;
      try {
        const stored = JSON.parse(localStorage.getItem(lsKey) || "{}");
        if (stored.sort) document.getElementById("mclListSort").value = stored.sort;
        if (stored.showPast === true) document.getElementById("mclListShowPast").checked = true;
        if (stored.propId) propSelect.value = stored.propId;
      } catch (_) { /* ignore */ }

      const persist = () => {
        try {
          localStorage.setItem(lsKey, JSON.stringify({
            sort: document.getElementById("mclListSort").value,
            showPast: document.getElementById("mclListShowPast").checked,
            propId: propSelect.value,
          }));
        } catch (_) { /* ignore */ }
      };

      const refresh = () => { persist(); this._renderListBody(); };
      propSelect.addEventListener("change", refresh);
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
    const pid = document.getElementById("mclListProp").value;
    const showPast = document.getElementById("mclListShowPast").checked;
    const sortMode = document.getElementById("mclListSort").value || "date-desc";
    const today = new Date().toLocaleDateString("sv-SE");

    let items = (this._listData || []).filter(c => !pid || c.propertyId === pid);
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
    const card = (c, opts = {}) => {
      const pct = c._total > 0 ? Math.round(c._done / c._total * 100) : 0;
      const statusBadge = c._isCompleted
        ? `<span class="badge bg-success">完了</span>`
        : (c._isAllDone ? `<span class="badge bg-info">全項目済</span>` : `<span class="badge bg-warning text-dark">進行中</span>`);
      const dateHtml = opts.showDate
        ? `<span class="small ${c._dateStr === today ? 'text-primary fw-bold' : (c._dateStr < today ? 'text-muted' : '')}">${this.fmtDate(c._dateStr)}${c._dateStr === today ? ' (今日)' : ''}</span>`
        : "";
      const propHtml = opts.showProp
        ? `<strong>${this.escapeHtml(c.propertyName || "(物件不明)")}</strong>`
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
    const pid = document.getElementById("mclListProp").value;
    const todays = (this._listData || []).filter(c => c._dateStr === today && (!pid || c.propertyId === pid));
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
      (node.taskTypes || []).forEach(walk);
      (node.subCategories || []).forEach(walk);
      (node.subSubCategories || []).forEach(walk);
    };
    areas.forEach(walk);
    return n;
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

    // 物件の cleaningFlow と提出先マスターをキャッシュ (renderFooter で使用)
    try {
      const firstSnap = await db.collection("checklists").doc(this.checklistId).get();
      const pid = firstSnap.exists ? firstSnap.data().propertyId : null;
      if (pid) {
        const p = await db.collection("properties").doc(pid).get();
        this._propertyCleaningFlow = (p.exists && p.data().cleaningFlow) || {};
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
        // templateSnapshot (タブ構造) が変わっていなければ、body 全体を再構築せず
        // タブバッジ・エリア内容・フッターのみ更新 (ランドリー操作での微振動を回避)
        const templateChanged = !old
          || JSON.stringify(old.templateSnapshot || []) !== JSON.stringify(this.checklist.templateSnapshot || []);
        if (templateChanged) {
          this.renderTree();
        } else {
          // 差分更新
          this._updateHeaderStatus();
          this._updateTabBadges();
          this.renderActiveArea();
          this.renderFooter();
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
    const tabs = areas.map(a => {
      const isActive = a.id === this.activeAreaId;
      const done = this.countItemsDone(a, c.itemStates || {});
      const total = this.countItems([a]);
      const allDone = total > 0 && done === total;
      return `
        <li class="nav-item">
          <a class="nav-link ${isActive ? "active" : ""}" href="#" data-area-id="${a.id}"
             style="${isActive ? '' : `background:${allDone ? '#d1f5d6' : '#f1f3f5'};border:1px solid ${allDone ? '#74c786' : '#ced4da'};color:${allDone ? '#0b5d24' : '#495057'};`}font-weight:600;">
            ${this.escapeHtml(a.name)}
            <span class="badge ${isActive ? 'bg-light text-dark' : (allDone ? 'bg-success' : 'bg-secondary')} ms-1">${done}/${total}</span>
          </a>
        </li>
      `;
    }).join("");

    // タブを IntersectionObserver で監視し、sentinel が viewport を越えたら fixed 化。
    // IntersectionObserver は scroll event に依存せず動作するため、ページ内スクロールや
    // 親要素の overflow コンテキストに左右されず確実に動く。
    body.innerHTML = `
      <div class="mcl-tabs-wrap" style="background:#fff;border-bottom:1px solid #dee2e6;padding:4px 4px;">
        <ul class="nav nav-pills flex-nowrap overflow-auto mb-0" style="white-space:nowrap;gap:8px;">
          ${tabs}
        </ul>
      </div>
      <div id="mclAreaContent"></div>
      <div id="mclFooter" class="mt-4"></div>
    `;

    this._setupTabStickyObserver(body);
    // spacer 高さを header + tabs 分に揃える
    requestAnimationFrame(() => this._applyHeaderLayout());

    // タブの active クラス + inline style を一括更新 (body 再構築は避ける = 横スクロール位置維持)
    const updateTabStyles = () => {
      body.querySelectorAll(".nav-link[data-area-id]").forEach(n => {
        const aid = n.dataset.areaId;
        const area = areas.find(a => a.id === aid);
        if (!area) return;
        const isActive = aid === this.activeAreaId;
        const done = this.countItemsDone(area, c.itemStates || {});
        const total = this.countItems([area]);
        const allDone = total > 0 && done === total;
        n.classList.toggle("active", isActive);
        // active 時は inline style をクリアし Bootstrap の青ピルを優先させる
        n.setAttribute("style", isActive
          ? "font-weight:600;"
          : `background:${allDone ? '#d1f5d6' : '#f1f3f5'};border:1px solid ${allDone ? '#74c786' : '#ced4da'};color:${allDone ? '#0b5d24' : '#495057'};font-weight:600;`);
        const badge = n.querySelector(".badge");
        if (badge) {
          badge.className = `badge ${isActive ? 'bg-light text-dark' : (allDone ? 'bg-success' : 'bg-secondary')} ms-1`;
          badge.textContent = `${done}/${total}`;
        }
      });
    };

    body.querySelectorAll("[data-area-id]").forEach(el => {
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        this.activeAreaId = el.dataset.areaId;
        updateTabStyles();
        this.renderActiveArea();
      });
    });

    this.renderActiveArea();
    this.renderFooter();
  },

  // ヘッダーの物件名・進捗バッジ更新 (body 再構築なし)
  _updateHeaderStatus() {
    const c = this.checklist;
    if (!c) return;
    const headerEl = document.getElementById("mclHeader");
    if (headerEl) headerEl.textContent = `${c.propertyName || ""}  ${this.fmtDate(c.checkoutDate)}`;
    const total = this.countItems(c.templateSnapshot || []);
    const done = this.countDone(c.templateSnapshot || [], c.itemStates || {});
    const statusEl = document.getElementById("mclStatus");
    if (statusEl) {
      statusEl.textContent = `${done}/${total}`;
      statusEl.className = `badge ${total > 0 && done === total ? "bg-success" : "bg-secondary"} small`;
    }
  },

  // タブバッジ (N/M) とタブの完了色を更新 (タブ DOM 自体は再生成しない)
  _updateTabBadges() {
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
      const isActive = n.classList.contains("active");
      // 非 active の inline style と badge のみ更新
      if (!isActive) {
        n.setAttribute("style", `background:${allDone ? '#d1f5d6' : '#f1f3f5'};border:1px solid ${allDone ? '#74c786' : '#ced4da'};color:${allDone ? '#0b5d24' : '#495057'};font-weight:600;`);
      }
      const badge = n.querySelector(".badge");
      if (badge) {
        badge.className = `badge ${isActive ? 'bg-light text-dark' : (allDone ? 'bg-success' : 'bg-secondary')} ms-1`;
        badge.textContent = `${done}/${total}`;
      }
    });
  },

  // タブ wrap を「常に画面上端固定」にする。scroll 監視や IntersectionObserver を使わず、
  // 最初から position:fixed にすることで、親要素のスクロール context に依存せず確実に効く。
  // ヘッダー (mcl-page-header) のすぐ下に配置する。
  _setupTabStickyObserver(body) {
    const wrap = body.querySelector(".mcl-tabs-wrap");
    if (!wrap) return;
    const applyLayout = () => {
      const mainEl = document.querySelector(".app-main");
      const rect = mainEl ? mainEl.getBoundingClientRect() : { left: 0, width: window.innerWidth };
      const topbar = document.querySelector(".app-topbar");
      const topbarH = topbar ? topbar.getBoundingClientRect().height : 0;
      const header = document.querySelector(".mcl-page-header");
      const headerH = header ? header.getBoundingClientRect().height : 0;
      wrap.style.position = "fixed";
      wrap.style.top = (topbarH + headerH) + "px";
      wrap.style.left = rect.left + "px";
      wrap.style.width = rect.width + "px";
      wrap.style.zIndex = "28";
      wrap.style.background = "#fff";
      wrap.style.boxShadow = "0 2px 6px rgba(0,0,0,0.06)";
      // fixed 化後に rAF で実レイアウト高さを測って spacer 更新
      requestAnimationFrame(() => {
        const spacer = document.querySelector(".mcl-page-header-spacer");
        if (spacer) spacer.style.height = (topbarH + headerH + wrap.getBoundingClientRect().height) + "px";
      });
    };
    // 旧 handler 解除
    if (this._tabsResizeHandler) window.removeEventListener("resize", this._tabsResizeHandler);
    this._tabsResizeHandler = applyLayout;
    window.addEventListener("resize", applyLayout, { passive: true });
    requestAnimationFrame(applyLayout);

    // タブクリック時にそのタブを tab bar の左端へスクロール (要望)
    const listEl = wrap.querySelector(".nav-pills");
    if (listEl) {
      wrap.querySelectorAll(".nav-link[data-area-id]").forEach(el => {
        el.addEventListener("click", () => {
          // setTimeout で active 切替後にスクロール
          setTimeout(() => {
            const left = el.offsetLeft;
            listEl.scrollTo({ left: Math.max(0, left - 4), behavior: "smooth" });
          }, 0);
        });
      });
    }
  },

  // ===== フッター: ランドリー 3 ボタン + 清掃完了ボタン =====
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
    const laundryEnabled = {
      putOut: !isCompleted,
      collected: !isCompleted && (collectedInfo.active || putOutInfo.active),
      stored: !isCompleted && (storedInfo.active || collectedInfo.active),
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
      <div class="card mb-3">
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
          <div class="card-body">
            <h6 class="card-title"><i class="bi bi-flag-fill text-success"></i> 清掃完了</h6>
            ${!allDone ? `
              <div class="alert alert-info py-2 small mb-2">
                <i class="bi bi-info-circle"></i>
                未チェック <strong>${total - done}</strong> 件。ランドリー記録も完了処理も未チェックのまま進められます。
              </div>` : `
              <div class="alert alert-success py-2 small mb-2">
                <i class="bi bi-check-circle"></i> 全項目チェック済み (${done}/${total})。完了処理を行えます。
              </div>`}
            <button type="button" class="btn btn-success btn-lg w-100" id="mclCompleteBtn">
              <i class="bi bi-check2-circle"></i> 清掃完了にする
            </button>
            <div class="small text-muted mt-2">
              完了するとオーナーに清掃完了通知、ランドリー入力のリマインドが送信されます。
            </div>
          </div>
        </div>`;

    el.innerHTML = laundrySection + completeSection;

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
      name: this.staffDoc?.name || user?.displayName || "",
    };
    const patch = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    if (current) {
      // 解除権限: ボタンを押した本人 / オーナー / サブオーナーのみ可
      const role = (Auth.currentUser && Auth.currentUser.role) || "staff";
      const isPrivileged = role === "owner" || role === "sub_owner";
      const isAuthor = current?.by?.uid && current.by.uid === user?.uid;
      if (!isAuthor && !isPrivileged) {
        showToast("解除不可", `この記録は「${current?.by?.name || "前のスタッフ"}」のものです。本人かオーナー/サブオーナーのみ解除できます。`, "error");
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
      // プリカ残高を自動減算
      if (info.paymentMethod === "prepaid" && info.prepaidId && info.amount) {
        try {
          const doc = await firebase.firestore().collection("settings").doc("prepaidCards").get();
          if (doc.exists) {
            const items = (doc.data().items || []).map(c => {
              if (c.id === info.prepaidId) {
                return { ...c, balance: Math.max(0, (Number(c.balance) || 0) - Number(info.amount)) };
              }
              return c;
            });
            await firebase.firestore().collection("settings").doc("prepaidCards").set({
              items,
              updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
          }
        } catch (e) { console.warn("プリカ残高減算失敗:", e.message); }
      }
      // laundry コレクションにも記録 (請求書自動集計用)
      try {
        await firebase.firestore().collection("laundry").add({
          date: new Date(),
          staffId: this.staffDoc?.id || "",
          propertyId: this.checklist?.propertyId || "",
          amount: Number(info.amount) || 0,
          depot: info.depot || "",
          depotOther: info.depotOther || "",
          paymentMethod: info.paymentMethod || "",
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
              <!-- ステップ3: プリカ選択 (支払方法=prepaid 時のみ) -->
              <div class="mb-3 d-none" id="lpoPrepaidWrap">
                <label class="form-label">③ プリカ選択 <span class="text-danger">*</span></label>
                <select class="form-select" id="lpoPrepaid">
                  <option value="">-- プリカを選択 --</option>
                </select>
                <div class="form-text">残高表示付き。プリカ管理はオーナー側で登録してください。</div>
              </div>
              <!-- ステップ3': 料金プリセット (支払方法=cash/credit/invoice 時) -->
              <div class="mb-3 d-none" id="lpoRateWrap">
                <label class="form-label">③ 料金プリセット <span class="text-danger">*</span></label>
                <select class="form-select" id="lpoRate"></select>
                <input type="number" class="form-control mt-2 d-none" id="lpoRateOther" min="0" placeholder="金額を手入力(円)">
              </div>
              <!-- ステップ4: メモ -->
              <div class="mb-3">
                <label class="form-label">④ メモ</label>
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
        // ステップ3の表示: 支払方法で分岐
        if (payV === "prepaid") {
          rateWrap.classList.add("d-none");
          prepaidWrap.classList.remove("d-none");
          // プリカをフィルタ (該当 depot に紐づくカードが優先、全体も表示)
          let filtered = prepaidCards;
          if (depotV !== "" && depotV !== "__other__") {
            const depotObj = depotMaster[+depotV];
            const depotId = depotObj?.id || depotObj?.name;
            const byDepot = prepaidCards.filter(c => c.depotId === depotId);
            if (byDepot.length) filtered = byDepot;
          }
          prepaidSel.innerHTML = `<option value="">-- プリカを選択 --</option>` +
            filtered.map(c => `<option value="${c.id}" data-balance="${c.balance || 0}" data-label="${(c.label||'').replace(/"/g,'&quot;')}">${(c.label||"").replace(/</g,"&lt;")}${c.cardNumber ? " #" + c.cardNumber : ""} (残高 ¥${(c.balance||0).toLocaleString()})</option>`).join("");
          if (!filtered.length) {
            prepaidSel.innerHTML = `<option value="">プリカが登録されていません</option>`;
          }
        } else if (payV === "cash" || payV === "credit" || payV === "invoice") {
          prepaidWrap.classList.add("d-none");
          rateWrap.classList.remove("d-none");
          const depot = depotV === "__other__" ? null : depotMaster[+depotV];
          const rates = (depot && depot.rates) || [];
          rateSel.innerHTML = `<option value="">-- 料金プリセットを選択 --</option>` +
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
          prepaidId = prepaidSel.value;
          if (!prepaidId) { showToast("入力エラー", "プリカを選択してください", "error"); return; }
          const opt = prepaidSel.options[prepaidSel.selectedIndex];
          prepaidLabel = opt?.dataset?.label || "";
          // プリペイドの場合、金額は「料金プリセット標準」を採用 (なければ0)
          const depot = depotIdx === "__other__" ? null : depotMaster[+depotIdx];
          const firstRate = depot?.rates?.[0];
          amount = firstRate ? Number(firstRate.amount) || 0 : 0;
          rateLabel = firstRate?.label || "";
        } else {
          const rv = rateSel.value;
          if (!rv) { showToast("入力エラー", "料金プリセットを選択してください", "error"); return; }
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
    if (!allDone) {
      const ok = await showConfirm(
        `未チェックの項目が ${unchecked} 件あります。それでも清掃完了にしますか？`,
        { title: "清掃完了の確認", okLabel: "完了にする", okClass: "btn-success" }
      );
      if (!ok) return;
    }
    const btn = document.getElementById('mclCompleteBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 処理中...'; }
    try {
      const user = firebase.auth().currentUser;
      await firebase.firestore().collection("checklists").doc(this.checklistId).update({
        status: "completed",
        completedAt: firebase.firestore.FieldValue.serverTimestamp(),
        completedBy: {
          uid: user?.uid || "",
          name: this.staffDoc?.name || user?.displayName || "",
        },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      showToast("清掃完了", "お疲れさまでした！ オーナーに通知しました。", "success");
      // 自動遷移はしない (その場で完了済みカード表示に切り替わる: onSnapshot → renderFooter)
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-check2-circle"></i> 清掃完了にする'; }
      showToast("エラー", e.message, "error");
    }
  },

  renderActiveArea() {
    const areas = this.checklist.templateSnapshot || [];
    const area = areas.find(a => a.id === this.activeAreaId);
    if (!area) return;
    const el = document.getElementById("mclAreaContent");
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
    // 全チェック/全外し
    el.querySelector(".mcl-toggle-all-check")?.addEventListener("click", () => this.toggleAllCheckInArea(area, allChecked));
    // 全展開/全折りたたみ
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
