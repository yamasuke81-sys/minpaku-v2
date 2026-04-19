/**
 * スタッフ用 送信済み請求書確認ページ
 *   - 自分の請求書一覧 (draft / submitted / paid を時系列降順)
 *   - draft は編集不可表示 (my-invoice-create へのリンク)
 *   - submitted 以降は読み取り専用、各明細を展開表示
 *   - PDF ダウンロードリンク (pdfUrl があれば)
 *
 * ルート: #/my-invoice
 */
const MyInvoicePage = {
  CF_BASE: "https://api-5qrfx7ujcq-an.a.run.app",

  async render(container) {
    container.innerHTML = `
      <div class="page-header" style="position:sticky;top:0;z-index:20;background:#fff;padding:12px 0;margin:-12px 0 12px 0;border-bottom:1px solid #dee2e6;">
        <h2 class="mb-0"><i class="bi bi-receipt"></i> 請求書</h2>
        <a href="#/my-invoice-create" class="btn btn-sm btn-primary">
          <i class="bi bi-plus-circle"></i> 新しい請求書を作成
        </a>
      </div>
      <div id="myInvBody">
        <div class="text-center text-muted py-5"><div class="spinner-border"></div></div>
      </div>
    `;
    await this._loadList();
  },

  async _loadList() {
    const bodyEl = document.getElementById("myInvBody");
    try {
      const token = await firebase.auth().currentUser.getIdToken();
      const res = await fetch(`${this.CF_BASE}/invoices`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const invoices = await res.json();

      if (!invoices.length) {
        bodyEl.innerHTML = `
          <div class="alert alert-secondary text-center">
            <i class="bi bi-inbox"></i> 請求書はまだありません。
            <br><a href="#/my-invoice-create" class="btn btn-sm btn-primary mt-2">
              <i class="bi bi-plus-circle"></i> 最初の請求書を作成
            </a>
          </div>`;
        return;
      }

      // 時系列降順 (yearMonth 降順)
      invoices.sort((a, b) => (b.yearMonth || "").localeCompare(a.yearMonth || ""));

      bodyEl.innerHTML = invoices.map(inv => this._renderCard(inv)).join("");

      // 明細アコーディオンのトグルを有効化
      bodyEl.querySelectorAll(".inv-toggle-detail").forEach(btn => {
        btn.addEventListener("click", () => {
          const detailEl = document.getElementById(btn.dataset.target);
          if (!detailEl) return;
          const isOpen = !detailEl.classList.contains("d-none");
          detailEl.classList.toggle("d-none", isOpen);
          btn.querySelector(".inv-chevron").style.transform = isOpen ? "" : "rotate(180deg)";
        });
      });
    } catch (e) {
      bodyEl.innerHTML = `
        <div class="alert alert-danger">
          <i class="bi bi-exclamation-triangle"></i> 読み込みエラー: ${this._esc(e.message)}
        </div>`;
    }
  },

  _renderCard(inv) {
    const statusMap = {
      draft: { label: "下書き", cls: "bg-secondary" },
      submitted: { label: "送信済み", cls: "bg-primary" },
      confirmed: { label: "確認済み", cls: "bg-info text-dark" },
      paid: { label: "支払済み", cls: "bg-success" },
    };
    const st = statusMap[inv.status] || { label: inv.status || "不明", cls: "bg-secondary" };
    const isDraft = inv.status === "draft";
    const detailId = `invDetail_${inv.id}`;

    // 明細行 HTML を組み立て
    const shiftRows = (inv.shifts || []).map(s => `
      <tr>
        <td>${this._esc(s.date || "")}</td>
        <td>${this._esc(s.propertyName || "")}</td>
        <td class="text-end">¥${(s.amount || 0).toLocaleString()}</td>
        <td class="text-muted small">${this._esc(s.memo || "")}</td>
      </tr>`).join("");

    const laundryRows = (inv.laundry || []).map(l => `
      <tr>
        <td>${this._esc(l.date || "")}</td>
        <td>ランドリー立替</td>
        <td class="text-end">¥${(l.amount || 0).toLocaleString()}</td>
        <td class="text-muted small">${this._esc(l.memo || "")}</td>
      </tr>`).join("");

    const manualRows = (inv.manualItems || []).map(m => `
      <tr>
        <td colspan="2">${this._esc(m.label || "")}</td>
        <td class="text-end">¥${(m.amount || 0).toLocaleString()}</td>
        <td class="text-muted small">${this._esc(m.memo || "")}</td>
      </tr>`).join("");

    const hasDetail = shiftRows || laundryRows || manualRows;

    // PDF リンク
    const pdfBtn = inv.pdfUrl
      ? `<a href="${this._esc(inv.pdfUrl)}" target="_blank" class="btn btn-sm btn-outline-secondary">
           <i class="bi bi-file-earmark-pdf"></i> PDF
         </a>`
      : "";

    // draft の場合は「作成を続ける」リンクを表示
    const editBtn = isDraft
      ? `<a href="#/my-invoice-create" class="btn btn-sm btn-outline-primary">
           <i class="bi bi-pencil"></i> 作成を続ける
         </a>`
      : "";

    // 明細展開ボタン (詳細がある場合のみ)
    const toggleBtn = hasDetail
      ? `<button class="btn btn-sm btn-outline-secondary inv-toggle-detail" data-target="${detailId}">
           <i class="bi bi-chevron-down inv-chevron" style="transition:transform 0.2s;"></i> 明細
         </button>`
      : "";

    return `
      <div class="card mb-3 ${isDraft ? 'border-secondary' : ''}">
        <div class="card-body">
          <div class="d-flex justify-content-between align-items-start flex-wrap gap-2">
            <div>
              <div class="fw-bold">${this._esc(inv.yearMonth || "")}</div>
              <div class="small text-muted">${this._esc(inv.id || "")}</div>
            </div>
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <span class="badge ${st.cls}">${st.label}</span>
              <span class="fs-5 fw-bold">¥${(inv.total || 0).toLocaleString()}</span>
              ${pdfBtn}
              ${editBtn}
              ${toggleBtn}
            </div>
          </div>

          ${isDraft ? `
          <div class="alert alert-secondary py-2 small mt-2 mb-0">
            <i class="bi bi-info-circle"></i>
            この請求書はまだ送信されていません。「作成を続ける」から内容を確認・送信してください。
          </div>` : ""}

          ${inv.status !== "draft" ? `
          <div class="small text-muted mt-1">
            <i class="bi bi-info-circle"></i>
            この請求書の修正が必要な場合はオーナーに連絡してください。
          </div>` : ""}

          ${hasDetail ? `
          <div id="${detailId}" class="d-none mt-3">
            <table class="table table-sm align-middle">
              <thead class="table-light">
                <tr>
                  <th>日付</th>
                  <th>内容</th>
                  <th class="text-end">金額</th>
                  <th>メモ</th>
                </tr>
              </thead>
              <tbody>
                ${shiftRows}
                ${laundryRows}
                ${manualRows}
              </tbody>
              <tfoot>
                <tr class="fw-bold">
                  <td colspan="2">合計</td>
                  <td class="text-end">¥${(inv.total || 0).toLocaleString()}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>` : ""}
        </div>
      </div>`;
  },

  _esc(s) {
    const d = document.createElement("div");
    d.textContent = String(s == null ? "" : s);
    return d.innerHTML;
  },
};
