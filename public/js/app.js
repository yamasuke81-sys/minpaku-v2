/**
 * メインアプリ — SPAルーター + 初期化
 * ロール別ルーティング対応（owner / staff）
 */
const App = {
  currentPage: null,

  // オーナー用ページ
  pages: {
    staff: StaffPage,
    properties: PropertiesPage,
    "property-checklist": PropertyChecklistPage,
    recruitment: RecruitmentPage,
    guests: GuestsPage,
    shifts: ShiftsPage,
    invoices: InvoicesPage,
    rates: RatesPage,
    notifications: NotificationsPage,
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

  /** 代理閲覧中のサブオーナーStaffId (null = 通常モード) */
  impersonating: null,
  impersonatingData: null,

  /**
   * 起動時に impersonateAs を読み込む
   * メインオーナーが特定サブオーナーの視点でアプリを閲覧するための機構
   */
  async initImpersonation() {
    const impersonateAs = localStorage.getItem("impersonateAs");
    if (!impersonateAs) {
      this.impersonating = null;
      this.impersonatingData = null;
      return;
    }
    // 実際のロールがオーナーの場合のみ有効
    const role = Auth.currentUser?.role || "owner";
    if (role !== "owner" && role !== null && role !== undefined) {
      // オーナー以外は impersonation 不可
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

  /** 代理閲覧バナーを表示 */
  _showImpersonateBanner(subOwner) {
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

    // スタッフ側のプリカ管理タブ: 担当物件に紐づくカードがある場合のみ表示
    if (role === "staff") this._maybeShowStaffPrepaidNav();

    // impersonation 初期化（オーナーのみ）
    this.initImpersonation().then(() => this.route());
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

    // #/dashboard または #/ (ルート) → #/my-recruitment へリダイレクト
    // ダッシュボード画面は廃止され、清掃スケジュール画面に統合済み (Phase 2-5)
    if (location.hash === "#/dashboard" || location.hash === "#/" || location.hash === "") {
      // スタッフ時はスタッフ側 defaultPage へ
      const r = Auth.currentUser?.role || "owner";
      if (r !== "staff") {
        location.hash = "#/my-recruitment";
        return;
      }
    }

    const role = Auth.currentUser.role || "owner";
    const hash = location.hash.replace("#", "") || "/";
    // クエリ部分 (?key=val) は route 決定には使わずページ側へ伝える (location.hash は残す)
    const pathOnly = hash.split("?")[0];
    const path = pathOnly.split("/").filter(Boolean);

    // デフォルトページ: 全ロール→my-recruitment (清掃スケジュール画面に統合済み)
    const defaultPage = "my-recruitment";
    const pageName = path[0] || defaultPage;

    // ロール別ページマップ選択（オーナー/サブオーナーはスタッフページにもアクセス可能）
    const availablePages = role === "staff"
      ? this.staffPages
      : { ...this.pages, ...this.staffPages };

    // サイドバーのアクティブ状態更新（サブオーナーはオーナーナビを使用）
    const navId = role === "staff" ? "#staffNav" : "#ownerNav";
    document.querySelectorAll(`${navId} .nav-link`).forEach((el) => {
      el.classList.toggle("active", el.getAttribute("data-page") === pageName);
    });

    const page = availablePages[pageName];
    if (page) {
      this.currentPage = pageName;
      page.render(document.getElementById("pageContainer"), path.slice(1));
      // ページ切り替え時にビュー最上部へスクロール
      try {
        window.scrollTo({ top: 0, behavior: "instant" });
        const mainEl = document.querySelector(".app-main");
        if (mainEl) mainEl.scrollTop = 0;
      } catch (_) {}
    } else {
      // スタッフがオーナーページにアクセスしようとした場合など
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
