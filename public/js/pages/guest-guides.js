/**
 * ゲスト案内 — 物件別のゲスト案内ページ一覧
 * 各物件の guideSlug から /guides/{slug}.html を開く。
 * 未作成の物件はインポート用モーダルで Claude Code 向けの指示プロンプトを生成。
 */

// propertyId → ガイドファイル名（public/guides/{slug}.html）
// マッピング本体は public/js/guide-map.js に集約。
// 新規ガイド作成時は guide-map.js と functions/utils/guideMap.js の両方を同期更新する。
const GUIDE_MAP = (window.GuideMap && window.GuideMap.GUIDE_MAP) || {};

const GuestGuidesPage = {
  propertyList: [],

  async render(container) {
    container.innerHTML = `
      <div class="container-fluid py-3">
        <div class="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
          <h1 class="h4 mb-0"><i class="bi bi-book me-2"></i>ゲスト案内</h1>
          <div class="text-muted small">物件をタップするとガイドページが開きます</div>
        </div>
        <div id="guideListArea" class="d-grid gap-2"></div>
      </div>

      <!-- インポート用モーダル -->
      <div class="modal fade" id="guideImportModal" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered modal-lg">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-file-earmark-plus me-2"></i>ゲスト案内を新規作成（インポート）</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="mb-3">
                <label class="form-label fw-bold small">作成先の物件</label>
                <div id="gImportTarget" class="form-control-plaintext fw-bold"></div>
              </div>
              <div class="mb-3">
                <label for="gImportSource" class="form-label fw-bold small">参照元（このガイドの見た目を複製します）</label>
                <select id="gImportSource" class="form-select"></select>
              </div>
              <div class="mb-3">
                <label for="gImportSlug" class="form-label fw-bold small">新ガイドのURL（/guides/○○.html の○○部分）</label>
                <input id="gImportSlug" type="text" class="form-control" placeholder="例: wakakusa">
                <div class="form-text">半角英数とハイフンのみ。後から変更は手動作業になるのでよく検討してください。</div>
              </div>

              <hr>
              <div class="alert alert-info small mb-2">
                <i class="bi bi-info-circle me-1"></i>
                現在の運用では、ファイルの複製とデプロイは Claude Code 経由で行います。
                下の指示プロンプトをコピーして Claude Code に貼り付けてください。
              </div>
              <label class="form-label fw-bold small">Claude Code 用プロンプト</label>
              <div class="position-relative">
                <textarea id="gImportPrompt" class="form-control font-monospace small" rows="10" readonly></textarea>
                <button id="gImportCopyBtn" class="btn btn-sm btn-primary position-absolute" style="top:8px; right:8px;">
                  <i class="bi bi-clipboard me-1"></i>コピー
                </button>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary" data-bs-dismiss="modal">閉じる</button>
            </div>
          </div>
        </div>
      </div>
    `;

    await this.loadProperties();
    this.bindEvents();
  },

  async loadProperties() {
    try {
      const list = await API.properties.list(false);
      // 民泊物件のみ対象（type === "minpaku"、未設定は民泊扱いで互換維持）
      const minpakuOnly = list.filter(p => !p.type || p.type === "minpaku");
      // propertyNumber 昇順
      this.propertyList = minpakuOnly.slice().sort((a, b) => {
        const av = a.propertyNumber == null ? Infinity : Number(a.propertyNumber);
        const bv = b.propertyNumber == null ? Infinity : Number(b.propertyNumber);
        return av - bv;
      });
      this.renderCards();
    } catch (e) {
      document.getElementById("guideListArea").innerHTML =
        `<div class="alert alert-danger">物件読み込み失敗: ${e.message}</div>`;
    }
  },

  getSlug(property) {
    const byId = GUIDE_MAP[property.id];
    return byId?.slug || null;
  },

  renderCards() {
    const host = document.getElementById("guideListArea");
    if (!this.propertyList.length) {
      host.innerHTML = `<div class="alert alert-secondary">物件が登録されていません。</div>`;
      return;
    }
    host.innerHTML = this.propertyList.map(p => {
      const num = p.propertyNumber != null ? p.propertyNumber : "–";
      const color = p.color || "#6c757d";
      const slug = this.getSlug(p);
      const url = slug ? `/guides/${slug}.html` : null;
      const actionHtml = url
        ? `<a href="${url}" target="_blank" rel="noopener" class="btn btn-outline-primary btn-sm">
             <i class="bi bi-box-arrow-up-right me-1"></i>案内を開く
           </a>`
        : `<button class="btn btn-success btn-sm" data-action="import" data-property-id="${p.id}">
             <i class="bi bi-file-earmark-plus me-1"></i>新規作成（インポート）
           </button>`;
      return `
        <div class="card">
          <div class="card-body d-flex align-items-center gap-3 flex-wrap">
            <span class="badge rounded-pill" style="background:${color}; color:#fff; font-size:0.95rem; padding:0.4rem 0.7rem;">
              #${num}
            </span>
            <div class="flex-grow-1">
              <div class="fw-bold" style="font-size:1.05rem;">${escapeHtml(p.name || "(無名)")}</div>
              ${slug ? `<div class="small text-muted font-monospace">/guides/${slug}.html</div>`
                     : `<div class="small text-warning">ガイド未作成</div>`}
            </div>
            ${actionHtml}
          </div>
        </div>
      `;
    }).join("");
  },

  bindEvents() {
    const host = document.getElementById("guideListArea");
    host.addEventListener("click", (e) => {
      const btn = e.target.closest('[data-action="import"]');
      if (!btn) return;
      this.openImportModal(btn.dataset.propertyId);
    });
    document.getElementById("gImportCopyBtn").addEventListener("click", () => this.copyPrompt());
    document.getElementById("gImportSource").addEventListener("change", () => this.updatePrompt());
    document.getElementById("gImportSlug").addEventListener("input", () => this.updatePrompt());
  },

  openImportModal(propertyId) {
    const property = this.propertyList.find(p => p.id === propertyId);
    if (!property) return;

    document.getElementById("gImportTarget").textContent = `#${property.propertyNumber ?? "–"} ${property.name}`;

    // 参照元セレクト（既存ガイドのみ）
    const sourceSelect = document.getElementById("gImportSource");
    const sources = this.propertyList
      .map(p => ({ p, slug: this.getSlug(p) }))
      .filter(x => x.slug);
    sourceSelect.innerHTML = sources.map(s =>
      `<option value="${s.slug}" data-name="${escapeAttr(s.p.name)}">${escapeHtml(s.p.name)}（/guides/${s.slug}.html）</option>`
    ).join("");

    // slug 初期値（物件名ベース）
    const slugInput = document.getElementById("gImportSlug");
    slugInput.value = this.suggestSlug(property.name);

    // 現在の対象を保持
    this._importTarget = property;

    this.updatePrompt();

    const modal = new bootstrap.Modal(document.getElementById("guideImportModal"));
    modal.show();
  },

  suggestSlug(name) {
    if (!name) return "";
    // 英数字とスペース/ハイフンのみ抽出、それ以外は除去
    const ascii = name
      .normalize("NFKC")
      .replace(/[^\w\s\-]/g, " ")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .toLowerCase();
    return ascii.replace(/^-|-$/g, "");
  },

  updatePrompt() {
    const target = this._importTarget;
    if (!target) return;
    const sourceSelect = document.getElementById("gImportSource");
    const selectedOpt = sourceSelect.options[sourceSelect.selectedIndex];
    const sourceSlug = sourceSelect.value;
    const sourceName = selectedOpt?.dataset.name || "";
    const newSlug = document.getElementById("gImportSlug").value.trim() || "(未入力)";
    const prompt = `民泊v2 のゲスト案内ページを新規作成してください。

- 参照元: /guides/${sourceSlug}.html（${sourceName}）
- 新規作成先: /guides/${newSlug}.html
- 対象物件: ${target.name}（propertyId: ${target.id}, propertyNumber: ${target.propertyNumber ?? "なし"}）

手順:
1. public/guides/${sourceSlug}.html を public/guides/${newSlug}.html に複製
2. 新ファイル内のタイトル・物件名・固有情報を「${target.name}」向けに書き換え（共通事項の紐付けはせず独立したページとして扱う）
3. 以下2ファイルの GUIDE_MAP に同じ行を追記（クライアント・サーバー両方）:
     "${target.id}": { slug: "${newSlug}" }
   - public/js/guide-map.js
   - functions/utils/guideMap.js
4. deploy（git commit & push → GitHub Actions で自動デプロイ）
5. 完了後、URL https://minpaku-v2.web.app/guides/${newSlug}.html を確認`;
    document.getElementById("gImportPrompt").value = prompt;
  },

  async copyPrompt() {
    const text = document.getElementById("gImportPrompt").value;
    try {
      await navigator.clipboard.writeText(text);
      const btn = document.getElementById("gImportCopyBtn");
      const orig = btn.innerHTML;
      btn.innerHTML = `<i class="bi bi-check2 me-1"></i>コピー済`;
      btn.classList.replace("btn-primary", "btn-success");
      setTimeout(() => {
        btn.innerHTML = orig;
        btn.classList.replace("btn-success", "btn-primary");
      }, 1800);
    } catch (e) {
      showToast("コピー失敗", "手動でコピーしてください", "error");
    }
  },
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
