/**
 * 募集管理ページ
 * 清掃スタッフ募集の一覧・作成・回答管理・選定・確定
 */
const RecruitmentPage = {
  recruitments: [],
  staffList: [],
  properties: [],           // 物件一覧
  selectedPropertyIds: [],  // フィルタ選択中の物件ID
  currentFilter: "all",
  currentSort: "smart",
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

      <!-- 物件フィルタ -->
      <div id="propertyFilterHost-recruitment"></div>

      <!-- ステータスフィルター + 日付ソート -->
      <div class="mb-3 d-flex flex-wrap gap-2 align-items-center">
        <div class="btn-group" role="group" id="recruitmentFilter">
          <button type="button" class="btn btn-outline-secondary active" data-filter="all">すべて</button>
          <button type="button" class="btn btn-outline-primary" data-filter="募集中">募集中</button>
          <button type="button" class="btn btn-outline-warning" data-filter="選定済">選定済</button>
          <button type="button" class="btn btn-outline-success" data-filter="スタッフ確定済み">確定済み</button>
        </div>
        <div class="btn-group btn-group-sm ms-auto" role="group" id="recruitmentSort">
          <button type="button" class="btn btn-outline-dark active" data-sort="smart" title="直近の今後案件が一番上、その後に過去の新しい順">
            <i class="bi bi-clock-history"></i> 直近順
          </button>
          <button type="button" class="btn btn-outline-dark" data-sort="dateAsc" title="古い日→新しい日">
            <i class="bi bi-sort-down"></i> 日付昇順
          </button>
          <button type="button" class="btn btn-outline-dark" data-sort="dateDesc" title="新しい日→古い日">
            <i class="bi bi-sort-up"></i> 日付降順
          </button>
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

    // 物件フィルタ初期化 (loadData後に物件一覧が揃っているので後ろで初期化)
    PropertyFilter.render({
      containerId: "propertyFilterHost-recruitment",
      tabKey: "recruitment",
      properties: this.properties,
      onChange: (ids) => {
        this.selectedPropertyIds = ids;
        this.renderList();
      },
    });
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

    document.getElementById("recruitmentSort")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-sort]");
      if (!btn) return;
      document.querySelectorAll("#recruitmentSort .btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      this.currentSort = btn.dataset.sort;
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

  // 他ページから openDetailModal を呼ぶときの初期化保証
  async ensureLoaded() {
    if (!this.detailModal) {
      const el = document.getElementById("recruitmentDetailModal");
      if (el) this.detailModal = new bootstrap.Modal(el);
    }
    if (!this.modal) {
      const el = document.getElementById("recruitmentModal");
      if (el) this.modal = new bootstrap.Modal(el);
    }
    if (!this.staffList || !this.staffList.length) {
      this.staffList = await API.staff.list(true);
    }
    if (!this.recruitments || !this.recruitments.length) {
      this.recruitments = await API.recruitments.list();
    }
    // bindEvents 一度も呼ばれていない場合、最低限 confirm/reopen ボタンをバインド
    if (!this._quickBound) {
      const cb = document.getElementById("btnConfirmRecruitment");
      const rb = document.getElementById("btnReopenRecruitment");
      if (cb) cb.addEventListener("click", () => this.confirmRecruitment());
      if (rb) rb.addEventListener("click", () => this.reopenRecruitment());
      this._quickBound = true;
    }
  },

  async loadData() {
    try {
      const [recruitments, staff, properties] = await Promise.all([
        API.recruitments.list(),
        API.staff.list(true),
        API.properties.listMinpakuNumbered(),
      ]);
      this.recruitments = recruitments;
      this.staffList = staff;
      this.properties = properties;
      this.selectedPropertyIds = PropertyFilter.getSelectedIds("recruitment", properties);
      this.renderList();
    } catch (e) {
      showToast("エラー", `データ読み込み失敗: ${e.message}`, "error");
    }
  },

  renderList() {
    const container = document.getElementById("recruitmentList");
    // 別画面 (清掃スケジュール等) から openDetailModal 経由で reopenRecruitment が
    // 呼ばれた後、this.loadData() → renderList() が連鎖する。そのとき募集画面の
    // DOM は存在しないので何もしない。
    if (!container) return;
    let filtered = [...this.recruitments];
    if (this.currentFilter !== "all") {
      filtered = filtered.filter(r => r.status === this.currentFilter);
    }
    // 物件フィルタ適用
    if (this.selectedPropertyIds && this.selectedPropertyIds.length > 0) {
      filtered = filtered.filter(r => !r.propertyId || this.selectedPropertyIds.includes(r.propertyId));
    } else if (this.selectedPropertyIds && this.selectedPropertyIds.length === 0) {
      filtered = [];
    }

    // 日付ソート
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const toDate = (s) => {
      const d = new Date(s); d.setHours(0, 0, 0, 0);
      return isNaN(d.getTime()) ? null : d;
    };
    if (this.currentSort === "dateAsc") {
      filtered.sort((a, b) => (toDate(a.checkoutDate) || 0) - (toDate(b.checkoutDate) || 0));
    } else if (this.currentSort === "dateDesc") {
      filtered.sort((a, b) => (toDate(b.checkoutDate) || 0) - (toDate(a.checkoutDate) || 0));
    } else { // "smart" (デフォルト)
      filtered.sort((a, b) => {
        const da = toDate(a.checkoutDate), dbv = toDate(b.checkoutDate);
        if (!da && !dbv) return 0;
        if (!da) return 1;
        if (!dbv) return -1;
        const aFuture = da >= today, bFuture = dbv >= today;
        if (aFuture && !bFuture) return -1;       // 未来を先
        if (!aFuture && bFuture) return 1;
        if (aFuture) return da - dbv;             // 未来同士: 近い順
        return dbv - da;                           // 過去同士: 新しい順
      });
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
             ${maruCount > 0 ? `<span class="badge bg-success">◎ ${maruCount}</span>` : ""}
             ${sankakuCount > 0 ? `<span class="badge bg-warning text-dark">△ ${sankakuCount}</span>` : ""}
             ${batsuCount > 0 ? `<span class="badge bg-danger">× ${batsuCount}</span>` : ""}
             <span class="text-muted small">回答 ${totalResponded}/${totalStaff}</span>
           </div>
         </div>`
      : `<div class="text-muted small mt-2">回答なし（${totalStaff}名中）</div>`;

    const selectedStaffHtml = r.selectedStaff
      ? `<div class="mt-2"><i class="bi bi-person-check text-success"></i> <strong>${this.escapeHtml(r.selectedStaff)}</strong></div>`
      : "";

    const workTypeBadge = this.getWorkTypeBadge(r.workType);

    return `
      <div class="card recruitment-card mb-3" data-id="${r.id}">
        <div class="card-body">
          <div class="d-flex justify-content-between align-items-start">
            <div>
              <h5 class="card-title mb-1">
                ${workTypeBadge}
                <i class="bi bi-calendar-event ms-1"></i>
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

  getWorkTypeBadge(wt) {
    if (wt === "pre_inspection") {
      return '<span class="badge" style="background:#6f42c1;color:#fff;" title="直前点検">直</span>';
    }
    return '<span class="badge" style="background:#0d6efd;color:#fff;" title="清掃">清</span>';
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
    const workType = document.getElementById("newRecruitmentWorkType")?.value || "cleaning_by_count";
    const memo = document.getElementById("recruitMemo").value.trim();

    try {
      await API.recruitments.create({
        checkoutDate,
        propertyId,
        propertyName,
        workType,
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
  openDetailModal(recruitment, options = {}) {
    this._currentRecruitment = recruitment;
    // viewMode: "owner" | "staff"。省略時は Auth.isOwner() から判定
    const viewMode = options.viewMode || ((typeof Auth !== "undefined" && Auth.isOwner && Auth.isOwner()) ? "owner" : "staff");
    this._viewMode = viewMode;
    const isStaffView = viewMode === "staff";
    const r = recruitment;
    const responses = r.responses || [];

    document.getElementById("detailRecruitId").value = r.id;
    // A1: チェックアウト日を「YYYY年M月D日(曜)」形式に統一
    document.getElementById("detailCheckoutDate").textContent =
      (typeof formatDateFull === "function") ? formatDateFull(r.checkoutDate) : (r.checkoutDate || "-");
    document.getElementById("detailProperty").textContent = r.propertyName || "-";
    // workType バッジを detailStatus の前に表示
    const workTypeBadgeEl = document.getElementById("detailWorkTypeBadge");
    if (workTypeBadgeEl) workTypeBadgeEl.innerHTML = this.getWorkTypeBadge(r.workType);
    document.getElementById("detailStatus").innerHTML = this.getStatusBadge(r.status);
    document.getElementById("detailMemo").textContent = r.memo || "-";

    // 選定済みスタッフ表示
    document.getElementById("detailSelectedStaff").textContent = r.selectedStaff || "未選定";

    // 統合テーブル + 選定アクション
    this.renderResponseTable(r);
    this.renderSelectionActions(r);

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

    // オーナー限定: 情報履歴 (iCal 取得日 / Gmail 照合日 等) を非同期で描画
    // スタッフビュー時は常に非表示
    const ownerInfoEl = document.getElementById("ownerInfoLog");
    if (ownerInfoEl) {
      ownerInfoEl.classList.add("d-none");
      ownerInfoEl.innerHTML = "";
      if (!isStaffView && Auth?.isOwner?.() && r.bookingId) {
        this._renderOwnerInfoLog(r);
      }
    }

    // スタッフビュー時: スタッフ確定ボタン・募集再開ボタンを非表示
    if (isStaffView) {
      confirmBtn?.classList.add("d-none");
      reopenBtn?.classList.add("d-none");
    }

    // A4: 自分の回答ボタン (◎△×) をモーダル上部に描画
    this.renderMyResponseArea(r);
    // A5: 右カラムのチェックリスト (読み取り専用) を描画
    this.renderChecklistSidebar(r);

    this.detailModal.show();
  },

  // A4: 自分の回答ボタンをモーダル上部 (スタッフ選定セクションの上) に描画
  // - 確定済み (スタッフ確定済み) は非表示
  // - 自分が未回答: ◎/△/× 3ボタン (△ は理由入力欄展開)
  // - 既に回答済み: 現在の回答 + 取消ボタン
  async renderMyResponseArea(recruitment) {
    const area = document.getElementById("detailMyResponseArea");
    if (!area) return;
    area.innerHTML = "";
    area.classList.add("d-none");

    if (!Auth || !Auth.currentUser) return;

    // 確定済みの場合: 自分が選定済みスタッフなら「回答変更要望」ボタンを出す (Task 8)
    if (recruitment.status === "スタッフ確定済み") {
      await this._renderChangeRequestArea(recruitment);
      return;
    }

    // 自分の staffId / name / email を特定 (オーナーも自分の staff ドキュメント扱い)
    let myStaffId = Auth.currentUser.staffId;
    let myStaff = null;
    if (!this.staffList || !this.staffList.length) {
      this.staffList = await API.staff.list(true);
    }
    if (myStaffId) {
      myStaff = this.staffList.find(s => s.id === myStaffId);
    }
    // オーナーで staffId クレームが無い場合、authUid で staff コレクションから解決
    if (!myStaff && Auth.isOwner && Auth.isOwner() && Auth.currentUser.uid) {
      myStaff = this.staffList.find(s => s.authUid === Auth.currentUser.uid);
      if (myStaff) myStaffId = myStaff.id;
    }
    if (!myStaff) return;

    const responses = recruitment.responses || [];
    const myEmail = (myStaff.email || "").toLowerCase();
    const mine = responses.find(r => {
      if (r.staffId && myStaffId && r.staffId === myStaffId) return true;
      if (r.staffName && myStaff.name && r.staffName === myStaff.name) return true;
      if (r.staffEmail && myEmail && r.staffEmail.toLowerCase() === myEmail) return true;
      return false;
    });

    area.classList.remove("d-none");
    if (mine) {
      // 既回答表示 + 取消
      const respLabel = mine.response === "◎" ? '<span class="badge bg-success">◎ OK</span>'
        : mine.response === "△" ? '<span class="badge bg-warning text-dark">△ 条件付</span>'
        : mine.response === "×" ? '<span class="badge bg-danger">× NG</span>'
        : `<span class="badge bg-secondary">${this.escapeHtml(mine.response || "-")}</span>`;
      area.innerHTML = `
        <div class="border rounded p-2 bg-light">
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <strong>あなたの回答:</strong> ${respLabel}
            ${mine.memo ? `<span class="small text-muted">（理由: ${this.escapeHtml(mine.memo)}）</span>` : ""}
            <button class="btn btn-sm btn-outline-secondary ms-auto" id="btnMyRespCancel">
              <i class="bi bi-x-lg"></i> 取消 (未回答に戻す)
            </button>
          </div>
        </div>`;
      document.getElementById("btnMyRespCancel").addEventListener("click", async () => {
        await this._submitMyResponse(recruitment, myStaff, null, null);
      });
    } else {
      area.innerHTML = `
        <div class="border rounded p-2 bg-light">
          <div class="small text-muted mb-2"><i class="bi bi-hand-index"></i> あなたの回答を選択してください</div>
          <div class="d-flex gap-2 flex-wrap">
            <button type="button" class="btn btn-success" data-resp="◎">◎ OK</button>
            <button type="button" class="btn btn-warning" data-resp="△">△ 条件付</button>
            <button type="button" class="btn btn-danger" data-resp="×">× NG</button>
          </div>
          <div id="myRespTriangleArea" class="d-none mt-2">
            <label class="form-label small fw-bold mb-1">△の理由 (必須)</label>
            <textarea id="myRespTriangleReason" class="form-control form-control-sm" rows="2" placeholder="詳しい理由を入力..."></textarea>
            <div class="d-flex gap-2 mt-2">
              <button type="button" class="btn btn-sm btn-warning" id="btnMyRespSubmitTriangle">
                <i class="bi bi-check-lg"></i> △ で送信
              </button>
              <button type="button" class="btn btn-sm btn-outline-secondary" id="btnMyRespCancelTriangle">キャンセル</button>
            </div>
          </div>
        </div>`;
      area.querySelectorAll('button[data-resp]').forEach(btn => {
        btn.addEventListener("click", async () => {
          const resp = btn.dataset.resp;
          if (resp === "△") {
            area.querySelector("#myRespTriangleArea").classList.remove("d-none");
            area.querySelector("#myRespTriangleReason").focus();
          } else {
            await this._submitMyResponse(recruitment, myStaff, resp, "");
          }
        });
      });
      area.querySelector("#btnMyRespCancelTriangle")?.addEventListener("click", () => {
        area.querySelector("#myRespTriangleArea").classList.add("d-none");
      });
      area.querySelector("#btnMyRespSubmitTriangle")?.addEventListener("click", async () => {
        const reason = area.querySelector("#myRespTriangleReason").value.trim();
        if (!reason) {
          showToast("入力エラー", "△の理由を入力してください", "error");
          return;
        }
        await this._submitMyResponse(recruitment, myStaff, "△", reason);
      });
    }
  },

  // 自分の回答を Firestore に書き込み (response=null で取消)
  async _submitMyResponse(recruitment, myStaff, response, memo) {
    try {
      const ref = db.collection("recruitments").doc(recruitment.id);
      const doc = await ref.get();
      if (!doc.exists) throw new Error("募集が見つかりません");
      const data = doc.data();
      if (data.status === "スタッフ確定済み") throw new Error("確定済みの募集は変更できません");
      const responses = data.responses || [];
      const myEmail = (myStaff.email || "").toLowerCase();
      const match = (r) => {
        if (r.staffId && myStaff.id && r.staffId === myStaff.id) return true;
        if (r.staffName && myStaff.name && r.staffName === myStaff.name) return true;
        if (r.staffEmail && myEmail && r.staffEmail.toLowerCase() === myEmail) return true;
        return false;
      };
      const filtered = responses.filter(r => !match(r));
      if (response) {
        filtered.push({
          staffId: myStaff.id,
          staffName: myStaff.name || "",
          staffEmail: myStaff.email || "",
          response,
          memo: memo || "",
          respondedAt: new Date().toISOString(),
        });
      }
      await ref.update({ responses: filtered, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      showToast("完了", response ? `${response} で回答しました` : "回答を取り消しました", "success");
      const updated = await API.recruitments.get(recruitment.id);
      const idx = this.recruitments.findIndex(r => r.id === recruitment.id);
      if (idx >= 0) this.recruitments[idx] = updated;
      // モーダル再描画
      this.openDetailModal(updated, { viewMode: this._viewMode });
      this.renderList();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  // Task 8: 確定済み募集で、自分が選定されているスタッフ向けに「回答変更要望」ボタンを表示
  async _renderChangeRequestArea(recruitment) {
    const area = document.getElementById("detailMyResponseArea");
    if (!area) return;
    // 自分の staff 情報を解決
    let myStaffId = Auth.currentUser.staffId;
    if (!this.staffList || !this.staffList.length) {
      try { this.staffList = await API.staff.list(true); } catch (_) { this.staffList = []; }
    }
    let myStaff = myStaffId ? this.staffList.find(s => s.id === myStaffId) : null;
    if (!myStaff && Auth.isOwner && Auth.isOwner() && Auth.currentUser.uid) {
      myStaff = this.staffList.find(s => s.authUid === Auth.currentUser.uid);
      if (myStaff) myStaffId = myStaff.id;
    }
    if (!myStaff) return;

    // 選定されているかどうかを確認 (selectedStaff は名前カンマ区切り)
    const sel = (recruitment.selectedStaff || "").trim();
    if (!sel) return;
    const selectedNames = sel.split(/[,、\s]+/).map(s => s.trim()).filter(Boolean);
    if (!selectedNames.includes(myStaff.name)) return;

    // 既に自分の要望が登録済みかチェック
    const existing = (recruitment.changeRequests || []).find(cr => cr && cr.staffId === myStaff.id);

    area.classList.remove("d-none");
    if (existing) {
      area.innerHTML = `
        <div class="border rounded p-2 bg-warning bg-opacity-10">
          <div class="small"><i class="bi bi-hourglass-split"></i> 回答変更要望を送信済みです</div>
          <div class="small text-muted mt-1">理由: ${this.escapeHtml(existing.reason || "")}</div>
        </div>`;
      return;
    }

    area.innerHTML = `
      <div class="border rounded p-2 bg-light">
        <div class="small text-muted mb-2">体調不良など、やむを得ず確定後に回答を変更したい場合はオーナーに変更要望を送信できます</div>
        <button type="button" class="btn btn-outline-warning btn-sm" id="btnRequestChange">
          <i class="bi bi-arrow-repeat"></i> 回答変更要望を出す
        </button>
      </div>`;
    document.getElementById("btnRequestChange").addEventListener("click", async () => {
      const reason = await showPrompt("回答変更要望の理由を入力してください", { title: "回答変更要望", placeholder: "例: 体調不良のため" });
      if (!reason) return;
      try {
        const ref = db.collection("recruitments").doc(recruitment.id);
        const FV = firebase.firestore.FieldValue;
        await ref.update({
          changeRequests: FV.arrayUnion({
            staffId: myStaff.id,
            staffName: myStaff.name || "",
            reason: reason.trim(),
            requestedAt: new Date().toISOString(),
          }),
          updatedAt: FV.serverTimestamp(),
        });
        showToast("送信完了", "回答変更要望をオーナーに送信しました", "success");
        const updated = await API.recruitments.get(recruitment.id);
        const idx = this.recruitments.findIndex(r => r.id === recruitment.id);
        if (idx >= 0) this.recruitments[idx] = updated;
        this.openDetailModal(updated, { viewMode: this._viewMode });
      } catch (e) {
        showToast("エラー", e.message, "error");
      }
    });
  },

  // A5: モーダル見出しの「チェックリストを開く」ボタンを設定
  // - checklist ドキュメントが存在する場合: 有効化 + クリックで #/my-checklist/{id} へ遷移
  // - 未生成の場合: disabled + title に理由
  async renderChecklistSidebar(recruitment) {
    const btn = document.getElementById("btnOpenChecklistFromRecruitment");
    if (!btn) return;
    // 初期化: 一旦 disabled + 非表示化
    btn.classList.remove("d-none");
    btn.disabled = true;
    btn.title = "読み込み中...";
    btn.onclick = null;
    try {
      if (!recruitment.bookingId) {
        btn.disabled = true;
        btn.title = "予約未紐付けのためチェックリスト未生成";
        return;
      }
      const shiftSnap = await db.collection("shifts")
        .where("bookingId", "==", recruitment.bookingId).limit(1).get();
      if (shiftSnap.empty) {
        btn.disabled = true;
        btn.title = "対応するシフトがありません";
        return;
      }
      const shiftId = shiftSnap.docs[0].id;
      const clSnap = await db.collection("checklists")
        .where("shiftId", "==", shiftId).limit(1).get();
      if (clSnap.empty) {
        btn.disabled = true;
        btn.title = "未生成";
        return;
      }
      const checklistId = clSnap.docs[0].id;
      btn.disabled = false;
      btn.title = "チェックリストを開く";
      btn.onclick = () => {
        // モーダルを閉じてから遷移 (モーダル残存対策)
        try { this.detailModal?.hide(); } catch (_) {}
        location.hash = `#/my-checklist/${checklistId}`;
      };
    } catch (e) {
      console.warn("チェックリストボタン設定エラー:", e);
      btn.disabled = true;
      btn.title = "読み込みエラー";
    }
  },

  // オーナー限定: 募集詳細モーダル最下部に「情報履歴」を描画
  // データソース: bookings ドキュメント
  //   - iCal 取得日 = bookings.createdAt
  //   - 最終同期日 = bookings.updatedAt
  //   - iCal UID / source / 手動復元フラグ
  //   - Gmail 照合 (将来実装): bookings.emailVerifiedAt / emailMessageId
  async _renderOwnerInfoLog(recruitment) {
    const el = document.getElementById("ownerInfoLog");
    if (!el) return;
    try {
      const snap = await db.collection("bookings").doc(recruitment.bookingId).get();
      if (!snap.exists) return;
      const b = snap.data();
      const fmt = (ts) => {
        if (!ts) return "-";
        const d = ts.toDate ? ts.toDate() : new Date(ts);
        return d.toLocaleString("ja-JP");
      };
      const lines = [];
      lines.push(`<div><strong>データソース:</strong> ${this.escapeHtml(b.source || b.syncSource || "-")}</div>`);
      lines.push(`<div><strong>情報登録日 (iCal 初回取得):</strong> ${fmt(b.createdAt)}</div>`);
      lines.push(`<div><strong>最終同期日:</strong> ${fmt(b.updatedAt)}</div>`);
      if (b.icalUid) lines.push(`<div><strong>iCal UID:</strong> <code style="font-size:11px;">${this.escapeHtml(b.icalUid)}</code></div>`);
      if (b.manualOverride) {
        lines.push(`<div class="text-warning mt-1"><strong><i class="bi bi-pencil-square"></i> 手動復元:</strong> ${fmt(b.manualOverrideAt)}</div>`);
        if (b.manualOverrideReason) {
          lines.push(`<div class="text-warning ps-3"><small>${this.escapeHtml(b.manualOverrideReason)}</small></div>`);
        }
      }
      // Gmail 照合情報 (feature/email-verification で実装予定)
      if (b.emailVerifiedAt) {
        lines.push(`<div class="text-success mt-1"><strong><i class="bi bi-envelope-check"></i> Gmail 照合日:</strong> ${fmt(b.emailVerifiedAt)}</div>`);
        if (b.emailMessageId) {
          const gmailUrl = `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(b.emailMessageId)}`;
          lines.push(`<div class="ps-3"><a href="${gmailUrl}" target="_blank" rel="noopener" class="small"><i class="bi bi-box-arrow-up-right"></i> Gmail でメールを開く</a></div>`);
        }
      } else {
        lines.push(`<div class="text-muted mt-1"><small><i class="bi bi-envelope-slash"></i> Gmail 照合: 未実行 (機能実装待ち)</small></div>`);
      }
      el.innerHTML = `
        <hr>
        <details>
          <summary class="small text-muted" style="cursor:pointer;">
            <i class="bi bi-shield-lock"></i> 情報履歴 (オーナーのみ)
          </summary>
          <div class="small text-muted mt-2" style="line-height:1.7;">
            ${lines.join("")}
          </div>
        </details>
      `;
      el.classList.remove("d-none");
    } catch (e) {
      console.warn("情報履歴読み込みエラー:", e);
    }
  },

  async renderResponseTable(recruitment) {
    const tbody = document.getElementById("responseTableBody");
    const responses = recruitment.responses || [];
    const isStaffView = this._viewMode === "staff";
    // スタッフビュー時: 選定列とテーブルヘッダ「選定」を非表示
    const theadSelectTh = document.querySelector('#responseTableBody')?.parentElement?.querySelector('thead th:first-child');
    if (theadSelectTh) theadSelectTh.style.display = isStaffView ? "none" : "";
    // 自分のstaffIdを特定 (スタッフビュー時、自分の行のみ代理回答ボタンを出す)
    const myStaffId = (typeof Auth !== "undefined" && Auth.currentUser) ? Auth.currentUser.staffId : null;

    // 回答マップ (name優先、emailフォールバック)
    const respByName = {};
    responses.forEach(r => {
      if (r.staffName) respByName[r.staffName] = r;
    });

    // 最新のアクティブスタッフ全員(オーナー含む)
    const allStaff = (await API.staff.list(true)).sort((a, b) => (a.displayOrder||0) - (b.displayOrder||0));

    if (!allStaff.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">スタッフが登録されていません</td></tr>';
      return;
    }

    const confirmed = recruitment.status === "スタッフ確定済み";
    const currentSelected = (recruitment.selectedStaff || "").split(",").map(s => s.trim()).filter(Boolean);

    // 並び: ◎ → △ → 未回答 → × の順で、各グループ内は displayOrder
    const order = { "◎": 0, "△": 1, "未回答": 2, "×": 3 };
    const rows = allStaff.map(s => {
      const r = respByName[s.name];
      return {
        staff: s,
        response: r ? r.response : "未回答",
        respondedAt: r ? r.respondedAt : null,
        memo: r ? (r.memo || "") : ""
      };
    }).sort((a, b) => {
      const oa = order[a.response] ?? 9;
      const ob = order[b.response] ?? 9;
      if (oa !== ob) return oa - ob;
      return (a.staff.displayOrder||0) - (b.staff.displayOrder||0);
    });

    const respBadge = (r) => {
      if (r === "◎") return '<span class="badge bg-success">◎</span>';
      if (r === "△") return '<span class="badge bg-warning text-dark">△</span>';
      if (r === "×") return '<span class="badge bg-danger">×</span>';
      return '<span class="badge bg-secondary">未回答</span>';
    };

    tbody.innerHTML = rows.map(row => {
      const s = row.staff;
      const checked = currentSelected.includes(s.name) ? "checked" : "";
      // A2: 回答日時は "M/D HH:MM" に統一
      const respondedStr = row.respondedAt
        ? ((typeof formatTimeShort === "function") ? formatTimeShort(row.respondedAt)
            : (row.respondedAt.toDate ? row.respondedAt.toDate().toLocaleString("ja-JP") : String(row.respondedAt)))
        : "";
      // A4 で自分の回答はモーダル上部に集約したので、テーブル内の自分行の回答ボタンは非表示にする
      // オーナービュー時は他スタッフへの代理回答のみ可 (自分の行は上部で操作)
      const isMeRow = myStaffId && s.id === myStaffId;
      const canRespond = !confirmed && !isStaffView && !isMeRow;
      const selectCell = isStaffView ? "" : `
        <td>
          <input class="form-check-input staff-select-cb" type="checkbox"
                 value="${this.escapeHtml(s.name)}" ${checked} ${confirmed ? "disabled" : ""}>
        </td>`;
      // A3: △ 回答の行は、直下に memo を薄色テキストで常時展開表示 (回答|理由 を一覧化)
      const colspan = isStaffView ? 4 : 5;
      const memoRow = (row.response === "△" && row.memo) ? `
        <tr class="triangle-memo-row">
          <td colspan="${colspan}" class="small text-muted ps-4 py-1" style="background:#fffbea;border-top:0;">
            <i class="bi bi-chat-left-text"></i> 理由: ${this.escapeHtml(row.memo)}
          </td>
        </tr>` : "";
      return `
        <tr>
          ${selectCell}
          <td>
            ${this.escapeHtml(s.name)}
            ${s.isOwner ? '<span class="badge bg-info ms-1" title="オーナー">OWN</span>' : ""}
          </td>
          <td>${respBadge(row.response)}</td>
          <td class="small text-muted d-none d-md-table-cell">${respondedStr}</td>
          <td>
            ${canRespond ? `
              <div class="btn-group btn-group-sm">
                <button class="btn btn-outline-success btn-respond" data-staff-id="${s.id}" data-staff-name="${this.escapeHtml(s.name)}" data-staff-email="${this.escapeHtml(s.email||"")}" data-response="◎" title="◎">◎</button>
                <button class="btn btn-outline-warning btn-respond" data-staff-id="${s.id}" data-staff-name="${this.escapeHtml(s.name)}" data-staff-email="${this.escapeHtml(s.email||"")}" data-response="△" title="△">△</button>
                <button class="btn btn-outline-danger btn-respond" data-staff-id="${s.id}" data-staff-name="${this.escapeHtml(s.name)}" data-staff-email="${this.escapeHtml(s.email||"")}" data-response="×" title="×">×</button>
              </div>
            ` : ""}
          </td>
        </tr>
        ${memoRow}
      `;
    }).join("");

    // 代理回答ボタン
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
          const updated = await API.recruitments.get(recruitmentId);
          const idx = this.recruitments.findIndex(r => r.id === recruitmentId);
          if (idx >= 0) this.recruitments[idx] = updated;
          this.renderResponseTable(updated);
          this.renderSelectionActions(updated);
          this.renderList();
        } catch (e) {
          showToast("エラー", `回答設定失敗: ${e.message}`, "error");
        }
      });
    });
  },

  // 旧 renderStaffSelector は renderSelectionActions にリネーム + 機能縮小
  // テーブル内のチェックボックスで選択、ここではボタン + ガイドだけ表示
  async renderSelectionActions(recruitment) {
    const selectContainer = document.getElementById("staffSelectContainer");
    if (!selectContainer) return;
    const isStaffView = this._viewMode === "staff";
    // スタッフビュー時は選定アクション全体を非表示
    if (isStaffView) { selectContainer.innerHTML = ""; return; }
    const confirmed = recruitment.status === "スタッフ確定済み";
    if (confirmed) { selectContainer.innerHTML = ""; return; }

    selectContainer.innerHTML = `
      <div class="d-flex align-items-center gap-2 mt-2">
        <button class="btn btn-sm btn-outline-primary" id="btnSelectStaff">
          <i class="bi bi-bookmark-check"></i> 選択状態を保存
        </button>
        <small class="text-muted">候補を残すだけで通知はされません。保存後、下の「スタッフ確定」で本決定。</small>
      </div>
      <div id="btnSelectStaffGuide" class="alert alert-info py-2 mt-2 small d-none">
        <i class="bi bi-info-circle"></i> 候補を保存しました。<strong>次はモーダル下部の「スタッフ確定」</strong>を押すと LINE 通知が送信され、シフトに割り当てられます。
      </div>
    `;

    document.getElementById("btnSelectStaff").addEventListener("click", async () => {
      const selected = [];
      // チェックボックスはテーブル内(responseTableBody)にある
      document.querySelectorAll("#responseTableBody .staff-select-cb:checked").forEach(cb => {
        selected.push(cb.value);
      });
      const currentSelected = (recruitment.selectedStaff || "").trim();
      if (!selected.length) {
        if (!currentSelected) {
          showToast("情報", "スタッフを1名以上チェックしてください", "info");
          return;
        }
        const ok = await showConfirm("選定解除", "スタッフを全員外して募集中に戻しますか？");
        if (!ok) return;
      }
      const recruitmentId = document.getElementById("detailRecruitId").value;
      try {
        await API.recruitments.selectStaff(recruitmentId, selected.join(","));
        const msg = selected.length
          ? `${selected.join(", ")} を候補として保存しました`
          : "候補を解除し、募集中に戻しました";
        showToast("完了", msg, "success");
        // ガイド表示
        const guide = document.getElementById("btnSelectStaffGuide");
        if (guide && selected.length) guide.classList.remove("d-none");
        const updated = await API.recruitments.get(recruitmentId);
        const idx = this.recruitments.findIndex(r => r.id === recruitmentId);
        if (idx >= 0) this.recruitments[idx] = updated;
        this.openDetailModal(updated);
        this.renderList();
        // 確定ボタンをハイライト
        const confirmBtn = document.getElementById("btnConfirmRecruitment");
        if (confirmBtn && selected.length) {
          confirmBtn.classList.add("btn-pulse");
          confirmBtn.focus();
        }
      } catch (e) {
        showToast("エラー", `候補保存失敗: ${e.message}`, "error");
      }
    });
  },

  async confirmRecruitment() {
    const recruitmentId = document.getElementById("detailRecruitId").value;
    if (!recruitmentId) return;

    let recruitment = this.recruitments.find(r => r.id === recruitmentId);

    // 現在のチェック状態を DOM から取得 (cb.value = staffName)
    const checkedNames = [];
    document.querySelectorAll("#responseTableBody .staff-select-cb:checked").forEach(cb => {
      checkedNames.push(cb.value);
    });

    // チェックが保存済と異なる場合、先に自動保存 (「選択状態を保存」を押さなくてもOKに)
    const savedCsv = (recruitment?.selectedStaff || "").trim();
    const checkedCsv = checkedNames.join(",");
    const savedSorted = savedCsv.split(/[,、\s]+/).filter(Boolean).sort().join(",");
    const checkedSorted = [...checkedNames].sort().join(",");
    if (checkedNames.length > 0 && savedSorted !== checkedSorted) {
      try {
        await API.recruitments.selectStaff(recruitmentId, checkedCsv);
        recruitment = await API.recruitments.get(recruitmentId);
        const idx = this.recruitments.findIndex(r => r.id === recruitmentId);
        if (idx >= 0) this.recruitments[idx] = recruitment;
      } catch (e) {
        showToast("エラー", `候補保存失敗: ${e.message}`, "error");
        return;
      }
    }

    // selectedStaffIds が空または未定義の場合は確定不可
    const ids = recruitment?.selectedStaffIds;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      showToast("エラー", "先にスタッフを1名以上選定してください", "error");
      return;
    }

    const ok = await this.confirmModal({
      title: "スタッフ確定",
      message: `${recruitment.selectedStaff} をスタッフとして確定しますか？`,
      confirmLabel: "確定する"
    });
    if (!ok) return;

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
    const ok = await this.confirmModal({
      title: "募集再開",
      message: "募集を再開しますか？現在の確定は解除されます。",
      confirmLabel: "再開する",
      danger: true
    });
    if (!ok) return;

    try {
      await API.recruitments.reopen(recruitmentId);
      showToast("完了", "募集を再開しました", "success");
      this.detailModal.hide();
      await this.loadData();
    } catch (e) {
      showToast("エラー", `再開失敗: ${e.message}`, "error");
    }
  },

  // Bootstrap confirm モーダル (native confirm の置き換え)
  confirmModal({ title, message, confirmLabel = "OK", danger = false }) {
    return new Promise(resolve => {
      const modalId = "rcConfirm_" + Date.now().toString(36);
      const btnClass = danger ? "btn-danger" : "btn-primary";
      document.body.insertAdjacentHTML("beforeend", `
        <div class="modal fade" id="${modalId}" tabindex="-1">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title">${this.escapeHtml(title)}</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
              </div>
              <div class="modal-body">${this.escapeHtml(message)}</div>
              <div class="modal-footer">
                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">キャンセル</button>
                <button type="button" class="btn ${btnClass}" id="${modalId}_ok">${this.escapeHtml(confirmLabel)}</button>
              </div>
            </div>
          </div>
        </div>
      `);
      const modalEl = document.getElementById(modalId);
      const modal = new bootstrap.Modal(modalEl);
      let confirmed = false;
      document.getElementById(`${modalId}_ok`).addEventListener("click", () => {
        confirmed = true; modal.hide();
      });
      modalEl.addEventListener("hidden.bs.modal", () => {
        modalEl.remove(); resolve(confirmed);
      });
      modal.show();
    });
  },

  async deleteRecruitment(id) {
    const recruitment = this.recruitments.find(r => r.id === id);
    const ok = await this.confirmModal({
      title: "募集の削除",
      message: `${recruitment?.checkoutDate || ""} の募集を削除しますか？`,
      confirmLabel: "削除", danger: true
    });
    if (!ok) return;

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
