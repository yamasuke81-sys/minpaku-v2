/**
 * 新旧cal比較ページ
 * GAS版（旧アプリ）と民泊v2の清掃スケジュールを横並びで比較する
 * オーナーのみ表示
 */
const CalComparePage = {
  async render(container) {
    const GAS_URL = "https://script.google.com/macros/s/AKfycbzfOEVVpybSZLZe-htulSn-j4wL0pYhyLyAk-Vmz0j9N_3LtAshQiq8GRP0BSDsS8eHdw/exec";
    const V2_URL = "/index.html#/schedule";

    container.innerHTML = `
      <div style="padding:12px 16px 8px;">
        <h5 class="mb-1"><i class="bi bi-arrow-left-right"></i> 新旧cal比較</h5>
        <p class="text-muted mb-2" style="font-size:12px;">
          ※ 横並び表示のためスマホでは見づらいです。比較目的でPC/タブレット推奨
        </p>

        <div style="display:flex; flex-direction:row; gap:8px; height:calc(100vh - 120px);">
          <!-- 左カラム: GAS版 -->
          <div style="flex:1; min-width:0; display:flex; flex-direction:column;">
            <div class="d-flex align-items-center gap-2 mb-1">
              <span class="fw-bold" style="font-size:14px;"><i class="bi bi-archive"></i> GAS版</span>
              <a href="${GAS_URL}" target="_blank" rel="noopener"
                class="btn btn-sm btn-outline-secondary ms-auto" style="font-size:12px;">
                <i class="bi bi-box-arrow-up-right"></i> 新しいタブで開く
              </a>
            </div>
            <iframe src="${GAS_URL}"
              style="flex:1; width:100%; border:1px solid #dee2e6; border-radius:4px;"
              loading="lazy"
              title="GAS版民泊管理アプリ">
            </iframe>
          </div>

          <!-- 右カラム: 民泊v2 -->
          <div style="flex:1; min-width:0; display:flex; flex-direction:column;">
            <div class="d-flex align-items-center gap-2 mb-1">
              <span class="fw-bold" style="font-size:14px;"><i class="bi bi-calendar-check"></i> 民泊v2</span>
              <a href="${V2_URL}" target="_blank" rel="noopener"
                class="btn btn-sm btn-outline-secondary ms-auto" style="font-size:12px;">
                <i class="bi bi-box-arrow-up-right"></i> 新しいタブで開く
              </a>
            </div>
            <iframe src="${V2_URL}"
              style="flex:1; width:100%; border:1px solid #dee2e6; border-radius:4px;"
              title="民泊v2 清掃スケジュール">
            </iframe>
          </div>
        </div>
      </div>
    `;
  },

  detach() {
    // リスナーなし — 何もしない
  },
};
