/**
 * 請求書作成ページ (スタッフ + オーナー両用)
 *   - 月指定 → 自分 (オーナーの場合は選択スタッフ) のシフト+ランドリー実績を自動集計
 *   - 追加明細: 報酬単価マスタから項目プルダウン選択 (そのスタッフに適用される料金)
 *     or 「その他」で手入力 (項目名/金額/メモ)
 *   - 各行にメモ欄あり
 *   - 送信で POST /invoices/my-submit → invoice_submitted 通知
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
        <h2><i class="bi bi-receipt"></i> 請求書作成${this.isOwner ? ' <small class="text-muted">(オーナーテスト)</small>' : ''}</h2>
        <div class="d-flex align-items-center gap-2 flex-wrap">
          ${staffSelectorHtml}
          <input type="month" class="form-control form-control-sm" id="invMonth" value="${defaultYM}" style="width:160px;">
          <button class="btn btn-sm btn-outline-primary" id="btnRecalc"><i class="bi bi-arrow-clockwise"></i> 再集計</button>
        </div>
      </div>
      <!-- スタッフ情報 (請求書必須項目) -->
      <div class="card mb-3">
        <div class="card-body">
          <h6 class="mb-2 d-flex justify-content-between align-items-center">
            <span><i class="bi bi-person-vcard"></i> 請求書記載情報</span>
            <span id="staffInfoSaveStatus" class="small"></span>
          </h6>
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

      <div class="card mb-3">
        <div class="card-body">
          <h6 class="mb-2">自動集計</h6>
          <div id="invSummary" class="small">読込中...</div>
        </div>
      </div>
      <div class="card mb-3">
        <div class="card-body">
          <h6 class="mb-2">追加明細</h6>
          <table class="table table-sm align-middle">
            <thead>
              <tr>
                <th style="min-width:260px;">項目</th>
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
      });
    }
    document.getElementById("btnAddRow").addEventListener("click", () => this.addManualRow());
    document.getElementById("btnRecalc").addEventListener("click", () => this.loadSummary());
    document.getElementById("invMonth").addEventListener("change", () => this.loadSummary());
    document.getElementById("btnSubmitInvoice").addEventListener("click", () => this.submit());

    if (!this.staffId) {
      container.innerHTML = `<div class="alert alert-warning">スタッフ情報が確認できません</div>`;
      return;
    }

    await this.loadStaffDoc();
    await this.loadWorkItemOptions();
    await this.loadSummary();
  },

  async loadStaffDoc() {
    try {
      const d = await db.collection("staff").doc(this.staffId).get();
      this.staffDoc = d.exists ? { id: d.id, ...d.data() } : {};
    } catch (_) { this.staffDoc = {}; }
    this._renderStaffInfoFields();
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
      // 自動保存 (debounced)
      if (!el._saveBound) {
        el._saveBound = true;
        el.addEventListener("input", () => this._queueStaffSave());
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

  addManualRow(data = { key: "", label: "", amount: "", memo: "" }) {
    const tbody = document.getElementById("manualRows");
    const tr = document.createElement("tr");
    // プルダウン (work item) + 「その他」
    const options = this.workItemOptions.map(o =>
      `<option value="${o.key}" data-amount="${o.amount}" data-label="${this._esc(o.label)}">${this._esc(o.label)} (¥${o.amount.toLocaleString()})</option>`
    ).join("");
    tr.innerHTML = `
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
    [labelInput, amountInput, memoInput].forEach(i => i.addEventListener("input", () => this.updateTotal()));
  },

  async loadSummary() {
    const ym = document.getElementById("invMonth").value;
    if (!ym) return;

    const sumEl = document.getElementById("invSummary");
    sumEl.innerHTML = `<div class="text-muted"><span class="spinner-border spinner-border-sm"></span> 集計中...</div>`;

    try {
      // バックエンドの compute-preview API を呼び出す（階段制・タイミー時給・特別加算対応）
      const token = await firebase.auth().currentUser.getIdToken();
      const body = { yearMonth: ym };
      // オーナーが代理プレビューする場合は staffId を添付
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

      // API 結果をキャッシュ（updateTotal で manualItems 合算に使う）
      this._previewShiftAmount = preview.shiftAmount || 0;
      this._previewLaundryAmount = preview.laundryAmount || 0;
      this._previewSpecialAmount = preview.specialAmount || 0;
      this._previewTransportFee = preview.transportationFee || 0;
      this._previewShiftCount = preview.shiftCount || 0;

      // 特別加算の内訳テキスト生成
      const specialBreakdown = (preview.special || []).length > 0
        ? `<div class="col-md-3"><div class="small text-muted">特別加算</div><div class="fw-bold text-warning">¥${(preview.specialAmount || 0).toLocaleString()}</div></div>`
        : "";

      sumEl.innerHTML = `
        <div class="row g-2">
          <div class="col-md-3"><div class="small text-muted">シフト件数</div><div class="fw-bold">${preview.shiftCount} 件</div></div>
          <div class="col-md-3"><div class="small text-muted">基本報酬</div><div class="fw-bold">¥${(preview.shiftAmount || 0).toLocaleString()}</div></div>
          <div class="col-md-3"><div class="small text-muted">交通費</div><div class="fw-bold">¥${(preview.transportationFee || 0).toLocaleString()}</div></div>
          <div class="col-md-3"><div class="small text-muted">ランドリー立替</div><div class="fw-bold">¥${(preview.laundryAmount || 0).toLocaleString()}</div></div>
          ${specialBreakdown}
        </div>
        <div class="text-muted small mt-2">※ 階段制単価・workType別・タイミー時給・特別加算を含む正確な計算です</div>
      `;
    } catch (e) {
      sumEl.innerHTML = `<div class="alert alert-danger mb-0"><i class="bi bi-exclamation-triangle"></i> 集計に失敗しました: ${(e && e.message) || e}</div>`;
      console.error("loadSummary エラー:", e);
      // API失敗時はキャッシュをリセット
      this._previewShiftAmount = 0;
      this._previewLaundryAmount = 0;
      this._previewSpecialAmount = 0;
      this._previewTransportFee = 0;
      this._previewShiftCount = 0;
      return;
    }
    this.updateTotal();
  },

  updateTotal() {
    // バックエンド計算済みの金額 + フロントの追加明細行のみ加算
    const apiBase = (this._previewShiftAmount || 0)
      + (this._previewLaundryAmount || 0)
      + (this._previewSpecialAmount || 0)
      + (this._previewTransportFee || 0);
    const manualTotal = [...document.querySelectorAll("#manualRows .m-amount")]
      .reduce((s, i) => s + (Number(i.value) || 0), 0);
    const total = apiBase + manualTotal;
    document.getElementById("invTotal").textContent = "¥" + total.toLocaleString();
  },

  async submit() {
    const ym = document.getElementById("invMonth").value;
    // 行から label/amount/memo を収集 (プルダウンから選んだ場合は選択肢のラベル)
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
        label,
        amount: Number(tr.querySelector(".m-amount")?.value) || 0,
        memo: tr.querySelector(".m-memo")?.value || "",
      };
    }).filter(i => i.label || i.amount);

    const ok = await showConfirm(`${ym} の請求書をオーナーへ送信します。よろしいですか？`, "送信確認");
    if (!ok) return;

    const btn = document.getElementById("btnSubmitInvoice");
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 送信中...';
    try {
      const token = await firebase.auth().currentUser.getIdToken();
      // オーナーの代理提出対応: asStaffId を添付
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
    } catch (e) {
      showToast("エラー", e.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  },

  _esc(s) { const d = document.createElement("div"); d.textContent = String(s || ""); return d.innerHTML; },
};
