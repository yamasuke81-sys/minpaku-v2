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

        <!-- GAS版スタッフ回答データ取込 -->
        <div class="card mt-4 mb-4">
          <div class="card-header bg-info text-white">
            <h5 class="mb-0"><i class="bi bi-download"></i> GAS版スタッフ回答データ取込</h5>
          </div>
          <div class="card-body">
            <p class="text-muted small mb-2">
              旧 GAS 版「募集_立候補」シートの回答と「募集」シートの確定状況を v2 に取込みます。一度きりの繋ぎツールです。
            </p>
            <ul class="text-muted small mb-3">
              <li>対象物件: <strong>the Terrace 長浜</strong>（固定）</li>
              <li>スタッフ照合: 苗字（最初の半角/全角スペース前）の前方一致</li>
              <li>苗字重複・未一致は警告にして<strong>スキップ</strong></li>
              <li>v2 に既存の人手入力回答がある場合は v2 優先で<strong>スキップ</strong></li>
              <li>GAS 記号 ○/× は ◎/× に、△ はメモ付きで取込</li>
            </ul>
            <div class="row g-2 mb-3">
              <div class="col-md-4">
                <label class="form-label small mb-1">CO日 開始</label>
                <input type="date" class="form-control form-control-sm" id="gasImportFrom">
              </div>
              <div class="col-md-4">
                <label class="form-label small mb-1">CO日 終了</label>
                <input type="date" class="form-control form-control-sm" id="gasImportTo">
              </div>
              <div class="col-md-4 d-flex align-items-end gap-2">
                <button class="btn btn-outline-info btn-sm flex-fill" id="btnGasImportPreview">
                  <i class="bi bi-eye"></i> プレビュー
                </button>
                <button class="btn btn-info btn-sm flex-fill" id="btnGasImportRun">
                  <i class="bi bi-cloud-download"></i> 実行
                </button>
              </div>
            </div>
            <div class="d-none" id="gasImportResult">
              <div class="alert" id="gasImportAlert"></div>
              <details class="mb-2">
                <summary class="small text-muted">警告一覧</summary>
                <div id="gasImportWarnings" class="small mt-2"></div>
              </details>
              <details>
                <summary class="small text-muted">取込予定/実績の詳細</summary>
                <div id="gasImportPreview" class="small mt-2"></div>
              </details>
            </div>
          </div>
        </div>
      </div>
    `;

    // GAS取込ハンドラ
    document.getElementById("btnGasImportPreview")?.addEventListener("click", () => this._gasImport(true));
    document.getElementById("btnGasImportRun")?.addEventListener("click", () => this._gasImport(false));
  },

  // the Terrace 長浜 propertyId 固定
  TERRACE_NAGAHAMA_ID: "tsZybhDMcPrxqgcRy7wp",

  async _gasImport(dryRun) {
    const from = document.getElementById("gasImportFrom").value;
    const to = document.getElementById("gasImportTo").value;
    const resBox = document.getElementById("gasImportResult");
    const alertEl = document.getElementById("gasImportAlert");
    const warnEl = document.getElementById("gasImportWarnings");
    const previewEl = document.getElementById("gasImportPreview");
    resBox.classList.remove("d-none");
    if (!from || !to) {
      alertEl.className = "alert alert-warning";
      alertEl.textContent = "CO日 開始 / 終了 を入力してください";
      return;
    }
    if (!dryRun) {
      const ok = await showConfirm(
        `GAS版の回答と確定状況を v2 に取込みます (${from} 〜 ${to})。v2 既存の人手入力回答は上書きしません。実行しますか？`,
        "GAS取込 実行確認"
      );
      if (!ok) return;
    }
    alertEl.className = "alert alert-info";
    alertEl.innerHTML = `<div class="spinner-border spinner-border-sm me-2"></div>${dryRun ? "プレビュー" : "取込"}中...`;
    warnEl.innerHTML = "";
    previewEl.innerHTML = "";
    try {
      const token = await firebase.auth().currentUser.getIdToken();
      const r = await fetch("https://api-5qrfx7ujcq-an.a.run.app/recruitment/import-gas-responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          from, to,
          propertyId: this.TERRACE_NAGAHAMA_ID,
          dryRun: !!dryRun,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "API失敗");
      const s = data.summary || {};
      alertEl.className = "alert " + (dryRun ? "alert-info" : "alert-success");
      alertEl.innerHTML = `<strong>${dryRun ? "プレビュー結果" : "取込完了"}</strong> — 回答: 該当 ${s.matched}件 / ${dryRun ? "予定" : "取込"} ${dryRun ? s.matched : s.imported}件 / スキップ ${s.skipped}件 (全候補行 ${s.totalCandidateRows}件)<br>確定: 対象 ${s.confirmedTargets || 0}件 / ${dryRun ? "予定" : "適用"} ${dryRun ? (s.confirmedTargets || 0) : (s.confirmedApplied || 0)}件`;

      const ws = data.warnings || [];
      if (ws.length === 0) {
        warnEl.innerHTML = `<span class="text-muted">警告なし</span>`;
      } else {
        const typeLabel = {
          duplicate_lastname: "苗字重複",
          no_match: "苗字未一致",
          no_recruitment: "v2に対応募集なし",
          v2_existing: "v2に既存回答あり",
          unresolved_staff: "確定スタッフ名解決不可",
          no_status_or_selected_column: "ステータス/選定スタッフ列なし",
        };
        warnEl.innerHTML = `<table class="table table-sm table-bordered"><thead><tr><th>種別</th><th>GASスタッフ名</th><th>日付</th><th>詳細</th></tr></thead><tbody>${ws.map((w) => {
          const t = typeLabel[w.type] || w.type;
          let detail = "";
          if (w.type === "duplicate_lastname") {
            detail = `候補: ${(w.candidates || []).map((c) => c.name).join(" / ")}`;
          } else if (w.type === "v2_existing") {
            detail = `staff: ${w.staffName || w.staffId}`;
          } else if (w.type === "unresolved_staff") {
            detail = `名前: ${(w.names || []).join(", ")}`;
          }
          return `<tr><td>${t}</td><td>${w.gasStaffName || w.staffName || ""}</td><td>${w.date || ""}</td><td>${detail}</td></tr>`;
        }).join("")}</tbody></table>`;
      }

      const ps = data.preview || [];
      const cps = data.confirmPreview || [];
      const respHtml = ps.length === 0 ? `<div class="text-muted">回答: なし</div>` :
        `<div class="mt-1"><strong>回答取込:</strong></div><table class="table table-sm table-bordered"><thead><tr><th>日付</th><th>スタッフ</th><th>回答</th><th>メモ</th></tr></thead><tbody>${ps.map((p) => `<tr><td>${p.date}</td><td>${p.staffName}</td><td>${p.response}</td><td>${p.memo || ""}</td></tr>`).join("")}</tbody></table>`;
      const confHtml = cps.length === 0 ? `<div class="text-muted">確定: なし</div>` :
        `<div class="mt-1"><strong>確定取込:</strong></div><table class="table table-sm table-bordered"><thead><tr><th>日付</th><th>選定スタッフ</th><th>現ステータス</th></tr></thead><tbody>${cps.map((c) => `<tr><td>${c.date}</td><td>${c.selectedStaff}</td><td>${c.currentStatus || ""}</td></tr>`).join("")}</tbody></table>`;
      previewEl.innerHTML = respHtml + confHtml;
    } catch (e) {
      alertEl.className = "alert alert-danger";
      alertEl.textContent = `エラー: ${e.message}`;
    }
  },

  detach() {
    // リスナーなし — 何もしない
  },
};
