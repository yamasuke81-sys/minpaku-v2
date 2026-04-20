/**
 * 旧: スタッフ用 送信済み請求書確認ページ
 * 2026-04-21: my-invoice-create に統合。リダイレクトのみ行う stub。
 *
 * ルート: #/my-invoice → #/my-invoice-create
 */
const MyInvoicePage = {
  async render(container) {
    // 即座にリダイレクト
    if (location.hash !== "#/my-invoice-create") {
      location.hash = "#/my-invoice-create";
      return;
    }
    container.innerHTML = `<div class="text-center text-muted py-5"><div class="spinner-border"></div></div>`;
  },
};
