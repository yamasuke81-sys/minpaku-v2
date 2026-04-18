/**
 * 清掃フロー組み合わせ設定画面
 *   物件毎に、清掃時に使うカード構成(チェックリスト/コインランドリー/リネン屋)をON/OFFする
 *   Firestore: properties/{id}.cleaningFlow = {
 *     useChecklist: bool,
 *     useCoinLaundry: bool,
 *     useLinenShop: bool,
 *     linenShopName: string,
 *     checkoutPhoto: bool,   // チェックアウト後の全景写真要否
 *     postComplete: string,  // 完了後の案内(チェックアウト/次ゲストへのメッセージ自動送信等)
 *   }
 *
 * ルート: #/cleaning-flow
 */
const CleaningFlowPage = {
  properties: [],

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-diagram-3"></i> 清掃フロー構成</h2>
        <span id="flowSaveStatus" class="small text-muted"></span>
      </div>
      <p class="text-muted small">物件ごとに、清掃時に使うカード構成をON/OFFします。変更は自動保存されます。</p>
      <div id="flowList" class="row g-3">
        <div class="col-12 text-muted">読込中...</div>
      </div>
    `;
    await this.load();
  },

  async load() {
    // API.properties.listMinpakuNumbered() で民泊物件のみ取得 (rates/shifts 等と同じ定義)
    try {
      if (API.properties && typeof API.properties.listMinpakuNumbered === "function") {
        this.properties = await API.properties.listMinpakuNumbered();
      } else {
        const snap = await db.collection("properties").get();
        this.properties = snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .filter(p => p.active !== false)
          .filter(p => (p.type || "minpaku") === "minpaku");
      }
    } catch (e) {
      console.warn("properties 取得失敗:", e.message);
      this.properties = [];
    }
    this.renderList();
  },

  renderList() {
    const wrap = document.getElementById("flowList");
    if (!this.properties.length) {
      wrap.innerHTML = `<div class="col-12 text-muted">物件がありません</div>`;
      return;
    }
    wrap.innerHTML = this.properties.map(p => {
      const f = p.cleaningFlow || {};
      const chk = (v, def) => (v === undefined ? def : !!v);
      return `
      <div class="col-md-6 col-lg-4">
        <div class="card" data-pid="${p.id}">
          <div class="card-body">
            <h6 class="card-title d-flex align-items-center gap-2">
              <span class="badge" style="background:${p.color || '#6c757d'}">${p.propertyNumber || "-"}</span>
              ${this._esc(p.name)}
            </h6>
            <div class="form-check form-switch mb-2">
              <input class="form-check-input flow-toggle" type="checkbox" data-field="useChecklist" ${chk(f.useChecklist, true) ? "checked" : ""}>
              <label class="form-check-label">清掃チェックリストを使う</label>
            </div>
            <div class="form-check form-switch mb-2">
              <input class="form-check-input flow-toggle" type="checkbox" data-field="useCoinLaundry" ${chk(f.useCoinLaundry, true) ? "checked" : ""}>
              <label class="form-check-label">コインランドリー利用あり</label>
            </div>
            <div class="form-check form-switch mb-2">
              <input class="form-check-input flow-toggle" type="checkbox" data-field="useLinenShop" ${chk(f.useLinenShop, false) ? "checked" : ""}>
              <label class="form-check-label">リネン屋に委託する</label>
            </div>
            <div class="mb-2 flow-linen-shop-name ${chk(f.useLinenShop, false) ? "" : "d-none"}">
              <label class="form-label small">リネン屋名</label>
              <input type="text" class="form-control form-control-sm flow-input" data-field="linenShopName" value="${this._esc(f.linenShopName || "")}">
            </div>
            <div class="form-check form-switch mb-2">
              <input class="form-check-input flow-toggle" type="checkbox" data-field="checkoutPhoto" ${chk(f.checkoutPhoto, false) ? "checked" : ""}>
              <label class="form-check-label">チェックアウト後の全景写真を必須化</label>
            </div>
            <div class="mb-0">
              <label class="form-label small">完了後の案内メモ</label>
              <textarea rows="2" class="form-control form-control-sm flow-input" data-field="postComplete" placeholder="次ゲストへの案内・鍵引き継ぎ等">${this._esc(f.postComplete || "")}</textarea>
            </div>
          </div>
        </div>
      </div>
      `;
    }).join("");

    // 変更イベント (自動保存, 800ms debounce)
    wrap.querySelectorAll(".flow-toggle, .flow-input").forEach(el => {
      const handler = () => {
        // リネン屋ON/OFFで店名欄の表示切替
        if (el.dataset.field === "useLinenShop") {
          const card = el.closest(".card");
          card.querySelector(".flow-linen-shop-name").classList.toggle("d-none", !el.checked);
        }
        this._queueSave(el.closest(".card").dataset.pid);
      };
      el.addEventListener("input", handler);
      el.addEventListener("change", handler);
    });
  },

  _queueSave(propertyId) {
    if (!this._timers) this._timers = {};
    if (this._timers[propertyId]) clearTimeout(this._timers[propertyId]);
    this._showStatus("saving");
    this._timers[propertyId] = setTimeout(() => this._save(propertyId), 800);
  },

  async _save(propertyId) {
    const card = document.querySelector(`.card[data-pid="${propertyId}"]`);
    if (!card) return;
    const flow = {};
    card.querySelectorAll(".flow-toggle").forEach(el => { flow[el.dataset.field] = !!el.checked; });
    card.querySelectorAll(".flow-input").forEach(el => { flow[el.dataset.field] = el.value || ""; });
    try {
      await db.collection("properties").doc(propertyId).set({
        cleaningFlow: flow,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      this._showStatus("saved");
    } catch (e) {
      this._showStatus("error", e.message);
    }
  },

  _showStatus(kind, msg) {
    const el = document.getElementById("flowSaveStatus");
    if (!el) return;
    if (kind === "saving") el.innerHTML = `<i class="bi bi-arrow-repeat"></i> 保存中…`;
    else if (kind === "saved") {
      el.innerHTML = `<span class="text-success"><i class="bi bi-check-circle-fill"></i> 保存済み</span>`;
      setTimeout(() => { if (el.innerHTML.includes("保存済み")) el.innerHTML = ""; }, 2000);
    } else if (kind === "error") el.innerHTML = `<span class="text-danger">保存失敗: ${this._esc(msg || "")}</span>`;
  },

  _esc(s) { const d = document.createElement("div"); d.textContent = String(s || ""); return d.innerHTML; },
};
