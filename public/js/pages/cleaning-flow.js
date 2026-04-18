/**
 * 清掃フロー構成画面
 *   物件毎に、清掃時に使うカード構成(チェックリスト/ランドリー業者)をON/OFFする
 *
 * データ:
 *   properties/{id}.cleaningFlow = {
 *     useChecklist: bool,
 *     laundryDepotIds: string[],  // settings/laundryDepots.items[].id のサブセット
 *     checkoutPhoto: bool,
 *     postComplete: string,
 *   }
 *   settings/laundryDepots.items = [{ id, name, kind: "coin_laundry"|"linen_shop"|"other", rates: [...] }]
 *
 * 挙動 (清掃画面 my-checklist 側):
 *   - laundryDepotIds が空 or useChecklist=false → 清掃画面のランドリーセクション非表示
 *   - 1件以上あり → 「洗濯物を出した」モーダルで各 depot が選択肢として出現
 *   - 複数選択 OK (業者A+業者Bの併用、コインランドリー+リネン屋の併用)
 *   - "linen_shop" kind の depot: 回収・収納ステップは不要扱い (業者が処理)
 *   - "coin_laundry" kind の depot: 出した→回収した→収納した の3ステップ全部表示
 *
 * ルート: #/cleaning-flow
 */
const CleaningFlowPage = {
  properties: [],
  depotMaster: [],  // settings/laundryDepots.items

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-diagram-3"></i> 清掃フロー構成</h2>
        <span id="flowSaveStatus" class="small text-muted"></span>
      </div>
      <p class="text-muted small">物件ごとに、清掃時に使うカード構成をON/OFFします。提出先マスターは <a href="#/laundry">ランドリーページ</a> で管理できます。変更は自動保存されます。</p>
      <div id="flowList" class="row g-3">
        <div class="col-12 text-muted">読込中...</div>
      </div>
    `;
    await this.load();
  },

  async load() {
    // 民泊物件のみ取得
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
    // 提出先マスター取得 (並び順保持)
    try {
      const doc = await db.collection("settings").doc("laundryDepots").get();
      this.depotMaster = (doc.exists && Array.isArray(doc.data().items)) ? doc.data().items : [];
    } catch (_) {
      this.depotMaster = [];
    }
    this.renderList();
  },

  renderList() {
    const wrap = document.getElementById("flowList");
    if (!this.properties.length) {
      wrap.innerHTML = `<div class="col-12 text-muted">民泊物件がありません</div>`;
      return;
    }
    const chk = (v, def) => (v === undefined ? def : !!v);
    const depots = this.depotMaster;
    wrap.innerHTML = this.properties.map(p => {
      const f = p.cleaningFlow || {};
      const selectedIds = Array.isArray(f.laundryDepotIds) ? f.laundryDepotIds : [];
      const depotChecks = depots.length
        ? depots.map(d => `
            <div class="form-check">
              <input class="form-check-input flow-depot" type="checkbox" data-depot-id="${d.id || d.name}" id="flow-${p.id}-${(d.id || d.name).replace(/[^a-z0-9]/gi,'_')}" ${selectedIds.includes(d.id || d.name) ? "checked" : ""}>
              <label class="form-check-label small" for="flow-${p.id}-${(d.id || d.name).replace(/[^a-z0-9]/gi,'_')}">
                <span class="badge bg-light text-dark border">${this._kindLabel(d.kind)}</span>
                ${this._esc(d.name)}
              </label>
            </div>
          `).join("")
        : `<div class="small text-muted">提出先マスターが未登録です。<a href="#/laundry">ランドリーページ</a>で追加してください。</div>`;
      return `
      <div class="col-md-6 col-lg-4">
        <div class="card h-100" data-pid="${p.id}">
          <div class="card-body">
            <h6 class="card-title d-flex align-items-center gap-2">
              <span class="badge" style="background:${p.color || '#6c757d'}">${p.propertyNumber || "-"}</span>
              ${this._esc(p.name)}
            </h6>
            <div class="form-check form-switch mb-2">
              <input class="form-check-input flow-toggle" type="checkbox" data-field="useChecklist" ${chk(f.useChecklist, true) ? "checked" : ""}>
              <label class="form-check-label">清掃チェックリストを使う</label>
            </div>
            <div class="mb-2">
              <label class="form-label small mb-1 fw-bold"><i class="bi bi-basket3"></i> ランドリー提出先 (複数選択可)</label>
              ${depotChecks}
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

    wrap.querySelectorAll(".flow-toggle, .flow-input, .flow-depot").forEach(el => {
      const handler = () => this._queueSave(el.closest(".card").dataset.pid);
      el.addEventListener("input", handler);
      el.addEventListener("change", handler);
    });
  },

  _kindLabel(kind) {
    if (kind === "coin_laundry") return "コインランドリー";
    if (kind === "linen_shop") return "リネン屋";
    return "提出先";
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
    // ランドリー提出先 (複数選択)
    flow.laundryDepotIds = [...card.querySelectorAll(".flow-depot")].filter(el => el.checked).map(el => el.dataset.depotId);
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
