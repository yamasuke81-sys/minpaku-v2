/**
 * 宿泊者名簿ページ
 * 旅館業法に基づくゲスト情報の一覧・登録・詳細・検索
 * Googleフォーム連携 + 手動入力対応
 */
const GuestsPage = {
  guestList: [],
  properties: [],          // 物件一覧
  selectedPropertyIds: [], // フィルタ選択中の物件ID
  modal: null,
  detailModal: null,
  searchTimer: null,

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-person-vcard"></i> 宿泊者名簿</h2>
        <div>
          <button class="btn btn-outline-secondary me-2" id="btnGuestSettings" title="フォームURL・フォーム項目管理">
            <i class="bi bi-gear"></i> 設定
          </button>
          <button class="btn btn-outline-info me-2" id="btnImportGas" title="GAS版スプレッドシートから指定期間をインポート">
            <i class="bi bi-cloud-download"></i> GASインポート
          </button>
          <button class="btn btn-primary" id="btnAddGuest">
            <i class="bi bi-plus-lg"></i> 手動登録
          </button>
        </div>
      </div>

      <!-- 物件フィルタ -->
      <div id="propertyFilterHost-guests"></div>

      <!-- 検索・フィルタ -->
      <div class="row g-2 mb-3">
        <div class="col-md-4">
          <div class="input-group">
            <span class="input-group-text"><i class="bi bi-search"></i></span>
            <input type="text" class="form-control" id="guestSearch"
              placeholder="氏名・国籍・電話で検索...">
          </div>
        </div>
        <div class="col-md-3">
          <div class="input-group">
            <input type="month" class="form-control" id="guestMonth"
              value="${new Date().toISOString().slice(0, 7)}">
            <button class="btn btn-outline-secondary" id="btnGuestYearView" title="年表示に切替">
              <i class="bi bi-calendar-range"></i>
            </button>
          </div>
        </div>
        <div class="col-md-2">
          <span class="badge bg-secondary fs-6 mt-1" id="guestCount">-件</span>
        </div>
      </div>

      <!-- 一覧テーブル -->
      <div class="table-responsive">
        <table class="table table-hover align-middle">
          <thead class="table-light">
            <tr>
              <th>チェックイン</th>
              <th>代表者氏名</th>
              <th class="d-none d-md-table-cell">国籍</th>
              <th>人数</th>
              <th class="d-none d-md-table-cell">予約元</th>
              <th class="d-none d-lg-table-cell">電話</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="guestTableBody">
            <tr><td colspan="7" class="text-center py-4">読み込み中...</td></tr>
          </tbody>
        </table>
      </div>
    `;

    this.modal = new bootstrap.Modal(document.getElementById("guestModal"));
    this.detailModal = new bootstrap.Modal(document.getElementById("guestDetailModal"));
    this.bindEvents();

    // 物件フィルタ初期化
    this.properties = await API.properties.listMinpakuNumbered();
    this.selectedPropertyIds = PropertyFilter.getSelectedIds("guests", this.properties);
    PropertyFilter.render({
      containerId: "propertyFilterHost-guests",
      tabKey: "guests",
      properties: this.properties,
      onChange: (ids) => {
        this.selectedPropertyIds = ids;
        this.loadGuests();
      },
    });

    await this.loadGuests();
  },

  bindEvents() {
    document.getElementById("btnAddGuest").addEventListener("click", () => {
      this.openModal();
    });

    // 「設定」ボタン → 宿泊者名簿設定モーダルを開く
    document.getElementById("btnGuestSettings").addEventListener("click", () => {
      this.openSettingsModal();
    });

    document.getElementById("btnImportGas").addEventListener("click", () => {
      this.showGasImportDialog();
    });

    document.getElementById("guestSearch").addEventListener("input", () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.loadGuests(), 300);
    });

    document.getElementById("guestMonth").addEventListener("change", () => {
      this._yearView = false;
      document.getElementById("btnGuestYearView").classList.remove("btn-primary");
      document.getElementById("btnGuestYearView").classList.add("btn-outline-secondary");
      this.loadGuests();
    });

    document.getElementById("btnGuestYearView").addEventListener("click", () => {
      this._yearView = !this._yearView;
      const btn = document.getElementById("btnGuestYearView");
      if (this._yearView) {
        btn.classList.remove("btn-outline-secondary");
        btn.classList.add("btn-primary");
      } else {
        btn.classList.remove("btn-primary");
        btn.classList.add("btn-outline-secondary");
      }
      this.loadGuests();
    });

    document.getElementById("btnSaveGuest").addEventListener("click", () => {
      this.saveGuest();
    });

    document.getElementById("btnAddCompanion").addEventListener("click", () => {
      this.addCompanionRow();
    });
  },

  async loadGuests() {
    const search = document.getElementById("guestSearch").value.trim();
    const month = document.getElementById("guestMonth").value;
    const params = {};
    if (search) params.search = search;
    if (this._yearView) {
      // 年表示: 選択月の年の1/1〜12/31
      const year = month ? month.slice(0, 4) : new Date().getFullYear().toString();
      params.from = year + "-01-01";
      params.to = year + "-12-31";
    } else if (month) {
      params.from = month + "-01";
      const d = new Date(month + "-01");
      d.setMonth(d.getMonth() + 1);
      d.setDate(0);
      params.to = d.toISOString().slice(0, 10);
    }

    try {
      this.guestList = await API.guests.list(params);
      // カウント表示は renderTable() 内でフィルタ後の件数を設定する
      this.renderTable();
    } catch (e) {
      showToast("エラー", `読み込み失敗: ${e.message}`, "error");
    }
  },

  renderTable() {
    const tbody = document.getElementById("guestTableBody");
    // 物件フィルタを適用 (propertyId がないレコードは常に表示)
    const filtered = this.guestList.filter(g =>
      !g.propertyId || this.selectedPropertyIds.length === 0 || this.selectedPropertyIds.includes(g.propertyId)
    );
    // カウント表示も絞り込み後の件数に更新
    const countEl = document.getElementById("guestCount");
    if (countEl) countEl.textContent = `${filtered.length}件`;

    if (!filtered.length) {
      tbody.innerHTML = `
        <tr><td colspan="7">
          <div class="empty-state">
            <i class="bi bi-person-vcard"></i>
            <p>宿泊者情報がありません</p>
          </div>
        </td></tr>
      `;
      return;
    }

    tbody.innerHTML = filtered.map(g => {
      const totalGuests = g.guestCount || 0;
      const companionCount = (g.guests || []).length;
      const sourceIcon = this.getSourceIcon(g.source);
      return `
        <tr data-id="${g.id}" class="guest-row ${g._coMismatch ? "table-warning" : ""}">
          <td>${formatDate(g.checkIn)}${g.checkInTime ? `<br><small class="text-muted">${this.escapeHtml(g.checkInTime)}</small>` : ""}</td>
          <td>
            <strong>${this.escapeHtml(g.guestName || "-")}</strong>
            ${companionCount > 0 ? `<br><small class="text-muted">他${companionCount}名</small>` : ""}
          </td>
          <td class="d-none d-md-table-cell">
            ${this.escapeHtml(g.nationality || "日本")}
          </td>
          <td>
            ${totalGuests > 0 ? totalGuests + "名" : "-"}${g.guestCountInfants ? `<br><small class="text-muted">+乳幼児${g.guestCountInfants}</small>` : ""}
          </td>
          <td class="d-none d-md-table-cell">${sourceIcon}</td>
          <td class="d-none d-lg-table-cell">${this.escapeHtml(g.phone || "-")}</td>
          <td>
            <div class="btn-group btn-group-sm">
              <button class="btn btn-outline-primary btn-view" title="詳細">
                <i class="bi bi-eye"></i>
              </button>
              <button class="btn btn-outline-secondary btn-edit-guest" title="編集">
                <i class="bi bi-pencil"></i>
              </button>
              <button class="btn btn-outline-danger btn-delete-guest" title="削除">
                <i class="bi bi-trash"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join("");

    // イベントバインド
    tbody.querySelectorAll(".btn-view").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.closest("tr").dataset.id;
        this.showDetail(id);
      });
    });
    tbody.querySelectorAll(".btn-edit-guest").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.closest("tr").dataset.id;
        const guest = this.guestList.find(g => g.id === id);
        if (guest) this.openModal(guest);
      });
    });
    tbody.querySelectorAll(".btn-delete-guest").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.closest("tr").dataset.id;
        this.deleteGuest(id);
      });
    });
  },

  getSourceIcon(source) {
    const map = {
      guest_form: '<span class="badge bg-success">公開フォーム</span>',
      beds24: '<span class="badge bg-primary">BEDS24</span>',
      manual: '<span class="badge bg-secondary">手動</span>',
    };
    return map[source] || "";
  },

  // === GASインポートダイアログ ===
  async showGasImportDialog() {
    // 保存済み Web App URL とシークレットを取得
    let settings = {};
    try {
      const doc = await db.collection("settings").doc("notifications").get();
      if (doc.exists) settings = doc.data();
    } catch (_) {}
    const webAppUrl = settings.gasSyncWebAppUrl || "";
    const gasSecret = settings.gasSecret || "";
    const today = new Date().toISOString().slice(0, 10);
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

    const html = `
      <div class="alert alert-info small mb-3">
        GAS版スプレッドシートからチェックイン日を絞って v2 の宿泊者名簿へ転記します。
      </div>
      <div class="mb-2">
        <label class="form-label small">GAS Web App URL</label>
        <input type="url" class="form-control form-control-sm" id="gasWebAppUrl" placeholder="https://script.google.com/macros/s/.../exec" value="${webAppUrl}">
        <small class="text-muted">GAS: デプロイ→新しいデプロイ→種類「ウェブアプリ」→URLを貼り付け</small>
      </div>
      <div class="mb-2">
        <label class="form-label small">GASシークレット</label>
        <input type="text" class="form-control form-control-sm" id="gasSecret" placeholder="gas_...(任意)" value="${gasSecret}">
      </div>
      <div class="row g-2 mb-2">
        <div class="col-6">
          <label class="form-label small">CI From</label>
          <input type="date" class="form-control form-control-sm" id="importFrom" value="${sevenDaysAgo}">
        </div>
        <div class="col-6">
          <label class="form-label small">CI To</label>
          <input type="date" class="form-control form-control-sm" id="importTo" value="${today}">
        </div>
      </div>
      <button class="btn btn-primary btn-sm w-100" id="btnRunGasImport"><i class="bi bi-cloud-download"></i> インポート実行</button>
      <div id="gasImportResult" class="small mt-2"></div>
    `;
    const body = document.getElementById("guestDetailBody");
    body.innerHTML = html;
    document.querySelector("#guestDetailModal .modal-title").innerHTML =
      '<i class="bi bi-cloud-download"></i> GAS版宿泊者名簿 取り込み';
    this.detailModal.show();

    setTimeout(() => {
      document.getElementById("btnRunGasImport").addEventListener("click", async () => {
        const url = document.getElementById("gasWebAppUrl").value.trim();
        const secret = document.getElementById("gasSecret").value.trim();
        const from = document.getElementById("importFrom").value;
        const to = document.getElementById("importTo").value;
        const resultEl = document.getElementById("gasImportResult");
        if (!url) { resultEl.innerHTML = `<span class="text-danger">Web App URL を入力してください</span>`; return; }
        if (!from || !to) { resultEl.innerHTML = `<span class="text-danger">CI日付範囲を指定してください</span>`; return; }

        // URL・シークレットを保存
        try {
          await db.collection("settings").doc("notifications").set({
            gasSyncWebAppUrl: url, gasSecret: secret,
          }, { merge: true });
        } catch (_) {}

        resultEl.innerHTML = `<span class="text-muted"><span class="spinner-border spinner-border-sm"></span> 実行中...</span>`;
        try {
          const params = new URLSearchParams({ from, to, secret });
          const res = await fetch(`${url}?${params.toString()}`);
          const text = await res.text();
          let data;
          try { data = JSON.parse(text); } catch { data = { message: text }; }
          if (data.error) {
            resultEl.innerHTML = `<span class="text-danger">エラー: ${data.error}</span>`;
          } else {
            resultEl.innerHTML = `<span class="text-success"><i class="bi bi-check-circle"></i> ${data.message || JSON.stringify(data)}</span>`;
            // 一覧を更新
            await this.loadGuests();
          }
        } catch (e) {
          resultEl.innerHTML = `<span class="text-danger">通信失敗: ${e.message}</span>`;
        }
      });
    }, 100);
  },

  // === 物件別 フォームURL + ミニゲーム設定セクション描画 ===
  async _renderPropertyFormSection() {
    const container = document.getElementById("guestFormPropertyList");
    if (!container) return;
    const baseUrl = location.origin + "/form/";

    // 物件一覧 + グローバルミニゲームデフォルト取得
    const [propsSnap, gfDoc] = await Promise.all([
      db.collection("properties").where("active", "==", true).get(),
      db.collection("settings").doc("guestForm").get(),
    ]);
    const globalMiniGame = gfDoc.exists ? (gfDoc.data().miniGameEnabled !== false) : true;
    const properties = propsSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(p => p.type === "minpaku")
      .sort((a, b) => (a.displayOrder || 999) - (b.displayOrder || 999));

    this._propertiesCache = properties;
    // 物件一覧が取得できたらセレクタを更新
    this._refreshFormTargetSelector();

    if (properties.length === 0) {
      container.innerHTML = '<div class="text-muted small">アクティブな民泊物件がありません</div>';
      return;
    }

    container.innerHTML = properties.map(p => {
      const url = `${baseUrl}?propertyId=${p.id}`;
      // 物件のミニゲーム設定: 物件個別の設定があればそれ、無ければグローバル値を継承
      const mgSet = typeof p.miniGameEnabled === "boolean" ? p.miniGameEnabled : globalMiniGame;
      const inherited = typeof p.miniGameEnabled !== "boolean";
      const otherProps = properties.filter(o => o.id !== p.id);
      return `
        <div class="border rounded mb-2 p-2">
          <div class="d-flex align-items-center justify-content-between flex-wrap gap-1 mb-1">
            <div class="fw-semibold small">
              ${this.esc(p.name)}
              ${p.propertyNumber ? `<span class="badge" style="background:${p.color || '#6c757d'};font-size:10px;">#${p.propertyNumber}</span>` : ""}
            </div>
            <div class="d-flex gap-1 align-items-center flex-wrap">
              <div class="form-check form-switch form-check-inline m-0" title="この物件のフォームでミニゲームを表示するか">
                <input class="form-check-input" type="checkbox" id="mg-${p.id}" ${mgSet ? "checked" : ""} data-prop-id="${p.id}">
                <label class="form-check-label small" for="mg-${p.id}">ミニゲーム ${inherited ? '<span class="text-muted" style="font-size:10px;">(共通設定を継承)</span>' : ""}</label>
              </div>
              ${otherProps.length > 0 ? `
                <div class="dropdown">
                  <button class="btn btn-sm btn-outline-secondary dropdown-toggle py-0 px-2" style="font-size:11px;" type="button" data-bs-toggle="dropdown" title="他物件から設定をコピー">
                    <i class="bi bi-arrow-down-square"></i> 他物件からインポート
                  </button>
                  <ul class="dropdown-menu dropdown-menu-end small">
                    ${otherProps.map(o => `<li><button class="dropdown-item small" type="button" data-import-from="${o.id}" data-import-to="${p.id}">${this.esc(o.name)} の設定をコピー</button></li>`).join("")}
                  </ul>
                </div>
              ` : ""}
            </div>
          </div>
          <div class="input-group input-group-sm" style="max-width:720px;">
            <input type="text" class="form-control" id="url-${p.id}" value="${url}" readonly>
            <button class="btn btn-outline-primary" type="button" data-copy-target="url-${p.id}"><i class="bi bi-clipboard"></i></button>
            <button class="btn btn-outline-secondary" type="button" data-open-target="url-${p.id}"><i class="bi bi-box-arrow-up-right"></i></button>
          </div>
        </div>
      `;
    }).join("");

    // イベントバインド (コピー/新タブは全体で再バインド)
    container.querySelectorAll("[data-copy-target]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const target = document.getElementById(btn.dataset.copyTarget);
        if (!target) return;
        const url = target.value;
        try { await navigator.clipboard.writeText(url); showToast("コピー完了", url.slice(0, 60), "success"); }
        catch (_) { target.select(); document.execCommand("copy"); showToast("コピー完了", "", "success"); }
      });
    });
    container.querySelectorAll("[data-open-target]").forEach(btn => {
      btn.addEventListener("click", () => {
        const target = document.getElementById(btn.dataset.openTarget);
        if (target) window.open(target.value, "_blank", "noopener");
      });
    });

    // ミニゲームトグル → properties/{id}.miniGameEnabled を更新
    container.querySelectorAll("input[data-prop-id]").forEach(cb => {
      cb.addEventListener("change", async () => {
        const propId = cb.dataset.propId;
        try {
          await db.collection("properties").doc(propId).update({ miniGameEnabled: cb.checked });
          showToast("保存しました", `${cb.checked ? "ON" : "OFF"} に変更`, "success");
          // 継承ラベル削除 (実際の設定が入ったので)
          const label = cb.closest(".form-check").querySelector("label .text-muted");
          if (label) label.remove();
        } catch (e) {
          showToast("保存失敗", e.message, "error");
          cb.checked = !cb.checked;
        }
      });
    });

    // 「他物件からインポート」 → src.miniGameEnabled を dst にコピー
    container.querySelectorAll("[data-import-from]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const srcId = btn.dataset.importFrom;
        const dstId = btn.dataset.importTo;
        const src = this._propertiesCache.find(p => p.id === srcId);
        if (!src) return;
        const mg = typeof src.miniGameEnabled === "boolean" ? src.miniGameEnabled : globalMiniGame;
        try {
          await db.collection("properties").doc(dstId).update({ miniGameEnabled: mg });
          showToast("インポート完了", `${src.name} の設定 (ミニゲーム ${mg ? "ON" : "OFF"}) をコピー`, "success");
          // 再描画
          await this._renderPropertyFormSection();
        } catch (e) {
          showToast("インポート失敗", e.message, "error");
        }
      });
    });
  },

  // === カスタムURL生成エリア描画 ===
  _renderCustomUrlArea() {
    const area = document.getElementById("guestFormCustomArea");
    if (!area) return;
    const baseUrl = location.origin + "/form/";
    area.innerHTML = `
      <div class="row g-2">
        <div class="col-md-3"><label class="form-label mb-0">物件</label>
          <select class="form-select form-select-sm" id="customUrlProp">
            <option value="">(指定なし)</option>
            ${(this._propertiesCache || []).map(p => `<option value="${p.id}">${this.esc(p.name)}</option>`).join("")}
          </select>
        </div>
        <div class="col-md-3"><label class="form-label mb-0">チェックイン</label>
          <input type="date" class="form-control form-control-sm" id="customUrlCI">
        </div>
        <div class="col-md-3"><label class="form-label mb-0">チェックアウト</label>
          <input type="date" class="form-control form-control-sm" id="customUrlCO">
        </div>
        <div class="col-md-3"><label class="form-label mb-0">人数</label>
          <input type="number" class="form-control form-control-sm" id="customUrlGuests" min="1">
        </div>
      </div>
      <div class="input-group input-group-sm mt-2" style="max-width:780px;">
        <input type="text" class="form-control" id="customUrlResult" readonly placeholder="上の項目を埋めると自動生成">
        <button class="btn btn-outline-primary" type="button" data-copy-target="customUrlResult"><i class="bi bi-clipboard"></i></button>
      </div>
    `;
    const update = () => {
      const prop = document.getElementById("customUrlProp").value;
      const ci = document.getElementById("customUrlCI").value;
      const co = document.getElementById("customUrlCO").value;
      const g = document.getElementById("customUrlGuests").value;
      const params = new URLSearchParams();
      if (prop) params.set("propertyId", prop);
      if (ci) params.set("checkIn", ci);
      if (co) params.set("checkOut", co);
      if (g) params.set("guests", g);
      const qs = params.toString();
      document.getElementById("customUrlResult").value = qs ? `${baseUrl}?${qs}` : "";
    };
    ["customUrlProp", "customUrlCI", "customUrlCO", "customUrlGuests"].forEach(id => {
      document.getElementById(id)?.addEventListener("change", update);
      document.getElementById(id)?.addEventListener("input", update);
    });
    // カスタムURL のコピーボタンも bind
    area.querySelectorAll("[data-copy-target]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const target = document.getElementById(btn.dataset.copyTarget);
        if (!target || !target.value) return;
        try { await navigator.clipboard.writeText(target.value); showToast("コピー完了", "", "success"); }
        catch (_) { target.select(); document.execCommand("copy"); showToast("コピー完了", "", "success"); }
      });
    });
  },

  // === フォームURL生成ダイアログ (旧実装、現在は未使用・残置のみ) ===
  async showFormUrlDialog() {
    const baseUrl = location.origin + "/form/";
    // ミニゲーム設定を取得 (デフォルト ON)
    let miniGameEnabled = true;
    try {
      const doc = await db.collection("settings").doc("guestForm").get();
      if (doc.exists && doc.data().miniGameEnabled === false) miniGameEnabled = false;
    } catch (_) {}
    const html = `
      <div class="alert alert-success mb-3">
        <strong><i class="bi bi-check-circle"></i> 共通URL（推奨）</strong>
        <p class="small mb-2 mt-1">Airbnb / Booking.com の自動メッセージにはこの共通URLのみを貼り付けてください。宿泊客自身がチェックイン日を入力すれば、その日のフォームが自動で表示されます。</p>
        <div class="input-group">
          <input type="text" class="form-control" value="${baseUrl}" readonly id="formUrlBasic">
          <button class="btn btn-primary" onclick="navigator.clipboard.writeText(document.getElementById('formUrlBasic').value);this.innerHTML='<i class=\\'bi bi-check\\'></i>'">
            <i class="bi bi-clipboard"></i> コピー
          </button>
        </div>
      </div>
      <div class="card mb-3">
        <div class="card-body py-2">
          <div class="form-check form-switch mb-0">
            <input class="form-check-input" type="checkbox" id="miniGameToggle" ${miniGameEnabled ? "checked" : ""}>
            <label class="form-check-label" for="miniGameToggle">
              <strong>ミニゲーム (騒音確認ゲーム) を有効にする</strong>
            </label>
          </div>
          <div class="small text-muted mt-1">
            OFF の場合: 宿泊者名簿のトップ → 次へ → 直接入力ページへ進みます<br>
            ON の場合: 宿泊者名簿のトップ → 次へ → ミニゲーム → 入力ページの流れ (現行)
          </div>
          <span id="miniGameSaveStatus" class="small"></span>
        </div>
      </div>
      <details class="mb-2">
        <summary class="text-muted small">▸ 特定のCI日を指定したカスタムURL（上級）</summary>
      <label class="form-label fw-bold">カスタムURL生成</label>
      <div class="row g-2 mb-2">
        <div class="col-6">
          <label class="form-label small">チェックイン</label>
          <input type="date" class="form-control form-control-sm" id="urlCheckIn">
        </div>
        <div class="col-6">
          <label class="form-label small">チェックアウト</label>
          <input type="date" class="form-control form-control-sm" id="urlCheckOut">
        </div>
        <div class="col-6">
          <label class="form-label small">宿泊人数</label>
          <input type="number" class="form-control form-control-sm" id="urlGuests" min="1">
        </div>
        <div class="col-6">
          <label class="form-label small">言語</label>
          <select class="form-select form-select-sm" id="urlLang">
            <option value="">日本語（デフォルト）</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>
      <button class="btn btn-primary btn-sm w-100 mb-2" id="btnGenerateUrl">URL生成</button>
      <div class="input-group d-none" id="generatedUrlGroup">
        <input type="text" class="form-control form-control-sm" id="generatedUrl" readonly>
        <button class="btn btn-outline-primary btn-sm" id="btnCopyGenerated">
          <i class="bi bi-clipboard"></i>
        </button>
      </div>
      </details>
    `;

    // 既存の詳細モーダルを流用（bodyを差し替え）
    const body = document.getElementById("guestDetailBody");
    body.innerHTML = html;
    document.querySelector("#guestDetailModal .modal-title").innerHTML =
      '<i class="bi bi-link-45deg"></i> 宿泊者名簿フォームURL';

    // URL生成ボタン + ミニゲームトグル
    setTimeout(() => {
      const mgToggle = document.getElementById("miniGameToggle");
      if (mgToggle) {
        mgToggle.addEventListener("change", async () => {
          const status = document.getElementById("miniGameSaveStatus");
          status.innerHTML = `<i class="bi bi-arrow-repeat text-muted"></i> 保存中...`;
          try {
            await db.collection("settings").doc("guestForm").set({
              miniGameEnabled: mgToggle.checked,
              updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
            status.innerHTML = `<span class="text-success"><i class="bi bi-check-circle-fill"></i> 保存済み</span>`;
            setTimeout(() => { status.innerHTML = ""; }, 2000);
          } catch (e) {
            status.innerHTML = `<span class="text-danger">保存失敗: ${e.message}</span>`;
          }
        });
      }
      document.getElementById("btnGenerateUrl").addEventListener("click", () => {
        const params = new URLSearchParams();
        const ci = document.getElementById("urlCheckIn").value;
        const co = document.getElementById("urlCheckOut").value;
        const g = document.getElementById("urlGuests").value;
        const lang = document.getElementById("urlLang").value;
        if (ci) params.set("checkIn", ci);
        if (co) params.set("checkOut", co);
        if (g) params.set("guests", g);
        if (lang) params.set("lang", lang);
        const url = baseUrl + (params.toString() ? "?" + params.toString() : "");
        document.getElementById("generatedUrl").value = url;
        document.getElementById("generatedUrlGroup").classList.remove("d-none");
      });
      document.getElementById("btnCopyGenerated").addEventListener("click", () => {
        navigator.clipboard.writeText(document.getElementById("generatedUrl").value);
        document.getElementById("btnCopyGenerated").innerHTML = '<i class="bi bi-check"></i>';
        showToast("完了", "URLをコピーしました", "success");
      });
    }, 100);

    this.detailModal.show();
  },

  // === 登録/編集モーダル ===
  openModal(guest = null) {
    const isEdit = !!guest;
    document.getElementById("guestModalTitle").textContent = isEdit ? "宿泊者情報編集" : "宿泊者情報登録";
    document.getElementById("guestEditId").value = isEdit ? guest.id : "";

    document.getElementById("guestNameInput").value = guest?.guestName || "";
    document.getElementById("guestNationality").value = guest?.nationality || "日本";
    document.getElementById("guestAddress").value = guest?.address || "";
    document.getElementById("guestPhone").value = guest?.phone || "";
    document.getElementById("guestEmail").value = guest?.email || "";
    document.getElementById("guestPassport").value = guest?.passportNumber || "";
    document.getElementById("guestPurpose").value = guest?.purpose || "";
    document.getElementById("guestCheckIn").value = guest?.checkIn || "";
    document.getElementById("guestCheckOut").value = guest?.checkOut || "";
    document.getElementById("guestCountInput").value = guest?.guestCount || "";
    document.getElementById("guestCountInfants").value = guest?.guestCountInfants || "";
    document.getElementById("guestBookingSite").value = guest?.bookingSite || "";
    document.getElementById("guestBBQ").value = guest?.bbq || "";
    document.getElementById("guestParking").value = guest?.parking || "";
    document.getElementById("guestMemoInput").value = guest?.memo || "";

    // 同行者リスト
    const companionBody = document.getElementById("companionTableBody");
    companionBody.innerHTML = "";
    if (guest?.guests?.length) {
      guest.guests.forEach(c => this.addCompanionRow(c));
    }

    this.modal.show();
  },

  addCompanionRow(data = null) {
    const tbody = document.getElementById("companionTableBody");
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input type="text" class="form-control form-control-sm comp-name" value="${this.escapeHtml(data?.name || "")}"></td>
      <td><input type="text" class="form-control form-control-sm comp-age" value="${this.escapeHtml(data?.age || "")}" style="width:60px"></td>
      <td><input type="text" class="form-control form-control-sm comp-nationality" value="${this.escapeHtml(data?.nationality || "日本")}"></td>
      <td><input type="text" class="form-control form-control-sm comp-passport" value="${this.escapeHtml(data?.passportNumber || "")}"></td>
      <td><button class="btn btn-sm btn-outline-danger btn-remove-comp"><i class="bi bi-x"></i></button></td>
    `;
    row.querySelector(".btn-remove-comp").addEventListener("click", () => row.remove());
    tbody.appendChild(row);
  },

  async saveGuest() {
    const id = document.getElementById("guestEditId").value;
    const guestName = document.getElementById("guestNameInput").value.trim();
    if (!guestName) {
      showToast("入力エラー", "代表者氏名は必須です", "error");
      return;
    }

    // 同行者データ収集
    const guests = [];
    document.querySelectorAll("#companionTableBody tr").forEach(row => {
      const name = row.querySelector(".comp-name").value.trim();
      if (name) {
        guests.push({
          name,
          age: row.querySelector(".comp-age").value.trim(),
          nationality: row.querySelector(".comp-nationality").value.trim() || "日本",
          passportNumber: row.querySelector(".comp-passport").value.trim(),
        });
      }
    });

    const data = {
      guestName,
      nationality: document.getElementById("guestNationality").value.trim() || "日本",
      address: document.getElementById("guestAddress").value.trim(),
      phone: document.getElementById("guestPhone").value.trim(),
      email: document.getElementById("guestEmail").value.trim(),
      passportNumber: document.getElementById("guestPassport").value.trim(),
      purpose: document.getElementById("guestPurpose").value.trim(),
      checkIn: document.getElementById("guestCheckIn").value,
      checkOut: document.getElementById("guestCheckOut").value,
      guestCount: Number(document.getElementById("guestCountInput").value) || 0,
      guestCountInfants: Number(document.getElementById("guestCountInfants").value) || 0,
      bookingSite: document.getElementById("guestBookingSite").value.trim(),
      bbq: document.getElementById("guestBBQ").value.trim(),
      parking: document.getElementById("guestParking").value.trim(),
      memo: document.getElementById("guestMemoInput").value.trim(),
      guests,
    };

    try {
      if (id) {
        await API.guests.update(id, data);
        showToast("完了", "宿泊者情報を更新しました", "success");
      } else {
        await API.guests.create(data);
        showToast("完了", "宿泊者情報を登録しました", "success");
      }
      this.modal.hide();
      await this.loadGuests();
    } catch (e) {
      showToast("エラー", `保存失敗: ${e.message}`, "error");
    }
  },

  // === 詳細モーダル ===
  showDetail(id) {
    const g = this.guestList.find(x => x.id === id);
    if (!g) return;

    const body = document.getElementById("guestDetailBody");
    const companions = g.guests || [];

    // 駐車場割当の表示用テキスト生成
    const parkingAllocText = (g.parkingAllocation || []).map(a =>
      `${a.index}台目(${this.escapeHtml(a.vehicleType || "")}) → ${this.escapeHtml(a.spot || "")}`
    ).join("<br>") || "-";

    // パスポート写真リンク生成（代表者 + 同行者）
    const passportPhotos = [];
    if (g.passportPhotoUrl) passportPhotos.push({ name: g.guestName || "代表者", url: g.passportPhotoUrl });
    companions.forEach(c => { if (c.passportPhotoUrl) passportPhotos.push({ name: c.name || "同行者", url: c.passportPhotoUrl }); });

    body.innerHTML = `
      <div class="row g-3">
        <div class="col-md-6">
          <h6 class="border-bottom pb-1 mb-2">代表者情報</h6>
          <table class="table table-sm table-borderless">
            <tr><th style="width:120px">氏名</th><td><strong>${this.escapeHtml(g.guestName || "-")}</strong></td></tr>
            <tr><th>国籍</th><td>${this.escapeHtml(g.nationality || "日本")}</td></tr>
            ${g.allGuests?.[0]?.age ? `<tr><th>年齢</th><td>${this.escapeHtml(g.allGuests[0].age)}</td></tr>` : ""}
            <tr><th>住所</th><td>${this.escapeHtml(g.address || "-")}</td></tr>
            <tr><th>電話</th><td>${this.escapeHtml(g.phone || "-")}</td></tr>
            ${g.phone2 ? `<tr><th>電話2</th><td>${this.escapeHtml(g.phone2)}</td></tr>` : ""}
            <tr><th>メール</th><td>${this.escapeHtml(g.email || "-")}</td></tr>
            <tr><th>旅券番号</th><td>${this.escapeHtml(g.passportNumber || "-")}</td></tr>
            <tr><th>旅の目的</th><td>${this.escapeHtml(g.purpose || "-")}</td></tr>
          </table>
        </div>
        <div class="col-md-6">
          <h6 class="border-bottom pb-1 mb-2">宿泊情報</h6>
          <table class="table table-sm table-borderless">
            <tr><th style="width:120px">チェックイン</th><td>${formatDate(g.checkIn)}${g.checkInTime ? ` <strong>${this.escapeHtml(g.checkInTime)}</strong>` : ""}</td></tr>
            <tr><th>チェックアウト</th><td>${formatDate(g.checkOut)}${g.checkOutTime ? ` <strong>${this.escapeHtml(g.checkOutTime)}</strong>` : ""}${g._coMismatch ? `<br><span class="badge bg-warning text-dark"><i class="bi bi-exclamation-triangle"></i> 予約サイトとCO日が異なります（${this.escapeHtml(g._coOriginal)} vs ${this.escapeHtml(g._coIncoming)}）</span>` : ""}</td></tr>
            <tr><th>宿泊人数</th><td>${g.guestCount || "-"}名${g.guestCountInfants ? ` ＋ 乳幼児${g.guestCountInfants}名（3才以下）` : ""}</td></tr>
            <tr><th>予約元</th><td>${this.getSourceIcon(g.source)} ${this.escapeHtml(g.bookingSite || "")}</td></tr>
            <tr><th>BBQ</th><td>${this.escapeHtml(g.bbq || "-")}</td></tr>
            ${g.bedChoice ? `<tr><th>ベッド</th><td>${this.escapeHtml(g.bedChoice)}</td></tr>` : ""}
            <tr><th>メモ</th><td>${this.escapeHtml(g.memo || "-")}</td></tr>
          </table>
        </div>
      </div>

      <!-- 交通・駐車場 -->
      ${g.transport || g.carCount || g.paidParking || (g.vehicleTypes || []).length ? `
      <hr>
      <h6><i class="bi bi-car-front"></i> 交通・駐車場</h6>
      <table class="table table-sm table-borderless">
        <tr><th style="width:120px">交通手段</th><td>${this.escapeHtml(g.transport)}</td></tr>
        ${g.carCount ? `<tr><th>車台数</th><td>${g.carCount}台</td></tr>` : ""}
        ${(g.vehicleTypes || []).length ? `<tr><th>車種</th><td>${g.vehicleTypes.map(v => this.escapeHtml(v)).join(", ")}</td></tr>` : ""}
        ${g.parkingAllocation ? `<tr><th>駐車場割当</th><td>${parkingAllocText}</td></tr>` : ""}
        ${g.paidParking ? `<tr><th>有料駐車場</th><td>${this.escapeHtml(g.paidParking)}</td></tr>` : ""}
      </table>
      ` : ""}

      <!-- 緊急連絡先 -->
      ${g.emergencyName || g.emergencyPhone ? `
      <hr>
      <h6><i class="bi bi-telephone"></i> 緊急連絡先</h6>
      <table class="table table-sm table-borderless">
        <tr><th style="width:120px">氏名</th><td>${this.escapeHtml(g.emergencyName || "-")}</td></tr>
        <tr><th>電話番号</th><td>${this.escapeHtml(g.emergencyPhone || "-")}</td></tr>
      </table>
      ` : ""}

      <!-- 前泊地・後泊地 -->
      ${g.previousStay || g.nextStay ? `
      <hr>
      <h6><i class="bi bi-signpost-2"></i> 前後泊</h6>
      <table class="table table-sm table-borderless">
        ${g.previousStay ? `<tr><th style="width:120px">前泊地</th><td>${this.escapeHtml(g.previousStay)}</td></tr>` : ""}
        ${g.nextStay ? `<tr><th style="width:120px">後泊地</th><td>${this.escapeHtml(g.nextStay)}</td></tr>` : ""}
      </table>
      ` : ""}

      <!-- 同意状況 -->
      <hr>
      <h6><i class="bi bi-check-circle"></i> 同意状況</h6>
      <table class="table table-sm table-borderless">
        <tr><th style="width:120px">騒音ルール</th><td>${g.noiseAgree ? '<span class="badge bg-success">同意済</span>' : '<span class="badge bg-danger">未同意</span>'}</td></tr>
      </table>

      ${companions.length > 0 ? `
        <hr>
        <h6><i class="bi bi-people"></i> 同行者（${companions.length}名）</h6>
        <div class="table-responsive">
          <table class="table table-sm table-bordered">
            <thead class="table-light">
              <tr><th>氏名</th><th>年齢</th><th>住所</th><th>国籍</th><th>旅券番号</th></tr>
            </thead>
            <tbody>
              ${companions.map(c => `
                <tr>
                  <td>${this.escapeHtml(c.name || "-")}</td>
                  <td>${this.escapeHtml(c.age || "-")}</td>
                  <td>${this.escapeHtml(c.address || "-")}</td>
                  <td>${this.escapeHtml(c.nationality || "日本")}</td>
                  <td>${this.escapeHtml(c.passportNumber || "-")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : ""}

      <!-- パスポート写真 -->
      ${passportPhotos.length > 0 ? `
        <hr>
        <h6><i class="bi bi-image"></i> パスポート写真</h6>
        <div class="row g-2">
          ${passportPhotos.map(p => `
            <div class="col-auto">
              <a href="${this.escapeHtml(p.url)}" target="_blank" rel="noopener" class="d-block text-center">
                <img src="${this.escapeHtml(p.url)}" alt="${this.escapeHtml(p.name)}" style="max-width:200px;max-height:150px;border-radius:8px;border:1px solid #dee2e6;">
                <small class="d-block mt-1 text-muted">${this.escapeHtml(p.name)}</small>
              </a>
            </div>
          `).join("")}
        </div>
      ` : ""}
    `;

    this.detailModal.show();
  },

  async deleteGuest(id) {
    const guest = this.guestList.find(g => g.id === id);
    await showConfirm(
      "宿泊者情報削除",
      `${guest?.guestName || ""} の宿泊者情報を削除しますか？`,
      async () => {
        try {
          await API.guests.delete(id);
          showToast("完了", "宿泊者情報を削除しました", "success");
          await this.loadGuests();
        } catch (e) {
          showToast("エラー", `削除失敗: ${e.message}`, "error");
        }
      }
    );
  },

  escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  },

  // escapeHtml の別名 (フォーム管理ロジックで使用)
  esc(str) {
    return this.escapeHtml(str);
  },

  // 編集対象セレクタのオプションを物件一覧から再構築する（全物件共通は廃止）
  _refreshFormTargetSelector() {
    const sel = document.getElementById("formTargetSelector");
    if (!sel) return;
    const props = this._propertiesCache || [];

    // 現在の選択値を保持（初回は最初の物件を選択）
    const currentVal = this._currentFormTarget || (props[0]?.id || "");

    // オプションを再構築（物件のみ）
    sel.innerHTML = "";
    props.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = (p.propertyNumber ? `#${p.propertyNumber} ` : "") + (p.name || p.id);
      sel.appendChild(opt);
    });

    // 選択値を復元
    sel.value = currentVal;
    if (!sel.value && props.length > 0) sel.value = props[0].id;

    // _currentFormTarget を実際の選択値に同期
    if (sel.value && sel.value !== this._currentFormTarget) {
      this._currentFormTarget = sel.value;
    }
  },

  // 「他物件から流用」メニューのオプションを再構築する
  _refreshCopyFromOtherMenu() {
    const menu = document.getElementById("copyFromOtherMenu");
    if (!menu) return;
    const props = this._propertiesCache || [];
    const target = this._currentFormTarget;

    // customFormEnabled=true の他物件のみ列挙
    const sources = props.filter(p => p.id !== target && p.customFormEnabled === true);
    if (sources.length === 0) {
      menu.innerHTML = `<li><span class="dropdown-item disabled small text-muted">設定済みの他物件がありません</span></li>`;
    } else {
      menu.innerHTML = sources.map(p =>
        `<li><button class="dropdown-item small" type="button" data-copy-from="${p.id}">${this.esc((p.propertyNumber ? `#${p.propertyNumber} ` : "") + p.name)} の設定を流用</button></li>`
      ).join("");
    }
  },

  // ===== 宿泊者名簿設定モーダル =====

  // 設定モーダルを開き、各タブの初期化を行う
  openSettingsModal() {
    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("guestSettingsModal"));

    // 共通URLをセット
    const baseUrl = location.origin + "/form/";
    const commonInput = document.getElementById("guestFormCommonUrl");
    if (commonInput) commonInput.value = baseUrl;

    // コピー/新タブ ボタンのハンドラをモーダル内に限定してバインド
    const modalEl = document.getElementById("guestSettingsModal");
    modalEl.querySelectorAll("[data-copy-target]").forEach(btn => {
      // 重複バインドを防ぐためクローンで置換
      const clone = btn.cloneNode(true);
      btn.replaceWith(clone);
      clone.addEventListener("click", async () => {
        const target = document.getElementById(clone.dataset.copyTarget);
        if (!target) return;
        const url = target.value;
        try {
          await navigator.clipboard.writeText(url);
          showToast("コピー完了", url.slice(0, 60) + (url.length > 60 ? "..." : ""), "success");
        } catch (_) {
          target.select();
          document.execCommand("copy");
          showToast("コピー完了", "", "success");
        }
      });
    });
    modalEl.querySelectorAll("[data-open-target]").forEach(btn => {
      const clone = btn.cloneNode(true);
      btn.replaceWith(clone);
      clone.addEventListener("click", () => {
        const target = document.getElementById(clone.dataset.openTarget);
        if (target) window.open(target.value, "_blank", "noopener");
      });
    });

    // 物件別URL + ミニゲーム設定を描画 (タブ1)
    this._renderPropertyFormSection();

    // カスタムURL生成 (details 内)
    this._renderCustomUrlArea();

    // フォーム項目管理の初期化 (モーダルを開くたびに現在の物件設定を再ロード)
    if (!this._formBtnsBound) {
      // ボタンバインド前の初回のみセレクタ同期が先に走るよう遅延
      setTimeout(() => this.loadFormConfig(), 50);
    } else {
      this.loadFormConfig();
    }

    // フォーム管理ボタンのバインド (1回のみ)
    if (!this._formBtnsBound) {
      // 物件セレクタ変更時
      document.getElementById("formTargetSelector")?.addEventListener("change", async (e) => {
        this._currentFormTarget = e.target.value;
        this.expandedCards.clear();
        await this.loadFormConfig();
      });

      // 「デフォルトを流用して作成」ボタン
      document.getElementById("btnUseDefault")?.addEventListener("click", async () => {
        const pid = this._currentFormTarget;
        if (!pid) return;
        const baseFields = JSON.parse(JSON.stringify(this.DEFAULT_FORM_FIELDS));
        try {
          await db.collection("properties").doc(pid).update({
            customFormEnabled: true,
            customFormFields: baseFields,
            customFormSections: this.DEFAULT_SECTIONS,
            showNoiseAgreement: true,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
          // _propertiesCache を更新してから再ロード
          const idx = (this._propertiesCache || []).findIndex(p => p.id === pid);
          if (idx >= 0) this._propertiesCache[idx].customFormEnabled = true;
          this.expandedCards.clear();
          await this.loadFormConfig();
          showToast("完了", "デフォルト設定を流用して作成しました", "success");
        } catch (e) {
          showToast("エラー", `作成失敗: ${e.message}`, "error");
        }
      });

      // 「他物件から流用」メニュー: イベント委譲
      document.getElementById("copyFromOtherMenu")?.addEventListener("click", async (e) => {
        const btn = e.target.closest("[data-copy-from]");
        if (!btn) return;
        const srcId = btn.dataset.copyFrom;
        const dstId = this._currentFormTarget;
        if (!dstId) return;

        try {
          const srcDoc = await db.collection("properties").doc(srcId).get();
          if (!srcDoc.exists || !srcDoc.data().customFormEnabled) {
            showToast("エラー", "流用元に設定がありません", "error");
            return;
          }
          const sd = srcDoc.data();
          await db.collection("properties").doc(dstId).update({
            customFormEnabled: true,
            customFormFields: sd.customFormFields || [],
            customFormSections: sd.customFormSections || this.DEFAULT_SECTIONS,
            showNoiseAgreement: sd.showNoiseAgreement !== false,
            miniGameEnabled: typeof sd.miniGameEnabled === "boolean" ? sd.miniGameEnabled : true,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
          const idx = (this._propertiesCache || []).findIndex(p => p.id === dstId);
          if (idx >= 0) this._propertiesCache[idx].customFormEnabled = true;
          this.expandedCards.clear();
          await this.loadFormConfig();
          const srcName = (this._propertiesCache || []).find(p => p.id === srcId)?.name || srcId;
          showToast("完了", `${srcName} の設定を流用しました`, "success");
        } catch (e) {
          showToast("エラー", `流用失敗: ${e.message}`, "error");
        }
      });

      // 騒音ルール表示ON/OFF トグル → 即保存
      document.getElementById("formNoiseToggle")?.addEventListener("change", async () => {
        const pid = this._currentFormTarget;
        if (!pid) return;
        const el = document.getElementById("formNoiseToggle");
        const statusEl = document.getElementById("formNoiseSaveStatus");
        if (!el) return;
        statusEl.innerHTML = `<span class="text-muted"><span class="spinner-border spinner-border-sm"></span> 保存中...</span>`;
        try {
          await db.collection("properties").doc(pid).update({
            showNoiseAgreement: el.checked,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
          this._showNoiseAgreementCurrent = el.checked;
          statusEl.innerHTML = `<span class="text-success"><i class="bi bi-check-circle-fill"></i> 保存済み (${el.checked ? "表示" : "非表示"})</span>`;
          setTimeout(() => { statusEl.innerHTML = ""; }, 2000);
        } catch (e) {
          statusEl.innerHTML = `<span class="text-danger">保存失敗: ${e.message}</span>`;
        }
      });

      // ミニゲーム トグル → 即保存
      document.getElementById("formMiniGameToggle")?.addEventListener("change", async () => {
        const pid = this._currentFormTarget;
        if (!pid) return;
        const mgEl = document.getElementById("formMiniGameToggle");
        const statusEl = document.getElementById("formMiniGameSaveStatus");
        statusEl.innerHTML = `<span class="text-muted"><span class="spinner-border spinner-border-sm"></span> 保存中...</span>`;
        try {
          await db.collection("properties").doc(pid).update({
            miniGameEnabled: mgEl.checked,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
          this._miniGameCurrent = mgEl.checked;
          statusEl.innerHTML = `<span class="text-success"><i class="bi bi-check-circle-fill"></i> ${mgEl.checked ? "ON" : "OFF"} に変更しました</span>`;
          setTimeout(() => { statusEl.innerHTML = ""; }, 2000);
          // タブ1の物件別URLリストも更新
          await this._renderPropertyFormSection();
        } catch (e) {
          statusEl.innerHTML = `<span class="text-danger">保存失敗: ${e.message}</span>`;
          mgEl.checked = !mgEl.checked;
        }
      });

      // フォーム項目ボタン群
      document.getElementById("btnLoadFormDefaults")?.addEventListener("click", () => this.loadFormDefaults());
      document.getElementById("btnAddFormField")?.addEventListener("click", () => this.addFormFieldRow());
      document.getElementById("btnSaveFormConfig")?.addEventListener("click", () => this.saveFormConfig());
      document.getElementById("btnPreviewForm")?.addEventListener("click", () => this.showFormPreview());
      document.getElementById("btnTranslateAll")?.addEventListener("click", () => this.translateAllWithGemini());

      // 「この物件の独自設定を削除」ボタン
      document.getElementById("btnClearCustomForm")?.addEventListener("click", async () => {
        const pid = this._currentFormTarget;
        if (!pid) return;
        const prop = (this._propertiesCache || []).find(p => p.id === pid);
        await showConfirm(
          "独自設定を削除",
          `「${prop?.name || "この物件"}」の独自フォーム設定をすべて削除します。よろしいですか？`,
          async () => {
            try {
              await db.collection("properties").doc(pid).update({
                customFormEnabled: false,
                customFormFields: firebase.firestore.FieldValue.delete(),
                customFormSections: firebase.firestore.FieldValue.delete(),
                showNoiseAgreement: firebase.firestore.FieldValue.delete(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
              });
              const idx = (this._propertiesCache || []).findIndex(p => p.id === pid);
              if (idx >= 0) this._propertiesCache[idx].customFormEnabled = false;
              this.expandedCards.clear();
              await this.loadFormConfig();
              showToast("完了", "独自設定を削除しました", "success");
            } catch (e) {
              showToast("エラー", `削除失敗: ${e.message}`, "error");
            }
          }
        );
      });

      this._formBtnsBound = true;
    }

    // 物件セレクタのオプションを更新（物件一覧は _propertiesCache に入っている可能性あり）
    this._refreshFormTargetSelector();

    modal.show();
  },

  // ===== 宿泊者名簿フォーム管理（Googleフォーム風カードエディタ） =====

  // デフォルトフォーム定義（guest-form.html の実画面と同期済み、2026-04-19更新）
  // 代表者情報は「同行者リスト先頭 (guest-block)」として入力: g-name/g-nationality/g-address/g-age/g-passport/g-passport-photo
  DEFAULT_FORM_FIELDS: [
    // === セクション1: 宿泊情報 ===
    { id: "checkIn",           label: "チェックイン日",         labelEn: "Check-in Date",        type: "date",   required: true,  section: "stay",      mapping: "checkIn" },
    { id: "checkInTime",       label: "チェックイン時刻",        labelEn: "Check-in Time",        type: "select", required: true,  section: "stay",      mapping: "checkInTime",  options: ["15:00","15:30","16:00","16:30","17:00","17:30","18:00","18:30","19:00","19:30","20:00","20:00以降"], optionsEn: ["15:00","15:30","16:00","16:30","17:00","17:30","18:00","18:30","19:00","19:30","20:00","After 20:00"] },
    { id: "checkOut",          label: "チェックアウト日",        labelEn: "Check-out Date",       type: "date",   required: true,  section: "stay",      mapping: "checkOut" },
    { id: "checkOutTime",      label: "チェックアウト時刻",      labelEn: "Check-out Time",       type: "select", required: true,  section: "stay",      mapping: "checkOutTime", options: ["7:00","7:30","8:00","8:30","9:00","9:30","10:00"], optionsEn: ["7:00","7:30","8:00","8:30","9:00","9:30","10:00"] },
    { id: "guestCount",        label: "宿泊人数（大人）",        labelEn: "Adults",               type: "number", required: true,  section: "stay",      mapping: "guestCount",   defaultValue: "1" },
    { id: "guestCountInfants", label: "3才以下の乳幼児",         labelEn: "Infants (under 3)",    type: "number", required: false, section: "stay",      mapping: "guestCountInfants", defaultValue: "0" },
    { id: "bookingSite",       label: "予約サイト",              labelEn: "Booking Site",         type: "select", required: true,  section: "stay",      mapping: "bookingSite",  options: ["Airbnb","Booking.com","楽天トラベル","じゃらん","Agoda","VRBO","Trip.com","自社公式ウェブサイト","直接予約","その他"], optionsEn: ["Airbnb","Booking.com","Rakuten Travel","Jalan","Agoda","VRBO","Trip.com","Official Website","Direct booking","Other"] },
    // === セクション2: 宿泊者情報（同行者リスト、先頭が代表者）===
    // 実画面では guest-block (g-name, g-nationality, g-address, g-age, g-passport, g-passport-photo) で入力
    // 管理画面エディタ上は companions セクションに含まれる
    // === セクション3: 施設利用情報 ===
    { id: "transport",         label: "交通手段",                labelEn: "Transportation",       type: "select", required: false, section: "facility",  mapping: "transport",    options: ["車","公共交通機関","タクシー","徒歩","その他"], optionsEn: ["Car","Public transport","Taxi","Walking","Other"] },
    { id: "taxiAgree",         label: "タクシー注意事項への同意", labelEn: "Taxi warning agreement", type: "checkbox-single", required: false, section: "facility", mapping: "taxiAgree" },
    { id: "carCount",          label: "車の台数",                labelEn: "Number of cars",       type: "select", required: false, section: "facility",  mapping: "carCount",     options: ["1台","2台","3台","4台","5台","6台","7台以上"], optionsEn: ["1 car","2 cars","3 cars","4 cars","5 cars","6 cars","7+ cars"] },
    { id: "neighborAgree",     label: "近隣駐車場注意事項への同意", labelEn: "Parking notes agreement", type: "checkbox-single", required: false, section: "facility", mapping: "neighborAgree" },
    { id: "paidParking",       label: "有料駐車場の利用",        labelEn: "Paid parking",         type: "select", required: false, section: "facility",  mapping: "paidParking",  options: ["利用しない","1台利用","2台利用"], optionsEn: ["No","1 car","2 cars"] },
    { id: "bbq",               label: "BBQ利用",                 labelEn: "BBQ use",              type: "select", required: true,  section: "facility",  mapping: "bbq",          options: ["利用しない","利用する"], optionsEn: ["No","Yes"] },
    { id: "bbqRule1",          label: "BBQルール同意①",          labelEn: "BBQ rule 1",           type: "checkbox-single", required: false, section: "facility", mapping: "bbqRule1" },
    { id: "bbqRule2",          label: "BBQルール同意②",          labelEn: "BBQ rule 2",           type: "checkbox-single", required: false, section: "facility", mapping: "bbqRule2" },
    { id: "bbqRule3",          label: "BBQルール同意③",          labelEn: "BBQ rule 3",           type: "checkbox-single", required: false, section: "facility", mapping: "bbqRule3" },
    { id: "bbqRule4",          label: "BBQルール同意④",          labelEn: "BBQ rule 4",           type: "checkbox-single", required: false, section: "facility", mapping: "bbqRule4" },
    { id: "bbqRule5",          label: "BBQルール同意⑤",          labelEn: "BBQ rule 5",           type: "checkbox-single", required: false, section: "facility", mapping: "bbqRule5" },
    { id: "bedChoice",         label: "ベッドの希望（2名の場合）", labelEn: "Bed preference (2 guests)", type: "select", required: false, section: "facility", mapping: "bedChoice", options: ["2人で1台のベッドを利用（2階リビング）","1人1台ずつベッドを利用（1階和室）"], optionsEn: ["1 double bed (2F living)","2 single beds (1F tatami)"] },
    // === セクション4: アンケート ===
    { id: "purpose",           label: "旅の目的",                labelEn: "Purpose of visit",     type: "select", required: false, section: "survey",    mapping: "purpose",      options: ["出張","宮島","原爆ドーム","広島市内観光","呉観光","大和ミュージアム","中国地方観光","中四国観光","その他"], optionsEn: ["Business","Miyajima","A-bomb Dome","Hiroshima sightseeing","Kure sightseeing","Yamato Museum","Chugoku region","Shikoku region","Other"] },
    { id: "previousStay",      label: "前泊地",                  labelEn: "Previous stay",        type: "text",   required: false, section: "survey",    mapping: "previousStay" },
    { id: "nextStay",          label: "後泊地",                  labelEn: "Next stay",            type: "text",   required: false, section: "survey",    mapping: "nextStay" },
    // === セクション5: 緊急連絡先 ===
    { id: "emergencyName",     label: "緊急連絡先 氏名",          labelEn: "Emergency contact name",  type: "text",   required: true,  section: "emergency", mapping: "emergencyName" },
    { id: "emergencyPhone",    label: "緊急連絡先 電話番号",      labelEn: "Emergency contact phone", type: "tel",    required: true,  section: "emergency", mapping: "emergencyPhone" },
    // === 隠しフィールド（システム用）===
    { id: "noiseAgree",        label: "騒音ルール同意（隠し）",   labelEn: "Noise rule agreement (hidden)", type: "checkbox-single", required: true, section: "agreement", mapping: "noiseAgree" },
    { id: "houseRuleAgree",    label: "ハウスルール同意（隠し）", labelEn: "House rule agreement (hidden)", type: "checkbox-single", required: true, section: "agreement", mapping: "houseRuleAgree" },
  ],

  DEFAULT_SECTIONS: [
    { id: "stay",        label: "宿泊情報",              labelEn: "Stay Details",                              order: 1 },
    { id: "facility",    label: "施設利用情報",           labelEn: "Facility Usage",                            order: 2 },
    { id: "survey",      label: "アンケート",             labelEn: "Survey",                                    order: 3 },
    { id: "emergency",   label: "緊急連絡先",             labelEn: "Emergency Contact",                         order: 4 },
    { id: "agreement",   label: "同意事項（システム用）", labelEn: "Agreement (system)",                        order: 5 },
    { id: "companions",  label: "宿泊者情報（旅館業法）", labelEn: "Guests (Required by Japanese Law)",         order: 6, isCompanion: true },
  ],

  TYPE_LABELS: {
    text: "テキスト", textarea: "テキスト(複数行)", date: "日付", number: "数値",
    tel: "電話番号", email: "メール", select: "プルダウン", radio: "ラジオボタン",
    checkbox: "チェックボックス(複数)", "checkbox-single": "チェックボックス(単一)",
    image: "画像",
  },

  formFields: [],
  expandedCards: new Set(),
  dragSourceIdx: null,
  // 現在編集中の対象: propertyId（__common__ は廃止）
  _currentFormTarget: null,

  async loadFormConfig() {
    const pid = this._currentFormTarget;
    if (!pid) return;

    // 初期化UIと編集UIを一旦隠す
    const initArea = document.getElementById("formInitArea");
    const editArea = document.getElementById("formEditArea");
    if (initArea) initArea.classList.add("d-none");
    if (editArea) editArea.classList.add("d-none");

    try {
      const pDoc = await db.collection("properties").doc(pid).get();
      if (!pDoc.exists) return;
      const pd = pDoc.data();

      if (pd.customFormEnabled === true && pd.customFormFields?.length > 0) {
        // 独自設定あり → 編集UIを表示
        this.formFields = pd.customFormFields;
        this.formSections = pd.customFormSections || this.DEFAULT_SECTIONS;
        this._showNoiseAgreementCurrent = pd.showNoiseAgreement !== false;
        this._miniGameCurrent = pd.miniGameEnabled !== false;
        this._showEditUI();
      } else {
        // 独自設定なし → 初期化UIを表示
        this._showInitUI();
      }
    } catch (e) {
      console.warn("物件フォーム設定読み込みエラー:", e);
      this._showInitUI();
    }
  },

  // 独自設定なし時の初期化UI表示
  _showInitUI() {
    const initArea = document.getElementById("formInitArea");
    const editArea = document.getElementById("formEditArea");
    if (initArea) initArea.classList.remove("d-none");
    if (editArea) editArea.classList.add("d-none");
    // 他物件流用メニューを更新（customFormEnabledの物件のみ）
    this._refreshCopyFromOtherMenu();
  },

  // 独自設定あり時の編集UI表示
  _showEditUI() {
    const initArea = document.getElementById("formInitArea");
    const editArea = document.getElementById("formEditArea");
    if (initArea) initArea.classList.add("d-none");
    if (editArea) editArea.classList.remove("d-none");

    // 騒音ルール表示ON/OFF トグルをセット
    const noiseEl = document.getElementById("formNoiseToggle");
    if (noiseEl) noiseEl.checked = this._showNoiseAgreementCurrent !== false;

    // ミニゲームトグルをセット
    const mgEl = document.getElementById("formMiniGameToggle");
    if (mgEl) mgEl.checked = this._miniGameCurrent !== false;

    // フォーム項目を描画
    this.renderFormFields();
  },

  loadFormDefaults() {
    showConfirm("デフォルト読み込み", "デフォルト項目を読み込みます。現在の設定は上書きされます。よろしいですか？", () => {
      this.formFields = JSON.parse(JSON.stringify(this.DEFAULT_FORM_FIELDS));
      this.expandedCards.clear();
      this.renderFormFields();
      showToast("完了", "デフォルト項目を読み込みました。「保存」を押して反映してください。", "success");
    });
  },

  getSectionLabel(secId) {
    const s = this.DEFAULT_SECTIONS.find(s => s.id === secId);
    return s ? s.label : secId;
  },

  hasOptions(type) {
    return ["select", "radio", "checkbox"].includes(type);
  },

  renderFormFields() {
    const container = document.getElementById("formFieldList");
    if (!container) return;
    if (!this.formFields.length) {
      container.innerHTML = '<div class="text-center text-muted py-3">項目がありません。「デフォルト読み込み」または「項目追加」で開始してください。</div>';
      return;
    }

    let html = '';
    let lastSection = '';

    this.formFields.forEach((f, i) => {
      // セクション区切り
      if (f.section !== lastSection) {
        lastSection = f.section;
        html += `<div class="ff-section-sep"><i class="bi bi-folder2-open"></i> ${this.esc(this.getSectionLabel(f.section))}</div>`;
      }

      const isExpanded = this.expandedCards.has(i);
      const typeBadge = this.TYPE_LABELS[f.type] || f.type;
      const shortLabel = (f.label || "").split("\n")[0].substring(0, 40);

      const isHidden = f.hidden === true;
      html += `
        <div class="ff-card${isExpanded ? " expanded" : ""}${isHidden ? " ff-hidden" : ""}" data-idx="${i}" draggable="true" style="${isHidden ? "opacity:0.55;" : ""}">
          <div class="ff-card-header" data-action="toggle" data-idx="${i}">
            <span class="ff-drag-handle" title="ドラッグで並び替え"><i class="bi bi-grip-vertical"></i></span>
            <span class="ff-card-num">${i + 1}</span>
            <div class="ff-card-title">
              <div class="ff-card-label">${this.esc(shortLabel) || '<span class="text-muted">(未入力)</span>'}</div>
              ${f.labelEn ? `<div class="ff-card-label-en">${this.esc(f.labelEn)}</div>` : ""}
            </div>
            <span class="badge bg-secondary ff-badge-type">${typeBadge}</span>
            ${f.required ? '<span class="badge bg-danger ff-badge-req">必須</span>' : ""}
            ${isHidden ? '<span class="badge bg-warning text-dark ff-badge-hidden"><i class="bi bi-eye-slash"></i> 非表示</span>' : ""}
            <span class="badge bg-light text-dark ff-badge-sec">${this.esc(this.getSectionLabel(f.section))}</span>
            <button type="button" class="btn btn-sm ${isHidden ? 'btn-outline-success' : 'btn-outline-secondary'} ff-visibility-btn" data-action="toggleHidden" data-idx="${i}" title="${isHidden ? '表示する' : '非表示にする'}" style="padding:2px 6px;" onclick="event.stopPropagation();">
              <i class="bi bi-${isHidden ? 'eye' : 'eye-slash'}"></i>
            </button>
            <i class="bi bi-chevron-${isExpanded ? "up" : "down"} ff-chevron"></i>
          </div>
          ${isExpanded ? this.renderFieldCardBody(f, i) : ""}
        </div>`;
    });

    container.innerHTML = html;
    this.bindCardEvents(container);
  },

  renderFieldCardBody(f, idx) {
    const secOpts = this.DEFAULT_SECTIONS.filter(s => !s.isCompanion).map(s =>
      `<option value="${s.id}" ${f.section === s.id ? "selected" : ""}>${this.esc(s.label)}</option>`
    ).join("");

    const typeOpts = Object.entries(this.TYPE_LABELS).map(([v, l]) =>
      `<option value="${v}" ${f.type === v ? "selected" : ""}>${l}</option>`
    ).join("");

    let optionsHtml = "";
    if (this.hasOptions(f.type)) {
      const opts = f.options || [];
      const optsEn = f.optionsEn || [];
      optionsHtml = `
        <div class="ff-options-section mt-3">
          <label class="form-label fw-semibold small"><i class="bi bi-list-ul"></i> 選択肢</label>
          <div class="ff-options-list" data-idx="${idx}">
            ${opts.map((o, oi) => `
              <div class="ff-opt-row" data-oi="${oi}">
                <span class="ff-opt-num">${oi + 1}.</span>
                <input type="text" class="form-control form-control-sm ff-opt-jp" value="${this.esc(o)}" placeholder="日本語">
                <input type="text" class="form-control form-control-sm ff-opt-en" value="${this.esc(optsEn[oi] || "")}" placeholder="English">
                <button class="btn btn-sm btn-outline-secondary ff-opt-up" data-idx="${idx}" data-oi="${oi}" title="上へ"><i class="bi bi-arrow-up"></i></button>
                <button class="btn btn-sm btn-outline-secondary ff-opt-down" data-idx="${idx}" data-oi="${oi}" title="下へ"><i class="bi bi-arrow-down"></i></button>
                <button class="btn btn-sm btn-outline-danger ff-opt-del" data-idx="${idx}" data-oi="${oi}" title="削除"><i class="bi bi-x"></i></button>
              </div>
            `).join("")}
          </div>
          <button class="btn btn-sm btn-outline-primary mt-1 ff-opt-add" data-idx="${idx}">
            <i class="bi bi-plus"></i> 選択肢を追加
          </button>
        </div>`;
    }

    // 画像タイプ用フィールド
    let imageHtml = "";
    if (f.type === "image") {
      imageHtml = `
        <div class="row g-2 mb-2">
          <div class="col-md-6">
            <label class="form-label small">画像URL</label>
            <input type="url" class="form-control form-control-sm ff-edit" data-idx="${idx}" data-key="imageUrl" value="${this.esc(f.imageUrl || "")}" placeholder="https://...">
          </div>
          <div class="col-md-3">
            <label class="form-label small">幅（%）</label>
            <input type="number" class="form-control form-control-sm ff-edit" data-idx="${idx}" data-key="imageWidth" value="${f.imageWidth || 100}" min="10" max="100">
          </div>
          <div class="col-md-3">
            <label class="form-label small">アップロード</label>
            <div class="position-relative">
              <input type="file" class="form-control form-control-sm ff-image-upload" data-idx="${idx}" accept="image/*" style="font-size:0.75rem;">
            </div>
          </div>
        </div>
        <div class="ff-upload-progress d-none mb-2" data-idx="${idx}">
          <div class="progress" style="height:6px;">
            <div class="progress-bar progress-bar-striped progress-bar-animated" style="width:0%"></div>
          </div>
          <small class="text-muted">アップロード中...</small>
        </div>
        ${f.imageUrl ? `<div class="mb-2"><img src="${this.esc(f.imageUrl)}" style="max-width:300px;max-height:200px;border-radius:4px;border:1px solid #ddd;"></div>` : ""}`;
    }

    return `
      <div class="ff-card-body">
        <div class="row g-2 mb-2">
          <div class="col-md-5">
            <label class="form-label small">ラベル（日本語）</label>
            <textarea class="form-control form-control-sm ff-edit" data-idx="${idx}" data-key="label" rows="2">${this.esc(f.label || "")}</textarea>
          </div>
          <div class="col-md-5">
            <label class="form-label small">ラベル（英語）</label>
            <textarea class="form-control form-control-sm ff-edit" data-idx="${idx}" data-key="labelEn" rows="2">${this.esc(f.labelEn || "")}</textarea>
          </div>
          <div class="col-md-2 d-flex align-items-end">
            <button class="btn btn-sm btn-outline-warning w-100 ff-translate-one" data-idx="${idx}" title="この項目をGeminiで翻訳"><i class="bi bi-translate"></i></button>
          </div>
        </div>
        <div class="row g-2 mb-2">
          <div class="col-md-3">
            <label class="form-label small">種類</label>
            <select class="form-select form-select-sm ff-edit" data-idx="${idx}" data-key="type">${typeOpts}</select>
          </div>
          <div class="col-md-3">
            <label class="form-label small">セクション</label>
            <select class="form-select form-select-sm ff-edit" data-idx="${idx}" data-key="section">${secOpts}</select>
          </div>
          <div class="col-md-3">
            <label class="form-label small">マッピングID</label>
            <input type="text" class="form-control form-control-sm ff-edit" data-idx="${idx}" data-key="mapping" value="${this.esc(f.mapping || "")}">
          </div>
          <div class="col-md-3 d-flex align-items-end">
            <div class="form-check">
              <input type="checkbox" class="form-check-input ff-edit" data-idx="${idx}" data-key="required" id="ff_req_${idx}" ${f.required ? "checked" : ""}>
              <label class="form-check-label small" for="ff_req_${idx}">必須</label>
            </div>
          </div>
        </div>
        ${imageHtml}
        ${f.type !== "image" ? `<div class="row g-2 mb-2">
          <div class="col-md-6">
            <label class="form-label small">デフォルト値</label>
            <input type="text" class="form-control form-control-sm ff-edit" data-idx="${idx}" data-key="defaultValue" value="${this.esc(f.defaultValue || "")}">
          </div>
          <div class="col-md-6">
            <label class="form-label small">プレースホルダ</label>
            <input type="text" class="form-control form-control-sm ff-edit" data-idx="${idx}" data-key="placeholder" value="${this.esc(f.placeholder || "")}">
          </div>
        </div>` : ""}
        ${optionsHtml}
        <div class="d-flex gap-2 mt-3 pt-2 border-top">
          <button class="btn btn-sm btn-outline-primary ff-action-dup" data-idx="${idx}"><i class="bi bi-copy"></i> 複製</button>
          <button class="btn btn-sm btn-outline-danger ff-action-del" data-idx="${idx}"><i class="bi bi-trash"></i> 削除</button>
        </div>
      </div>`;
  },

  bindCardEvents(container) {
    // カードヘッダー展開/折り畳みトグル
    container.querySelectorAll(".ff-card-header").forEach(hdr => {
      hdr.addEventListener("click", (e) => {
        if (e.target.closest(".ff-drag-handle")) return;
        if (e.target.closest(".ff-visibility-btn")) return; // 非表示トグルボタンはカード展開させない
        const idx = Number(hdr.dataset.idx);
        if (this.expandedCards.has(idx)) this.expandedCards.delete(idx);
        else this.expandedCards.add(idx);
        this.renderFormFields();
      });
    });

    // 非表示/表示 トグルボタン
    container.querySelectorAll('[data-action="toggleHidden"]').forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.idx);
        if (!this.formFields[idx]) return;
        // hidden プロパティを反転
        this.formFields[idx].hidden = !this.formFields[idx].hidden;
        this.renderFormFields();
        if (typeof showToast === "function") {
          showToast("", `${this.formFields[idx].label || "項目"}を${this.formFields[idx].hidden ? "非表示" : "表示"}に変更 (保存で確定)`, "info");
        }
      });
    });

    // フィールド値の編集（リアルタイム更新）
    container.querySelectorAll(".ff-edit").forEach(el => {
      const handler = () => {
        const idx = Number(el.dataset.idx);
        const key = el.dataset.key;
        if (key === "required") {
          this.formFields[idx][key] = el.checked;
        } else {
          this.formFields[idx][key] = el.value;
        }
        // type変更時は選択肢セクションの表示/非表示を切り替え
        if (key === "type") this.renderFormFields();
        // セクション変更時は再描画（区切り線の更新）
        if (key === "section") this.renderFormFields();
      };
      el.addEventListener("change", handler);
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        el.addEventListener("input", handler);
      }
    });

    // 選択肢の編集
    container.querySelectorAll(".ff-opt-jp, .ff-opt-en").forEach(el => {
      el.addEventListener("input", () => {
        const row = el.closest(".ff-opt-row");
        const list = el.closest(".ff-options-list");
        const idx = Number(list.dataset.idx);
        const oi = Number(row.dataset.oi);
        if (el.classList.contains("ff-opt-jp")) {
          if (!this.formFields[idx].options) this.formFields[idx].options = [];
          this.formFields[idx].options[oi] = el.value;
        } else {
          if (!this.formFields[idx].optionsEn) this.formFields[idx].optionsEn = [];
          this.formFields[idx].optionsEn[oi] = el.value;
        }
      });
    });

    // 選択肢追加
    container.querySelectorAll(".ff-opt-add").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        if (!this.formFields[idx].options) this.formFields[idx].options = [];
        if (!this.formFields[idx].optionsEn) this.formFields[idx].optionsEn = [];
        this.formFields[idx].options.push("");
        this.formFields[idx].optionsEn.push("");
        this.renderFormFields();
      });
    });

    // 選択肢削除
    container.querySelectorAll(".ff-opt-del").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        const oi = Number(btn.dataset.oi);
        this.formFields[idx].options.splice(oi, 1);
        (this.formFields[idx].optionsEn || []).splice(oi, 1);
        this.renderFormFields();
      });
    });

    // 選択肢上下移動
    container.querySelectorAll(".ff-opt-up, .ff-opt-down").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        const oi = Number(btn.dataset.oi);
        const dir = btn.classList.contains("ff-opt-up") ? -1 : 1;
        const opts = this.formFields[idx].options || [];
        const optsEn = this.formFields[idx].optionsEn || [];
        const newOi = oi + dir;
        if (newOi < 0 || newOi >= opts.length) return;
        [opts[oi], opts[newOi]] = [opts[newOi], opts[oi]];
        if (optsEn.length > Math.max(oi, newOi)) {
          [optsEn[oi], optsEn[newOi]] = [optsEn[newOi], optsEn[oi]];
        }
        this.renderFormFields();
      });
    });

    // 画像アップロード
    container.querySelectorAll(".ff-image-upload").forEach(input => {
      input.addEventListener("change", (e) => this.uploadFormImage(Number(input.dataset.idx), e.target.files[0]));
    });

    // 個別翻訳ボタン
    container.querySelectorAll(".ff-translate-one").forEach(btn => {
      btn.addEventListener("click", () => this.translateOneWithGemini(Number(btn.dataset.idx)));
    });

    // フィールド複製
    container.querySelectorAll(".ff-action-dup").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        const clone = JSON.parse(JSON.stringify(this.formFields[idx]));
        clone.id = "field_" + Date.now();
        clone.label = (clone.label || "") + "（コピー）";
        this.formFields.splice(idx + 1, 0, clone);
        this.expandedCards.clear();
        this.expandedCards.add(idx + 1);
        this.renderFormFields();
      });
    });

    // フィールド削除
    container.querySelectorAll(".ff-action-del").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        showConfirm("項目削除", `「${this.formFields[idx].label || ""}」を削除しますか？`, () => {
          this.formFields.splice(idx, 1);
          this.expandedCards.clear();
          this.renderFormFields();
        });
      });
    });

    // ドラッグ&ドロップ
    this.initDragDrop(container);
  },

  initDragDrop(container) {
    const cards = container.querySelectorAll(".ff-card");
    cards.forEach(card => {
      card.addEventListener("dragstart", (e) => {
        this.dragSourceIdx = Number(card.dataset.idx);
        card.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", this.dragSourceIdx);
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
        container.querySelectorAll(".ff-card").forEach(c => c.classList.remove("drag-over"));
        this.dragSourceIdx = null;
      });
      card.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        container.querySelectorAll(".ff-card").forEach(c => c.classList.remove("drag-over"));
        card.classList.add("drag-over");
      });
      card.addEventListener("dragleave", () => {
        card.classList.remove("drag-over");
      });
      card.addEventListener("drop", (e) => {
        e.preventDefault();
        card.classList.remove("drag-over");
        const fromIdx = this.dragSourceIdx;
        const toIdx = Number(card.dataset.idx);
        if (fromIdx === null || fromIdx === toIdx) return;
        const [moved] = this.formFields.splice(fromIdx, 1);
        this.formFields.splice(toIdx, 0, moved);
        this.expandedCards.clear();
        this.renderFormFields();
      });
    });
  },

  addFormFieldRow() {
    const newField = {
      id: "field_" + Date.now(),
      label: "",
      labelEn: "",
      type: "text",
      required: false,
      section: "other",
      mapping: "",
      options: [],
      optionsEn: [],
      defaultValue: "",
      placeholder: "",
    };
    this.formFields.push(newField);
    this.expandedCards.clear();
    this.expandedCards.add(this.formFields.length - 1);
    this.renderFormFields();
    // 最後のカードにスクロール
    const lastCard = document.querySelector("#formFieldList .ff-card:last-child");
    if (lastCard) lastCard.scrollIntoView({ behavior: "smooth", block: "center" });
  },

  async saveFormConfig() {
    const fields = this.formFields.map((f, i) => ({ ...f, order: i + 1 }));

    const resultEl = document.getElementById("formSaveResult");
    const alertEl = document.getElementById("formSaveAlert");
    resultEl.classList.remove("d-none");
    alertEl.className = "alert alert-info py-2";
    alertEl.innerHTML = '<div class="spinner-border spinner-border-sm me-2"></div>保存中...';

    try {
      const pid = this._currentFormTarget;
      if (!pid) {
        alertEl.className = "alert alert-warning py-2";
        alertEl.textContent = "保存対象の物件が選択されていません。";
        return;
      }
      // 物件別設定として保存 (customFormEnabled=true のときのみ保存可)
      const pDoc = await db.collection("properties").doc(pid).get();
      if (!pDoc.exists || pDoc.data().customFormEnabled !== true) {
        alertEl.className = "alert alert-warning py-2";
        alertEl.textContent = "独自設定が有効ではありません。先に「デフォルトを流用して作成」または「他物件から流用」してください。";
        return;
      }
      await db.collection("properties").doc(pid).update({
        customFormFields: fields,
        customFormSections: this.DEFAULT_SECTIONS,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      this.formFields = fields;
      alertEl.className = "alert alert-success py-2";
      alertEl.textContent = `${fields.length}件のフォーム項目を保存しました。ゲストフォームに即時反映されます。`;
      showToast("完了", "フォーム設定を保存しました", "success");
    } catch (e) {
      alertEl.className = "alert alert-danger py-2";
      alertEl.textContent = `保存失敗: ${e.message}`;
    }
  },

  showFormPreview() {
    const body = document.getElementById("formPreviewBody");
    if (!body) return;

    const sectionLabels = {};
    this.DEFAULT_SECTIONS.forEach(s => { sectionLabels[s.id] = s.label; });

    let html = '<form class="preview-form">';
    let lastSec = "";

    this.formFields.forEach(f => {
      if (f.section !== lastSec) {
        lastSec = f.section;
        html += `<h6 class="mt-3 mb-2 fw-bold text-primary border-bottom pb-1">${this.esc(sectionLabels[f.section] || f.section)}</h6>`;
      }

      const reqMark = f.required ? ' <span class="text-danger">*</span>' : "";
      const label = (f.label || "").replace(/\n/g, "<br>");
      html += `<div class="mb-3"><label class="form-label">${label}${reqMark}</label>`;

      switch (f.type) {
        case "image":
          html += f.imageUrl ? `<div class="text-center"><img src="${this.esc(f.imageUrl)}" style="width:${f.imageWidth || 100}%;max-width:100%;border-radius:8px;"></div>` : '<span class="text-muted">（画像URL未設定）</span>';
          break;
        case "textarea":
          html += `<textarea class="form-control" rows="2" placeholder="${this.esc(f.placeholder || "")}" disabled></textarea>`;
          break;
        case "select":
          html += `<select class="form-select" disabled><option>--</option>${(f.options || []).map(o => `<option>${this.esc(o)}</option>`).join("")}</select>`;
          break;
        case "radio":
          (f.options || []).forEach(o => {
            html += `<div class="form-check"><input class="form-check-input" type="radio" disabled><label class="form-check-label">${this.esc(o)}</label></div>`;
          });
          break;
        case "checkbox":
          (f.options || []).forEach(o => {
            html += `<div class="form-check"><input class="form-check-input" type="checkbox" disabled><label class="form-check-label">${this.esc(o)}</label></div>`;
          });
          break;
        case "checkbox-single":
          html += `<div class="form-check"><input class="form-check-input" type="checkbox" disabled><label class="form-check-label">${this.esc(f.label)}</label></div>`;
          break;
        case "date":
          html += `<input type="date" class="form-control" disabled>`;
          break;
        case "number":
          html += `<input type="number" class="form-control" value="${this.esc(f.defaultValue || "")}" disabled>`;
          break;
        default:
          html += `<input type="${f.type || "text"}" class="form-control" placeholder="${this.esc(f.placeholder || "")}" value="${this.esc(f.defaultValue || "")}" disabled>`;
      }
      html += "</div>";
    });
    html += "</form>";
    body.innerHTML = html;

    const modal = new bootstrap.Modal(document.getElementById("formPreviewModal"));
    modal.show();
  },

  // --- 画像アップロード ---

  async uploadFormImage(idx, file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("エラー", "画像ファイルを選択してください", "error");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToast("エラー", "5MB以下の画像を選択してください", "error");
      return;
    }

    const progressEl = document.querySelector(`.ff-upload-progress[data-idx="${idx}"]`);
    const progressBar = progressEl?.querySelector(".progress-bar");
    if (progressEl) progressEl.classList.remove("d-none");

    try {
      const storage = firebase.storage();
      const ext = file.name.split(".").pop() || "jpg";
      const path = `form-images/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const ref = storage.ref(path);
      const task = ref.put(file);

      task.on("state_changed",
        (snap) => {
          const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
          if (progressBar) progressBar.style.width = pct + "%";
        },
        (err) => {
          if (progressEl) progressEl.classList.add("d-none");
          showToast("エラー", `アップロード失敗: ${err.message}`, "error");
        },
        async () => {
          const url = await ref.getDownloadURL();
          this.formFields[idx].imageUrl = url;
          if (progressEl) progressEl.classList.add("d-none");
          this.renderFormFields();
          showToast("完了", "画像をアップロードしました", "success");
        }
      );
    } catch (e) {
      if (progressEl) progressEl.classList.add("d-none");
      showToast("エラー", `アップロード失敗: ${e.message}`, "error");
    }
  },

  // --- Gemini翻訳 ---

  async getGeminiConfig() {
    try {
      const doc = await db.collection("settings").doc("gemini").get();
      if (doc.exists) {
        const d = doc.data();
        if (d.apiKey && d.model) return { apiKey: d.apiKey, model: d.model };
      }
    } catch (e) { /* ignore */ }
    showToast("エラー", "Gemini APIキーが未設定です。設定タブの「Gemini API」セクションで設定してください。", "error");
    return null;
  },

  async callGeminiTranslate(apiKey, model, prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.1 },
      }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || res.statusText);
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  },

  async translateOneWithGemini(idx) {
    const f = this.formFields[idx];
    if (!f.label) { showToast("エラー", "日本語ラベルが空です", "error"); return; }

    const cfg = await this.getGeminiConfig();
    if (!cfg) return;

    const btn = document.querySelector(`.ff-translate-one[data-idx="${idx}"]`);
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    btn.disabled = true;

    try {
      let prompt = `以下の日本語を自然な英語に翻訳してください。JSONで返してください。\n\n`;
      const reqObj = { label: f.label };
      if (f.options?.length) reqObj.options = f.options;
      if (f.placeholder) reqObj.placeholder = f.placeholder;
      prompt += JSON.stringify(reqObj, null, 2);
      prompt += `\n\n返答はJSON形式のみ（コードブロックなし）。キー名はそのまま: {"label":"...","options":["..."],"placeholder":"..."}`;

      const raw = await this.callGeminiTranslate(cfg.apiKey, cfg.model, prompt);
      const json = JSON.parse(raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim());

      if (json.label) f.labelEn = json.label;
      if (json.options?.length) f.optionsEn = json.options;
      if (json.placeholder) f.placeholderEn = json.placeholder;

      this.renderFormFields();
      showToast("完了", `「${f.label.split("\n")[0].substring(0, 20)}」を翻訳しました`, "success");
    } catch (e) {
      showToast("エラー", `翻訳失敗: ${e.message}`, "error");
    }
  },

  async translateAllWithGemini() {
    const cfg = await this.getGeminiConfig();
    if (!cfg) return;

    // 英語ラベルが空の項目のみ翻訳対象
    const targets = this.formFields
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => f.label && !f.labelEn);

    if (!targets.length) {
      showToast("情報", "全項目に英語ラベルが設定済みです。空の項目のみ翻訳対象です。", "info");
      return;
    }

    const btn = document.getElementById("btnTranslateAll");
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> 翻訳中...';
    btn.disabled = true;

    try {
      const reqArray = targets.map(({ f, i }) => {
        const obj = { idx: i, label: f.label };
        if (f.options?.length) obj.options = f.options;
        if (f.placeholder) obj.placeholder = f.placeholder;
        return obj;
      });

      const prompt = `以下のフォーム項目を自然な英語に翻訳してください。宿泊者名簿（Guest Registration Form）の文脈です。
JSON配列で返してください。コードブロックは不要です。

入力:
${JSON.stringify(reqArray, null, 2)}

出力形式: [{"idx":0,"label":"...","options":["..."],"placeholder":"..."}, ...]
idxはそのまま返してください。optionsとplaceholderは入力にある場合のみ返してください。`;

      const raw = await this.callGeminiTranslate(cfg.apiKey, cfg.model, prompt);
      const results = JSON.parse(raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim());

      let count = 0;
      for (const r of results) {
        const f = this.formFields[r.idx];
        if (!f) continue;
        if (r.label) { f.labelEn = r.label; count++; }
        if (r.options?.length) f.optionsEn = r.options;
        if (r.placeholder) f.placeholderEn = r.placeholder;
      }

      this.renderFormFields();
      showToast("完了", `${count}件の項目を英語翻訳しました。「保存」を押して反映してください。`, "success");
    } catch (e) {
      showToast("エラー", `一括翻訳失敗: ${e.message}`, "error");
    } finally {
      btn.innerHTML = origHtml;
      btn.disabled = false;
    }
  },
};
