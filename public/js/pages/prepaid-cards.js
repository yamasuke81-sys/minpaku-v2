/**
 * プリペイドカード管理
 *   オーナー/サブオーナーがコインランドリー等で使うプリカを登録。
 *   洗濯物を出した時にスタッフが選んだプリカから残高が自動減算される。
 *
 * データ: settings/prepaidCards.items = [{ id, label, cardNumber, balance, depotId }]
 * ルート: #/prepaid-cards
 */
const PrepaidCardsPage = {
  cards: [],
  depots: [],

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-credit-card-2-front"></i> プリカ管理</h2>
        <div class="d-flex gap-2">
          <span id="prepaidSaveStatus" class="small"></span>
          <button class="btn btn-outline-primary" id="btnAddPrepaid"><i class="bi bi-plus"></i> プリカ追加</button>
          <button class="btn btn-primary" id="btnSavePrepaid"><i class="bi bi-check-lg"></i> 保存</button>
        </div>
      </div>
      <p class="text-muted small">ランドリー提出先ごとに複数のプリカを管理できます。洗濯物を出した時にスタッフが選んだカードから金額が自動減算されます。</p>
      <div id="prepaidList" class="row g-3">
        <div class="col-12 text-muted">読込中...</div>
      </div>
    `;
    document.getElementById("btnAddPrepaid").addEventListener("click", () => this.addCard());
    document.getElementById("btnSavePrepaid").addEventListener("click", () => this.save());
    await this.load();
  },

  async load() {
    try {
      const doc = await db.collection("settings").doc("prepaidCards").get();
      this.cards = (doc.exists && Array.isArray(doc.data().items)) ? doc.data().items : [];
    } catch (_) { this.cards = []; }
    try {
      const doc = await db.collection("settings").doc("laundryDepots").get();
      this.depots = (doc.exists && Array.isArray(doc.data().items)) ? doc.data().items : [];
    } catch (_) { this.depots = []; }
    this.renderList();
  },

  renderList() {
    const wrap = document.getElementById("prepaidList");
    if (!this.cards.length) {
      wrap.innerHTML = `<div class="col-12 text-muted">プリカが登録されていません。「プリカ追加」から登録してください。</div>`;
      return;
    }
    const depotOpts = `<option value="">-- 任意 (全提出先で利用可) --</option>` +
      this.depots.map(d => `<option value="${d.id || d.name}">${this._esc(d.name)}</option>`).join("");
    wrap.innerHTML = this.cards.map((c, i) => `
      <div class="col-md-6 col-lg-4">
        <div class="card h-100" data-idx="${i}">
          <div class="card-body">
            <div class="mb-2">
              <label class="form-label small">名称</label>
              <input type="text" class="form-control form-control-sm c-label" value="${this._esc(c.label || '')}" placeholder="例: コインランドリーA プリカ①">
            </div>
            <div class="row g-2 mb-2">
              <div class="col-7">
                <label class="form-label small">カード番号</label>
                <input type="text" class="form-control form-control-sm c-number" value="${this._esc(c.cardNumber || '')}" placeholder="#001">
              </div>
              <div class="col-5">
                <label class="form-label small">残高 (円)</label>
                <input type="number" class="form-control form-control-sm c-balance" value="${c.balance || 0}" min="0">
              </div>
            </div>
            <div class="mb-2">
              <label class="form-label small">紐付け提出先</label>
              <select class="form-select form-select-sm c-depot">${depotOpts}</select>
            </div>
            <button class="btn btn-sm btn-outline-danger c-remove"><i class="bi bi-trash"></i> 削除</button>
          </div>
        </div>
      </div>
    `).join("");
    // depot 値を反映
    wrap.querySelectorAll(".card").forEach(el => {
      const i = +el.dataset.idx;
      const dep = this.cards[i].depotId;
      if (dep) el.querySelector(".c-depot").value = dep;
      el.querySelector(".c-remove").addEventListener("click", () => {
        this.cards.splice(i, 1);
        this.renderList();
      });
    });
  },

  addCard() {
    this.cards.push({
      id: "prepaid_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      label: "", cardNumber: "", balance: 0, depotId: "",
    });
    this.renderList();
  },

  async save() {
    const items = [];
    document.querySelectorAll("#prepaidList .card[data-idx]").forEach(el => {
      const i = +el.dataset.idx;
      const existing = this.cards[i] || {};
      const label = el.querySelector(".c-label").value.trim();
      if (!label) return;
      items.push({
        id: existing.id || ("prepaid_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        label,
        cardNumber: el.querySelector(".c-number").value.trim(),
        balance: Number(el.querySelector(".c-balance").value) || 0,
        depotId: el.querySelector(".c-depot").value || "",
      });
    });
    const status = document.getElementById("prepaidSaveStatus");
    status.innerHTML = `<i class="bi bi-arrow-repeat text-muted"></i> 保存中...`;
    try {
      await db.collection("settings").doc("prepaidCards").set({
        items,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      this.cards = items;
      status.innerHTML = `<span class="text-success"><i class="bi bi-check-circle-fill"></i> 保存しました</span>`;
      setTimeout(() => { status.innerHTML = ""; }, 2000);
    } catch (e) {
      status.innerHTML = `<span class="text-danger">保存失敗: ${e.message}</span>`;
    }
  },

  _esc(s) { const d = document.createElement("div"); d.textContent = String(s || ""); return d.innerHTML; },
};
