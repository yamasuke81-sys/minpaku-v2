/**
 * 物件管理ページ
 * 一覧・登録・編集・無効化（BEDS24物件IDフィールド付き）
 */
// LINE チャネル配列の上限（将来拡張しやすいよう定数化）
const LINE_CHANNELS_MAX = 2;

// 物件番号プルダウンの候補範囲
const PROPERTY_NUMBER_MAX = 20;

// 物件表示色のプリセット候補
const PRESET_COLORS = [
  { value: "#dc3545", name: "赤" },
  { value: "#198754", name: "緑" },
  { value: "#0d6efd", name: "青" },
  { value: "#ffc107", name: "黄" },
  { value: "#6f42c1", name: "紫" },
  { value: "#fd7e14", name: "オレンジ" },
  { value: "#20c997", name: "ティール" },
  { value: "#d63384", name: "ピンク" },
  { value: "#6c757d", name: "グレー" },
  { value: "#0dcaf0", name: "シアン" },
];

// ソート選択の localStorage キー
const PROP_SORT_KEY_STORAGE = "propSortKey_v1";
// 種別の並び順 (種類別ソート時に使用)
const TYPE_ORDER = { minpaku: 0, rental: 1, other: 2 };

const PropertiesPage = {
  propertyList: [],
  modal: null,
  editingId: null,       // 現在編集中の物件ID (新規=null)
  _autoSaveTimer: null,  // 自動保存デバウンスタイマー
  // 現在モーダルに表示している LINE チャネル配列（保存済みトークンを保持するため）
  _lineChannels: [],
  // Webアプリ管理者候補 (isOwner or isSubOwner の staff)
  _ownerStaffOptions: [],
  // カード一覧のソートキー
  sortKey: "manual",
  // D&D 用 Sortable インスタンス
  _cardSortable: null,

  async render(container) {
    // 保存済みソートキーを復元
    try {
      const saved = localStorage.getItem(PROP_SORT_KEY_STORAGE);
      if (saved) this.sortKey = saved;
    } catch (e) {}

    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-buildings"></i> 物件管理</h2>
        <div class="d-flex align-items-center gap-2">
          <label class="small text-muted mb-0">並び順:</label>
          <select id="propSortKey" class="form-select form-select-sm" style="width:auto;">
            <option value="manual">手動並び順 (ドラッグ&ドロップ)</option>
            <option value="number">物件番号順</option>
            <option value="name">物件名順 (あいうえお)</option>
            <option value="type">種類別 (民泊/賃貸/その他)</option>
            <option value="createdAt-desc">登録日 (新しい順)</option>
            <option value="createdAt-asc">登録日 (古い順)</option>
          </select>
          <button class="btn btn-primary" id="btnAddProperty">
            <i class="bi bi-plus-lg"></i> 物件登録
          </button>
        </div>
      </div>

      <div class="row g-3" id="propertyCards">
        <div class="col-12 text-center py-4">読み込み中...</div>
      </div>
    `;

    // ソートキー初期値反映
    const sortSel = document.getElementById("propSortKey");
    if (sortSel) sortSel.value = this.sortKey;

    this.modal = new bootstrap.Modal(document.getElementById("propertyModal"));
    // モーダル閉了時は編集中IDをクリア (重複判定の残存バグ防止)
    const modalEl = document.getElementById("propertyModal");
    if (modalEl && !modalEl.dataset.hiddenBound) {
      modalEl.dataset.hiddenBound = "1";
      modalEl.addEventListener("hidden.bs.modal", () => {
        this.editingId = null;
      });
    }
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

    const sortSel = document.getElementById("propSortKey");
    if (sortSel) {
      sortSel.addEventListener("change", () => {
        this.sortKey = sortSel.value;
        try { localStorage.setItem(PROP_SORT_KEY_STORAGE, this.sortKey); } catch (e) {}
        this.renderCards();
      });
    }
  },

  // 現在の sortKey に従って propertyList をソートした配列を返す (非破壊)
  _sortedProperties() {
    const arr = [...(this.propertyList || [])];
    const byOrder = (a, b) => {
      const av = a.displayOrder == null ? Infinity : Number(a.displayOrder);
      const bv = b.displayOrder == null ? Infinity : Number(b.displayOrder);
      return av - bv;
    };
    const toMs = (t) => {
      if (!t) return 0;
      if (typeof t.toDate === "function") return t.toDate().getTime();
      if (t.seconds != null) return t.seconds * 1000;
      if (t instanceof Date) return t.getTime();
      const n = new Date(t).getTime();
      return isNaN(n) ? 0 : n;
    };
    switch (this.sortKey) {
      case "number":
        arr.sort((a, b) => {
          const av = a.propertyNumber == null ? Infinity : Number(a.propertyNumber);
          const bv = b.propertyNumber == null ? Infinity : Number(b.propertyNumber);
          return av - bv;
        });
        break;
      case "name":
        arr.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ja"));
        break;
      case "type":
        arr.sort((a, b) => {
          const at = TYPE_ORDER[a.type] ?? 99;
          const bt = TYPE_ORDER[b.type] ?? 99;
          if (at !== bt) return at - bt;
          return byOrder(a, b);
        });
        break;
      case "createdAt-desc":
        arr.sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
        break;
      case "createdAt-asc":
        arr.sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
        break;
      case "manual":
      default:
        arr.sort(byOrder);
        break;
    }
    return arr;
  },

  async loadProperties() {
    try {
      this.propertyList = await API.properties.list(false);
      // impersonation 中 (メインWebアプリ管理者が物件オーナー代理閲覧): 所有物件のみ表示
      if (typeof App !== "undefined" && App.impersonating && App.impersonatingData) {
        const owned = App.impersonatingData.ownedPropertyIds || [];
        this.propertyList = this.propertyList.filter(p => owned.includes(p.id));
      }
      // サブオーナー本人ログイン: 所有物件のみ表示
      if (Auth.isSubOwner()) {
        const owned = Array.isArray(Auth.currentUser?.ownedPropertyIds)
          ? Auth.currentUser.ownedPropertyIds : [];
        this.propertyList = this.propertyList.filter(p => owned.includes(p.id));
        // 物件登録ボタンを非表示 (新規物件作成はオーナーのみ)
        const btnAdd = document.getElementById("btnAddProperty");
        if (btnAdd) btnAdd.style.display = "none";
      }
      // Webアプリ管理者候補 (isOwner or isSubOwner の staff) を取得
      await this._loadOwnerStaffOptions();
      this.renderCards();
      // 外部から sessionStorage 経由でモーダル直接オープンを要求された場合に対応
      this._openFromSession();
    } catch (e) {
      showToast("エラー", `物件読み込み失敗: ${e.message}`, "error");
    }
  },

  // sessionStorage "openPropertyEdit" に物件IDが入っていたらモーダルを自動オープン
  _openFromSession() {
    try {
      const targetId = sessionStorage.getItem("openPropertyEdit");
      if (!targetId) return;
      sessionStorage.removeItem("openPropertyEdit");
      const prop = this.propertyList.find(p => p.id === targetId);
      if (prop) {
        setTimeout(() => this.openModal(prop), 100);
      }
    } catch (e) {
      console.warn("[properties _openFromSession]", e.message);
    }
  },

  // Webアプリ管理者候補 (請求書宛名用) を staff から取得
  async _loadOwnerStaffOptions() {
    try {
      const snap = await db.collection("staff").orderBy("displayOrder", "asc").get();
      this._ownerStaffOptions = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(s => s.isOwner === true || s.isSubOwner === true);
    } catch (e) {
      console.warn("Webアプリ管理者候補読込失敗:", e.message);
      this._ownerStaffOptions = [];
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
    const sorted = this._sortedProperties();
    const canDrag = this.sortKey === "manual";

    container.innerHTML = sorted.map((p) => `
      <div class="col-md-6 col-lg-4 prop-card-col" data-id="${p.id}">
        <div class="card h-100 ${p.active ? "" : "border-secondary opacity-50"}">
          <div class="card-body">
            <div class="d-flex justify-content-between align-items-start mb-1">
              <h5 class="card-title mb-0">
                ${canDrag ? '<i class="bi bi-grip-vertical text-muted me-1 prop-card-handle" style="cursor:grab;" title="ドラッグで並び替え"></i>' : ''}
                ${renderPropertyNumberBadge(p)}${this.escapeHtml(p.name)}
              </h5>
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
              <button class="btn btn-sm btn-success btn-activate-property float-end ms-1" data-id="${p.id}">
                <i class="bi bi-check2-circle"></i> 有効化
              </button>
              <button class="btn btn-sm btn-danger btn-force-delete-property float-end" data-id="${p.id}" title="Firestore からこの物件を完全に削除します (関連データは残ります)">
                <i class="bi bi-trash-fill"></i> 完全削除
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

    container.querySelectorAll(".btn-force-delete-property").forEach((btn) => {
      btn.addEventListener("click", () => {
        const prop = this.propertyList.find((p) => p.id === btn.dataset.id);
        if (prop) this.forceDeleteProperty(prop);
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

    // D&D 並び替え (手動並び順表示時のみ有効)
    this._initCardSortable(container, canDrag);
  },

  // 物件カードの Sortable 初期化
  _initCardSortable(container, enabled) {
    if (this._cardSortable) {
      try { this._cardSortable.destroy(); } catch (e) {}
      this._cardSortable = null;
    }
    if (!enabled || typeof Sortable === "undefined") return;
    this._cardSortable = Sortable.create(container, {
      handle: ".prop-card-handle",
      draggable: ".prop-card-col",
      animation: 150,
      onEnd: async () => {
        const ids = [...container.querySelectorAll(".prop-card-col")]
          .map(el => el.dataset.id).filter(Boolean);
        try {
          // displayOrder を並び順で再採番して Firestore に一括更新
          const updates = ids.map((id, i) =>
            db.collection("properties").doc(id).update({ displayOrder: i + 1 })
          );
          await Promise.all(updates);
          // ローカルも同期
          this.propertyList.forEach(p => {
            const idx = ids.indexOf(p.id);
            if (idx >= 0) p.displayOrder = idx + 1;
          });
          this._showSavedToast();
        } catch (e) {
          showToast("エラー", `並び順保存失敗: ${e.message}`, "error");
          await this.loadProperties();
        }
      },
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
    // 清掃必要人数: 早い者勝ち時のみ有効。それ以外はグレーアウト
    const _toggleReqCount = () => {
      const sel = document.getElementById("propertySelectionMethod");
      const inp = document.getElementById("propertyCleaningRequiredCount");
      const disabled = sel.value !== "firstCome";
      inp.disabled = disabled;
      inp.classList.toggle("bg-light", disabled);
    };
    _toggleReqCount();
    const _selEl = document.getElementById("propertySelectionMethod");
    if (!_selEl._reqCountBound) {
      _selEl.addEventListener("change", _toggleReqCount);
      _selEl._reqCountBound = true;
    }
    // 物件番号プルダウン / 色スウォッチを重複チェック込みで描画
    this._renderPropertyNumberSelect(property?.propertyNumber ?? null);
    this._renderPropertyColorSwatches(property?.color || "#0d6efd");
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

    // キーボックス番号: 予約フロー画面の keyboxCode と相互同期 (どちらかに値があれば優先)
    document.getElementById("propertyKeyboxNumber").value = property?.keyboxNumber || property?.keyboxCode || "";
    // タスク8-2: Wi-Fi SSID/パスワード (旧 wifiInfo は後方互換で読む)
    document.getElementById("propertyWifiSSID").value = property?.wifiSSID || "";
    document.getElementById("propertyWifiPassword").value = property?.wifiPassword || "";
    // タスク8-3: ポスト情報
    const postEnabled = !!property?.post?.enabled;
    document.getElementById("propertyPostEnabled").checked = postEnabled;
    document.getElementById("propertyPostCode").value = property?.post?.code || "";
    document.getElementById("propertyPostCodeWrap").style.display = postEnabled ? "" : "none";
    document.getElementById("propertyPostEnabled").onchange = function() {
      document.getElementById("propertyPostCodeWrap").style.display = this.checked ? "" : "none";
    };
    document.getElementById("propertyNotes").value = property?.notes || "";

    // 物件オーナー (請求書宛名) プルダウンを構築 + 名義 / 編集リンク
    // 絞り込みのため現在編集中の物件 ID を保持
    this._currentEditingPropertyId = property?.id || "";
    this._renderOwnerStaffSelect(property?.ownerStaffId || "");
    this._renderOwnerBillingProfileSelect(
      property?.ownerStaffId || "",
      property?.ownerBillingProfileId || ""
    );
    this._bindOwnerStaffChange();

    // LINE 連携フィールド
    document.getElementById("propertyLineEnabled").checked = !!property?.lineEnabled;

    // 配信モード初期化（デフォルト: fallback = 推奨）
    const deliveryMode = property?.lineDeliveryMode || "fallback";
    const deliveryRadio = document.querySelector(`input[name="propLineDeliveryMode"][value="${deliveryMode}"]`);
    if (deliveryRadio) {
      deliveryRadio.checked = true;
    } else {
      // デフォルト値に戻す
      const defaultRadio = document.querySelector(`input[name="propLineDeliveryMode"][value="fallback"]`);
      if (defaultRadio) defaultRadio.checked = true;
    }

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

    // --- Gmail 連携セクション（編集時のみ読み込み）---
    const gmailSection = document.getElementById("propertyGmailSection");
    if (isEdit) {
      if (gmailSection) gmailSection.innerHTML = '<div class="text-muted small">読み込み中...</div>';
      this._loadGmailSection(property.id, property.senderGmail || null);
    } else {
      if (gmailSection) gmailSection.innerHTML = '<p class="text-muted small">物件を保存してから Gmail を連携してください。</p>';
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

    // 物件オーナー (請求書宛名) 必須チェック
    const ownerStaffId = document.getElementById("propertyOwnerStaffId")?.value || "";
    if (!ownerStaffId) {
      showToast("入力エラー", "物件オーナーは必須です。スタッフ管理画面で「物件オーナー設定」が ON のスタッフを登録し、所有物件にこの物件をチェックしてください。", "error");
      return;
    }

    // 物件番号 / 色の他物件重複チェック
    const numRaw = document.getElementById("propertyNumber").value;
    const numVal = numRaw === "" ? null : Number(numRaw);
    const colorVal = document.getElementById("propertyColor").value || null;
    const dup = this._findDuplicateNumberOrColor(id, numVal, colorVal);
    if (dup.number) {
      showToast("入力エラー", `物件番号 ${numVal} は「${dup.number.name}」で使用中です`, "error");
      return;
    }
    if (dup.color) {
      showToast("入力エラー", `表示色は「${dup.color.name}」で使用中です`, "error");
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
      // キーボックス番号: 予約フロー画面の keyboxCode と相互同期 (両方に同じ値を書く)
      keyboxNumber: document.getElementById("propertyKeyboxNumber").value.trim() || null,
      keyboxCode:   document.getElementById("propertyKeyboxNumber").value.trim() || null,
      // タスク8-2: Wi-Fi SSID/パスワード分割保存
      wifiSSID: document.getElementById("propertyWifiSSID")?.value.trim() || null,
      wifiPassword: document.getElementById("propertyWifiPassword")?.value.trim() || null,
      // タスク8-3: ポスト情報
      post: {
        enabled: !!document.getElementById("propertyPostEnabled")?.checked,
        code: document.getElementById("propertyPostCode")?.value.trim() || null,
      },
      notes: document.getElementById("propertyNotes").value.trim(),
      // Webアプリ管理者 (請求書宛名用 staff ID) + 名義 (billingProfile ID)
      ownerStaffId: document.getElementById("propertyOwnerStaffId")?.value || null,
      ownerBillingProfileId: document.getElementById("propertyOwnerBillingProfileId")?.value || null,
      // LINE 連携フィールド
      lineEnabled: document.getElementById("propertyLineEnabled").checked,
      lineChannels: this._collectLineChannels(),
      // 配信モード（single / rotate / fallback）、未選択時は fallback
      lineDeliveryMode: (() => {
        const el = document.querySelector('input[name="propLineDeliveryMode"]:checked');
        return el ? el.value : "fallback";
      })(),
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
      let finalId = id;
      if (id) {
        await API.properties.update(id, data);
        showToast("完了", "物件情報を更新しました", "success");
      } else {
        const created = await API.properties.create(data);
        finalId = created?.id || created?.propertyId || id;
        showToast("完了", "物件を登録しました", "success");
      }
      // 物件オーナー (staff) の ownedPropertyIds に当該物件を同期追加 (物件オーナー設定と整合)
      try {
        if (finalId && ownerStaffId) {
          const sRef = db.collection("staff").doc(ownerStaffId);
          const sDoc = await sRef.get();
          if (sDoc.exists) {
            const owned = Array.isArray(sDoc.data().ownedPropertyIds) ? sDoc.data().ownedPropertyIds : [];
            if (!owned.includes(finalId)) {
              owned.push(finalId);
              await sRef.update({
                ownedPropertyIds: owned,
                isSubOwner: true, // 明示的に物件オーナー設定を ON
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
              });
            }
          }
        }
      } catch (syncErr) {
        console.warn("物件オーナー設定の同期に失敗:", syncErr.message);
      }
      // 保存完了したら編集中 ID をクリア (次回 openModal で上書きされるが念のため)
      this.editingId = null;
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

    // 物件番号 / 色の重複は自動保存対象外 (手動保存時のみエラー表示)
    const numRawA = document.getElementById("propertyNumber").value;
    const numValA = numRawA === "" ? null : Number(numRawA);
    const colorValA = document.getElementById("propertyColor").value || null;
    const dupA = this._findDuplicateNumberOrColor(id, numValA, colorValA);
    if (dupA.number || dupA.color) {
      console.warn("[物件自動保存] 番号/色の重複のためスキップ");
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
          recurStart: recur ? `${pad(rsm)}-${pad(rsd)}` : null,
          recurEnd: recur ? `${pad(rem)}-${pad(red)}` : null,
          periodStart: recur ? null : (document.getElementById("propertyInspectionPeriodStart").value || null),
          periodEnd: recur ? null : (document.getElementById("propertyInspectionPeriodEnd").value || null),
        };
      })(),
      // キーボックス番号: 予約フロー画面の keyboxCode と相互同期 (両方に同じ値を書く)
      keyboxNumber: document.getElementById("propertyKeyboxNumber").value.trim() || null,
      keyboxCode:   document.getElementById("propertyKeyboxNumber").value.trim() || null,
      // タスク8-2: Wi-Fi SSID/パスワード分割保存
      wifiSSID: document.getElementById("propertyWifiSSID")?.value.trim() || null,
      wifiPassword: document.getElementById("propertyWifiPassword")?.value.trim() || null,
      // タスク8-3: ポスト情報
      post: {
        enabled: !!document.getElementById("propertyPostEnabled")?.checked,
        code: document.getElementById("propertyPostCode")?.value.trim() || null,
      },
      notes: document.getElementById("propertyNotes").value.trim(),
      // Webアプリ管理者 (請求書宛名用 staff ID) + 名義 (billingProfile ID)
      ownerStaffId: document.getElementById("propertyOwnerStaffId")?.value || null,
      ownerBillingProfileId: document.getElementById("propertyOwnerBillingProfileId")?.value || null,
      lineEnabled: document.getElementById("propertyLineEnabled").checked,
      lineChannels: this._collectLineChannels(),
      // 配信モード（single / rotate / fallback）、未選択時は fallback
      lineDeliveryMode: (() => {
        const el = document.querySelector('input[name="propLineDeliveryMode"]:checked');
        return el ? el.value : "fallback";
      })(),
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
      // 自動保存は loadProperties() を呼ばないため、ローカルの propertyList を手動で同期する
      // これをしないと「物件番号 5 → 10」に変更後も使用済み判定が旧番号 5 を残し続けるバグになる
      const idx = (this.propertyList || []).findIndex(p => p.id === id);
      if (idx >= 0) {
        this.propertyList[idx] = { ...this.propertyList[idx], ...data };
      }
      // 現在モーダルに開いている物件の番号プルダウン / 色スウォッチも最新データで再描画
      // (他フィールド変更でも呼ばれるが軽量なので問題なし)
      this._renderPropertyNumberSelect(data.propertyNumber);
      this._renderPropertyColorSwatches(data.color);
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

  // 物件を Firestore から完全削除 (active=false のものだけ対象)
  // 関連データ (予約/シフト/募集/チェックリスト等) は残すが、物件自体が消えるので
  // 物件名は表示されなくなる。誤操作しにくいように件数を先に表示して 2 段階確認する。
  async forceDeleteProperty(property) {
    try {
      // 関連データ件数を先に取得
      const counts = await API.properties.relatedCount(property.id);
      const labels = {
        bookings: "予約",
        shifts: "シフト",
        recruitments: "募集",
        checklists: "チェックリスト",
        checklistTemplates: "チェックリストマスタ",
        guestRegistrations: "宿泊者名簿",
        laundry: "ランドリー記録",
        invoices: "請求書",
      };
      const lines = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `・${labels[k] || k}: ${n} 件`);
      const relatedMsg = lines.length
        ? `以下の関連データが残っています (削除しません、履歴として保持):\n${lines.join("\n")}\n\n`
        : "関連データはありません。\n\n";
      const ok = await showConfirm(
        `【完全削除】\n物件「${property.name}」を Firestore から完全に削除します。\n\n${relatedMsg}この操作は取り消せません。続行しますか？`,
        "物件の完全削除"
      );
      if (!ok) return;

      await API.properties.deleteForce(property.id);
      showToast("完了", `${property.name} を完全に削除しました`, "success");
      await this.loadProperties();
    } catch (e) {
      showToast("エラー", `完全削除に失敗しました: ${e.message}`, "error");
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

  // 物件オーナー (請求書宛名) プルダウンを描画
  // - isSubOwner=true かつ ownedPropertyIds に現在の物件を含むスタッフのみ表示 (物件オーナー設定と同期)
  // - 現在編集中の物件 ID は this._currentEditingPropertyId に保持
  _renderOwnerStaffSelect(selectedId) {
    const sel = document.getElementById("propertyOwnerStaffId");
    if (!sel) return;
    const escape = (s) => this.escapeHtml(String(s || ""));
    const pid = this._currentEditingPropertyId || "";
    // 対象スタッフ: isSubOwner=true かつ ownedPropertyIds に pid を含む
    // 新規作成時 (pid なし) は全物件オーナーを表示
    const candidates = (this._ownerStaffOptions || []).filter(s => {
      if (!s.isSubOwner) return false;
      if (!pid) return true; // 新規物件: まだ紐付いていないので全員候補
      const owned = Array.isArray(s.ownedPropertyIds) ? s.ownedPropertyIds : [];
      return owned.includes(pid);
    });
    const opts = [`<option value="">-- 選択してください --</option>`].concat(
      candidates.map(s =>
        `<option value="${escape(s.id)}" ${s.id === selectedId ? "selected" : ""}>${escape(s.name)} (物件オーナー)</option>`
      )
    ).join("");
    sel.innerHTML = opts;
    // 該当物件オーナーが居ない場合の注意書き
    const hintId = "propertyOwnerStaffHint";
    let hint = document.getElementById(hintId);
    if (candidates.length === 0) {
      if (!hint) {
        hint = document.createElement("div");
        hint.id = hintId;
        hint.className = "form-text text-danger mt-1";
        sel.parentNode.insertBefore(hint, sel.nextSibling);
      }
      hint.textContent = "この物件に紐づく物件オーナーが未登録です。スタッフ管理画面で「物件オーナー設定」を ON にし、所有物件にこの物件をチェックしてください。";
    } else if (hint) {
      hint.remove();
    }
  },

  // 選択スタッフの billingProfiles[] から名義プルダウンを描画
  _renderOwnerBillingProfileSelect(staffId, selectedBpId) {
    const wrap = document.getElementById("propertyOwnerBillingProfileWrap");
    const sel = document.getElementById("propertyOwnerBillingProfileId");
    const hint = document.getElementById("propertyOwnerBillingProfileHint");
    const link = document.getElementById("linkToStaffBilling");
    if (!wrap || !sel) return;
    const escape = (s) => this.escapeHtml(String(s || ""));

    // リンク更新 (スタッフ未選択なら非表示)
    if (link) {
      if (staffId) {
        link.classList.remove("d-none");
        link.dataset.staffId = staffId;
      } else {
        link.classList.add("d-none");
        link.dataset.staffId = "";
      }
    }

    if (!staffId) {
      wrap.classList.add("d-none");
      sel.innerHTML = `<option value="">(自動選択)</option>`;
      if (hint) hint.textContent = "";
      return;
    }

    const staff = this._ownerStaffOptions.find(s => s.id === staffId);
    let profiles = Array.isArray(staff?.billingProfiles) ? staff.billingProfiles : [];
    // 旧データ互換: billingProfiles が無い & 旧 companyName/zipCode/address のどれかがあれば仮想 1 エントリ
    if (profiles.length === 0 && staff && (staff.companyName || staff.zipCode || staff.address)) {
      profiles = [{
        id: "__legacy__",
        label: "メイン (旧形式)",
        companyName: staff.companyName || "",
        zipCode: staff.zipCode || "",
        address: staff.address || "",
      }];
    }

    wrap.classList.remove("d-none");

    if (profiles.length === 0) {
      sel.innerHTML = `<option value="">(名義未登録)</option>`;
      sel.disabled = true;
      if (hint) {
        hint.innerHTML = `<span class="text-warning"><i class="bi bi-exclamation-triangle"></i> このスタッフに請求書表示内容が未登録です。右のリンクから登録してください。</span>`;
      }
      return;
    }

    sel.disabled = false;
    const optsHtml = profiles.map(p => {
      const label = p.label || (p.companyName || "(無題)");
      const detail = [p.companyName, p.address].filter(Boolean).join(" / ");
      const display = detail ? `${label} — ${detail}` : label;
      const sel2 = p.id === selectedBpId ? "selected" : "";
      return `<option value="${escape(p.id)}" ${sel2}>${escape(display)}</option>`;
    }).join("");

    if (profiles.length === 1) {
      // 1 件なら自動選択
      sel.innerHTML = optsHtml;
      sel.value = profiles[0].id;
      if (hint) hint.textContent = "このスタッフの名義は 1 件のため自動選択されています。";
    } else {
      // 2 件以上は手動選択 (先頭に未選択を入れない: 必ず選ぶ運用)
      sel.innerHTML = optsHtml;
      if (selectedBpId && profiles.find(p => p.id === selectedBpId)) {
        sel.value = selectedBpId;
      } else {
        sel.value = profiles[0].id;
      }
      if (hint) hint.textContent = "使用する名義を選択してください。";
    }
  },

  // Webアプリ管理者スタッフ変更 / 編集リンクのイベント紐付け (1 回だけ)
  _bindOwnerStaffChange() {
    const sel = document.getElementById("propertyOwnerStaffId");
    if (sel && !sel.dataset.ownerChangeBound) {
      sel.dataset.ownerChangeBound = "1";
      sel.addEventListener("change", () => {
        // Webアプリ管理者変更時は名義選択をリセットして再描画
        this._renderOwnerBillingProfileSelect(sel.value || "", "");
      });
    }
    const link = document.getElementById("linkToStaffBilling");
    if (link && !link.dataset.bound) {
      link.dataset.bound = "1";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const staffId = link.dataset.staffId || document.getElementById("propertyOwnerStaffId")?.value || "";
        if (!staffId) return;
        // sessionStorage に対象 staffId を置き、スタッフ画面に遷移後に staff.js が自動で開く
        try { sessionStorage.setItem("openStaffEdit", staffId); } catch (err) {}
        this.modal.hide();
        const modalEl = document.getElementById("propertyModal");
        const onHidden = () => {
          modalEl.removeEventListener("hidden.bs.modal", onHidden);
          location.hash = "#/staff";
        };
        modalEl.addEventListener("hidden.bs.modal", onHidden);
      });
    }
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
  // 実ロジックは公開共有モジュール window.propertyIcalPanel に集約 (reservation-flow.js と共通)

  /**
   * この物件に紐付く syncSettings を読み込んでリスト表示する
   */
  async _loadPropertyIcal(propertyId) {
    const listEl = document.getElementById("propertyIcalList");
    const addRow = document.getElementById("propertyIcalAddRow");
    if (!listEl) return;
    if (addRow) addRow.classList.remove("d-none");

    if (window.propertyIcalPanel && typeof window.propertyIcalPanel.bindLegacy === "function") {
      await window.propertyIcalPanel.bindLegacy({
        listEl,
        urlInput: document.getElementById("propertyNewIcalUrl"),
        platformInput: document.getElementById("propertyNewIcalPlatform"),
        addBtn: document.getElementById("btnAddPropertyIcal"),
        propertyId,
      });
    } else {
      listEl.innerHTML = `<div class="alert alert-warning py-1 small">iCal パネルモジュールが読み込めませんでした</div>`;
    }
  },

  /**
   * iCal 追加フォームのイベントをバインドする
   * (既存 API 互換。_loadPropertyIcal 側で bindLegacy 呼び出し済みのため no-op)
   */
  _bindPropertyIcalEvents(_propertyId) {
    // no-op: _loadPropertyIcal で bindLegacy 済み
  },

  // ---- 物件番号 / 色の重複防止 ----

  /**
   * 他物件の物件番号 → 物件情報 のマップを返す
   * 編集中の物件 (this.editingId) は除外する
   */
  _usedPropertyNumbers() {
    const map = new Map();
    (this.propertyList || []).forEach(p => {
      if (!p || p.id === this.editingId) return;
      if (p.propertyNumber != null && p.propertyNumber !== "") {
        map.set(Number(p.propertyNumber), p);
      }
    });
    return map;
  },

  /**
   * 他物件で使用中の色 (小文字) → 物件情報 のマップを返す
   */
  _usedPropertyColors() {
    const map = new Map();
    (this.propertyList || []).forEach(p => {
      if (!p || p.id === this.editingId) return;
      if (p.color) map.set(String(p.color).toLowerCase(), p);
    });
    return map;
  },

  /**
   * 物件番号プルダウンを描画 (既使用番号は disabled + 物件名表示)
   */
  _renderPropertyNumberSelect(currentValue) {
    const sel = document.getElementById("propertyNumber");
    if (!sel) return;
    const used = this._usedPropertyNumbers();
    const cur = currentValue == null || currentValue === "" ? "" : String(currentValue);
    const opts = [`<option value="">(未設定)</option>`];
    for (let n = 1; n <= PROPERTY_NUMBER_MAX; n++) {
      const conflict = used.get(n);
      const selected = cur === String(n) ? "selected" : "";
      if (conflict) {
        opts.push(
          `<option value="${n}" disabled>${n} (既使用: ${this.escapeHtml(conflict.name)})</option>`
        );
      } else {
        opts.push(`<option value="${n}" ${selected}>${n}</option>`);
      }
    }
    sel.innerHTML = opts.join("");
    // 既存値が範囲外の場合は option を動的追加
    if (cur && Number(cur) > PROPERTY_NUMBER_MAX) {
      const extra = document.createElement("option");
      extra.value = cur;
      extra.textContent = cur;
      extra.selected = true;
      sel.appendChild(extra);
    }
  },

  /**
   * 色スウォッチを描画 (既使用色は半透明+斜線+tooltip)
   */
  _renderPropertyColorSwatches(currentValue) {
    const container = document.getElementById("propertyColorSwatches");
    if (!container) return;
    const used = this._usedPropertyColors();
    const cur = (currentValue || "").toLowerCase();
    container.innerHTML = PRESET_COLORS.map(c => {
      const key = c.value.toLowerCase();
      const conflict = used.get(key);
      const isCurrent = cur === key;
      const disabled = !!conflict;
      // 半透明 + 斜線 (linear-gradient) で既使用を表現
      const bg = disabled
        ? `background: linear-gradient(135deg, ${c.value} 0%, ${c.value} 45%, rgba(255,255,255,.8) 48%, rgba(255,255,255,.8) 52%, ${c.value} 55%, ${c.value} 100%); opacity:.55;`
        : `background:${c.value};`;
      const border = isCurrent ? "border:3px solid #000;" : "border:1px solid #ccc;";
      const title = disabled
        ? `${c.name}: ${this.escapeHtml(conflict.name)} で使用中`
        : c.name;
      return `<button type="button" class="property-color-swatch" data-color="${c.value}"
        ${disabled ? "disabled" : ""}
        title="${title}"
        style="width:26px;height:26px;border-radius:4px;padding:0;${bg}${border}cursor:${disabled ? "not-allowed" : "pointer"};"></button>`;
    }).join("");

    // 既存リスナを一掃するため委譲で登録
    if (!container.dataset.swatchBound) {
      container.dataset.swatchBound = "1";
      container.addEventListener("click", (e) => {
        const btn = e.target.closest(".property-color-swatch");
        if (!btn || btn.disabled) return;
        const v = btn.dataset.color;
        const input = document.getElementById("propertyColor");
        if (input) {
          input.value = v;
          // change イベントを発火させて自動保存をトリガー
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        // 選択状態を視覚更新
        this._renderPropertyColorSwatches(v);
      });
    }
  },

  /**
   * 他物件と番号/色が重複しているか調べる
   * @returns {{number: object|null, color: object|null}}
   */
  _findDuplicateNumberOrColor(editingId, num, color) {
    const result = { number: null, color: null };
    (this.propertyList || []).forEach(p => {
      if (!p || p.id === editingId) return;
      if (num != null && p.propertyNumber != null && Number(p.propertyNumber) === Number(num)) {
        result.number = p;
      }
      if (color && p.color && String(p.color).toLowerCase() === String(color).toLowerCase()) {
        result.color = p;
      }
    });
    return result;
  },

  // ---- Gmail 連携（物件単位） ----

  /**
   * Gmail 連携セクションを描画する
   * @param {string} propertyId
   * @param {string|null} currentSenderGmail  - properties/{pid}.senderGmail
   */
  async _loadGmailSection(propertyId, currentSenderGmail) {
    const el = document.getElementById("propertyGmailSection");
    if (!el) return;

    // 連携済みアカウント一覧を取得（emailVerification context と共有）
    let accounts = [];
    try {
      const res = await this._cfApi("GET", "/gmail-auth/accounts?context=emailVerification");
      accounts = res.accounts || [];
    } catch (e) {
      el.innerHTML = `<div class="text-danger small">Gmail アカウント一覧の取得に失敗しました: ${this.escapeHtml(e.message)}</div>`;
      return;
    }

    const sender = currentSenderGmail || "";
    const linkedAccount = accounts.find(a => a.email === sender);

    if (sender && linkedAccount) {
      // 連携済み状態
      const savedAt = linkedAccount.savedAt
        ? this._formatTs(linkedAccount.savedAt)
        : "";
      const statusBadge = linkedAccount.hasRefreshToken
        ? `<span class="badge bg-success">有効</span>`
        : `<span class="badge bg-danger">失効</span>`;
      el.innerHTML = `
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <span class="small"><i class="bi bi-envelope-fill text-primary"></i>
            <strong>${this.escapeHtml(sender)}</strong> ${statusBadge}
            ${savedAt ? `<span class="text-muted small ms-1">連携日: ${savedAt}</span>` : ""}
          </span>
          <button class="btn btn-sm btn-outline-danger" id="btnPropGmailUnlink">
            <i class="bi bi-x-circle"></i> 解除
          </button>
          <button class="btn btn-sm btn-outline-secondary" id="btnPropGmailRelink">
            <i class="bi bi-arrow-repeat"></i> 別アカウントで再連携
          </button>
        </div>
      `;
      document.getElementById("btnPropGmailUnlink")?.addEventListener("click", () => {
        this._unlinkPropertyGmail(propertyId);
      });
      document.getElementById("btnPropGmailRelink")?.addEventListener("click", () => {
        this._connectPropertyGmail(propertyId);
      });
    } else if (sender && !linkedAccount) {
      // senderGmail は設定済みだがトークンが存在しない（別環境で連携した等）
      el.innerHTML = `
        <div class="alert alert-warning py-2 small mb-2">
          <i class="bi bi-exclamation-triangle"></i>
          送信元に <strong>${this.escapeHtml(sender)}</strong> が設定されていますが、
          このアカウントのトークンが見つかりません。再連携してください。
        </div>
        <button class="btn btn-sm btn-outline-primary" id="btnPropGmailConnect">
          <i class="bi bi-plus-lg"></i> Gmail を連携
        </button>
      `;
      document.getElementById("btnPropGmailConnect")?.addEventListener("click", () => {
        this._connectPropertyGmail(propertyId);
      });
    } else {
      // 未連携
      el.innerHTML = `
        <div class="alert alert-secondary py-2 small mb-2">
          <i class="bi bi-info-circle"></i> 未連携 — 連携すると宿泊者宛メールをこの物件専用アカウントから送信できます。
        </div>
        <button class="btn btn-sm btn-outline-primary" id="btnPropGmailConnect">
          <i class="bi bi-plus-lg"></i> Gmail を連携
        </button>
      `;
      document.getElementById("btnPropGmailConnect")?.addEventListener("click", () => {
        this._connectPropertyGmail(propertyId);
      });
    }
  },

  /** Gmail 連携ボタン: OAuth フローを新タブで開く */
  async _connectPropertyGmail(propertyId) {
    const email = window.showPrompt
      ? await window.showPrompt(
          "連携する Gmail アドレスを入力してください (例: example@gmail.com)",
          "",
          "Gmail 連携"
        )
      : window.prompt("連携する Gmail アドレス:");
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (window.showAlert) await window.showAlert("メールアドレスの形式が正しくありません", "エラー");
      return;
    }
    const cfBase = "https://api-5qrfx7ujcq-an.a.run.app";
    const url = `${cfBase}/gmail-auth/start?context=property&propertyId=${encodeURIComponent(propertyId)}&email=${encodeURIComponent(email)}`;
    window.open(url, "_blank", "noopener");
    if (window.showAlert) {
      await window.showAlert(
        "新しいタブで Google 認証画面が開きます。完了後、このモーダルを閉じて再度開くと連携状態が反映されます。",
        "Gmail 連携"
      );
    }
  },

  /** Gmail 連携解除: properties.senderGmail をクリア */
  async _unlinkPropertyGmail(propertyId) {
    const ok = window.showConfirm
      ? await window.showConfirm("この物件の Gmail 連携を解除しますか？ 以降はサンクスメールが送信できなくなります。", "Gmail 連携解除")
      : window.confirm("Gmail 連携を解除しますか？");
    if (!ok) return;
    try {
      await db.collection("properties").doc(propertyId).update({ senderGmail: null });
      showToast("完了", "Gmail 連携を解除しました", "success");
      // セクションを再描画
      await this._loadGmailSection(propertyId, null);
    } catch (e) {
      showToast("エラー", `解除失敗: ${e.message}`, "error");
    }
  },

  /** Cloud Functions API を呼ぶ簡易ラッパ */
  async _cfApi(method, path) {
    let token = "test-token";
    if (typeof Auth !== "undefined" && !Auth.testMode && Auth.currentUser?.getIdToken) {
      token = await Auth.currentUser.getIdToken();
    }
    const cfBase = "https://api-5qrfx7ujcq-an.a.run.app";
    const res = await fetch(`${cfBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.substring(0, 200)}`);
    }
    return res.json();
  },

  /** タイムスタンプを M/D HH:mm に変換 */
  _formatTs(v) {
    if (!v) return "";
    try {
      let d;
      if (typeof v === "string") d = new Date(v);
      else if (v.toDate) d = v.toDate();
      else if (v._seconds) d = new Date(v._seconds * 1000);
      else d = new Date(v);
      if (isNaN(d.getTime())) return "";
      return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    } catch (_) { return ""; }
  },

  // ---- 共通ユーティリティ ----

  escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  },
};
