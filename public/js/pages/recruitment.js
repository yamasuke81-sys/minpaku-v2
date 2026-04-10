/**
 * 募集管理ページ
 * 清掃スタッフ募集の一覧・作成・回答管理・選定・確定
 */
const RecruitmentPage = {
  recruitments: [],
  staffList: [],
  currentFilter: "all",
  modal: null,
  detailModal: null,

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-megaphone"></i> 募集管理</h2>
        <button class="btn btn-primary" id="btnAddRecruitment">
          <i class="bi bi-plus-lg"></i> 新規募集
        </button>
      </div>

      <!-- ステータスフィルター -->
      <div class="mb-3">
        <div class="btn-group" role="group" id="recruitmentFilter">
          <button type="button" class="btn btn-outline-secondary active" data-filter="all">すべて</button>
          <button type="button" class="btn btn-outline-primary" data-filter="募集中">募集中</button>
          <button type="button" class="btn btn-outline-warning" data-filter="選定済">選定済</button>
          <button type="button" class="btn btn-outline-success" data-filter="スタッフ確定済み">確定済み</button>
        </div>
      </div>

      <!-- 募集一覧 -->
      <div id="recruitmentList">
        <div class="text-center py-4">
          <div class="spinner-border text-primary" role="status"></div>
          <p class="mt-2 text-muted">読み込み中...</p>
        </div>
      </div>
    `;

    this.modal = new bootstrap.Modal(document.getElementById("recruitmentModal"));
    this.detailModal = new bootstrap.Modal(document.getElementById("recruitmentDetailModal"));
    this.bindEvents();
    await this.loadData();
  },

  bindEvents() {
    document.getElementById("btnAddRecruitment").addEventListener("click", () => {
      this.openCreateModal();
    });

    document.getElementById("recruitmentFilter").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-filter]");
      if (!btn) return;
      document.querySelectorAll("#recruitmentFilter .btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      this.currentFilter = btn.dataset.filter;
      this.renderList();
    });

    document.getElementById("btnSaveRecruitment").addEventListener("click", () => {
      this.saveRecruitment();
    });

    document.getElementById("btnConfirmRecruitment").addEventListener("click", () => {
      this.confirmRecruitment();
    });

    document.getElementById("btnReopenRecruitment").addEventListener("click", () => {
      this.reopenRecruitment();
    });
  },

  async loadData() {
    try {
      const [recruitments, staff] = await Promise.all([
        API.recruitments.list(),
        API.staff.list(true),
      ]);
      this.recruitments = recruitments;
      this.staffList = staff;
      this.renderList();
    } catch (e) {
      showToast("エラー", `データ読み込み失敗: ${e.message}`, "error");
    }
  },

  renderList() {
    const container = document.getElementById("recruitmentList");
    let filtered = this.recruitments;
    if (this.currentFilter !== "all") {
      filtered = filtered.filter(r => r.status === this.currentFilter);
    }

    if (!filtered.length) {
      container.innerHTML = `
        <div class="empty-state">
          <i class="bi bi-megaphone"></i>
          <p>${this.currentFilter === "all" ? "募集がありません" : `「${this.currentFilter}」の募集はありません`}</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map(r => this.renderCard(r)).join("");

    // カードクリックイベント
    container.querySelectorAll(".recruitment-card").forEach(card => {
      card.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        const id = card.dataset.id;
        const recruitment = this.recruitments.find(r => r.id === id);
        if (recruitment) this.openDetailModal(recruitment);
      });
    });

    // アクションボタンイベント
    container.querySelectorAll(".btn-delete-recruit").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.closest(".recruitment-card").dataset.id;
        this.deleteRecruitment(id);
      });
    });
  },

  renderCard(r) {
    const responses = r.responses || [];
    const maruCount = responses.filter(v => v.response === "◎").length;
    const sankakuCount = responses.filter(v => v.response === "△").length;
    const batsuCount = responses.filter(v => v.response === "×").length;
    const totalResponded = maruCount + sankakuCount + batsuCount;
    const totalStaff = this.staffList.length;

    const statusBadge = this.getStatusBadge(r.status);
    const checkoutStr = r.checkoutDate || "-";
    const propertyName = r.propertyName || "";

    // 回答サマリーバー
    const responseSummary = totalResponded > 0
      ? `<div class="response-summary mt-2">
           <div class="d-flex align-items-center gap-2 flex-wrap">
             ${maruCount > 0 ? `<span class="badge bg-success"><i class="bi bi-circle"></i> ◎ ${maruCount}</span>` : ""}
             ${sankakuCount > 0 ? `<span class="badge bg-warning text-dark"><i class="bi bi-triangle"></i> △ ${sankakuCount}</span>` : ""}
             ${batsuCount > 0 ? `<span class="badge bg-danger"><i class="bi bi-x-circle"></i> × ${batsuCount}</span>` : ""}
             <span class="text-muted small">回答 ${totalResponded}/${totalStaff}</span>
           </div>
         </div>`
      : `<div class="text-muted small mt-2">回答なし（${totalStaff}名中）</div>`;

    const selectedStaffHtml = r.selectedStaff
      ? `<div class="mt-2"><i class="bi bi-person-check text-success"></i> <strong>${this.escapeHtml(r.selectedStaff)}</strong></div>`
      : "";

    return `
      <div class="card recruitment-card mb-3" data-id="${r.id}">
        <div class="card-body">
          <div class="d-flex justify-content-between align-items-start">
            <div>
              <h5 class="card-title mb-1">
                <i class="bi bi-calendar-event"></i>
                ${this.escapeHtml(checkoutStr)}
                ${propertyName ? `<small class="text-muted ms-2">${this.escapeHtml(propertyName)}</small>` : ""}
              </h5>
              ${statusBadge}
              ${responseSummary}
              ${selectedStaffHtml}
            </div>
            <div class="btn-group btn-group-sm">
              <button class="btn btn-outline-danger btn-delete-recruit" title="削除">
                <i class="bi bi-trash"></i>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  getStatusBadge(status) {
    const map = {
      "募集中": '<span class="badge bg-primary">募集中</span>',
      "選定済": '<span class="badge bg-warning text-dark">選定済</span>',
      "スタッフ確定済み": '<span class="badge bg-success">スタッフ確定済み</span>',
    };
    return map[status] || `<span class="badge bg-secondary">${this.escapeHtml(status)}</span>`;
  },

  // === 新規募集作成モーダル ===
  openCreateModal() {
    document.getElementById("recruitmentModalTitle").textContent = "新規募集作成";
    document.getElementById("recruitEditId").value = "";
    document.getElementById("recruitCheckoutDate").value = "";
    document.getElementById("recruitMemo").value = "";
    // 物件セレクタに選択肢を設定
    const propSelect = document.getElementById("recruitPropertyId");
    propSelect.innerHTML = '<option value="">-- 物件を選択 --</option>';
    API.properties.list(true).then(props => {
      props.forEach(p => {
        propSelect.innerHTML += `<option value="${p.id}" data-name="${this.escapeHtml(p.name)}">${this.escapeHtml(p.name)}</option>`;
      });
    });
    this.modal.show();
  },

  async saveRecruitment() {
    const checkoutDate = document.getElementById("recruitCheckoutDate").value;
    if (!checkoutDate) {
      showToast("入力エラー", "チェックアウト日は必須です", "error");
      return;
    }
    const propSelect = document.getElementById("recruitPropertyId");
    const propertyId = propSelect.value;
    const propertyName = propSelect.selectedOptions[0]?.dataset?.name || "";
    const memo = document.getElementById("recruitMemo").value.trim();

    try {
      await API.recruitments.create({
        checkoutDate,
        propertyId,
        propertyName,
        memo,
      });
      this.modal.hide();
      showToast("完了", "募集を作成しました", "success");
      await this.loadData();
    } catch (e) {
      showToast("エラー", `募集作成失敗: ${e.message}`, "error");
    }
  },

  // === 募集詳細モーダル ===
  openDetailModal(recruitment) {
    this._currentRecruitment = recruitment;
    const r = recruitment;
    const responses = r.responses || [];

    document.getElementById("detailRecruitId").value = r.id;
    document.getElementById("detailCheckoutDate").textContent = r.checkoutDate || "-";
    document.getElementById("detailProperty").textContent = r.propertyName || "-";
    document.getElementById("detailStatus").innerHTML = this.getStatusBadge(r.status);
    document.getElementById("detailMemo").textContent = r.memo || "-";

    // 選定済みスタッフ表示
    document.getElementById("detailSelectedStaff").textContent = r.selectedStaff || "未選定";

    // 回答一覧テーブル構築
    this.renderResponseTable(r);

    // スタッフ選定セレクタ構築
    this.renderStaffSelector(r);

    // ボタン表示切替
    const confirmBtn = document.getElementById("btnConfirmRecruitment");
    const reopenBtn = document.getElementById("btnReopenRecruitment");
    if (r.status === "スタッフ確定済み") {
      confirmBtn.classList.add("d-none");
      reopenBtn.classList.remove("d-none");
    } else {
      confirmBtn.classList.remove("d-none");
      reopenBtn.classList.add("d-none");
    }

    this.detailModal.show();
  },

  renderResponseTable(recruitment) {
    const tbody = document.getElementById("responseTableBody");
    const responses = recruitment.responses || [];

    // 全スタッフの回答状況をマージ（回答済み + 未回答）
    const responseByKey = {};
    responses.forEach(r => {
      const key = r.staffEmail ? r.staffEmail.toLowerCase() : (r.staffName || "").toLowerCase();
      responseByKey[key] = r;
    });

    const allEntries = this.staffList.map(s => {
      const key = s.email ? s.email.toLowerCase() : s.name.toLowerCase();
      const resp = responseByKey[key] || responseByKey[s.name.toLowerCase()];
      return {
        staffName: s.name,
        staffEmail: s.email,
        staffId: s.id,
        response: resp ? resp.response : "未回答",
        memo: resp ? (resp.memo || "") : "",
        respondedAt: resp ? (resp.respondedAt || "") : "",
        responseId: resp ? resp.id : null,
      };
    });

    if (!allEntries.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">スタッフが登録されていません</td></tr>';
      return;
    }

    tbody.innerHTML = allEntries.map(e => {
      const responseClass = { "◎": "text-success fw-bold", "△": "text-warning fw-bold", "×": "text-danger fw-bold", "未回答": "text-muted" };
      const respondedStr = e.respondedAt
        ? (e.respondedAt.toDate ? e.respondedAt.toDate().toLocaleString("ja-JP") : String(e.respondedAt))
        : "";
      return `
        <tr>
          <td>${this.escapeHtml(e.staffName)}</td>
          <td class="${responseClass[e.response] || ""}">
            ${this.escapeHtml(e.response)}
            ${e.memo ? `<br><small class="text-muted">${this.escapeHtml(e.memo)}</small>` : ""}
          </td>
          <td class="small text-muted">${respondedStr}</td>
          <td>
            ${recruitment.status !== "スタッフ確定済み" ? `
              <div class="btn-group btn-group-sm">
                <button class="btn btn-outline-success btn-respond" data-staff-id="${e.staffId}" data-staff-name="${this.escapeHtml(e.staffName)}" data-staff-email="${this.escapeHtml(e.staffEmail)}" data-response="◎" title="◎">◎</button>
                <button class="btn btn-outline-warning btn-respond" data-staff-id="${e.staffId}" data-staff-name="${this.escapeHtml(e.staffName)}" data-staff-email="${this.escapeHtml(e.staffEmail)}" data-response="△" title="△">△</button>
                <button class="btn btn-outline-danger btn-respond" data-staff-id="${e.staffId}" data-staff-name="${this.escapeHtml(e.staffName)}" data-staff-email="${this.escapeHtml(e.staffEmail)}" data-response="×" title="×">×</button>
              </div>
            ` : ""}
          </td>
        </tr>
      `;
    }).join("");

    // 回答ボタンイベント
    tbody.querySelectorAll(".btn-respond").forEach(btn => {
      btn.addEventListener("click", async () => {
        const recruitmentId = document.getElementById("detailRecruitId").value;
        try {
          await API.recruitments.respond(recruitmentId, {
            staffId: btn.dataset.staffId,
            staffName: btn.dataset.staffName,
            staffEmail: btn.dataset.staffEmail,
            response: btn.dataset.response,
          });
          showToast("完了", `${btn.dataset.staffName} の回答を ${btn.dataset.response} に設定しました`, "success");
          // データ再読み込みして詳細モーダルを更新
          const updated = await API.recruitments.get(recruitmentId);
          const idx = this.recruitments.findIndex(r => r.id === recruitmentId);
          if (idx >= 0) this.recruitments[idx] = updated;
          this.renderResponseTable(updated);
          this.renderStaffSelector(updated);
          this.renderList();
        } catch (e) {
          showToast("エラー", `回答設定失敗: ${e.message}`, "error");
        }
      });
    });
  },

  renderStaffSelector(recruitment) {
    const selectContainer = document.getElementById("staffSelectContainer");
    const responses = recruitment.responses || [];
    // ◎回答したスタッフ優先、次に△、スキップは除外
    const candidates = responses
      .filter(r => r.response === "◎" || r.response === "△")
      .sort((a, b) => {
        if (a.response === "◎" && b.response !== "◎") return -1;
        if (a.response !== "◎" && b.response === "◎") return 1;
        return 0;
      });

    if (!candidates.length) {
      selectContainer.innerHTML = '<p class="text-muted small">◎または△の回答がないため、選定できません</p>';
      return;
    }

    const currentSelected = (recruitment.selectedStaff || "").split(",").map(s => s.trim()).filter(Boolean);

    selectContainer.innerHTML = `
      <div class="mb-2">
        ${candidates.map(c => {
          const checked = currentSelected.includes(c.staffName) ? "checked" : "";
          return `
            <div class="form-check">
              <input class="form-check-input staff-select-cb" type="checkbox" value="${this.escapeHtml(c.staffName)}" id="sel_${this.escapeHtml(c.staffName)}" ${checked}>
              <label class="form-check-label" for="sel_${this.escapeHtml(c.staffName)}">
                ${this.escapeHtml(c.staffName)}
                <span class="badge ${c.response === "◎" ? "bg-success" : "bg-warning text-dark"} ms-1">${c.response}</span>
              </label>
            </div>
          `;
        }).join("")}
      </div>
      <button class="btn btn-sm btn-primary" id="btnSelectStaff">
        <i class="bi bi-person-check"></i> スタッフ選定
      </button>
    `;

    document.getElementById("btnSelectStaff").addEventListener("click", async () => {
      const selected = [];
      selectContainer.querySelectorAll(".staff-select-cb:checked").forEach(cb => {
        selected.push(cb.value);
      });
      if (!selected.length) {
        if (!confirm("スタッフを全員外して募集中に戻しますか？")) return;
      }
      const recruitmentId = document.getElementById("detailRecruitId").value;
      try {
        await API.recruitments.selectStaff(recruitmentId, selected.join(","));
        const msg = selected.length
          ? `${selected.join(", ")} を選定しました`
          : "スタッフを解除し、募集中に戻しました";
        showToast("完了", msg, "success");
        const updated = await API.recruitments.get(recruitmentId);
        const idx = this.recruitments.findIndex(r => r.id === recruitmentId);
        if (idx >= 0) this.recruitments[idx] = updated;
        this.openDetailModal(updated);
        this.renderList();
      } catch (e) {
        showToast("エラー", `スタッフ選定失敗: ${e.message}`, "error");
      }
    });
  },

  async confirmRecruitment() {
    const recruitmentId = document.getElementById("detailRecruitId").value;
    if (!recruitmentId) return;

    const recruitment = this.recruitments.find(r => r.id === recruitmentId);
    if (!recruitment?.selectedStaff) {
      showToast("エラー", "先にスタッフを選定してください", "error");
      return;
    }

    if (!confirm(`${recruitment.selectedStaff} をスタッフとして確定しますか？`)) return;

    try {
      await API.recruitments.confirm(recruitmentId);
      showToast("完了", "スタッフを確定しました", "success");
      this.detailModal.hide();
      await this.loadData();
    } catch (e) {
      showToast("エラー", `確定失敗: ${e.message}`, "error");
    }
  },

  async reopenRecruitment() {
    const recruitmentId = document.getElementById("detailRecruitId").value;
    if (!recruitmentId) return;
    if (!confirm("募集を再開しますか？")) return;

    try {
      await API.recruitments.reopen(recruitmentId);
      showToast("完了", "募集を再開しました", "success");
      this.detailModal.hide();
      await this.loadData();
    } catch (e) {
      showToast("エラー", `再開失敗: ${e.message}`, "error");
    }
  },

  async deleteRecruitment(id) {
    const recruitment = this.recruitments.find(r => r.id === id);
    if (!confirm(`${recruitment?.checkoutDate || ""} の募集を削除しますか？`)) return;

    try {
      await API.recruitments.delete(id);
      showToast("完了", "募集を削除しました", "success");
      await this.loadData();
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
