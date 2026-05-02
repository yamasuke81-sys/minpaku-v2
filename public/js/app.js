/**
 * メインアプリ — SPAルーター + 初期化
 * ロール別ルーティング対応（owner / staff）
 */
const App = {
  currentPage: null,

  // Webアプリ管理者用ページ
  pages: {
    staff: StaffPage,
    properties: PropertiesPage,
    "guest-guides": GuestGuidesPage,
    "property-checklist": PropertyChecklistPage,
    recruitment: RecruitmentPage,
    guests: GuestsPage,
    shifts: ShiftsPage,
    invoices: InvoicesPage,
    rates: RatesPage,
    notifications: NotificationsPage,
    contacts: ContactsPage,
    laundry: LaundryPage,
    checklist: ChecklistPage,
    "reservation-flow": ReservationFlowPage,
    "cleaning-flow": CleaningFlowPage,
    "prepaid-cards": PrepaidCardsPage,
    reports: ReportsPage,
    command: CommandCenterPage,
    projects: ProjectsPage,
    "scan-sorter": ScanSorterPage,
    "tax-docs": TaxDocsPage,
    "email-verification": EmailVerificationPage,
    settings: SettingsPage,
    // 予約・清掃スケジュール (Webアプリ管理者用フル機能ビュー) — MyRecruitmentPage を view mode で分岐
    "schedule": MyRecruitmentPage,
    // 新旧cal比較（オーナーのみ）
    "cal-compare": CalComparePage,
  },

  // スタッフ用ページ
  staffPages: {
    "my-dashboard": MyDashboardPage,
    "my-recruitment": MyRecruitmentPage,
    "my-checklist": MyChecklistPage,
    "my-invoice": MyInvoicePage,
    "my-invoice-create": MyInvoiceCreatePage,
    "prepaid-cards": PrepaidCardsPage,
  },

  init() {
    Auth.init();
    window.addEventListener("hashchange", () => this.route());
    this.initSidebar();
  },

  initSidebar() {
    const toggle = document.getElementById("sidebarToggle");
    const sidebar = document.getElementById("appSidebar");
    const overlay = document.getElementById("sidebarOverlay");
    if (toggle) {
      toggle.addEventListener("click", () => {
        sidebar.classList.toggle("show");
        overlay.classList.toggle("show");
      });
    }
    if (overlay) {
      overlay.addEventListener("click", () => {
        sidebar.classList.remove("show");
        overlay.classList.remove("show");
      });
    }
    // サイドバーリンクをクリックしたらモバイルでは閉じる
    document.querySelectorAll(".sidebar-nav .nav-link").forEach(el => {
      el.addEventListener("click", () => {
        if (window.innerWidth < 992) {
          const sb = document.getElementById("appSidebar");
          const bd = document.getElementById("sidebarBackdrop");
          if (sb) sb.classList.remove("show");
          if (bd) bd.classList.remove("show");
        }
      });
    });
  },

  // ========== Impersonation (代理閲覧) ==========

  /** 代理閲覧中の物件オーナーStaffId (null = 通常モード) */
  impersonating: null,
  impersonatingData: null,

  /**
   * 起動時に impersonateAs を読み込む
   * メインWebアプリ管理者が特定物件オーナーの視点でアプリを閲覧するための機構
   */
  async initImpersonation() {
    const impersonateAs = localStorage.getItem("impersonateAs");
    if (!impersonateAs) {
      this.impersonating = null;
      this.impersonatingData = null;
      return;
    }
    // 実際のロールがWebアプリ管理者の場合のみ有効
    const role = Auth.currentUser?.role || "owner";
    if (role !== "owner" && role !== null && role !== undefined) {
      // Webアプリ管理者以外は impersonation 不可
      localStorage.removeItem("impersonateAs");
      return;
    }
    try {
      const db = firebase.firestore();
      const sDoc = await db.collection("staff").doc(impersonateAs).get();
      if (!sDoc.exists || !sDoc.data().isSubOwner) {
        localStorage.removeItem("impersonateAs");
        return;
      }
      this.impersonating = impersonateAs;
      this.impersonatingData = { id: impersonateAs, ...sDoc.data() };
      this._showImpersonateBanner(this.impersonatingData);
    } catch (e) {
      console.warn("impersonation初期化エラー:", e.message);
      localStorage.removeItem("impersonateAs");
    }
  },

  /** impersonation 中の表示制御 (現状: 何もしない — スタッフ画面ネスト構造で全リンク常時表示) */
  _applyImpersonateNavVisibility() {
    // 旧版では impersonation 中に「清掃スケジュール (スタッフ視点)」「チェックリスト」を
    // 隠していたが、物件オーナー画面 > スタッフ画面のネスト構造に変わったため不要
    ["ownerNavMyRecruitment", "ownerNavMyChecklist"].forEach(id => {
      document.getElementById(id)?.classList.remove("d-none");
    });
  },

  /** 代理閲覧バナーを表示 */
  _showImpersonateBanner(subOwner) {
    this._applyImpersonateNavVisibility();
    let banner = document.getElementById("impersonateBanner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "impersonateBanner";
      banner.className = "impersonate-banner alert alert-warning alert-dismissible mb-0 rounded-0 d-flex align-items-center";
      banner.style.cssText = "position:sticky;top:0;z-index:1050;font-size:0.85rem;padding:6px 12px;";
      document.querySelector(".app-main")?.prepend(banner);
    }
    banner.innerHTML = `
      <i class="bi bi-person-badge me-2"></i>
      <strong>代理閲覧中: ${this.escapeHtml(subOwner.name)}</strong>
      <span class="ms-2 text-muted small">(所有物件: ${(subOwner.ownedPropertyIds || []).length}件)</span>
      <button type="button" class="btn btn-sm btn-outline-dark ms-auto" id="btnExitImpersonate">
        <i class="bi bi-x-circle"></i> 解除
      </button>
    `;
    document.getElementById("btnExitImpersonate")?.addEventListener("click", () => {
      localStorage.removeItem("impersonateAs");
      window.location.reload();
    });
  },

  /** impersonation中の ownedPropertyIds を返す (通常時は null) */
  getImpersonatedPropertyIds() {
    if (!this.impersonating || !this.impersonatingData) return null;
    return this.impersonatingData.ownedPropertyIds || [];
  },

  // ========== View-As-Staff (管理者がスタッフ視点で my-* ページを閲覧) ==========

  /** 現在「○○スタッフとして閲覧中」の staffId (null = 自分として閲覧) */
  viewAsStaffId: null,
  /** 同 表示名 (バッジ用) */
  viewAsStaffName: null,
  /** プルダウン用キャッシュ */
  _viewAsStaffList: [],

  /** 管理者が viewAsStaff を切り替えられるページ */
  VIEW_AS_TARGET_PAGES: ["my-recruitment", "my-checklist", "my-invoice-create"],

  /** viewAsStaff を設定。localStorage に保存し、対象ページなら再描画 */
  setViewAsStaff(staffId) {
    if (staffId) {
      const s = (this._viewAsStaffList || []).find(x => x.id === staffId);
      this.viewAsStaffId = staffId;
      this.viewAsStaffName = s ? s.name : staffId;
      try { localStorage.setItem("viewAsStaffId", staffId); } catch (_) {}
    } else {
      this.viewAsStaffId = null;
      this.viewAsStaffName = null;
      try { localStorage.removeItem("viewAsStaffId"); } catch (_) {}
    }
    this._renderViewAsBadge();
    // 対象ページなら再描画
    if (this.VIEW_AS_TARGET_PAGES.includes(this.currentPage)) {
      this.route();
    }
  },

  /** 「○○として閲覧中」バッジ
   *  視点切替が実際に効くページ (VIEW_AS_TARGET_PAGES) のみ表示 */
  _renderViewAsBadge() {
    const existing = document.getElementById("viewAsStaffBanner");
    if (existing) existing.remove();
    if (!this.viewAsStaffId) return;
    if (!this.VIEW_AS_TARGET_PAGES.includes(this.currentPage)) return;
    const banner = document.createElement("div");
    banner.id = "viewAsStaffBanner";
    banner.className = "alert alert-info alert-dismissible mb-0 rounded-0 d-flex align-items-center";
    banner.style.cssText = "position:sticky;top:0;z-index:1049;font-size:0.85rem;padding:6px 12px;";
    banner.innerHTML = `
      <i class="bi bi-person-circle me-2"></i>
      <strong>${this.escapeHtml(this.viewAsStaffName || "")} さんとして閲覧中</strong>
      <span class="ms-2 text-muted small">(書き込みは他人として記録されます)</span>
      <button type="button" class="btn btn-sm btn-outline-dark ms-auto" id="btnExitViewAs">
        <i class="bi bi-x-circle"></i> 自分に戻す
      </button>`;
    document.querySelector(".app-main")?.prepend(banner);
    document.getElementById("btnExitViewAs")?.addEventListener("click", () => {
      const sel = document.getElementById("ownerViewAsStaffSelect");
      if (sel) sel.value = "";
      this.setViewAsStaff(null);
    });
  },

  /** プルダウン初期化 (管理者のみ) */
  async initViewAsStaffSelect() {
    const wrap = document.getElementById("ownerViewAsStaffWrap");
    const sel = document.getElementById("ownerViewAsStaffSelect");
    if (!wrap || !sel) return;
    // 管理者でなければ非表示
    if (!Auth.isOwner()) {
      wrap.classList.add("d-none");
      return;
    }
    // impersonating 中も viewAsStaff は使う (物件オーナー画面 > スタッフ画面で選択)
    // ただし候補は impersonating 中は _refreshStaffViewSelect で物件オーナーの担当物件のスタッフのみに絞る
    try {
      const list = await API.staff.list(true);
      // 物件オーナー(isSubOwner) と 自分(isOwner) は除外、active のみ、displayOrder順
      this._viewAsStaffList = list
        .filter(s => !s.isSubOwner && !s.isOwner && s.active !== false && s.name)
        .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
      const stored = (() => {
        try { return localStorage.getItem("viewAsStaffId") || ""; } catch (_) { return ""; }
      })();
      // option 構築 (先頭の「自分」optionは残す)
      const head = '<option value="">自分（管理者）として閲覧</option>';
      sel.innerHTML = head + this._viewAsStaffList.map(s =>
        `<option value="${s.id}" ${s.id === stored ? "selected" : ""}>${this.escapeHtml(s.name)}</option>`
      ).join("");
      // 保存値が候補に存在する場合のみ復元
      if (stored && this._viewAsStaffList.find(s => s.id === stored)) {
        this.viewAsStaffId = stored;
        const sObj = this._viewAsStaffList.find(s => s.id === stored);
        this.viewAsStaffName = sObj ? sObj.name : stored;
        this._renderViewAsBadge();
      } else {
        try { localStorage.removeItem("viewAsStaffId"); } catch (_) {}
      }
      sel.addEventListener("change", (e) => {
        this.setViewAsStaff(e.target.value || null);
      });
    } catch (e) {
      console.warn("[viewAsStaff] 初期化失敗:", e.message);
    }
  },

  /** my-* ページが「効果的な staffId」を取得するためのヘルパー。
   *  管理者かつ viewAsStaff 設定中、かつ現在ページが対象3ページの時のみ viewAsStaffId を返す。
   *  impersonating 中も viewAsStaff は有効 (物件オーナー画面 > スタッフ画面のネスト構造)。 */
  getViewAsStaffId() {
    if (!Auth.isOwner()) return null;
    if (!this.VIEW_AS_TARGET_PAGES.includes(this.currentPage)) return null;
    return this.viewAsStaffId || null;
  },

  escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = String(s || "");
    return d.innerHTML;
  },

  // ========== 認証完了後の初期化 ==========

  onAuthReady() {
    const user = Auth.currentUser;
    if (user) {
      const name = user.displayName || user.email?.split("@")[0] || "ユーザー";
      const nameEl = document.getElementById("userName");
      if (nameEl) nameEl.textContent = name;
      const avatar = document.getElementById("userAvatar");
      if (avatar) avatar.textContent = name.charAt(0).toUpperCase();
    }

    // ロール別ナビ表示切替
    const role = Auth.currentUser?.role || "owner";
    const ownerNav = document.getElementById("ownerNav");
    const staffNav = document.getElementById("staffNav");
    if (ownerNav) ownerNav.classList.toggle("d-none", role === "staff");
    if (staffNav) staffNav.classList.toggle("d-none", role !== "staff");

    // サブオーナーは ownerNav 内の許可項目 (data-sub-owner-show="1") のみ表示
    // セクション divider (sidebar-section) と未許可リンクは隠す
    if (ownerNav && role === "sub_owner") {
      ownerNav.querySelectorAll(":scope > *").forEach(el => {
        const allowed = el.matches(".nav-link[data-sub-owner-show]");
        if (!allowed) el.style.display = "none";
      });
    }

    // スタッフ側のプリカ管理タブ: 担当物件に紐づくカードがある場合のみ表示
    if (role === "staff") this._maybeShowStaffPrepaidNav();

    // サイドバーセクションの折りたたみ初期化
    this._initSidebarSectionToggles();

    // 上部 (管理者用) メニューをタッチしたら代理閲覧を解除
    this._wireOwnerNavExitImpersonation();

    // impersonation 初期化（Webアプリ管理者のみ）
    this.initImpersonation().then(() => {
      // viewAsStaff プルダウン (impersonation と排他)
      this.initViewAsStaffSelect();
      // サブオーナー impersonation プルダウン
      this.initImpersonateSelect();
      this.route();
    });
  },

  /** 上部の管理者用メニューをクリックしたら代理閲覧を解除する
   *  (subOwnerGroup 内のリンクは別ハンドラで impersonation を起動するので除外) */
  _wireOwnerNavExitImpersonation() {
    const ownerNav = document.getElementById("ownerNav");
    if (!ownerNav) return;
    ownerNav.querySelectorAll(":scope > a.nav-link").forEach(a => {
      a.addEventListener("click", () => {
        if (!this.impersonating) return;
        try { localStorage.removeItem("impersonateAs"); } catch (_) {}
        this.impersonating = null;
        this.impersonatingData = null;
        document.getElementById("impersonateBanner")?.remove();
        // 物件オーナー画面の select も初期化
        const sel = document.getElementById("ownerImpersonateSelect");
        if (sel) sel.value = "";
        this._renderSubOwnerMenuList("");
        this._applyImpersonateNavVisibility();
      });
    });
  },

  /** スタッフ画面/サブオーナー画面セクションの折りたたみ */
  _initSidebarSectionToggles() {
    document.querySelectorAll(".sidebar-section-toggle").forEach(hdr => {
      const groupId = hdr.dataset.sectionGroup;
      const body = document.getElementById(groupId);
      if (!body) return;
      const storeKey = "sidebarSection_" + groupId;
      const stored = localStorage.getItem(storeKey);
      const collapsed = stored === "1";
      if (collapsed) {
        hdr.classList.add("collapsed");
        body.classList.add("d-none-collapsed");
      }
      hdr.addEventListener("click", () => {
        const nowCollapsed = !hdr.classList.contains("collapsed");
        hdr.classList.toggle("collapsed", nowCollapsed);
        body.classList.toggle("d-none-collapsed", nowCollapsed);
        try { localStorage.setItem(storeKey, nowCollapsed ? "1" : "0"); } catch (_) {}
      });
    });
  },

  /** サブオーナー画面セクションの初期化 — 選択時にメニューを動的生成 */
  async initImpersonateSelect() {
    const sel = document.getElementById("ownerImpersonateSelect");
    if (!sel) return;
    if (!Auth.isOwner || !Auth.isOwner()) {
      // オーナー以外はサブオーナー画面セクションごと隠す
      document.getElementById("subOwnerGroup")?.classList.add("d-none");
      document.querySelector('.sidebar-section-toggle[data-section-group="subOwnerGroup"]')?.classList.add("d-none");
      return;
    }
    try {
      const list = await API.staff.list(true);
      this._subOwnerList = list
        .filter(s => s.isSubOwner && s.active !== false && s.name)
        .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
      const current = this.impersonating || (() => { try { return localStorage.getItem("subOwnerPick") || ""; } catch (_) { return ""; } })();
      sel.innerHTML = '<option value="">— 物件オーナーを選択 —</option>' +
        this._subOwnerList.map(s => `<option value="${s.id}" ${s.id === current ? "selected" : ""}>${this.escapeHtml(s.name)}</option>`).join("");
      sel.addEventListener("change", (e) => {
        const v = e.target.value;
        try { v ? localStorage.setItem("subOwnerPick", v) : localStorage.removeItem("subOwnerPick"); } catch (_) {}
        this._renderSubOwnerMenuList(v);
      });
      // 初期表示
      if (current) this._renderSubOwnerMenuList(current);
    } catch (e) {
      console.warn("[impersonateSelect] 初期化失敗:", e.message);
    }
  },

  /** 選択中サブオーナーが見られるメニューを羅列 + スタッフ画面ネストセクション表示制御 */
  _renderSubOwnerMenuList(subOwnerId) {
    const list = document.getElementById("subOwnerMenuList");
    const staffToggle = document.getElementById("staffViewToggle");
    const staffBody = document.getElementById("staffViewGroup");
    if (!list) return;
    if (!subOwnerId) {
      list.innerHTML = "";
      staffToggle?.classList.add("d-none");
      staffBody?.classList.add("d-none");
      return;
    }
    const subOwner = (this._subOwnerList || []).find(s => s.id === subOwnerId);
    if (!subOwner) { list.innerHTML = ""; return; }
    // ownerNav 内の data-sub-owner-show="1" 付きリンクを抽出してコピー
    const links = Array.from(document.querySelectorAll('#ownerNav > a.nav-link[data-sub-owner-show="1"]'));
    list.innerHTML = links.map(a => {
      const href = a.getAttribute("href") || "#";
      const target = a.getAttribute("target") ? ` target="${a.getAttribute("target")}"` : "";
      return `<a class="nav-link sub-owner-menu-link" href="${href}"${target} data-sub-owner-id="${subOwnerId}">${a.innerHTML}</a>`;
    }).join("");
    list.querySelectorAll(".sub-owner-menu-link").forEach(a => {
      a.addEventListener("click", (ev) => {
        const href = a.getAttribute("href") || "";
        // 外部リンク (target=_blank) はそのまま
        if (a.getAttribute("target")) {
          try { localStorage.setItem("impersonateAs", subOwnerId); } catch (_) {}
          return;
        }
        // ハッシュリンク: リロードせずに impersonation を即座に切り替えてページ遷移
        ev.preventDefault();
        const subOwner = (this._subOwnerList || []).find(s => s.id === subOwnerId);
        if (!subOwner) return;
        try { localStorage.setItem("impersonateAs", subOwnerId); } catch (_) {}
        this.impersonating = subOwnerId;
        this.impersonatingData = subOwner;
        this._showImpersonateBanner(subOwner);
        // ハッシュ遷移 (同じハッシュでも route が動くよう一旦変えて戻す)
        if (location.hash === href) {
          this.route();
        } else {
          location.hash = href;
        }
      });
    });
    // スタッフ画面サブセクションを表示
    staffToggle?.classList.remove("d-none");
    staffBody?.classList.remove("d-none");
    // スタッフ select をサブオーナー担当物件のスタッフに絞り込み
    this._refreshStaffViewSelect(subOwner.ownedPropertyIds || []);
    // スタッフ画面メニューリンク: viewAsStaff 未選択時はクリックを防ぐ
    document.querySelectorAll("#staffViewMenuList a.nav-link").forEach(a => {
      // 既存ハンドラは1度だけ登録
      if (a.dataset.staffViewWired === "1") return;
      a.dataset.staffViewWired = "1";
      a.addEventListener("click", (ev) => {
        if (!this.viewAsStaffId) {
          ev.preventDefault();
          if (typeof window.showAlert === "function") {
            window.showAlert("「スタッフ画面」を開くには、まず上のプルダウンでスタッフを選択してください。", "スタッフ未選択");
          } else {
            alert("「スタッフ画面」を開くには、まず上のプルダウンでスタッフを選択してください。");
          }
        }
      });
    });
  },

  /** スタッフ select を「指定物件群を担当しているスタッフ」に絞り込み */
  async _refreshStaffViewSelect(propertyIds) {
    const sel = document.getElementById("ownerViewAsStaffSelect");
    if (!sel) return;
    try {
      const all = this._viewAsStaffList && this._viewAsStaffList.length
        ? this._viewAsStaffList
        : (await API.staff.list(true))
            .filter(s => !s.isSubOwner && !s.isOwner && s.active !== false && s.name)
            .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
      const propSet = new Set(propertyIds);
      const filtered = propSet.size === 0
        ? all
        : all.filter(s => Array.isArray(s.assignedPropertyIds) && s.assignedPropertyIds.some(pid => propSet.has(pid)));
      const current = this.viewAsStaffId || "";
      sel.innerHTML = '<option value="">— スタッフを選択 —</option>' +
        filtered.map(s => `<option value="${s.id}" ${s.id === current ? "selected" : ""}>${this.escapeHtml(s.name)}</option>`).join("");
      // 候補にない選択は解除
      if (current && !filtered.find(s => s.id === current)) {
        this.setViewAsStaff(null);
      }
    } catch (e) {
      console.warn("[refreshStaffViewSelect] 失敗:", e.message);
    }
  },

  // スタッフの担当物件に紐づくプリカが存在する時だけサイドバーに「プリカ管理」を表示
  async _maybeShowStaffPrepaidNav() {
    const link = document.getElementById("staffNavPrepaid");
    if (!link) return;
    try {
      const staffId = Auth.currentUser?.staffId;
      if (!staffId) return;
      const db = firebase.firestore();
      const sDoc = await db.collection("staff").doc(staffId).get();
      if (!sDoc.exists) return;
      const assigned = new Set(sDoc.data().assignedPropertyIds || []);
      if (!assigned.size) return;
      const pDoc = await db.collection("settings").doc("prepaidCards").get();
      if (!pDoc.exists) return;
      const items = pDoc.data().items || [];
      const hasMatch = items.some(c => (c.propertyIds || []).some(pid => assigned.has(pid)));
      if (hasMatch) link.classList.remove("d-none");
    } catch (e) {
      console.warn("プリカナビ表示判定エラー:", e.message);
    }
  },

  route() {
    if (!Auth.currentUser) return;

    // #/my-laundry → my-checklist へのエイリアス (ランドリーセクションへスクロール)
    if (location.hash === "#/my-laundry") {
      sessionStorage.setItem("pclScrollToLaundry", "1");
      location.hash = "#/my-checklist";
      return; // hashchange イベントが再発火して route() が再呼び出しされる
    }

    // #/dashboard または #/ (ルート) → ロールに応じてリダイレクト
    // Webアプリ管理者/物件オーナー → #/schedule (フル機能)、スタッフ → #/my-recruitment (スタッフビュー)
    if (location.hash === "#/dashboard" || location.hash === "#/" || location.hash === "") {
      const currentRole = Auth?.currentUser?.role || "owner";
      location.hash = currentRole === "staff" ? "#/my-recruitment" : "#/schedule";
      return;
    }

    const role = Auth.currentUser.role || "owner";
    const hash = location.hash.replace("#", "") || "/";
    // クエリ部分 (?key=val) は route 決定には使わずページ側へ伝える (location.hash は残す)
    const pathOnly = hash.split("?")[0];
    const path = pathOnly.split("/").filter(Boolean);

    // デフォルトページ: スタッフ→my-recruitment、それ以外→schedule
    const defaultPage = role === "staff" ? "my-recruitment" : "schedule";
    const pageName = path[0] || defaultPage;

    // サブオーナー: 許可外ページへの直打ちを #/schedule にリダイレクト
    if (role === "sub_owner") {
      const subOwnerAllowed = new Set([
        "schedule", "properties", "staff", "guests", "guest-guides",
        "recruitment", "laundry", "checklist", "prepaid-cards",
        "reservation-flow", "cleaning-flow", "rates", "invoices",
      ]);
      if (!subOwnerAllowed.has(pageName)) {
        location.hash = "#/schedule";
        return;
      }
    }

    // ロール別ページマップ選択（Webアプリ管理者/物件オーナーはスタッフページにもアクセス可能）
    const availablePages = role === "staff"
      ? this.staffPages
      : { ...this.pages, ...this.staffPages };

    // サイドバーのアクティブ状態更新（物件オーナーはWebアプリ管理者ナビを使用）
    const navId = role === "staff" ? "#staffNav" : "#ownerNav";
    document.querySelectorAll(`${navId} .nav-link`).forEach((el) => {
      el.classList.toggle("active", el.getAttribute("data-page") === pageName);
    });

    const page = availablePages[pageName];
    if (page) {
      this.currentPage = pageName;
      // viewAsStaff バッジを対象ページに応じて再評価（対象外ページに移動したら隠す）
      this._renderViewAsBadge();
      page.render(document.getElementById("pageContainer"), path.slice(1));
      // ページ切り替え時にビュー最上部へスクロール
      try {
        window.scrollTo({ top: 0, behavior: "instant" });
        const mainEl = document.querySelector(".app-main");
        if (mainEl) mainEl.scrollTop = 0;
      } catch (_) {}
    } else {
      // スタッフがWebアプリ管理者ページにアクセスしようとした場合など
      const backPage = role === "staff" ? "my-recruitment" : "dashboard";
      const backLabel = role === "staff" ? "清掃スケジュール" : "ダッシュボード";
      document.getElementById("pageContainer").innerHTML = `
        <div class="empty-state fade-in">
          <i class="bi bi-tools"></i>
          <p>このページは準備中です</p>
          <a href="#/${backPage}" class="btn btn-primary">${backLabel}に戻る</a>
        </div>
      `;
    }
  },
};

