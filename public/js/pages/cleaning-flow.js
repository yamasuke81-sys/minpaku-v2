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
        /* フロー縦配置スタイル */
        .cf-flow-vertical { display:flex; flex-direction:column; gap:0; }
        .cf-step { background:#f8f9fa; border:1px solid #dee2e6; border-radius:8px; padding:10px 14px; position:relative; }
        .cf-step.active { background:#e7f1ff; border-color:#9fc5ff; }
        .cf-step.disabled { opacity:0.35; background:#f1f3f5; }
        .cf-step-title { font-weight:600; font-size:0.88rem; margin-bottom:6px; display:flex; align-items:center; gap:6px; }
        .cf-step-body { font-size:0.8rem; color:#495057; }
        /* 縦矢印 */
        .cf-arrow-down { text-align:center; color:#adb5bd; font-size:1.3rem; line-height:1.4; margin:2px 0; }
        /* ランドリー詳細カード */
        .cf-laundry-card { border:1px solid #9fc5ff; border-radius:8px; background:#f0f7ff; }
        .cf-laundry-card .card-header { background:#ddeeff; border-radius:8px 8px 0 0; font-weight:600; font-size:0.88rem; padding:8px 14px; }
        .cf-laundry-card .card-body { padding:12px 14px; }
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

  // 物件別 + 作業項目 毎の報酬一覧を返す (人数別単価 commonRates 対応)
  async _fetchRatesForProperty(propertyId) {
    const result = [];
    try {
      const doc = await db.collection("propertyWorkItems").doc(propertyId).get();
      if (doc.exists) {
        const items = (doc.data().items || []);
        items.forEach(it => {
          if (!it || !it.name) return;
          const id = `${propertyId}:${it.id || it.name}`;
          // 新形式 commonRates オブジェクト (人数別) 優先、なければ旧 commonRate(scalar) 互換
          let commonRate = 0;
          if (it.commonRates && typeof it.commonRates === "object") {
            // 1名時の単価を代表値として採用 (なければ 2名→3名 の順で fallback)
            commonRate = Number(it.commonRates[1]) || Number(it.commonRates[2]) || Number(it.commonRates[3]) || 0;
          }
          if (!commonRate) commonRate = Number(it.commonRate) || 0;
          result.push({ id, label: it.name, commonRate });
        });
      }
    } catch (_) {}
    return result;
  },

  async renderList() {
    const wrap = document.getElementById("flowList");
    if (!this.properties.length) {
      wrap.innerHTML = `<div class="col-12 text-muted">民泊物件がありません</div>`;
      return;
    }
    // 物件ごとに非同期で報酬項目を取得してマップ化
    const ratesPerProp = {};
    for (const p of this.properties) {
      ratesPerProp[p.id] = await this._fetchRatesForProperty(p.id);
    }

    const chk = (v, def) => (v === undefined ? def : !!v);
    const depots = this.depotMaster;

    // アコーディオン全体を1つのdivにまとめる
    const accordionId = "cleaningFlowAccordion";
    wrap.innerHTML = `<div class="col-12"><div class="accordion" id="${accordionId}">${
      this.properties.map((p, idx) => {
        const f = p.cleaningFlow || {};
        const selectedIds = Array.isArray(f.laundryDepotIds) ? f.laundryDepotIds : [];
        const useChk = chk(f.useChecklist, true);
        const usePhoto = chk(f.checkoutPhoto, false);
        const hasLaundry = selectedIds.length > 0;
        const rewards = f.laundryRewards || {}; // { putOut, collected, stored } = rateId or ""

        // 物件ごとの報酬プルダウンオプション
        const propRates = ratesPerProp[p.id] || [];
        const rateOptions = `<option value="">報酬なし</option>` +
          propRates.map(r => `<option value="${r.id}">${this._esc(r.label)} (共通 ¥${(r.commonRate || 0).toLocaleString()})</option>`).join("");

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

        const collapseId = `flowCollapse-${p.id}`;
        const headerId = `flowHeader-${p.id}`;

        // フロー有効状態のサマリバッジ (ヘッダに表示)
        const activeBadges = [
          useChk ? '<span class="badge bg-primary-subtle text-primary border border-primary-subtle ms-1">✓ チェックリスト</span>' : '',
          usePhoto ? '<span class="badge bg-secondary-subtle text-secondary border border-secondary-subtle ms-1">✓ 全景写真</span>' : '',
          hasLaundry ? `<span class="badge bg-info-subtle text-info border border-info-subtle ms-1">✓ ランドリー(${selectedIds.length})</span>` : '',
        ].filter(Boolean).join("");

        return `
        <div class="accordion-item" data-pid="${p.id}">
          <h2 class="accordion-header" id="${headerId}">
            <button class="accordion-button collapsed" type="button"
              data-bs-toggle="collapse" data-bs-target="#${collapseId}"
              aria-expanded="false" aria-controls="${collapseId}">
              <span class="badge me-2" style="background:${p.color || '#6c757d'}">${p.propertyNumber || "-"}</span>
              <span class="fw-semibold">${this._esc(p.name)}</span>
              <span class="ms-2 d-flex flex-wrap gap-1 align-items-center" style="font-size:0.75rem;">${activeBadges}</span>
            </button>
          </h2>
          <div id="${collapseId}" class="accordion-collapse collapse" aria-labelledby="${headerId}" data-bs-parent="#${accordionId}">
            <div class="accordion-body" data-pid="${p.id}">

              <!-- フロー縦配置 -->
              <div class="cf-flow-vertical mb-3" style="max-width:480px;">

                <!-- ステップ①: チェックリスト -->
                <div class="cf-step ${useChk ? 'active' : 'disabled'}" data-step="checklist" data-pid="${p.id}">
                  <div class="cf-step-title"><i class="bi bi-clipboard-check"></i> ① チェックリスト</div>
                  <div class="form-check form-switch mb-1">
                    <input class="form-check-input flow-toggle" type="checkbox" data-field="useChecklist" ${useChk ? "checked" : ""} id="cf-use-${p.id}">
                    <label class="form-check-label small" for="cf-use-${p.id}">${useChk ? '有効' : '無効'}</label>
                  </div>
                  <div class="cf-detail small mt-1" style="display:${useChk ? 'block' : 'none'};">
                    <a href="#/property-checklist/${p.id}" class="text-decoration-none"><i class="bi bi-pencil-square"></i> テンプレ編集</a>
                  </div>
                </div>

                <!-- 縦矢印 -->
                <div class="cf-arrow-down"><i class="bi bi-arrow-down"></i></div>

                <!-- ステップ②: 全景写真 -->
                <div class="cf-step ${usePhoto ? 'active' : 'disabled'}" data-step="photo" data-pid="${p.id}">
                  <div class="cf-step-title"><i class="bi bi-camera"></i> ② 全景写真</div>
                  <div class="form-check form-switch mb-1">
                    <input class="form-check-input flow-toggle" type="checkbox" data-field="checkoutPhoto" ${usePhoto ? "checked" : ""} id="cf-photo-${p.id}">
                    <label class="form-check-label small" for="cf-photo-${p.id}">${usePhoto ? '必須' : '任意'}</label>
                  </div>
                </div>

                <!-- 縦矢印 -->
                <div class="cf-arrow-down"><i class="bi bi-arrow-down"></i></div>

                <!-- ステップ③: ランドリー (有効/無効トグルのみ) -->
                <div class="cf-step ${hasLaundry ? 'active' : 'disabled'}" data-step="laundry" data-pid="${p.id}">
                  <div class="cf-step-title"><i class="bi bi-basket3"></i> ③ ランドリー</div>
                  <div class="form-check form-switch mb-1">
                    <input class="form-check-input flow-laundry-toggle" type="checkbox" ${hasLaundry ? "checked" : ""} id="cf-laundry-${p.id}">
                    <label class="form-check-label small" for="cf-laundry-${p.id}">${hasLaundry ? `有効 (${selectedIds.length}業者)` : '無効'}</label>
                  </div>
                </div>

              </div><!-- /.cf-flow-vertical -->

              <!-- ランドリー詳細カード (有効時のみ表示、集約) -->
              <div class="cf-laundry-detail" data-pid="${p.id}" style="display:${hasLaundry ? 'block' : 'none'};">
                <div class="cf-laundry-card card mb-3">
                  <div class="card-header">
                    <i class="bi bi-basket3-fill me-1"></i> ランドリー詳細設定
                  </div>
                  <div class="card-body">
                    <div class="row g-3">
                      <!-- 提出先チェックボックス -->
                      <div class="col-md-6">
                        <label class="form-label small mb-1 fw-bold"><i class="bi bi-basket3"></i> 提出先 (複数可)</label>
                        ${depotChecks}
                      </div>
                      <!-- 操作ごとの報酬 -->
                      <div class="col-md-6">
                        <label class="form-label small mb-1 fw-bold"><i class="bi bi-coin"></i> 操作ごとの報酬</label>
                        <div class="row g-1 align-items-center mb-1">
                          <div class="col-5 small text-muted">① 出した</div>
                          <div class="col-7"><select class="form-select form-select-sm flow-reward" data-field="putOut">${rateOptions}</select></div>
                        </div>
                        <div class="row g-1 align-items-center mb-1">
                          <div class="col-5 small text-muted">② 回収した</div>
                          <div class="col-7"><select class="form-select form-select-sm flow-reward" data-field="collected">${rateOptions}</select></div>
                        </div>
                        <div class="row g-1 align-items-center">
                          <div class="col-5 small text-muted">③ 収納した</div>
                          <div class="col-7"><select class="form-select form-select-sm flow-reward" data-field="stored">${rateOptions}</select></div>
                        </div>
                        <div class="form-text small">押したスタッフに報酬が加算 (請求書集計時)。</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div><!-- /.cf-laundry-detail -->

              <!-- 完了後の案内メモ -->
              <div class="mb-0">
                <label class="form-label small">完了後の案内メモ</label>
                <textarea rows="2" class="form-control form-control-sm flow-input" data-field="postComplete" placeholder="次ゲストへの案内・鍵引き継ぎ等">${this._esc(f.postComplete || "")}</textarea>
              </div>

            </div><!-- /.accordion-body -->
          </div><!-- /.accordion-collapse -->
        </div><!-- /.accordion-item -->
        `;
      }).join("")
    }</div></div>`;

    // 報酬値を流し込み
    document.querySelectorAll(".accordion-item[data-pid]").forEach(item => {
      const p = this.properties.find(pp => pp.id === item.dataset.pid);
      const rew = (p?.cleaningFlow?.laundryRewards) || {};
      item.querySelectorAll(".flow-reward").forEach(sel => {
        const f = sel.dataset.field;
        if (rew[f]) sel.value = rew[f];
      });
    });

    // イベント登録: flow-toggle / flow-input / flow-depot / flow-reward
    wrap.querySelectorAll(".flow-toggle, .flow-input, .flow-depot, .flow-reward").forEach(el => {
      const handler = () => {
        // accordion-item を起点に検索
        const item = el.closest(".accordion-item");
        if (!item) return;

        // チェックリスト トグル
        if (el.classList.contains("flow-toggle") && el.dataset.field === "useChecklist") {
          const step = item.querySelector('.cf-step[data-step="checklist"]');
          if (step) step.classList.toggle("active", el.checked);
          if (step) step.classList.toggle("disabled", !el.checked);
          const lbl = step?.querySelector("label.form-check-label");
          if (lbl) lbl.textContent = el.checked ? "有効" : "無効";
          const detail = step?.querySelector(".cf-detail");
          if (detail) detail.style.display = el.checked ? "block" : "none";
        }
        // 全景写真 トグル
        if (el.classList.contains("flow-toggle") && el.dataset.field === "checkoutPhoto") {
          const step = item.querySelector('.cf-step[data-step="photo"]');
          if (step) step.classList.toggle("active", el.checked);
          if (step) step.classList.toggle("disabled", !el.checked);
          const lbl = step?.querySelector("label.form-check-label");
          if (lbl) lbl.textContent = el.checked ? "必須" : "任意";
        }
        // ランドリー提出先の増減 → サマリ更新
        if (el.classList.contains("flow-depot")) {
          const checked = item.querySelectorAll(".flow-depot:checked").length;
          const step = item.querySelector('.cf-step[data-step="laundry"]');
          const toggle = step?.querySelector(".flow-laundry-toggle");
          if (step) step.classList.toggle("active", checked > 0);
          if (step) step.classList.toggle("disabled", checked === 0);
          if (toggle) toggle.checked = checked > 0;
          const lbl = step?.querySelector("label.form-check-label");
          if (lbl) lbl.textContent = checked > 0 ? `有効 (${checked}業者)` : "無効";
        }
        this._queueSave(item.dataset.pid);
      };
      el.addEventListener("input", handler);
      el.addEventListener("change", handler);
    });

    // ランドリー有効/無効トグル: OFF で全提出先を外す、ON で全提出先を入れる
    wrap.querySelectorAll(".flow-laundry-toggle").forEach(tg => {
      tg.addEventListener("change", () => {
        const item = tg.closest(".accordion-item");
        if (!item) return;
        const pid = item.dataset.pid;
        const depotCbs = item.querySelectorAll(".flow-depot");
        if (tg.checked) {
          // 有効化: すべてチェック
          depotCbs.forEach(cb => cb.checked = true);
        } else {
          depotCbs.forEach(cb => cb.checked = false);
        }
        const step = item.querySelector('.cf-step[data-step="laundry"]');
        const detail = item.querySelector(`.cf-laundry-detail[data-pid="${pid}"]`);
        if (detail) detail.style.display = tg.checked ? "block" : "none";
        const lbl = step?.querySelector("label.form-check-label");
        if (lbl) lbl.textContent = tg.checked ? `有効 (${depotCbs.length}業者)` : "無効";
        if (step) step.classList.toggle("active", tg.checked);
        if (step) step.classList.toggle("disabled", !tg.checked);
        this._queueSave(pid);
      });
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
    // accordion-item から保存データを収集
    const item = document.querySelector(`.accordion-item[data-pid="${propertyId}"]`);
    if (!item) return;
    const flow = {};
    item.querySelectorAll(".flow-toggle").forEach(el => { flow[el.dataset.field] = !!el.checked; });
    item.querySelectorAll(".flow-input").forEach(el => { flow[el.dataset.field] = el.value || ""; });
    // ランドリー提出先 (複数選択)
    flow.laundryDepotIds = [...item.querySelectorAll(".flow-depot")].filter(el => el.checked).map(el => el.dataset.depotId);
    // 報酬選択 (putOut/collected/stored)
    const rewards = {};
    item.querySelectorAll(".flow-reward").forEach(sel => { rewards[sel.dataset.field] = sel.value || ""; });
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
