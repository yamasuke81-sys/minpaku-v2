/**
 * スタッフ用 請求書作成ページ
 *   - 月を指定 → 自分のシフト/ランドリー実績を集計
 *   - 追加明細(交通費など)を手入力可能
 *   - 送信で Cloud Functions /invoices/my-submit を呼び、オーナーへ通知
 *
 * ルート: #/my-invoice-create
 */
const MyInvoiceCreatePage = {
  CF_BASE: "https://api-5qrfx7ujcq-an.a.run.app",
  staffId: null,
  staffDoc: null,

  async render(container) {
    const isOwner = Auth.currentUser?.role === "owner";
    this.staffId = Auth.currentUser?.staffId;
    if (isOwner && !this.staffId) {
      try {
        const snap = await db.collection("staff").where("authUid", "==", Auth.currentUser.uid).limit(1).get();
        if (!snap.empty) this.staffId = snap.docs[0].id;
      } catch (_) {}
    }
    if (!this.staffId) {
      container.innerHTML = `<div class="alert alert-warning">スタッフ情報が確認できません</div>`;
      return;
    }
    try {
      const d = await db.collection("staff").doc(this.staffId).get();
      this.staffDoc = d.exists ? { id: d.id, ...d.data() } : {};
    } catch (_) { this.staffDoc = {}; }

    const today = new Date();
    const defaultYM = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0");

    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-receipt"></i> 請求書作成</h2>
        <div class="d-flex align-items-center gap-2">
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
          <h6 class="mb-2">追加明細（交通費など）</h6>
          <table class="table table-sm align-middle">
            <thead><tr><th>項目</th><th style="width:120px;">金額(円)</th><th>メモ</th><th style="width:60px;"></th></tr></thead>
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

    this.manualItems = [];
    document.getElementById("btnAddRow").addEventListener("click", () => this.addManualRow());
    document.getElementById("btnRecalc").addEventListener("click", () => this.loadSummary());
    document.getElementById("invMonth").addEventListener("change", () => this.loadSummary());
    document.getElementById("btnSubmitInvoice").addEventListener("click", () => this.submit());

    await this.loadSummary();
  },

  addManualRow(data = { label: "", amount: "", memo: "" }) {
    const tbody = document.getElementById("manualRows");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="text" class="form-control form-control-sm m-label" value="${data.label || ""}" placeholder="交通費 etc."></td>
      <td><input type="number" class="form-control form-control-sm m-amount" value="${data.amount || ""}" min="0"></td>
      <td><input type="text" class="form-control form-control-sm m-memo" value="${data.memo || ""}"></td>
      <td class="text-end"><button class="btn btn-sm btn-outline-danger m-del"><i class="bi bi-x"></i></button></td>
    `;
    tbody.appendChild(tr);
    tr.querySelector(".m-del").addEventListener("click", () => { tr.remove(); this.updateTotal(); });
    tr.querySelectorAll("input").forEach(i => i.addEventListener("input", () => this.updateTotal()));
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
    const manualItems = [...document.querySelectorAll("#manualRows tr")].map(tr => ({
      label: tr.querySelector(".m-label")?.value || "",
      amount: Number(tr.querySelector(".m-amount")?.value) || 0,
      memo: tr.querySelector(".m-memo")?.value || "",
    })).filter(i => i.label || i.amount);

    const ok = await showConfirm(`${ym} の請求書をオーナーへ送信します。よろしいですか？`, "送信確認");
    if (!ok) return;

    const btn = document.getElementById("btnSubmitInvoice");
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 送信中...';
    try {
      const token = await firebase.auth().currentUser.getIdToken();
      const res = await fetch(`${this.CF_BASE}/invoices/my-submit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ yearMonth: ym, manualItems }),
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
};