// トースト通知
function showToast(title, message, type = "info") {
  const toast = document.getElementById("appToast");
  const header = toast.querySelector(".toast-header");
  const bgClass = type === "error" ? "bg-danger text-white" : type === "success" ? "bg-success text-white" : "";
  header.className = `toast-header ${bgClass}`;
  document.getElementById("toastTitle").textContent = title;
  document.getElementById("toastBody").textContent = message;
  bootstrap.Toast.getOrCreateInstance(toast).show();
}

// ===== 確認ダイアログ (ネイティブ confirm/alert/prompt の Bootstrap モーダル置換) =====
// ブラウザ別ネイティブ UI を避け、意匠を統一するため使用する。
function _escAttr(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }
function _escHtml(s) { const d = document.createElement("div"); d.textContent = String(s == null ? "" : s); return d.innerHTML; }

/** Promise<boolean> を返す確認モーダル。OK=true / キャンセル=false */
function showConfirm(message, opts = {}) {
  return new Promise((resolve) => {
    const title = opts.title || "確認";
    const okLabel = opts.okLabel || "OK";
    const cancelLabel = opts.cancelLabel || "キャンセル";
    const okClass = opts.okClass || "btn-primary";
    const modalId = `confirmModal_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    const html = `
      <div class="modal fade" id="${modalId}" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">${_escHtml(title)}</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body" style="white-space:pre-wrap;">${_escHtml(message)}</div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">${_escHtml(cancelLabel)}</button>
              <button type="button" class="btn ${okClass}" data-role="ok">${_escHtml(okLabel)}</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
    const el = document.getElementById(modalId);
    const modal = new bootstrap.Modal(el);
    let confirmed = false;
    el.querySelector('[data-role="ok"]').addEventListener("click", () => { confirmed = true; modal.hide(); });
    el.addEventListener("hidden.bs.modal", () => { resolve(confirmed); el.remove(); });
    modal.show();
  });
}

