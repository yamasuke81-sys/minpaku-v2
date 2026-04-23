/**
 * 共通物件フィルタコンポーネント
 *
 * 使い方:
 *   PropertyFilter.render({
 *     containerId: "propertyFilterHost-guests",
 *     tabKey: "guests",
 *     properties: [...],  // API.properties.listMinpakuNumbered() の結果
 *     onChange: (selectedIds) => { ... },
 *   });
 *
 * localStorage キー:
 *   propertyFilter:global            = JSON配列 (選択中のpropertyId)
 *   propertyFilter:{tabKey}          = JSON配列 (タブ別)
 *   propertyFilter:{tabKey}:useGlobal = "true" / "false"
 */
const PropertyFilter = {

  /**
   * フィルタUIを描画してイベントをバインドする
   * @param {Object} opts
   * @param {string} opts.containerId  描画先の要素ID
   * @param {string} opts.tabKey       タブ識別子 (localStorage key 生成に使用)
   * @param {Array}  opts.properties   物件一覧 (_num, _color 付き = listMinpakuNumbered の結果)
   * @param {Function} opts.onChange   選択変化時コールバック (selectedIds: string[]) => void
   */
  render({ containerId, tabKey, properties, onChange }) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!properties || properties.length === 0) {
      container.innerHTML = "";
      return;
    }

    // 物件オーナー / impersonation 時は選択肢を強制制限
    const forcedIds = this._getForcedIds(properties);
    const isForcedMode = forcedIds !== null;

    // 現在の選択状態を復元
    const useGlobal = this._getUseGlobal(tabKey);
    const selectedIds = isForcedMode ? forcedIds : this._getSelectedIds(tabKey, properties);

    container.innerHTML = this._buildHTML(tabKey, properties, selectedIds, useGlobal, isForcedMode);
    this._bindEvents(container, tabKey, properties, selectedIds, onChange, isForcedMode);
  },

  /**
   * 現在の選択済みIDを取得する (外部から参照用)
   * 物件オーナーまたは impersonation 中は ownedPropertyIds に強制制限
   * @param {string} tabKey
   * @param {Array}  properties
   * @returns {string[]}
   */
  getSelectedIds(tabKey, properties) {
    const forcedIds = this._getForcedIds(properties);
    if (forcedIds !== null) return forcedIds;
    return this._getSelectedIds(tabKey, properties);
  },

  /**
   * 物件オーナー / impersonation 時の強制フィルタIDを返す
   * 対象外の場合は null を返す
   */
  _getForcedIds(properties) {
    // impersonation (Webアプリ管理者が物件オーナー代理閲覧中)
    if (typeof App !== "undefined" && App.impersonating && App.impersonatingData) {
      const owned = App.impersonatingData.ownedPropertyIds || [];
      return properties.filter(p => owned.includes(p.id)).map(p => p.id);
    }
    // 物件オーナー本人のログイン
    if (typeof Auth !== "undefined" && Auth.currentUser?.role === "sub_owner") {
      const owned = Auth.currentUser.ownedPropertyIds || [];
      return properties.filter(p => owned.includes(p.id)).map(p => p.id);
    }
    return null;
  },

  // === 内部メソッド ===

  /** グローバル使用フラグを取得 (デフォルト: true) */
  _getUseGlobal(tabKey) {
    try {
      const val = localStorage.getItem(`propertyFilter:${tabKey}:useGlobal`);
      return val === null ? true : val === "true";
    } catch (_) {
      return true;
    }
  },

  /** 選択済みIDリストを取得 */
  _getSelectedIds(tabKey, properties) {
    const allIds = properties.map(p => p.id);
    const useGlobal = this._getUseGlobal(tabKey);
    const key = useGlobal ? "propertyFilter:global" : `propertyFilter:${tabKey}`;
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return [...allIds]; // 未保存 = 全ON
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved)) return [...allIds];
      // 保存された選択を有効な物件IDのみに絞る
      return saved.filter(id => allIds.includes(id));
    } catch (_) {
      return [...allIds];
    }
  },

  /** 選択済みIDを保存 */
  _saveSelectedIds(tabKey, selectedIds) {
    const useGlobal = this._getUseGlobal(tabKey);
    const key = useGlobal ? "propertyFilter:global" : `propertyFilter:${tabKey}`;
    try {
      localStorage.setItem(key, JSON.stringify(selectedIds));
    } catch (_) {}
  },

  /** グローバル使用フラグを保存 */
  _saveUseGlobal(tabKey, value) {
    try {
      localStorage.setItem(`propertyFilter:${tabKey}:useGlobal`, value ? "true" : "false");
    } catch (_) {}
  },

  /** チェックボックスのHTML文字列を生成 */
  _buildHTML(tabKey, properties, selectedIds, useGlobal, isForcedMode = false) {
    const selectedSet = new Set(selectedIds);
    const checkboxes = properties.map(p => {
      const checked = selectedSet.has(p.id);
      const color = p._color || p.color || "#6c757d";
      const num = p._num || "";
      return `
        <div class="form-check form-check-inline mb-0">
          <input class="form-check-input pf-check" type="checkbox"
            id="pf-${this._esc(tabKey)}-${p.id}"
            value="${p.id}"
            ${checked ? "checked" : ""}
            style="border-color:${this._esc(color)};background-color:${checked ? this._esc(color) : "#fff"};">
          <label class="form-check-label" for="pf-${this._esc(tabKey)}-${p.id}">
            <span class="badge" style="background:${this._esc(color)};color:#fff;font-size:11px;">#${num}</span>
            <span class="text-muted" style="font-size:12px;">${this._esc(p.name)}</span>
          </label>
        </div>
      `;
    }).join("");

    // 物件オーナー / impersonation 時は操作UI を非表示にして「フィルタ固定」バッジだけ表示
    const controlsHtml = isForcedMode
      ? `<span class="badge bg-warning text-dark ms-2"><i class="bi bi-lock-fill"></i> 物件フィルタ固定中</span>`
      : `
        <button class="btn btn-sm btn-outline-secondary pf-all" type="button">全ON</button>
        <button class="btn btn-sm btn-outline-secondary pf-none" type="button">全OFF</button>
        <div class="form-check form-switch ms-3 mb-0">
          <input class="form-check-input pf-global-toggle" type="checkbox"
            id="pf-${this._esc(tabKey)}-global"
            ${useGlobal ? "checked" : ""}>
          <label class="form-check-label small text-muted" for="pf-${this._esc(tabKey)}-global">全タブ共通</label>
        </div>
      `;

    return `
      <div class="property-filter d-flex flex-wrap gap-2 align-items-center mb-3">
        <span class="text-muted small me-1">物件:</span>
        ${checkboxes}
        ${controlsHtml}
      </div>
    `;
  },

  /** イベントバインド */
  _bindEvents(container, tabKey, properties, initialSelectedIds, onChange, isForcedMode = false) {
    // 物件オーナー強制モードでは変更不可（初期値のみで onChange を一度呼ぶ）
    if (isForcedMode) {
      setTimeout(() => onChange && onChange([...initialSelectedIds]), 0);
      return;
    }

    // 現在の選択状態 (ミュータブル)
    let selectedIds = [...initialSelectedIds];

    const fire = () => onChange && onChange([...selectedIds]);

    // 各チェックボックス
    container.querySelectorAll(".pf-check").forEach(cb => {
      cb.addEventListener("change", () => {
        const pid = cb.value;
        const p = properties.find(x => x.id === pid);
        const color = (p && (p._color || p.color)) || "#6c757d";

        if (cb.checked) {
          if (!selectedIds.includes(pid)) selectedIds.push(pid);
          cb.style.backgroundColor = color;
        } else {
          selectedIds = selectedIds.filter(id => id !== pid);
          cb.style.backgroundColor = "#fff";
        }

        this._saveSelectedIds(tabKey, selectedIds);
        fire();
      });
    });

    // 全ON
    container.querySelector(".pf-all").addEventListener("click", () => {
      selectedIds = properties.map(p => p.id);
      container.querySelectorAll(".pf-check").forEach(cb => {
        cb.checked = true;
        const p = properties.find(x => x.id === cb.value);
        cb.style.backgroundColor = (p && (p._color || p.color)) || "#6c757d";
      });
      this._saveSelectedIds(tabKey, selectedIds);
      fire();
    });

    // 全OFF
    container.querySelector(".pf-none").addEventListener("click", () => {
      selectedIds = [];
      container.querySelectorAll(".pf-check").forEach(cb => {
        cb.checked = false;
        cb.style.backgroundColor = "#fff";
      });
      this._saveSelectedIds(tabKey, selectedIds);
      fire();
    });

    // グローバルトグル
    container.querySelector(".pf-global-toggle").addEventListener("change", (e) => {
      const nowGlobal = e.target.checked;
      this._saveUseGlobal(tabKey, nowGlobal);

      // 切替後はそのキーに保存されている選択に更新
      const newSelected = this._getSelectedIds(tabKey, properties);
      selectedIds = newSelected;

      // チェックボックスUIを更新
      const selectedSet = new Set(selectedIds);
      container.querySelectorAll(".pf-check").forEach(cb => {
        const checked = selectedSet.has(cb.value);
        cb.checked = checked;
        const p = properties.find(x => x.id === cb.value);
        const color = (p && (p._color || p.color)) || "#6c757d";
        cb.style.backgroundColor = checked ? color : "#fff";
      });

      fire();
    });
  },

  /** XSS対策エスケープ */
  _esc(str) {
    return String(str || "").replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  },
};
