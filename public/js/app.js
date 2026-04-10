/**
 * メインアプリ — SPAルーター + 初期化
 */
const App = {
  currentPage: null,

  pages: {
    dashboard: DashboardPage,
    staff: StaffPage,
    properties: PropertiesPage,
    recruitment: RecruitmentPage,
    guests: GuestsPage,
    shifts: ShiftsPage,
    invoices: InvoicesPage,
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
    document.querySelectorAll("#sidebarNav .nav-item a").forEach(el => {
      el.addEventListener("click", () => {
        if (window.innerWidth < 992) {
          sidebar.classList.remove("show");
          overlay.classList.remove("show");
        }
      });
    });
  },

  onAuthReady() {
    // ユーザー名表示
    const user = Auth.currentUser;
    if (user) {
      const name = user.displayName || user.email?.split("@")[0] || "ユーザー";
      const nameEl = document.getElementById("userName");
      if (nameEl) nameEl.textContent = name;
      const avatar = document.getElementById("userAvatar");
      if (avatar) avatar.textContent = name.charAt(0).toUpperCase();
    }
    this.route();
  },

  route() {
    if (!Auth.currentUser) return;

    const hash = location.hash.replace("#", "") || "/";
    const path = hash.split("/").filter(Boolean);
    const pageName = path[0] || "dashboard";

    // サイドバーのアクティブ状態更新
    document.querySelectorAll("#sidebarNav .nav-item a").forEach((el) => {
      el.classList.toggle("active", el.getAttribute("data-page") === pageName);
    });

    const page = this.pages[pageName];
    if (page) {
      this.currentPage = pageName;
      page.render(document.getElementById("pageContainer"), path.slice(1));
    } else {
      document.getElementById("pageContainer").innerHTML = `
        <div class="empty-state fade-in">
          <i class="bi bi-tools"></i>
          <p>このページは準備中です</p>
          <a href="#/" class="btn btn-primary">ダッシュボードに戻る</a>
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

// 日付フォーマット
function formatDate(date) {
  if (!date) return "-";
  const d = date.toDate ? date.toDate() : new Date(date);
  return d.toLocaleDateString("ja-JP");
}

// 金額フォーマット
function formatCurrency(amount) {
  return `¥${(amount || 0).toLocaleString()}`;
}

// アプリ開始
document.addEventListener("DOMContentLoaded", () => App.init());