/** Promise<void> を返す通知モーダル (alert 代替) */
function showAlert(message, opts = {}) {
  return new Promise((resolve) => {
    const title = opts.title || "通知";
    const okLabel = opts.okLabel || "OK";
    const modalId = `alertModal_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    const html = `
      <div class="modal fade" id="${modalId}" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">${_escHtml(title)}</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body" style="white-space:pre-wrap;">${_escHtml(message)}</div>
            <div class="modal-footer">
              <button type="button" class="btn btn-primary" data-bs-dismiss="modal">${_escHtml(okLabel)}</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
    const el = document.getElementById(modalId);
    const modal = new bootstrap.Modal(el);
    el.addEventListener("hidden.bs.modal", () => { resolve(); el.remove(); });
    modal.show();
  });
}

/** Promise<string|null> を返す入力モーダル (prompt 代替)。キャンセル時は null */
function showPrompt(message, opts = {}) {
  return new Promise((resolve) => {
    const title = opts.title || "入力";
    const okLabel = opts.okLabel || "OK";
    const cancelLabel = opts.cancelLabel || "キャンセル";
    const defaultValue = opts.defaultValue != null ? String(opts.defaultValue) : "";
    const inputType = opts.type || "text";
    const placeholder = opts.placeholder || "";
    const modalId = `promptModal_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    const html = `
      <div class="modal fade" id="${modalId}" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">${_escHtml(title)}</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="mb-2" style="white-space:pre-wrap;">${_escHtml(message)}</div>
              <input type="${_escAttr(inputType)}" class="form-control" data-role="input"
                     placeholder="${_escAttr(placeholder)}" value="${_escAttr(defaultValue)}">
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">${_escHtml(cancelLabel)}</button>
              <button type="button" class="btn btn-primary" data-role="ok">${_escHtml(okLabel)}</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
    const el = document.getElementById(modalId);
    const input = el.querySelector('[data-role="input"]');
    const modal = new bootstrap.Modal(el);
    let result = null;
    el.querySelector('[data-role="ok"]').addEventListener("click", () => { result = input.value; modal.hide(); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); result = input.value; modal.hide(); } });
    el.addEventListener("shown.bs.modal", () => { input.focus(); input.select(); });
    el.addEventListener("hidden.bs.modal", () => { resolve(result); el.remove(); });
    modal.show();
  });
}

// 日付フォーマット: "2026/4/30(金)" 統一形式
function formatDate(date) {
  if (!date) return "-";
  let d;
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    d = new Date(date + "T00:00:00"); // タイムゾーンずれ防止
  } else {
    d = date.toDate ? date.toDate() : new Date(date);
  }
  if (isNaN(d.getTime())) return String(date);
  const dow = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}(${dow})`;
}

// 金額フォーマット
function formatCurrency(amount) {
  return `¥${(amount || 0).toLocaleString()}`;
}

// アプリ開始
document.addEventListener("DOMContentLoaded", () => App.init());
