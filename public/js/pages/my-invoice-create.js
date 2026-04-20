/**
 * 請求書作成ページ (スタッフ + オーナー両用) — 2026-04-21 リファクタ版
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
  staffOptions: [],    // オーナー用スタッフ一覧
  workItemOptions: [], // { key, label, amount } 報酬プルダウン用
  _summaryRows: [],    // 集計行キャッシュ (縦テーブル表示用)

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

    const today = new Date();
    const defaultYM = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0");

    // スタッフ一覧 (オーナーの場合セレクタを出す)
    let staffSelectorHtml = "";
    if (this.isOwner) {
      const snap = await db.collection("staff").orderBy("displayOrder", "asc").get();
      this.staffOptions = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.name);
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
        <h2><i class="bi bi-receipt"></i> 請求書${this.isOwner ? ' <small class="text-muted">(オーナーテスト)</small>' : ''}</h2>
        <div class="d-flex align-items-center gap-2 flex-wrap">
          ${staffSelectorHtml}
          <input type="month" class="form-control form-control-sm" id="invMonth" value="${defaultYM}" style="width:160px;">
          <button class="btn btn-sm btn-outline-primary" id="btnRecalc"><i class="bi bi-arrow-clockwise"></i> 再集計</button>
        </div>
      </div>

      <!-- 過去の請求書 -->
      <div class="card mb-3">
        <div class="card-body">
          <h6 class="mb-2"><i class="bi bi-clock-history"></i> 過去の請求書</h6>
          <div id="pastInvoicesList" class="small">
            <div class="text-muted"><span class="spinner-border spinner-border-sm"></span> 読込中...</div>
          </div>
        </div>
      </div>

      <!-- 請求書記載情報 (折りたたみ) -->
      <div class="card mb-3">
        <div class="card-body p-0">
          <button class="btn btn-link text-decoration-none w-100 d-flex justify-content-between align-items-center p-3" type="button" id="btnToggleStaffInfo" style="color:inherit;">
            <span class="text-start">
              <i class="bi bi-person-vcard"></i> <strong>請求書記載情報</strong>
              <span id="staffInfoSummary" class="ms-2 small text-muted"></span>
            </span>
            <span>
              <span id="staffInfoSaveStatus" class="small me-2"></span>
              <i class="bi bi-chevron-down" id="staffInfoChevron" style="transition:transform 0.2s;"></i>
            </span>
          </button>
          <div id="staffInfoBody" class="p-3 pt-0 d-none">
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
          <table class="table table-sm align-middle">
            <thead>
              <tr>
                <th style="width:150px;">日付</th>
                <th style="min-width:220px;">項目</th>
                <th style="width:140px;">金額(円)</th>
                <th>メモ</th>
                <th style="width:60px;"></th>
              </tr>
            </thead>
            <tbody id="manualRows"></tbody>
          </table>
          <button class="btn btn-sm btn-outline-secondary" id="btnAddRow"><i class="bi bi-plus"></i> 行を追加</button>
        </div>
      </div>

      <div class="card mb-3 border-primary">
        <div class="card-body d-flex justify-content-between align-items-center">
          <div>
            <div class="small text-muted">合計金額</div>
            <div class="fs-3 fw-bold" id="invTotal">¥0</div>
          </div>
          <button class="btn btn-primary btn-lg" id="btnSubmitInvoice">
            <i class="bi bi-send"></i> オーナーへ送信
          </button>
        </div>
      </div>
      <div id="invResult"></div>
    `;

    if (this.isOwner) {
      document.getElementById("invStaffSel").addEventListener("change", async (e) => {
        this.staffId = e.target.value;
        await this.loadStaffDoc();
        await this.loadWorkItemOptions();
        await this.loadSummary();
        await this.loadPastInvoices();
      });
    }
    document.getElementById("btnAddRow").addEventListener("click", () => this.addManualRow());
    document.getElementById("btnRecalc").addEventListener("click", () => this.loadSummary());
    document.getElementById("invMonth").addEventListener("change", () => this.loadSummary());
    document.getElementById("btnSubmitInvoice").addEventListener("click", () => this.submit());
    document.getElementById("btnToggleStaffInfo").addEventListener("click", () => this.toggleStaffInfo());

    if (!this.staffId) {
      container.innerHTML = `<div class="alert alert-warning">スタッフ情報が確認できません</div>`;
      return;
    }

    await this.loadStaffDoc();
    await this.loadWorkItemOptions();
    await this.loadSummary();
    await this.loadPastInvoices();
  },

  // 折りたたみトグル
  toggleStaffInfo(forceOpen = null) {
    const body = document.getElementById("staffInfoBody");
    const chev = document.getElementById("staffInfoChevron");
    if (!body || !chev) return;
    const shouldOpen = forceOpen === null ? body.classList.contains("d-none") : forceOpen;
    body.classList.toggle("d-none", !shouldOpen);
    chev.style.transform = shouldOpen ? "rotate(180deg)" : "";
  },

  // サマリラベル更新 (折りたたみ時のヘッダ要約)
  _updateStaffInfoSummary() {
    const sEl = document.getElementById("staffInfoSummary");
    if (!sEl) return;
    const d = this.staffDoc || {};
    const acc = d.accountNumber ? String(d.accountNumber).slice(-4) : "";
    const parts = [];
    if (d.name) parts.push(d.name);
    if (d.bankName) parts.push(d.bankName);
    if (acc) parts.push(`末尾${acc}`);
    sEl.textContent = parts.length ? `(${parts.join(" / ")})` : "(未入力)";
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
    sumEl.innerHTML = `<div class="text-muted small"><span class="spinner-border spinner-border-sm"></span> 集計中...</div>`;

    try {
      const token = await firebase.auth().currentUser.getIdToken();
      const body = { yearMonth: ym };
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
      this._previewShiftCount = 0;
      this._summaryRows = [];
      return;
    }
    this.updateTotal();
  },

  // 縦 4 列テーブル (日付 | 項目 | 単価 | 備考) を描画
  _renderSummaryTable(el, preview) {
    const rows = preview.rows || [];
    if (!rows.length) {
      el.innerHTML = `<div class="text-muted small">対象月の実績はありません</div>`;
      return;
    }
    const total = (preview.shiftAmount || 0) + (preview.laundryAmount || 0)
      + (preview.specialAmount || 0) + (preview.transportationFee || 0);
    const body = rows.map(r => `
      <tr>
        <td class="small">${this._esc(r.date || "")}</td>
        <td class="small">${this._esc(r.category || "")}</td>
        <td class="text-end small">¥${Number(r.unitPrice || 0).toLocaleString()}</td>
        <td class="text-muted small">${this._esc(r.note || "")}</td>
      </tr>
    `).join("");
    el.innerHTML = `
      <div class="table-responsive">
        <table class="table table-sm table-hover align-middle mb-0">
          <thead class="table-light">
            <tr>
              <th style="width:110px;">日付</th>
              <th>項目</th>
              <th class="text-end" style="width:110px;">単価</th>
              <th>備考</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot>
            <tr class="fw-bold table-light">
              <td colspan="2">自動集計 合計</td>
              <td class="text-end">¥${total.toLocaleString()}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="text-muted small mt-1">※ 階段制単価・workType別・タイミー時給・特別加算を含む正確な計算です</div>
    `;
  },

  updateTotal() {
    const apiBase = (this._previewShiftAmount || 0)
      + (this._previewLaundryAmount || 0)
      + (this._previewSpecialAmount || 0)
      + (this._previewTransportFee || 0);
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

    const ok = await showConfirm(`${ym} の請求書をオーナーへ送信します。よろしいですか？`, { title: "送信確認" });
    if (!ok) return;

    const btn = document.getElementById("btnSubmitInvoice");
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 送信中...';
    try {
      const token = await firebase.auth().currentUser.getIdToken();
      const body = { yearMonth: ym, manualItems };
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
      showToast("送信完了", "オーナーへ請求書を送信しました", "success");
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
      // オーナーモードで staffId 絞り込み
      if (this.isOwner && this.staffId) {
        invoices = invoices.filter(inv => inv.staffId === this.staffId);
      }
      if (!invoices.length) {
        listEl.innerHTML = `<div class="text-muted small">過去の請求書はまだありません。</div>`;
        return;
      }
      invoices.sort((a, b) => (b.yearMonth || "").localeCompare(a.yearMonth || ""));
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

    return `
      <div class="border rounded p-2 mb-2">
        <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
          <div>
            <strong>${this._esc(inv.yearMonth || "")}</strong>
            <span class="badge ${st.cls} ms-2">${st.label}</span>
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
