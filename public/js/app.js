/**
 * メインアプリ — SPAルーター + 初期化
 * ロール別ルーティング対応（owner / staff）
 */
const App = {
  currentPage: null,

  // オーナー用ページ
  pages: {
    dashboard: DashboardPage,
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
    reports: ReportsPage,
    command: CommandCenterPage,
    projects: ProjectsPage,
    "scan-sorter": ScanSorterPage,
    "tax-docs": TaxDocsPage,
    settings: SettingsPage,
  },

  // スタッフ用ページ
  staffPages: {
    "my-dashboard": MyDashboardPage,
    "my-recruitment": MyRecruitmentPage,
    "my-checklist": MyChecklistPage,
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

    this.route();
  },

  route() {
    if (!Auth.currentUser) return;

    const role = Auth.currentUser.role || "owner";
    const hash = location.hash.replace("#", "") || "/";
    const path = hash.split("/").filter(Boolean);

    // デフォルトページ: オーナー→dashboard、スタッフ→my-dashboard
    const defaultPage = role === "staff" ? "my-dashboard" : "dashboard";
    const pageName = path[0] || defaultPage;

    // ロール別ページマップ選択（オーナーはスタッフページにもアクセス可能）
    const availablePages = role === "staff"
      ? this.staffPages
      : { ...this.pages, ...this.staffPages };

    // サイドバーのアクティブ状態更新
    const navId = role === "staff" ? "#staffNav" : "#ownerNav";
    document.querySelectorAll(`${navId} .nav-link`).forEach((el) => {
      el.classList.toggle("active", el.getAttribute("data-page") === pageName);
    });

    const page = availablePages[pageName];
    if (page) {
      this.currentPage = pageName;
      page.render(document.getElementById("pageContainer"), path.slice(1));
    } else {
      // スタッフがオーナーページにアクセスしようとした場合など
      const backPage = role === "staff" ? "my-dashboard" : "dashboard";
      const backLabel = role === "staff" ? "マイページ" : "ダッシュボード";
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
