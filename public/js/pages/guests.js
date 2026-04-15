/**
 * 宿泊者名簿ページ
 * 旅館業法に基づくゲスト情報の一覧・登録・詳細・検索
 * Googleフォーム連携 + 手動入力対応
 */
const GuestsPage = {
  guestList: [],
  modal: null,
  detailModal: null,
  searchTimer: null,

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-person-vcard"></i> 宿泊者名簿</h2>
        <div>
          <button class="btn btn-outline-success me-2" id="btnFormUrl">
            <i class="bi bi-link-45deg"></i> フォームURL生成
          </button>
          <button class="btn btn-primary" id="btnAddGuest">
            <i class="bi bi-plus-lg"></i> 手動登録
          </button>
        </div>
      </div>

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
    await this.loadGuests();
  },

  bindEvents() {
    document.getElementById("btnAddGuest").addEventListener("click", () => {
      this.openModal();
    });

    document.getElementById("btnFormUrl").addEventListener("click", () => {
      this.showFormUrlDialog();
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
      document.getElementById("guestCount").textContent = `${this.guestList.length}件`;
      this.renderTable();
    } catch (e) {
      showToast("エラー", `読み込み失敗: ${e.message}`, "error");
    }
  },

  renderTable() {
    const tbody = document.getElementById("guestTableBody");
    if (!this.guestList.length) {
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

    tbody.innerHTML = this.guestList.map(g => {
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

  // === フォームURL生成ダイアログ ===
  showFormUrlDialog() {
    const baseUrl = location.origin + "/form/";
    const html = `
      <div class="mb-3">
        <label class="form-label fw-bold">基本URL（パラメータなし）</label>
        <div class="input-group">
          <input type="text" class="form-control" value="${baseUrl}" readonly id="formUrlBasic">
          <button class="btn btn-outline-primary" onclick="navigator.clipboard.writeText(document.getElementById('formUrlBasic').value);this.innerHTML='<i class=\\'bi bi-check\\'></i>'">
            <i class="bi bi-clipboard"></i>
          </button>
        </div>
        <small class="text-muted">ゲストに送る基本リンク</small>
      </div>
      <hr>
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
    `;

    // 既存の詳細モーダルを流用（bodyを差し替え）
    const body = document.getElementById("guestDetailBody");
    body.innerHTML = html;
    document.querySelector("#guestDetailModal .modal-title").innerHTML =
      '<i class="bi bi-link-45deg"></i> 宿泊者名簿フォームURL';

    // URL生成ボタン
    setTimeout(() => {
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
        <tr><th>ハウスルール</th><td>${g.houseRuleAgree ? '<span class="badge bg-success">同意済</span>' : '<span class="badge bg-danger">未同意</span>'}</td></tr>
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
    if (!confirm(`${guest?.guestName || ""} の宿泊者情報を削除しますか？`)) return;

    try {
      await API.guests.delete(id);
      showToast("完了", "宿泊者情報を削除しました", "success");
      await this.loadGuests();
    } catch (e) {
      showToast("エラー", `削除失敗: ${e.message}`, "error");
    }
  },

  escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  },
};
