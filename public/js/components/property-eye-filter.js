/**
 * 目アイコン型の物件フィルター (横カレンダー/my-checklist と同じ見た目で統一)
 *
 * 使い方:
 *   const ctrl = PropertyEyeFilter.render({
 *     containerId: "propEyeFilterHost-invoices",
 *     tabKey: "invoices",
 *     properties: [...],                 // listMinpakuNumbered の結果 ({id, name, _num, _color})
 *     onChange: (visibleIds) => { ... }, // 表示対象物件 ID 配列
 *   });
 *
 * 返り値: { getVisibleIds(), getHiddenIds(), isVisible(propId), setAll(visible) }
 *
 * localStorage key: propEyeFilter_${tabKey}
 *   値: { [propertyId]: false }  // false のみ保存 (未記載は visible)
 *
 * 物件オーナー / impersonation 対応:
 *   ownedPropertyIds で事前に properties を絞り込む (呼び出し側の責務にはせず内部で対応)
 */
const PropertyEyeFilter = {

  render({ containerId, tabKey, properties, onChange }) {
    const container = document.getElementById(containerId);
    if (!container) return this._emptyController();

    // 物件オーナー / impersonation 強制フィルタ
    const owned = this._getForcedIds(properties);
    const effectiveProps = owned === null
      ? [...(properties || [])]
      : (properties || []).filter(p => owned.includes(p.id));

    // 物件番号昇順ソート
    effectiveProps.sort((a, b) => {
      const na = Number(a._num) || 9999;
      const nb = Number(b._num) || 9999;
      if (na !== nb) return na - nb;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });

    if (effectiveProps.length === 0) {
      container.innerHTML = "";
      return this._emptyController();
    }

    const lsKey = `propEyeFilter_${tabKey}`;
    const visibility = this._loadVisibility(lsKey, effectiveProps);

    const save = () => {
      try {
        // false のみ保存 (visible = 未記載)
        const toSave = {};
        Object.keys(visibility).forEach(id => {
          if (visibility[id] === false) toSave[id] = false;
        });
        localStorage.setItem(lsKey, JSON.stringify(toSave));
      } catch (_) {}
    };

    const getVisibleIds = () => effectiveProps
      .filter(p => visibility[p.id] !== false)
      .map(p => p.id);

    const getHiddenIds = () => effectiveProps
      .filter(p => visibility[p.id] === false)
      .map(p => p.id);

    const render = () => {
      container.innerHTML = this._buildHTML(effectiveProps, visibility);
      container.querySelectorAll(".pef-toggle").forEach(btn => {
        btn.addEventListener("click", () => {
          const pid = btn.getAttribute("data-prop-id");
          visibility[pid] = !(visibility[pid] !== false); // toggle
          save();
          render();
          if (onChange) onChange(getVisibleIds());
        });
      });
      // 全ON / 全OFF
      const allBtn = container.querySelector(".pef-all");
      const noneBtn = container.querySelector(".pef-none");
      if (allBtn) allBtn.addEventListener("click", () => {
        effectiveProps.forEach(p => { visibility[p.id] = true; });
        save(); render();
        if (onChange) onChange(getVisibleIds());
      });
      if (noneBtn) noneBtn.addEventListener("click", () => {
        effectiveProps.forEach(p => { visibility[p.id] = false; });
        save(); render();
        if (onChange) onChange(getVisibleIds());
      });
    };

    render();
    // 初期状態で一度発火 (呼び出し側がシンプルになる)
    setTimeout(() => { if (onChange) onChange(getVisibleIds()); }, 0);

    return {
      getVisibleIds,
      getHiddenIds,
      isVisible: (pid) => visibility[pid] !== false,
      setAll: (visible) => {
        effectiveProps.forEach(p => { visibility[p.id] = !!visible; });
        save(); render();
        if (onChange) onChange(getVisibleIds());
      },
    };
  },

  _emptyController() {
    return {
      getVisibleIds: () => [],
      getHiddenIds: () => [],
      isVisible: () => true,
      setAll: () => {},
    };
  },

  /** 物件オーナー / impersonation の強制フィルタ ID 配列 (対象外は null) */
  _getForcedIds(properties) {
    if (typeof App !== "undefined" && App.impersonating && App.impersonatingData) {
      const owned = App.impersonatingData.ownedPropertyIds || [];
      return (properties || []).filter(p => owned.includes(p.id)).map(p => p.id);
    }
    if (typeof Auth !== "undefined" && Auth.currentUser?.role === "sub_owner") {
      const owned = Auth.currentUser.ownedPropertyIds || [];
      return (properties || []).filter(p => owned.includes(p.id)).map(p => p.id);
    }
    return null;
  },

  _loadVisibility(lsKey, props) {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(lsKey) || "{}") || {}; } catch (_) { stored = {}; }
    const vis = {};
    props.forEach(p => {
      vis[p.id] = stored[p.id] !== false; // 既定 true
    });
    return vis;
  },

  _buildHTML(properties, visibility) {
    const buttons = properties.map(p => {
      const visible = visibility[p.id] !== false;
      const icon = visible ? "bi-eye" : "bi-eye-slash";
      const opacity = visible ? "1" : "0.35";
      const color = p._color || p.color || "#6c757d";
      const num = p._num || "";
      const name = this._esc((p.name || "").slice(0, 10));
      return `
        <button type="button" class="pef-toggle" data-prop-id="${this._esc(p.id)}"
          style="border:1px solid #ced4da;background:#fff;border-radius:6px;padding:3px 8px;display:inline-flex;align-items:center;gap:4px;cursor:pointer;opacity:${opacity};">
          <i class="bi ${icon}"></i>
          <span class="badge" style="background:${this._esc(color)};color:#fff;">${this._esc(String(num))}</span>
          ${name}
        </button>`;
    }).join("");

    return `
      <div class="property-eye-filter d-flex flex-wrap gap-2 align-items-center mb-3">
        <span class="text-muted small me-1">物件:</span>
        ${buttons}
        <button type="button" class="btn btn-sm btn-outline-secondary pef-all">全表示</button>
        <button type="button" class="btn btn-sm btn-outline-secondary pef-none">全非表示</button>
      </div>
    `;
  },

  _esc(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  },
};
