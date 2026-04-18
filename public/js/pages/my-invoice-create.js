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
    const [y, m] = ym.split("-").map(Number);
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 0, 23, 59, 59);

    const [shSnap, lnSnap] = await Promise.all([
      db.collection("shifts").where("staffId", "==", this.staffId)
        .where("date", ">=", start).where("date", "<=", end).get(),
      db.collection("laundry").where("staffId", "==", this.staffId)
        .where("date", ">=", start).where("date", "<=", end).get(),
    ]);
    const shifts = shSnap.docs.map(d => d.data());
    const laundry = lnSnap.docs.map(d => d.data());

    this._shiftCount = shifts.length;
    this._laundryTotal = laundry.reduce((s, l) => s + (l.amount || 0), 0);
    this._ratePerJob = this.staffDoc.ratePerJob || 0;
    this._transportFee = this.staffDoc.transportationFee || 0;

    const basePayment = shifts.length * this._ratePerJob;
    const transportationFee = shifts.length * this._transportFee;

    document.getElementById("invSummary").innerHTML = `
      <div class="row g-2">
        <div class="col-md-3"><div class="small text-muted">シフト件数</div><div class="fw-bold">${shifts.length} 件</div></div>
        <div class="col-md-3"><div class="small text-muted">基本報酬</div><div class="fw-bold">¥${basePayment.toLocaleString()}</div></div>
        <div class="col-md-3"><div class="small text-muted">交通費</div><div class="fw-bold">¥${transportationFee.toLocaleString()}</div></div>
        <div class="col-md-3"><div class="small text-muted">ランドリー立替</div><div class="fw-bold">¥${this._laundryTotal.toLocaleString()}</div></div>
      </div>
      <div class="text-muted small mt-2">※ シフト単価 ¥${this._ratePerJob.toLocaleString()} × ${shifts.length}件 + 交通費 ¥${this._transportFee.toLocaleString()} × ${shifts.length}件 + ランドリー実費</div>
    `;
    this.updateTotal();
  },

  updateTotal() {
    const basePayment = (this._shiftCount || 0) * (this._ratePerJob || 0);
    const transportationFee = (this._shiftCount || 0) * (this._transportFee || 0);
    const manualTotal = [...document.querySelectorAll("#manualRows .m-amount")]
      .reduce((s, i) => s + (Number(i.value) || 0), 0);
    const total = basePayment + (this._laundryTotal || 0) + transportationFee + manualTotal;
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
