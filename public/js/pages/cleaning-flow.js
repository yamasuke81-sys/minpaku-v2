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
      <p class="text-muted small">物件ごとに、清掃時のフローを組み立てます。提出先マスターは <a href="#/laundry">ランドリーページ</a>、報酬単価は <a href="#/rates">報酬単価ページ</a>、プリカは <a href="#/prepaid-cards">プリカ管理ページ</a>で管理します。変更は自動保存されます。</p>
      <style>
        .cf-flow { display:flex; align-items:stretch; gap:4px; flex-wrap:wrap; }
        .cf-step { flex:1; min-width:120px; background:#f8f9fa; border:1px solid #dee2e6; border-radius:8px; padding:8px 10px; position:relative; }
        .cf-step.active { background:#e7f1ff; border-color:#9fc5ff; }
        .cf-step.disabled { opacity:0.35; background:#f1f3f5; }
        .cf-step-title { font-weight:600; font-size:0.85rem; margin-bottom:4px; display:flex; align-items:center; gap:4px; }
        .cf-step-body { font-size:0.78rem; color:#495057; }
        .cf-arrow { align-self:center; color:#adb5bd; font-size:1.2rem; }
      </style>
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

  async _fetchRates() {
    if (this._rates) return this._rates;
    this._rates = {};
    try {
      const snap = await db.collection("propertyWorkItems").get();
      const map = {};
      snap.docs.forEach(d => {
        const items = (d.data().items || []);
        items.forEach(it => {
          const id = `${d.id}:${it.id || it.name}`;
          map[id] = { label: it.name, commonRate: it.commonRate || 0 };
        });
      });
      this._rates = map;
    } catch (_) {}
    return this._rates;
  },

  async renderList() {
    const wrap = document.getElementById("flowList");
    if (!this.properties.length) {
      wrap.innerHTML = `<div class="col-12 text-muted">民泊物件がありません</div>`;
      return;
    }
    const rates = await this._fetchRates();
    const rateOptions = `<option value="">報酬なし</option>` +
      Object.entries(rates).map(([id, r]) => `<option value="${id}">${this._esc(r.label)} (¥${(r.commonRate || 0).toLocaleString()})</option>`).join("");

    const chk = (v, def) => (v === undefined ? def : !!v);
    const depots = this.depotMaster;
    wrap.innerHTML = this.properties.map(p => {
      const f = p.cleaningFlow || {};
      const selectedIds = Array.isArray(f.laundryDepotIds) ? f.laundryDepotIds : [];
      const useChk = chk(f.useChecklist, true);
      const usePhoto = chk(f.checkoutPhoto, false);
      const hasLaundry = selectedIds.length > 0;
      const rewards = f.laundryRewards || {}; // { putOut, collected, stored } = rateId or ""
      const depotChecks = depots.length
        ? depots.map(d => `
            <div class="form-check">
              <input class="form-check-input flow-depot" type="checkbox" data-depot-id="${d.id || d.name}" id="flow-${p.id}-${(d.id || d.name).replace(/[^a-z0-9]/gi,'_')}" ${selectedIds.includes(d.id || d.name) ? "checked" : ""}>
              <label class="form-check-label small" for="flow-${p.id}-${(d.id || d.name).replace(/[^a-z0-9]/gi,'_')}">
                <span class="badge bg-light text-dark border" title="提出先の種別">${this._kindLabel(d.kind)}</span>
                ${this._esc(d.name)}
              </label>
            </div>
          `).join("")
        : `<div class="small text-muted">提出先マスターが未登録です。<a href="#/laundry">ランドリーページ</a>で追加してください。</div>`;

      // フロー図: チェックリスト → 写真 → ランドリー
      const flowDiagram = `
        <div class="cf-flow mb-3">
          <div class="cf-step ${useChk ? 'active' : 'disabled'}">
            <div class="cf-step-title"><i class="bi bi-clipboard-check"></i> チェックリスト</div>
            <div class="cf-step-body">${useChk ? '有効' : '無効'}</div>
          </div>
          <div class="cf-arrow">→</div>
          <div class="cf-step ${usePhoto ? 'active' : 'disabled'}">
            <div class="cf-step-title"><i class="bi bi-camera"></i> 全景写真</div>
            <div class="cf-step-body">${usePhoto ? '必須' : '任意'}</div>
          </div>
          <div class="cf-arrow">→</div>
          <div class="cf-step ${hasLaundry ? 'active' : 'disabled'}">
            <div class="cf-step-title"><i class="bi bi-basket3"></i> ランドリー</div>
            <div class="cf-step-body">${hasLaundry ? `${selectedIds.length}業者` : '未使用'}</div>
          </div>
        </div>`;

      return `
      <div class="col-12 col-xl-6">
        <div class="card h-100" data-pid="${p.id}">
          <div class="card-body">
            <h6 class="card-title d-flex align-items-center gap-2">
              <span class="badge" style="background:${p.color || '#6c757d'}">${p.propertyNumber || "-"}</span>
              ${this._esc(p.name)}
            </h6>
            ${flowDiagram}
            <div class="row g-2">
              <div class="col-md-6">
                <div class="form-check form-switch mb-2">
                  <input class="form-check-input flow-toggle" type="checkbox" data-field="useChecklist" ${useChk ? "checked" : ""}>
                  <label class="form-check-label"><i class="bi bi-clipboard-check"></i> 清掃チェックリストを使う</label>
                </div>
                <div class="form-check form-switch mb-2">
                  <input class="form-check-input flow-toggle" type="checkbox" data-field="checkoutPhoto" ${usePhoto ? "checked" : ""}>
                  <label class="form-check-label"><i class="bi bi-camera"></i> 全景写真を必須化</label>
                </div>
                <div class="mb-0">
                  <label class="form-label small">完了後の案内メモ</label>
                  <textarea rows="2" class="form-control form-control-sm flow-input" data-field="postComplete" placeholder="次ゲストへの案内・鍵引き継ぎ等">${this._esc(f.postComplete || "")}</textarea>
                </div>
              </div>
              <div class="col-md-6">
                <label class="form-label small mb-1 fw-bold"><i class="bi bi-basket3"></i> ランドリー提出先 (複数選択可)</label>
                ${depotChecks}
                <div class="mt-3">
                  <label class="form-label small mb-1 fw-bold"><i class="bi bi-coin"></i> ランドリー操作の報酬</label>
                  <div class="row g-1 align-items-center mb-1">
                    <div class="col-5 small text-muted">① 出した時</div>
                    <div class="col-7"><select class="form-select form-select-sm flow-reward" data-field="putOut">${rateOptions}</select></div>
                  </div>
                  <div class="row g-1 align-items-center mb-1">
                    <div class="col-5 small text-muted">② 回収した時</div>
                    <div class="col-7"><select class="form-select form-select-sm flow-reward" data-field="collected">${rateOptions}</select></div>
                  </div>
                  <div class="row g-1 align-items-center">
                    <div class="col-5 small text-muted">③ 収納した時</div>
                    <div class="col-7"><select class="form-select form-select-sm flow-reward" data-field="stored">${rateOptions}</select></div>
                  </div>
                  <div class="form-text small">押したスタッフに選択した報酬単価が加算されます (請求書集計時)。</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      `;
    }).join("");

    // 報酬値を流し込み
    document.querySelectorAll(".card[data-pid]").forEach(card => {
      const p = this.properties.find(pp => pp.id === card.dataset.pid);
      const rew = (p?.cleaningFlow?.laundryRewards) || {};
      card.querySelectorAll(".flow-reward").forEach(sel => {
        const f = sel.dataset.field;
        if (rew[f]) sel.value = rew[f];
      });
    });

    wrap.querySelectorAll(".flow-toggle, .flow-input, .flow-depot, .flow-reward").forEach(el => {
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
    // 報酬選択 (putOut/collected/stored)
    const rewards = {};
    card.querySelectorAll(".flow-reward").forEach(sel => { rewards[sel.dataset.field] = sel.value || ""; });
    flow.laundryRewards = rewards;
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
