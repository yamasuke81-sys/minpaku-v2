/**
 * 請求書作成ページ (スタッフ + Webアプリ管理者両用) — 2026-04-21 リファクタ版
 *   - 過去の請求書一覧 (my-invoice を統合)
 *   - 月指定 → 自動集計を縦テーブル (日付/項目/単価/備考) で表示
 *   - 追加明細: 日付/項目/金額/メモ の 4 列
 *   - 請求書記載情報 (銀行口座等) は折りたたみ式
 *   - 必須項目未入力時は自動展開 + 赤枠 + トースト + 送信キャンセル
 *
 * ルート: #/my-invoice-create
 */
const MyInvoiceCreatePage = {
  CF_BASE: "https://api-5qrfx7ujcq-an.a.run.app",
  staffId: null,
  staffDoc: null,
  isOwner: false,
  staffOptions: [],    // Webアプリ管理者用スタッフ一覧
  workItemOptions: [], // { key, label, amount } 報酬プルダウン用
  _summaryRows: [],    // 集計行キャッシュ (縦テーブル表示用)
  propertyId: null,    // 選択中の物件ID (物件別請求書)
  propertyMap: {},     // { id: {name, ...} } 物件マスタキャッシュ

  // 請求書記載情報の必須項目
  REQUIRED_STAFF_FIELDS: ["name", "address", "email", "bankName", "branchName", "accountNumber", "accountHolder"],

  async render(container) {
    this.isOwner = Auth.currentUser?.role === "owner";

    // 初期 staffId の決定
    this.staffId = Auth.currentUser?.staffId;
    if (this.isOwner && !this.staffId) {
      try {
        const snap = await db.collection("staff").where("authUid", "==", Auth.currentUser.uid).limit(1).get();
        if (!snap.empty) this.staffId = snap.docs[0].id;
      } catch (_) {}
    }
    // viewAsStaff (管理者のスタッフ視点閲覧) で上書き
    this._viewAsStaffId = (typeof App !== "undefined" && App.getViewAsStaffId) ? App.getViewAsStaffId() : null;
    if (this._viewAsStaffId) this.staffId = this._viewAsStaffId;

    const today = new Date();
    const defaultYM = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0");

    // スタッフ一覧 (Webアプリ管理者の場合セレクタを出す)
    let staffSelectorHtml = "";
    if (this.isOwner) {
      const snap = await db.collection("staff").orderBy("displayOrder", "asc").get();
      this.staffOptions = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.name);
      // impersonation 中: 物件オーナーが担当する物件の担当スタッフのみ表示
      if (typeof App !== "undefined" && App.impersonating && App.impersonatingData) {
        const ownedA = new Set(App.impersonatingData.ownedPropertyIds || []);
        this.staffOptions = this.staffOptions.filter(s => {
          const assigned = Array.isArray(s.assignedPropertyIds) ? s.assignedPropertyIds : [];
          return assigned.some(pid => ownedA.has(pid));
        });
        // 現在の staffId が候補外ならリセット
        if (this.staffId && !this.staffOptions.find(s => s.id === this.staffId)) {
          this.staffId = null;
        }
      }
      if (!this.staffId && this.staffOptions.length) this.staffId = this.staffOptions[0].id;
      const opts = this.staffOptions.map(s =>
        `<option value="${s.id}" ${s.id === this.staffId ? "selected" : ""}>${s.name}${s.active === false ? " (無効)" : ""}</option>`
      ).join("");
      staffSelectorHtml = `
        <select class="form-select form-select-sm" id="invStaffSel" style="width:200px;">
          ${opts}
        </select>`;
    }

    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-receipt"></i> 請求書${this.isOwner ? ' <small class="text-muted">(Webアプリ管理者テスト)</small>' : ''}</h2>
        <div class="d-flex align-items-center gap-2 flex-wrap">
          ${staffSelectorHtml}
          <input type="month" class="form-control form-control-sm" id="invMonth" value="${defaultYM}" style="width:160px;">
          <select id="invPropertySel" class="form-select form-select-sm" style="width:180px;">
            <option value="">物件を選択</option>
          </select>
          <button class="btn btn-sm btn-outline-primary" id="btnRecalc"><i class="bi bi-arrow-clockwise"></i> 再集計</button>
          <!-- プレビューボタン: PDF 同等の見た目を新タブ的モーダルで表示 -->
          <button class="btn btn-sm btn-outline-info" id="btnPreviewPdf" title="PDFプレビュー">
            <i class="bi bi-file-earmark-pdf"></i> プレビュー
          </button>
          <!-- 歯車アイコン: 請求書記載情報モーダルを開く -->
          <button class="btn btn-sm btn-outline-secondary" id="btnStaffInfoSettings" title="請求書記載情報" data-bs-toggle="tooltip">
            <i class="bi bi-gear"></i>
          </button>
        </div>
      </div>

      <!-- PDF プレビュー モーダル -->
      <div class="modal fade" id="pdfPreviewModal" tabindex="-1" aria-labelledby="pdfPreviewModalTitle">
        <div class="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header py-2">
              <h5 class="modal-title" id="pdfPreviewModalTitle"><i class="bi bi-file-earmark-pdf"></i> 請求書プレビュー</h5>
              <div class="ms-auto d-flex gap-2 me-2">
                <a class="btn btn-sm btn-outline-primary" id="btnPdfOpenNewTab" href="#" target="_blank" rel="noopener">
                  <i class="bi bi-box-arrow-up-right"></i> 新タブで開く
                </a>
                <a class="btn btn-sm btn-outline-success" id="btnPdfDownload" href="#" download>
                  <i class="bi bi-download"></i> ダウンロード
                </a>
              </div>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body p-0" style="min-height:80vh;">
              <iframe id="pdfPreviewIframe" src="about:blank" style="width:100%;height:80vh;border:0;"></iframe>
            </div>
          </div>
        </div>
      </div>

      <!-- 自動集計 (縦テーブル) -->
      <div class="card mb-3">
        <div class="card-body">
          <h6 class="mb-2"><i class="bi bi-list-ul"></i> 自動集計</h6>
          <div id="invSummary"><div class="text-muted small">読込中...</div></div>
        </div>
      </div>

      <!-- 追加明細 -->
      <div class="card mb-3">
        <div class="card-body">
          <h6 class="mb-2">追加明細</h6>
          <div class="table-responsive">
            <table class="table table-sm align-middle" style="min-width:720px;">
              <thead>
                <tr>
                  <th style="width:150px;">日付</th>
                  <th style="min-width:200px;">項目</th>
                  <th style="width:140px;">金額(円)</th>
                  <th style="min-width:180px;">メモ</th>
                  <th style="width:60px;"></th>
                </tr>
              </thead>
              <tbody id="manualRows"></tbody>
            </table>
          </div>
          <button class="btn btn-sm btn-outline-secondary" id="btnAddRow"><i class="bi bi-plus"></i> 行を追加</button>
        </div>
      </div>

      <!-- メモ (スタッフ→Webアプリ管理者) — 毎月内容を変えて OK、staff には保存しない -->
      <div class="card mb-3">
        <div class="card-body">
          <label class="form-label mb-1" for="invoiceMemoText">
            <i class="bi bi-chat-left-text"></i> メモ
          </label>
          <div class="small text-muted mb-2">請求書のメモ欄に表示されます。</div>
          <textarea id="invoiceMemoText" class="form-control form-control-sm" rows="3"></textarea>
        </div>
      </div>

      <!-- 合計 + 送信ボタン -->
      <div class="card mb-3 border-primary">
        <div class="card-body d-flex justify-content-between align-items-center">
          <div>
            <div class="small text-muted">合計金額</div>
            <div class="fs-3 fw-bold" id="invTotal">¥0</div>
          </div>
          <button class="btn btn-primary btn-lg" id="btnSubmitInvoice">
            <i class="bi bi-send"></i> Webアプリ管理者へ送信
          </button>
        </div>
      </div>
      <div id="invResult"></div>

      <!-- 過去の請求書 -->
      <div class="card mb-3">
        <div class="card-body">
          <h6 class="mb-2"><i class="bi bi-clock-history"></i> 過去の請求書</h6>
          <div id="pastInvoicesList" class="small">
            <div class="text-muted"><span class="spinner-border spinner-border-sm"></span> 読込中...</div>
          </div>
        </div>
      </div>

      <!-- 請求書記載情報モーダル (歯車アイコンで開く) -->
      <div class="modal fade" id="staffInfoModal" tabindex="-1" aria-labelledby="staffInfoModalLabel" aria-hidden="true">
        <div class="modal-dialog modal-lg modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="staffInfoModalLabel">
                <i class="bi bi-person-vcard"></i> 請求書記載情報
                <span id="staffInfoSaveStatus" class="small ms-2"></span>
              </h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="閉じる"></button>
            </div>
            <div class="modal-body">
              <div class="small text-muted mb-2">この情報は<strong>スタッフマスタと同期</strong>しています。編集すると自動でスタッフタブにも反映されます。</div>
              <div class="row g-2" id="staffInfoFields">
                <div class="col-md-6"><label class="form-label small mb-1">氏名 <span class="text-danger">*</span></label><input type="text" class="form-control form-control-sm s-field" data-field="name"></div>
                <div class="col-md-6"><label class="form-label small mb-1">電話</label><input type="tel" class="form-control form-control-sm s-field" data-field="phone"></div>
                <div class="col-md-12"><label class="form-label small mb-1">住所 <span class="text-danger">*</span></label><input type="text" class="form-control form-control-sm s-field" data-field="address"></div>
                <div class="col-md-6"><label class="form-label small mb-1">メールアドレス <span class="text-danger">*</span></label><input type="email" class="form-control form-control-sm s-field" data-field="email"></div>
                <div class="col-md-6"></div>
                <div class="col-md-6"><label class="form-label small mb-1">金融機関名 <span class="text-danger">*</span></label><input type="text" class="form-control form-control-sm s-field" data-field="bankName"></div>
                <div class="col-md-6"><label class="form-label small mb-1">支店名 <span class="text-danger">*</span></label><input type="text" class="form-control form-control-sm s-field" data-field="branchName"></div>
                <div class="col-md-4"><label class="form-label small mb-1">口座種類</label>
                  <select class="form-select form-select-sm s-field" data-field="accountType">
                    <option value="普通">普通</option><option value="当座">当座</option>
                  </select>
                </div>
                <div class="col-md-4"><label class="form-label small mb-1">口座番号 <span class="text-danger">*</span></label><input type="text" class="form-control form-control-sm s-field" data-field="accountNumber"></div>
                <div class="col-md-4"><label class="form-label small mb-1">口座名義 <span class="text-danger">*</span></label><input type="text" class="form-control form-control-sm s-field" data-field="accountHolder"></div>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">閉じる</button>
            </div>
          </div>
        </div>
      </div>
    `;

    if (this.isOwner) {
      // viewAsStaff 中はサイドバー側プルダウンが優先。本ページ内 select は無効化
      if (this._viewAsStaffId) {
        const sel = document.getElementById("invStaffSel");
        if (sel) { sel.disabled = true; sel.title = "サイドバーの『○○として閲覧』で切替中"; }
      }
      document.getElementById("invStaffSel").addEventListener("change", async (e) => {
        this.staffId = e.target.value;
        this.propertyId = null; // スタッフ切替で物件選択リセット
        await this.loadStaffDoc();
        await this.loadWorkItemOptions();
        await this.rebuildPropertySelect();
        await this.loadSummary();
        await this.loadPastInvoices();
      });
    }
    document.getElementById("btnAddRow").addEventListener("click", () => this.addManualRow());
    document.getElementById("btnRecalc").addEventListener("click", () => this.loadSummary());
    document.getElementById("invMonth").addEventListener("change", () => this.loadSummary());
    document.getElementById("invPropertySel").addEventListener("change", (e) => {
      this.propertyId = e.target.value || null;
      this.loadSummary();
    });
    document.getElementById("btnSubmitInvoice").addEventListener("click", () => this.submit());
    document.getElementById("btnPreviewPdf").addEventListener("click", () => this.previewPdf());

    // プレビューモーダルが閉じたら iframe の Blob URL を解放 + backdrop クリーンアップ
    document.getElementById("pdfPreviewModal").addEventListener("hidden.bs.modal", () => {
      if (this._previewBlobUrl) {
        URL.revokeObjectURL(this._previewBlobUrl);
        this._previewBlobUrl = null;
      }
      const ifr = document.getElementById("pdfPreviewIframe");
      if (ifr) ifr.src = "about:blank";
      // 念のため backdrop と body class を強制削除 (PDF ビューア起動で
      // ライフサイクルが切れて backdrop が残るバグへの保険)
      document.querySelectorAll(".modal-backdrop").forEach(el => el.remove());
      document.body.classList.remove("modal-open");
      document.body.style.overflow = "";
      document.body.style.paddingRight = "";
    });
    // タブ復帰時に backdrop が残っていたら強制掃除
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      const modalEl = document.getElementById("pdfPreviewModal");
      if (modalEl && !modalEl.classList.contains("show")) {
        document.querySelectorAll(".modal-backdrop").forEach(el => el.remove());
        document.body.classList.remove("modal-open");
        document.body.style.overflow = "";
        document.body.style.paddingRight = "";
      }
    });
    // 歯車アイコン: 請求書記載情報モーダルを開く
    document.getElementById("btnStaffInfoSettings").addEventListener("click", () => this.toggleStaffInfo(true));

    if (!this.staffId) {
      container.innerHTML = `<div class="alert alert-warning">スタッフ情報が確認できません</div>`;
      return;
    }

    await this.loadStaffDoc();
    await this.loadWorkItemOptions();
    await this.rebuildPropertySelect();
    await this.loadSummary();
    await this.loadPastInvoices();
  },

  // 物件プルダウンを担当物件のみで再構築
  // スタッフ: 自分の assignedPropertyIds、Webアプリ管理者: 選択中スタッフの assignedPropertyIds
  async rebuildPropertySelect() {
    const sel = document.getElementById("invPropertySel");
    if (!sel) return;
    // 物件マスタを 1 回だけ取得
    if (!Object.keys(this.propertyMap).length) {
      try {
        const snap = await db.collection("properties").where("active", "==", true).get();
        snap.docs.forEach(d => { this.propertyMap[d.id] = { id: d.id, ...d.data() }; });
      } catch (e) {
        console.warn("物件マスタ読込失敗:", e.message);
      }
    }
    const assigned = Array.isArray(this.staffDoc?.assignedPropertyIds) ? this.staffDoc.assignedPropertyIds : [];
    let targetIds = assigned.filter(id => this.propertyMap[id]);
    // impersonation 中: 物件オーナー所有物件のみに絞り込み
    if (typeof App !== "undefined" && App.impersonating && App.impersonatingData) {
      const ownedA = new Set(App.impersonatingData.ownedPropertyIds || []);
      targetIds = targetIds.filter(id => ownedA.has(id));
    }
    const opts = [`<option value="">物件を選択</option>`].concat(
      targetIds.map(id => {
        const p = this.propertyMap[id];
        const selected = this.propertyId === id ? " selected" : "";
        return `<option value="${this._esc(id)}"${selected}>${this._esc(p.name || id)}</option>`;
      })
    ).join("");
    sel.innerHTML = opts;
    // 選択中の propertyId が候補外なら null 化
    if (this.propertyId && !targetIds.includes(this.propertyId)) {
      this.propertyId = null;
    }
    // 担当物件が 1件なら自動選択
    if (!this.propertyId && targetIds.length === 1) {
      this.propertyId = targetIds[0];
      sel.value = this.propertyId;
    }
  },

  // モーダル開閉 (既存 API 互換: forceOpen=true→開く / false→閉じる / null→トグル)
  toggleStaffInfo(forceOpen = null) {
    const modalEl = document.getElementById("staffInfoModal");
    if (!modalEl) return;
    // Bootstrap Modal インスタンスを取得 or 生成
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    const isShown = modalEl.classList.contains("show");
    const shouldOpen = forceOpen === null ? !isShown : forceOpen;
    if (shouldOpen) modal.show();
    else modal.hide();
  },

  // 歯車アイコンの tooltip に記載情報の要約を反映 (未入力なら赤点)
  _updateStaffInfoSummary() {
    const btn = document.getElementById("btnStaffInfoSettings");
    if (!btn) return;
    const d = this.staffDoc || {};
    const acc = d.accountNumber ? String(d.accountNumber).slice(-4) : "";
    const parts = [];
    if (d.name) parts.push(d.name);
    if (d.bankName) parts.push(d.bankName);
    if (acc) parts.push(`末尾${acc}`);
    const summary = parts.length ? parts.join(" / ") : "未入力";
    btn.setAttribute("title", `請求書記載情報 (${summary})`);
    btn.setAttribute("data-bs-original-title", `請求書記載情報 (${summary})`);
  },

  async loadStaffDoc() {
    try {
      const d = await db.collection("staff").doc(this.staffId).get();
      this.staffDoc = d.exists ? { id: d.id, ...d.data() } : {};
    } catch (_) { this.staffDoc = {}; }
    this._renderStaffInfoFields();
    this._updateStaffInfoSummary();
  },

  // スタッフ情報パネルの値を流し込み + 自動保存をセット
  _renderStaffInfoFields() {
    const fields = ["name", "phone", "address", "email", "bankName", "branchName", "accountType", "accountNumber", "accountHolder"];
    fields.forEach(f => {
      const el = document.querySelector(`.s-field[data-field="${f}"]`);
      if (!el) return;
      let v = this.staffDoc[f];
      // 住所の互換: memo に入っているケース
      if (f === "address" && !v) v = this.staffDoc.memo || "";
      el.value = v || (f === "accountType" ? "普通" : "");
      // 入力時に赤枠を解除
      el.classList.remove("is-invalid");
      // 自動保存 (debounced)
      if (!el._saveBound) {
        el._saveBound = true;
        el.addEventListener("input", () => {
          el.classList.remove("is-invalid");
          this._queueStaffSave();
        });
        el.addEventListener("change", () => this._queueStaffSave());
      }
    });
  },

  _queueStaffSave() {
    if (this._staffSaveTimer) clearTimeout(this._staffSaveTimer);
    const status = document.getElementById("staffInfoSaveStatus");
    if (status) status.innerHTML = `<i class="bi bi-arrow-repeat text-muted"></i> 保存中...`;
    this._staffSaveTimer = setTimeout(() => this._saveStaffInfo(), 800);
  },

  async _saveStaffInfo() {
    if (!this.staffId) return;
    const patch = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    document.querySelectorAll(".s-field").forEach(el => {
      patch[el.dataset.field] = el.value || "";
    });
    const status = document.getElementById("staffInfoSaveStatus");
    try {
      await db.collection("staff").doc(this.staffId).set(patch, { merge: true });
      Object.assign(this.staffDoc, patch);
      this._updateStaffInfoSummary();
      if (status) {
        status.innerHTML = `<span class="text-success"><i class="bi bi-check-circle-fill"></i> 保存済み</span>`;
        setTimeout(() => { if (status.innerHTML.includes("保存済み")) status.innerHTML = ""; }, 2000);
      }
    } catch (e) {
      if (status) status.innerHTML = `<span class="text-danger">保存失敗: ${e.message}</span>`;
    }
  },

  // 報酬単価マスタから、このスタッフに適用されるレートを収集
  async loadWorkItemOptions() {
    this.workItemOptions = [];
    try {
      const propSnap = await db.collection("properties").get();
      const propMap = {};
      propSnap.docs.forEach(d => { propMap[d.id] = d.data().name || d.id; });

      const itemsSnap = await db.collection("propertyWorkItems").get();
      for (const doc of itemsSnap.docs) {
        const propertyId = doc.id;
        const propertyName = propMap[propertyId] || propertyId;
        const items = (doc.data().items || []).filter(i => i && i.name);
        for (const it of items) {
          const staffRate = it.staffRates && it.staffRates[this.staffId];
          const rate = (staffRate !== undefined && staffRate !== null && staffRate !== "") ? Number(staffRate) : Number(it.commonRate || 0);
          if (!rate) continue; // 0 or null は除外
          this.workItemOptions.push({
            key: `${propertyId}:${it.id || it.name}`,
            label: `${propertyName} / ${it.name}`,
            amount: rate,
          });
        }
      }
    } catch (e) {
      console.warn("報酬単価マスタ読込失敗:", e.message);
    }
  },

  addManualRow(data = { date: "", key: "", label: "", amount: "", memo: "" }) {
    const tbody = document.getElementById("manualRows");
    const tr = document.createElement("tr");
    // プルダウン (work item) + 「その他」
    const options = this.workItemOptions.map(o =>
      `<option value="${o.key}" data-amount="${o.amount}" data-label="${this._esc(o.label)}">${this._esc(o.label)} (¥${o.amount.toLocaleString()})</option>`
    ).join("");
    // デフォルト日付は今月の 1 日
    const ym = document.getElementById("invMonth")?.value || "";
    const defaultDate = data.date || (ym ? `${ym}-01` : "");
    tr.innerHTML = `
      <td><input type="date" class="form-control form-control-sm m-date" value="${this._esc(defaultDate)}"></td>
      <td>
        <select class="form-select form-select-sm m-preset">
          <option value="">-- 選択 --</option>
          ${options}
          <option value="__custom__">その他 (手入力)</option>
        </select>
        <input type="text" class="form-control form-control-sm m-label mt-1 d-none" placeholder="項目名を入力">
      </td>
      <td><input type="number" class="form-control form-control-sm m-amount" min="0" value=""></td>
      <td><input type="text" class="form-control form-control-sm m-memo" placeholder="メモ"></td>
      <td class="text-end"><button class="btn btn-sm btn-outline-danger m-del"><i class="bi bi-x"></i></button></td>
    `;
    tbody.appendChild(tr);

    const presetSel = tr.querySelector(".m-preset");
    const labelInput = tr.querySelector(".m-label");
    const amountInput = tr.querySelector(".m-amount");
    const memoInput = tr.querySelector(".m-memo");
    const dateInput = tr.querySelector(".m-date");

    presetSel.addEventListener("change", () => {
      const v = presetSel.value;
      if (v === "__custom__") {
        labelInput.classList.remove("d-none");
        labelInput.focus();
        amountInput.value = "";
      } else if (v) {
        const opt = presetSel.options[presetSel.selectedIndex];
        labelInput.classList.add("d-none");
        labelInput.value = opt.dataset.label || "";
        amountInput.value = opt.dataset.amount || "";
      } else {
        labelInput.classList.add("d-none");
        labelInput.value = "";
        amountInput.value = "";
      }
      this.updateTotal();
    });
    tr.querySelector(".m-del").addEventListener("click", () => { tr.remove(); this.updateTotal(); });
    [labelInput, amountInput, memoInput, dateInput].forEach(i => i.addEventListener("input", () => this.updateTotal()));
  },

  async loadSummary() {
    const ym = document.getElementById("invMonth").value;
    if (!ym) return;

    const sumEl = document.getElementById("invSummary");

    // 物件未選択時はガイド表示 + 再集計ボタン無効化
    const recalcBtn = document.getElementById("btnRecalc");
    if (!this.propertyId) {
      sumEl.innerHTML = `<div class="alert alert-info mb-0 small"><i class="bi bi-info-circle"></i> 物件を選択してください</div>`;
      if (recalcBtn) recalcBtn.disabled = true;
      // 合計もリセット
      this._previewShiftAmount = 0;
      this._previewLaundryAmount = 0;
      this._previewSpecialAmount = 0;
      this._previewTransportFee = 0;
      this._previewPrepaidExpense = 0;
      this._previewShiftCount = 0;
      this._summaryRows = [];
      this.updateTotal();
      return;
    }
    if (recalcBtn) recalcBtn.disabled = false;

    sumEl.innerHTML = `<div class="text-muted small"><span class="spinner-border spinner-border-sm"></span> 集計中...</div>`;

    try {
      const token = await firebase.auth().currentUser.getIdToken();
      const body = { yearMonth: ym, propertyId: this.propertyId };
      if (this.isOwner && this.staffId) body.staffId = this.staffId;

      const res = await fetch(`${this.CF_BASE}/invoices/compute-preview`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const preview = await res.json();

      // キャッシュ更新
      this._previewShiftAmount = preview.shiftAmount || 0;
      this._previewLaundryAmount = preview.laundryAmount || 0;
      this._previewSpecialAmount = preview.specialAmount || 0;
      this._previewTransportFee = preview.transportationFee || 0;
      this._previewPrepaidExpense = preview.prepaidExpense || 0;
      this._previewShiftCount = preview.shiftCount || 0;
      this._summaryRows = preview.rows || [];

      // 縦テーブル描画
      this._renderSummaryTable(sumEl, preview);
    } catch (e) {
      sumEl.innerHTML = `<div class="alert alert-danger mb-0"><i class="bi bi-exclamation-triangle"></i> 集計に失敗しました: ${(e && e.message) || e}</div>`;
      console.error("loadSummary エラー:", e);
      this._previewShiftAmount = 0;
      this._previewLaundryAmount = 0;
      this._previewSpecialAmount = 0;
      this._previewTransportFee = 0;
      this._previewPrepaidExpense = 0;
      this._previewShiftCount = 0;
      this._summaryRows = [];
      return;
    }
    this.updateTotal();
  },

  // 縦 5 列テーブル (日付 | 項目 | 単価 | 備考 | 操作) を描画
  _renderSummaryTable(el, preview) {
    const rows = preview.rows || [];
    const excludedRows = preview.excludedRows || [];
    if (!rows.length && !excludedRows.length) {
      el.innerHTML = `<div class="text-muted small">対象月の実績はありません</div>`;
      return;
    }
    const total = (preview.shiftAmount || 0) + (preview.laundryAmount || 0)
      + (preview.specialAmount || 0) + (preview.transportationFee || 0)
      + (preview.prepaidExpense || 0);
    const body = rows.map(r => {
      // プリカ購入行は控えめに黄色背景+カードアイコン
      const isPrepaid = r.category === "プリカ購入";
      const trCls = isPrepaid ? ' style="background:#fffbea;"' : "";
      const catHtml = isPrepaid
        ? `<i class="bi bi-credit-card-2-front text-warning"></i> ${this._esc(r.category || "")}`
        : this._esc(r.category || "");
      // 除外ボタン (type/refId があるもののみ)
      const hasRef = r.type && r.refId;
      const excludeBtn = hasRef
        ? `<button class="btn btn-sm btn-outline-danger btn-exclude" data-type="${this._esc(r.type)}" data-ref-id="${this._esc(r.refId)}" title="請求書から除外"><i class="bi bi-dash-circle"></i> 除外</button>`
        : "";
      return `
      <tr${trCls}>
        <td class="small" style="white-space:nowrap;">${this._esc(r.date || "")}</td>
        <td class="small" style="white-space:nowrap;">${catHtml}</td>
        <td class="text-end small" style="white-space:nowrap;">¥${Number(r.unitPrice || 0).toLocaleString()}</td>
        <td class="text-muted small" style="white-space:nowrap;">${this._esc(r.note || "")}</td>
        <td class="text-end" style="white-space:nowrap;">${excludeBtn}</td>
      </tr>
    `;
    }).join("");

    // 除外済み行 (折りたたみ)
    let excludedHtml = "";
    if (excludedRows.length) {
      const exBody = excludedRows.map(r => {
        const by = r.excludedBy?.staffName || "";
        return `
          <tr class="text-muted">
            <td class="small"><s>${this._esc(r.date || "")}</s></td>
            <td class="small"><s>${this._esc(r.category || "")}</s></td>
            <td class="text-end small"><s>¥${Number(r.unitPrice || 0).toLocaleString()}</s></td>
            <td class="small"><s>${this._esc(r.note || "")}</s>${by ? ` <span class="badge bg-light text-muted">除外: ${this._esc(by)}</span>` : ""}</td>
            <td class="text-end">
              <button class="btn btn-sm btn-outline-secondary btn-unexclude" data-type="${this._esc(r.type || "")}" data-ref-id="${this._esc(r.refId || "")}"><i class="bi bi-arrow-counterclockwise"></i> 除外解除</button>
            </td>
          </tr>
        `;
      }).join("");
      excludedHtml = `
        <details class="mt-2">
          <summary class="text-muted small" style="cursor:pointer;">除外済み ${excludedRows.length}件 ▸</summary>
          <div class="table-responsive mt-2">
            <table class="table table-sm table-borderless align-middle mb-0" style="min-width:640px;">
              <tbody>${exBody}</tbody>
            </table>
          </div>
        </details>
      `;
    }

    el.innerHTML = `
      <div class="table-responsive">
        <table class="table table-sm table-hover align-middle mb-0" style="min-width:640px;">
          <thead class="table-light">
            <tr>
              <th style="width:110px; white-space:nowrap;">日付</th>
              <th style="min-width:120px; white-space:nowrap;">項目</th>
              <th class="text-end" style="width:110px; white-space:nowrap;">単価</th>
              <th style="min-width:140px;">備考</th>
              <th style="width:100px; white-space:nowrap;"></th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot>
            <tr class="fw-bold table-light">
              <td colspan="2">自動集計 合計</td>
              <td class="text-end">¥${total.toLocaleString()}</td>
              <td colspan="2"></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="text-muted small mt-1">※ 階段制単価・workType別・タイミー時給・特別加算を含む正確な計算です</div>
      ${excludedHtml}
    `;

    // 除外ボタン handler
    el.querySelectorAll(".btn-exclude").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const t = e.currentTarget;
        this._handleExclude(t.dataset.type, t.dataset.refId);
      });
    });
    // 除外解除ボタン handler
    el.querySelectorAll(".btn-unexclude").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const t = e.currentTarget;
        this._handleUnexclude(t.dataset.type, t.dataset.refId);
      });
    });
  },

  // 項目を請求書から除外
  async _handleExclude(type, refId) {
    if (!type || !refId) return;
    if (!this.propertyId) { await showAlert("物件を選択してください"); return; }
    const ok = await showConfirm("この項目を請求書から除外しますか?\n(情報自体は削除されません)", { title: "除外" });
    if (!ok) return;
    try {
      const ym = document.getElementById("invMonth").value;
      if (!ym) return;
      const docId = `${ym}_${this.staffId}_${this.propertyId}`;
      const ref = db.collection("invoiceExclusions").doc(docId);
      const entry = {
        type,
        refId,
        excludedAt: new Date(),
        excludedBy: {
          staffId: this.staffId || "",
          staffName: this.staffDoc?.name || Auth.currentUser?.displayName || "",
        },
      };
      // ドキュメントが無い場合に備え set(merge) + arrayUnion
      await ref.set({
        staffId: this.staffId,
        yearMonth: ym,
        propertyId: this.propertyId,
        exclusions: firebase.firestore.FieldValue.arrayUnion(entry),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      if (typeof showToast === "function") showToast("除外しました", "再集計します", "success");
      await this.loadSummary();
    } catch (e) {
      console.error("除外エラー:", e);
      await showAlert("除外に失敗しました: " + (e.message || e));
    }
  },

  // 除外を解除
  async _handleUnexclude(type, refId) {
    if (!type || !refId) return;
    if (!this.propertyId) { await showAlert("物件を選択してください"); return; }
    try {
      const ym = document.getElementById("invMonth").value;
      if (!ym) return;
      const docId = `${ym}_${this.staffId}_${this.propertyId}`;
      const ref = db.collection("invoiceExclusions").doc(docId);
      // arrayRemove は完全一致が必要なので、現状を読んで type/refId 一致分を削除
      const snap = await ref.get();
      if (!snap.exists) { await this.loadSummary(); return; }
      const cur = Array.isArray(snap.data().exclusions) ? snap.data().exclusions : [];
      const removed = cur.filter(x => !(x && x.type === type && x.refId === refId));
      await ref.set({
        staffId: this.staffId,
        yearMonth: ym,
        propertyId: this.propertyId,
        exclusions: removed,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      if (typeof showToast === "function") showToast("除外を解除しました", "再集計します", "success");
      await this.loadSummary();
    } catch (e) {
      console.error("除外解除エラー:", e);
      await showAlert("除外解除に失敗しました: " + (e.message || e));
    }
  },

  updateTotal() {
    const apiBase = (this._previewShiftAmount || 0)
      + (this._previewLaundryAmount || 0)
      + (this._previewSpecialAmount || 0)
      + (this._previewTransportFee || 0)
      + (this._previewPrepaidExpense || 0);
    const manualTotal = [...document.querySelectorAll("#manualRows .m-amount")]
      .reduce((s, i) => s + (Number(i.value) || 0), 0);
    const total = apiBase + manualTotal;
    document.getElementById("invTotal").textContent = "¥" + total.toLocaleString();
  },

  // 必須項目チェック。未入力があれば true を返し、該当欄を赤枠にする
  _validateStaffInfo() {
    const missing = [];
    const d = this.staffDoc || {};
    // フィールド対応 (住所は memo フォールバック)
    for (const f of this.REQUIRED_STAFF_FIELDS) {
      let v = d[f];
      if (f === "address" && !v) v = d.memo || "";
      if (!v || String(v).trim() === "") {
        missing.push(f);
        const el = document.querySelector(`.s-field[data-field="${f}"]`);
        if (el) el.classList.add("is-invalid");
      }
    }
    return missing;
  },

  async submit() {
    const ym = document.getElementById("invMonth").value;

    // 物件選択チェック
    if (!this.propertyId) {
      if (typeof showToast === "function") {
        showToast("物件が未選択です", "請求書を作成する物件を選んでください", "error");
      } else {
        await showAlert("物件を選択してください");
      }
      return;
    }

    // 必須項目チェック
    const missing = this._validateStaffInfo();
    if (missing.length) {
      this.toggleStaffInfo(true);  // 折りたたみ展開
      if (typeof showToast === "function") {
        showToast("記入が必要な項目があります", `未入力: ${missing.join(", ")}`, "error");
      } else {
        await showAlert(`記入が必要な項目があります: ${missing.join(", ")}`);
      }
      return;
    }

    // 行から date/label/amount/memo を収集
    const manualItems = [...document.querySelectorAll("#manualRows tr")].map(tr => {
      const preset = tr.querySelector(".m-preset");
      const v = preset.value;
      let label = "";
      if (v === "__custom__") {
        label = tr.querySelector(".m-label")?.value.trim() || "";
      } else if (v) {
        const opt = preset.options[preset.selectedIndex];
        label = opt?.dataset?.label || opt?.text || "";
      }
      return {
        date: tr.querySelector(".m-date")?.value || "",
        label,
        amount: Number(tr.querySelector(".m-amount")?.value) || 0,
        memo: tr.querySelector(".m-memo")?.value || "",
      };
    }).filter(i => i.label || i.amount);

    const ok = await showConfirm(`${ym} の請求書をWebアプリ管理者へ送信します。よろしいですか？`, { title: "送信確認" });
    if (!ok) return;

    const btn = document.getElementById("btnSubmitInvoice");
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 送信中...';
    try {
      const token = await firebase.auth().currentUser.getIdToken();
      // Webアプリ管理者へのメッセージ (請求書メモ) — 毎月可変
      const invoiceMemo = document.getElementById("invoiceMemoText")?.value || "";
      const body = { yearMonth: ym, propertyId: this.propertyId, manualItems, invoiceMemo };
      if (this.isOwner && this.staffId) body.asStaffId = this.staffId;
      const res = await fetch(`${this.CF_BASE}/invoices/my-submit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "送信失敗");
      document.getElementById("invResult").innerHTML = `
        <div class="alert alert-success">
          <i class="bi bi-check-circle"></i> 請求書 <strong>${data.id}</strong> を送信しました（合計 ¥${(data.total||0).toLocaleString()}）
        </div>
      `;
      showToast("送信完了", "Webアプリ管理者へ請求書を送信しました", "success");
      // 送信成功後は折りたたみを閉じる
      this.toggleStaffInfo(false);
      // 過去一覧をリフレッシュ
      await this.loadPastInvoices();
    } catch (e) {
      showToast("エラー", e.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  },

  // PDFプレビュー: /my-preview-pdf を POST で呼んで PDF Blob を取得、
  // モーダル内の iframe に表示する (Storage には保存しない)
  async previewPdf() {
    const ym = document.getElementById("invMonth").value;
    if (!ym) { showToast("エラー", "対象年月を指定してください", "error"); return; }
    if (!this.propertyId) { showToast("エラー", "物件を選択してください", "warning"); return; }

    // manual 行の収集 (submit() と同じロジック)
    const manualItems = [...document.querySelectorAll("#manualRows tr")].map(tr => {
      const preset = tr.querySelector(".m-preset");
      const v = preset?.value || "";
      let label = "";
      if (v === "__custom__") {
        label = tr.querySelector(".m-label")?.value.trim() || "";
      } else if (v) {
        const opt = preset.options[preset.selectedIndex];
        label = opt?.dataset?.label || opt?.text || "";
      }
      return {
        date: tr.querySelector(".m-date")?.value || "",
        label,
        amount: Number(tr.querySelector(".m-amount")?.value) || 0,
        memo: tr.querySelector(".m-memo")?.value || "",
      };
    }).filter(i => i.label || i.amount);

    const btn = document.getElementById("btnPreviewPdf");
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 生成中...';

    try {
      const token = await firebase.auth().currentUser.getIdToken();
      // Webアプリ管理者へのメッセージ (請求書メモ)
      const invoiceMemo = document.getElementById("invoiceMemoText")?.value || "";
      const body = { yearMonth: ym, propertyId: this.propertyId, manualItems, invoiceMemo };
      if (this.isOwner && this.staffId) body.asStaffId = this.staffId;
      const res = await fetch(`${this.CF_BASE}/invoices/my-preview-pdf`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      // 直前に貼ってあった Blob URL があれば解放
      if (this._previewBlobUrl) URL.revokeObjectURL(this._previewBlobUrl);
      this._previewBlobUrl = URL.createObjectURL(blob);
      // モバイル判定: iframe で PDF 表示できないため新タブで直接開く
      const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
      if (isMobile) {
        // 新タブで PDF を開く (モーダル経由しない → backdrop 残り問題も回避)
        const a = document.createElement("a");
        a.href = this._previewBlobUrl;
        a.target = "_blank";
        a.rel = "noopener";
        a.download = `invoice_preview_${ym}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return;
      }
      const ifr = document.getElementById("pdfPreviewIframe");
      ifr.src = this._previewBlobUrl;
      document.getElementById("btnPdfOpenNewTab").href = this._previewBlobUrl;
      const dlBtn = document.getElementById("btnPdfDownload");
      dlBtn.href = this._previewBlobUrl;
      dlBtn.setAttribute("download", `invoice_preview_${ym}.pdf`);
      bootstrap.Modal.getOrCreateInstance(document.getElementById("pdfPreviewModal")).show();
    } catch (e) {
      showToast("プレビュー失敗", e.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  },

  // ================ 過去の請求書一覧 (my-invoice から統合) ================
  async loadPastInvoices() {
    const listEl = document.getElementById("pastInvoicesList");
    if (!listEl) return;
    try {
      const token = await firebase.auth().currentUser.getIdToken();
      const res = await fetch(`${this.CF_BASE}/invoices`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      let invoices = await res.json();
      // Webアプリ管理者モードで staffId 絞り込み
      if (this.isOwner && this.staffId) {
        invoices = invoices.filter(inv => inv.staffId === this.staffId);
      }
      // impersonation 中: 物件オーナー所有物件が対象の請求書のみ
      if (typeof App !== "undefined" && App.impersonating && App.impersonatingData) {
        const ownedA = new Set(App.impersonatingData.ownedPropertyIds || []);
        invoices = invoices.filter(inv => {
          if (inv.propertyId && ownedA.has(inv.propertyId)) return true;
          const byProp = Array.isArray(inv.byProperty) ? inv.byProperty : [];
          if (byProp.some(bp => bp && ownedA.has(bp.propertyId))) return true;
          const shifts = Array.isArray(inv.details?.shifts) ? inv.details.shifts : [];
          if (shifts.some(s => s && ownedA.has(s.propertyId))) return true;
          return false;
        });
      }
      if (!invoices.length) {
        listEl.innerHTML = `<div class="text-muted small">過去の請求書はまだありません。</div>`;
        return;
      }
      // yearMonth 降順 → 同月内は propertyName 昇順で並べる (同月複数物件があれば並ぶ)
      invoices.sort((a, b) => {
        const ym = (b.yearMonth || "").localeCompare(a.yearMonth || "");
        if (ym !== 0) return ym;
        const an = a.propertyName || this.propertyMap[a.propertyId]?.name || "";
        const bn = b.propertyName || this.propertyMap[b.propertyId]?.name || "";
        return an.localeCompare(bn);
      });
      listEl.innerHTML = invoices.map(inv => this._renderPastRow(inv)).join("");
      // 明細トグル
      listEl.querySelectorAll(".past-toggle-detail").forEach(btn => {
        btn.addEventListener("click", () => {
          const detailEl = document.getElementById(btn.dataset.target);
          if (!detailEl) return;
          const isOpen = !detailEl.classList.contains("d-none");
          detailEl.classList.toggle("d-none", isOpen);
          const ch = btn.querySelector(".past-chevron");
          if (ch) ch.style.transform = isOpen ? "" : "rotate(180deg)";
        });
      });
    } catch (e) {
      listEl.innerHTML = `<div class="alert alert-danger mb-0 small"><i class="bi bi-exclamation-triangle"></i> 読み込みエラー: ${this._esc(e.message)}</div>`;
    }
  },

  _renderPastRow(inv) {
    const statusMap = {
      draft: { label: "下書き", cls: "bg-secondary" },
      submitted: { label: "送信済み", cls: "bg-primary" },
      confirmed: { label: "確認済み", cls: "bg-info text-dark" },
      paid: { label: "支払済み", cls: "bg-success" },
    };
    const st = statusMap[inv.status] || { label: inv.status || "不明", cls: "bg-secondary" };
    const detailId = `pastDetail_${inv.id}`;
    const pdfBtn = inv.pdfUrl
      ? `<a href="${this._esc(inv.pdfUrl)}" target="_blank" class="btn btn-sm btn-outline-secondary"><i class="bi bi-file-earmark-pdf"></i> PDF</a>`
      : "";

    // 明細テーブル
    const shiftRows = (inv.details?.shifts || inv.shifts || []).map(s => {
      const typeLabel = {
        cleaning_by_count: "清掃", pre_inspection: "直前点検", other: "その他",
        laundry_put_out: "ランドリー出し", laundry_collected: "ランドリー受取", laundry_expense: "ランドリー立替",
      }[s.workType] || s.workItemName || "清掃";
      const d = s.date && s.date.toDate ? s.date.toDate() : (s.date ? new Date(s.date) : null);
      const dStr = d ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}` : "";
      return `<tr><td>${this._esc(dStr)}</td><td>${this._esc(typeLabel)}</td><td class="text-end">¥${(s.amount||0).toLocaleString()}</td><td class="small text-muted">${this._esc(s.propertyName||"")}</td></tr>`;
    }).join("");
    const manualRows = (inv.details?.manualItems || inv.manualItems || []).map(m => `
      <tr><td>${this._esc(m.date||"")}</td><td>${this._esc(m.label||"")}</td><td class="text-end">¥${(m.amount||0).toLocaleString()}</td><td class="small text-muted">${this._esc(m.memo||"")}</td></tr>
    `).join("");
    const hasDetail = shiftRows || manualRows;

    // 物件名 (propertyName 優先、なければ propertyId から解決)
    let propLabel = inv.propertyName || "";
    if (!propLabel && inv.propertyId && this.propertyMap[inv.propertyId]) {
      propLabel = this.propertyMap[inv.propertyId].name || "";
    }
    const propBadge = propLabel
      ? `<span class="badge bg-light text-dark border ms-2"><i class="bi bi-house-door"></i> ${this._esc(propLabel)}</span>`
      : "";

    return `
      <div class="border rounded p-2 mb-2">
        <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
          <div>
            <strong>${this._esc(inv.yearMonth || "")}</strong>
            <span class="badge ${st.cls} ms-2">${st.label}</span>
            ${propBadge}
          </div>
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <span class="fw-bold">¥${(inv.total||0).toLocaleString()}</span>
            ${pdfBtn}
            ${hasDetail ? `<button class="btn btn-sm btn-outline-secondary past-toggle-detail" data-target="${detailId}"><i class="bi bi-chevron-down past-chevron" style="transition:transform 0.2s;"></i> 明細</button>` : ""}
          </div>
        </div>
        ${hasDetail ? `
        <div id="${detailId}" class="d-none mt-2">
          <table class="table table-sm mb-0">
            <thead class="table-light">
              <tr><th>日付</th><th>項目</th><th class="text-end">金額</th><th>備考</th></tr>
            </thead>
            <tbody>${shiftRows}${manualRows}</tbody>
          </table>
        </div>` : ""}
      </div>
    `;
  },

  _esc(s) { const d = document.createElement("div"); d.textContent = String(s || ""); return d.innerHTML; },
};
