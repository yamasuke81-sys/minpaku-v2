/**
 * プリペイドカード管理 (物件別)
 *   - コインランドリー店舗ごとに頭文字 prefix を設定し、その後に3桁連番を自動付与
 *   - カードは propertyIds[] で所属物件を管理 (複数紐付け可)
 *   - 残高は洗濯物を出した時に自動減算
 *   - 残高0は使用済みとしてグレーアウト、デフォルト非表示
 *
 * データ: settings/prepaidCards.items = [{ id, prefix, cardNumber, balance, depotId, propertyIds, memo }]
 *         settings/prepaidCards.depotPrefixes = { [depotId]: "小柴" } (店舗頭文字キャッシュ)
 * ルート: #/prepaid-cards
 *
 * スタッフ表示:
 *   - currentUser.role === "staff" | "sub_owner" の場合、自分 staff.assignedPropertyIds と
 *     交差する propertyIds を持つカードのみ表示
 *   - 編集/追加/削除はオーナー・サブオーナーのみ (スタッフは閲覧のみ)
 */
const PrepaidCardsPage = {
  cards: [],
  depots: [],
  properties: [],
  staffList: [],   // 購入者プルダウン用 (オーナー時のみ取得)
  staffDoc: null,  // スタッフ側表示時の自分情報
  canEdit: false,

  async render(container) {
    const role = (Auth.currentUser && Auth.currentUser.role) || "owner";
    // スタッフも「追加」操作を許可 (ランドリー購入時の登録フロー)
    this.canEdit = role === "owner" || role === "sub_owner" || role === "staff";
    this.isOwnerLevel = role === "owner" || role === "sub_owner";

    // スタッフ/サブオーナー時は自身の担当物件を取得
    if (!this.canEdit || role === "sub_owner") {
      try {
        const staffId = Auth.currentUser.staffId;
        if (staffId) {
          const d = await db.collection("staff").doc(staffId).get();
          if (d.exists) this.staffDoc = { id: d.id, ...d.data() };
        }
      } catch (_) {}
    }

    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-credit-card-2-front"></i> プリカ管理</h2>
        <div class="d-flex gap-2">
          <span id="prepaidSaveStatus" class="small"></span>
          ${this.canEdit ? `<button class="btn btn-outline-primary" id="btnAddPrepaid"><i class="bi bi-plus"></i> プリカ追加</button>` : ""}
          ${this.canEdit ? `<button class="btn btn-primary" id="btnSavePrepaid"><i class="bi bi-check-lg"></i> 保存</button>` : ""}
        </div>
      </div>
      <p class="text-muted small">${this.canEdit
        ? 'コインランドリー店舗ごとに頭文字を設定し、番号は自動で3桁連番が付与されます。残高は洗濯物を出した時に自動減算されます。'
        : '閲覧のみ。変更はオーナーにお問い合わせください。'}</p>

      <!-- チャージ額 → 残高 ルール (店舗別、プリカ購入時に適用) -->
      ${this.isOwnerLevel ? `
      <div class="card mb-3">
        <div class="card-header py-2">
          <strong><i class="bi bi-arrow-right-circle"></i> チャージ額 → 残高 ルール (店舗別)</strong>
          <small class="text-muted ms-2">例: 小柴で2000円→残高2200円 (ボーナス200円)</small>
        </div>
        <div class="card-body p-2">
          <div id="chargeRulesList"></div>
          <button class="btn btn-sm btn-outline-secondary mt-1" id="btnAddChargeRule"><i class="bi bi-plus"></i> ルール追加</button>
          <button class="btn btn-sm btn-primary mt-1 ms-2" id="btnSaveChargeRules"><i class="bi bi-check"></i> 保存</button>
        </div>
      </div>` : ''}

      <!-- 物件フィルタ (目アイコン型) -->
      <div id="propEyeFilterHost-prepaidCards"></div>
      <div class="row g-2 align-items-end mb-3">
        <div class="col-md-4">
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" id="showUsedCards">
            <label class="form-check-label small" for="showUsedCards">使用済み(残高0)のカードも表示</label>
          </div>
        </div>
      </div>

      <div id="prepaidList" class="row g-3">
        <div class="col-12 text-muted">読込中...</div>
      </div>

      <!-- プリカ追加モーダル -->
      <div class="modal fade" id="prepaidAddModal" tabindex="-1">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-plus-circle"></i> プリカ追加</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="mb-3">
                <label class="form-label">提出先 (コインランドリー) <span class="text-danger">*</span></label>
                <select class="form-select" id="newPrepaidDepot">
                  <option value="">-- 選択 --</option>
                </select>
              </div>
              <div class="mb-3" id="newPrepaidPrefixWrap">
                <label class="form-label">カード番号の頭文字 <span class="text-danger">*</span></label>
                <input type="text" class="form-control" id="newPrepaidPrefix" placeholder="例: 小柴">
                <div class="form-text">この頭文字 + 3桁連番で自動採番されます (例: 小柴001, 小柴002)</div>
              </div>
              <div class="mb-3">
                <label class="form-label">採番されるカード番号</label>
                <input type="text" class="form-control" id="newPrepaidNumber" readonly style="background:#f8f9fa;">
              </div>
              <div class="row g-2 mb-3">
                <div class="col-6">
                  <label class="form-label">購入金額 (円)</label>
                  <input type="number" class="form-control" id="newPrepaidCharge" min="0" value="2000">
                  <div class="form-text small">チャージ額ルールが設定されていれば残高が自動計算されます</div>
                </div>
                <div class="col-6">
                  <label class="form-label">残高 (円) <span class="text-danger">*</span></label>
                  <input type="number" class="form-control" id="newPrepaidBalance" min="0" value="2200">
                </div>
              </div>
              <!-- 購入者選択 (オーナーのみ表示。スタッフ/サブオーナーは自動で自分) -->
              <div class="mb-3 d-none" id="newPrepaidPurchaserWrap">
                <label class="form-label">購入者 <span class="text-danger">*</span></label>
                <select class="form-select" id="newPrepaidPurchaser">
                  <option value="">-- 選択 --</option>
                </select>
                <div class="form-text small">購入者の月次請求書に立替として自動計上されます</div>
              </div>
              <div class="mb-3">
                <label class="form-label">利用物件 (複数選択可)</label>
                <div id="newPrepaidProperties" class="d-flex flex-wrap gap-2 border rounded p-2"></div>
              </div>
              <div class="mb-0">
                <label class="form-label">メモ</label>
                <input type="text" class="form-control" id="newPrepaidMemo" placeholder="例: 購入日、購入場所 etc.">
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">キャンセル</button>
              <button type="button" class="btn btn-primary" id="btnCreatePrepaid"><i class="bi bi-check-lg"></i> 追加する</button>
            </div>
          </div>
        </div>
      </div>
    `;
    if (this.canEdit) {
      document.getElementById("btnAddPrepaid").addEventListener("click", () => this.addCard());
      document.getElementById("btnSavePrepaid").addEventListener("click", () => this.save());
    }
    if (this.isOwnerLevel) {
      document.getElementById("btnAddChargeRule")?.addEventListener("click", () => this.addChargeRule());
      document.getElementById("btnSaveChargeRules")?.addEventListener("click", () => this.saveChargeRules());
    }
    document.getElementById("showUsedCards").addEventListener("change", () => this.renderList());
    await this.load();
  },

  async load() {
    try {
      const doc = await db.collection("settings").doc("prepaidCards").get();
      this.cards = (doc.exists && Array.isArray(doc.data().items)) ? doc.data().items : [];
      this.depotPrefixes = (doc.exists && doc.data().depotPrefixes) || {};
      this.chargeRules = (doc.exists && Array.isArray(doc.data().chargeRules)) ? doc.data().chargeRules : [{ chargeAmount: 2000, balance: 2200 }];
    } catch (_) { this.cards = []; this.depotPrefixes = {}; this.chargeRules = [{ chargeAmount: 2000, balance: 2200 }]; }
    // コインランドリー種別の提出先のみ
    try {
      const doc = await db.collection("settings").doc("laundryDepots").get();
      const all = (doc.exists && Array.isArray(doc.data().items)) ? doc.data().items : [];
      this.depots = all.filter(d => d.kind === "coin_laundry");
    } catch (_) { this.depots = []; }
    // 物件一覧
    try {
      if (API.properties && typeof API.properties.listMinpakuNumbered === "function") {
        this.properties = await API.properties.listMinpakuNumbered();
      } else {
        const snap = await db.collection("properties").get();
        this.properties = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.active !== false);
      }
    } catch (_) { this.properties = []; }

    // スタッフ時は担当物件で絞り込み
    if (!this.canEdit && this.staffDoc) {
      const assigned = new Set(this.staffDoc.assignedPropertyIds || []);
      this.properties = this.properties.filter(p => assigned.has(p.id));
    }

    // オーナー時のみスタッフ一覧を取得 (購入者プルダウン用)
    if (this.isOwnerLevel) {
      try {
        const snap = await db.collection("staff").orderBy("displayOrder", "asc").get();
        this.staffList = snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .filter(s => s.name && s.active !== false);
      } catch (_) { this.staffList = []; }
    }

    // 物件フィルタ (目アイコン型で統一)
    this._visiblePropIds = this.properties.map(p => p.id);
    this._propEyeCtrl = PropertyEyeFilter.render({
      containerId: "propEyeFilterHost-prepaidCards",
      tabKey: "prepaidCards",
      properties: this.properties,
      onChange: (visibleIds) => {
        this._visiblePropIds = visibleIds;
        this.renderList();
      },
    });

    this.renderChargeRules();
    this.renderList();
  },

  renderChargeRules() {
    const wrap = document.getElementById("chargeRulesList");
    if (!wrap) return;
    if (!this.chargeRules || !this.chargeRules.length) {
      this.chargeRules = [{ depotId: "", chargeAmount: 2000, balance: 2200 }];
    }
    const depotOpts = `<option value="">-- 全店舗共通 --</option>` +
      this.depots.map(d => `<option value="${d.id || d.name}">${this._esc(d.name)}</option>`).join("");
    wrap.innerHTML = this.chargeRules.map((r, i) => `
      <div class="d-flex align-items-center gap-2 mb-1 charge-rule-row flex-wrap" data-idx="${i}">
        <select class="form-select form-select-sm cr-depot" style="width:auto;min-width:180px;">${depotOpts}</select>
        <span class="small text-muted">購入</span>
        <input type="number" class="form-control form-control-sm cr-charge" value="${r.chargeAmount || 0}" min="0" style="width:110px;">
        <span class="small text-muted">円 →</span>
        <span class="small text-muted">残高</span>
        <input type="number" class="form-control form-control-sm cr-balance" value="${r.balance || 0}" min="0" style="width:110px;">
        <span class="small text-muted">円</span>
        <button type="button" class="btn btn-sm btn-outline-danger cr-remove"><i class="bi bi-x"></i></button>
      </div>
    `).join("");
    // 店舗 select の値を反映
    wrap.querySelectorAll(".charge-rule-row").forEach(row => {
      const idx = +row.dataset.idx;
      const sel = row.querySelector(".cr-depot");
      if (sel) sel.value = this.chargeRules[idx].depotId || "";
    });
    wrap.querySelectorAll(".cr-remove").forEach(b => b.addEventListener("click", (e) => {
      const idx = +e.target.closest("[data-idx]").dataset.idx;
      this.chargeRules.splice(idx, 1);
      this.renderChargeRules();
    }));
  },

  addChargeRule() {
    if (!this.chargeRules) this.chargeRules = [];
    this.chargeRules.push({ depotId: "", chargeAmount: 0, balance: 0 });
    this.renderChargeRules();
  },

  async saveChargeRules() {
    const rules = [];
    document.querySelectorAll("#chargeRulesList .charge-rule-row").forEach(row => {
      const depotId = row.querySelector(".cr-depot")?.value || "";
      const charge = Number(row.querySelector(".cr-charge").value) || 0;
      const balance = Number(row.querySelector(".cr-balance").value) || 0;
      if (charge > 0) rules.push({ depotId, chargeAmount: charge, balance });
    });
    // 店舗ID → 購入額 の順で昇順
    rules.sort((a, b) => (a.depotId || "").localeCompare(b.depotId || "") || a.chargeAmount - b.chargeAmount);
    try {
      await db.collection("settings").doc("prepaidCards").set({
        chargeRules: rules,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      this.chargeRules = rules;
      showToast("保存", "チャージ額ルールを保存しました", "success");
      this.renderChargeRules();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  // 購入金額+店舗IDに対応する残高を返す
  // 優先順: (depotId一致 + chargeAmount一致) > (depotId空=全店共通 + chargeAmount一致) > chargeAmount(互換)
  _resolveBalance(chargeAmount, depotId) {
    const rules = this.chargeRules || [];
    const amt = Number(chargeAmount);
    // 1. 店舗IDもchargeAmountも一致
    let rule = rules.find(r => Number(r.chargeAmount) === amt && (r.depotId || "") === (depotId || ""));
    if (rule && rule.balance) return Number(rule.balance);
    // 2. 全店共通 (depotId 空) で chargeAmount 一致
    if (depotId) {
      rule = rules.find(r => Number(r.chargeAmount) === amt && !r.depotId);
      if (rule && rule.balance) return Number(rule.balance);
    }
    // 3. 旧データ互換: depotIdフィールド無しで chargeAmount 一致
    rule = rules.find(r => r.depotId === undefined && Number(r.chargeAmount) === amt);
    if (rule && rule.balance) return Number(rule.balance);
    return amt || 0;
  },

  // 店舗(depotId)ごとに頭文字prefix+3桁連番
  _nextCardNumber(depotId) {
    if (!depotId) return "";
    const prefix = this.depotPrefixes[depotId] || "";
    if (!prefix) return "";
    const pattern = new RegExp(`^${this._escRegex(prefix)}(\\d{3})$`);
    let max = 0;
    this.cards.forEach(c => {
      if (c.depotId !== depotId) return;
      const m = (c.cardNumber || "").match(pattern);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return `${prefix}${String(max + 1).padStart(3, "0")}`;
  },

  _escRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); },

  _filteredCards() {
    const showUsed = document.getElementById("showUsedCards")?.checked || false;
    const visibleSet = new Set(this._visiblePropIds || this.properties.map(p => p.id));
    return this.cards
      .map((c, _idx) => ({ c, _idx }))
      .filter(({ c }) => showUsed || (Number(c.balance) || 0) > 0)
      .filter(({ c }) => {
        // スタッフ時は担当物件に紐づくカードのみ
        if (!this.canEdit && this.staffDoc) {
          const assigned = new Set(this.staffDoc.assignedPropertyIds || []);
          return (c.propertyIds || []).some(pid => assigned.has(pid));
        }
        return true;
      })
      .filter(({ c }) => {
        // propertyIds が空のカードは常に表示、それ以外は可視物件と交差するもののみ
        const pids = c.propertyIds || [];
        if (pids.length === 0) return true;
        return pids.some(pid => visibleSet.has(pid));
      })
      .sort((a, b) => {
        // 紐付け提出先 → カード番号
        const ao = this.depots.findIndex(d => (d.id || d.name) === a.c.depotId);
        const bo = this.depots.findIndex(d => (d.id || d.name) === b.c.depotId);
        if (ao !== bo) return ao - bo;
        return String(a.c.cardNumber || "").localeCompare(String(b.c.cardNumber || ""), "ja");
      });
  },

  renderList() {
    const wrap = document.getElementById("prepaidList");
    if (!this.depots.length && this.canEdit) {
      wrap.innerHTML = `<div class="col-12"><div class="alert alert-warning">コインランドリー種別の提出先が登録されていません。<a href="#/laundry">ランドリーページ</a>で追加してください。</div></div>`;
      return;
    }
    const filtered = this._filteredCards();
    if (!filtered.length) {
      const showUsed = document.getElementById("showUsedCards")?.checked || false;
      wrap.innerHTML = `<div class="col-12 text-muted">${showUsed ? 'カードがありません' : '使用済み以外のカードがありません。上の「使用済みも表示」をONにするか、「プリカ追加」で登録してください。'}</div>`;
      return;
    }

    // 店舗ごとグルーピング
    const grouped = {};
    filtered.forEach(({ c, _idx }) => {
      const key = c.depotId || "__unassigned__";
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push({ c, _idx });
    });
    const propMap = {};
    this.properties.forEach(p => { propMap[p.id] = p.name; });

    const depotOpts = `<option value="">-- 選択 --</option>` +
      this.depots.map(d => `<option value="${d.id || d.name}">${this._esc(d.name)}</option>`).join("");
    const propertyChecksFor = (selected, idx) => this.properties.map(p =>
      `<label class="form-check form-check-inline mb-0 small"><input type="checkbox" class="form-check-input c-property" value="${p.id}" ${(selected || []).includes(p.id) ? "checked" : ""} ${!this.canEdit ? "disabled" : ""}> ${renderPropertyNumberBadge(p)}${this._esc(p.name)}</label>`
    ).join("");

    wrap.innerHTML = Object.entries(grouped).map(([depotId, list]) => {
      const depot = this.depots.find(d => (d.id || d.name) === depotId);
      const title = depot ? depot.name : "紐付け未設定";
      const currentPrefix = this.depotPrefixes[depotId] || "";
      const prefixEditor = this.canEdit && depot ? `
        <div class="mb-2 small">
          <label class="form-label small mb-0">番号の頭文字</label>
          <input type="text" class="form-control form-control-sm depot-prefix" data-depot-id="${depotId}" value="${this._esc(currentPrefix)}" placeholder="例: 小柴" style="max-width:180px;">
          <span class="text-muted">→ 自動で「${this._esc(currentPrefix || '頭文字')}001, ${this._esc(currentPrefix || '頭文字')}002...」</span>
        </div>` : "";
      return `
        <div class="col-12">
          <h6 class="mt-2"><i class="bi bi-shop"></i> ${this._esc(title)} <span class="badge bg-secondary">${list.length}枚</span></h6>
          ${prefixEditor}
          <div class="row g-2">
            ${list.map(({ c, _idx }) => {
              const isUsed = (Number(c.balance) || 0) <= 0;
              return `
                <div class="col-md-6 col-lg-4">
                  <div class="card ${isUsed ? 'border-secondary' : ''}" data-idx="${_idx}" style="${isUsed ? 'opacity:0.55;background:#f1f3f5;' : ''}">
                    <div class="card-body">
                      ${isUsed ? '<span class="badge bg-secondary mb-2"><i class="bi bi-x-circle"></i> 使用済み</span>' : ''}
                      <div class="row g-2">
                        <div class="col-12">
                          <label class="form-label small mb-1">提出先 (コインランドリー)</label>
                          <select class="form-select form-select-sm c-depot" ${this.canEdit ? '' : 'disabled'}>${depotOpts}</select>
                        </div>
                        <div class="col-12">
                          <label class="form-label small mb-1">カード番号</label>
                          <input type="text" class="form-control form-control-sm c-number" value="${this._esc(c.cardNumber || '')}" readonly style="background:#f8f9fa;">
                        </div>
                        <div class="col-12">
                          <label class="form-label small mb-1">残高 (円)</label>
                          <input type="number" class="form-control form-control-sm c-balance" value="${c.balance || 0}" min="0" ${this.canEdit ? '' : 'readonly'}>
                        </div>
                        <div class="col-12">
                          <label class="form-label small mb-1">利用物件 (複数可)</label>
                          <div class="d-flex flex-wrap gap-1">
                            ${propertyChecksFor(c.propertyIds, _idx)}
                          </div>
                        </div>
                        <div class="col-12">
                          <label class="form-label small mb-1">メモ</label>
                          <input type="text" class="form-control form-control-sm c-memo" value="${this._esc(c.memo || '')}" ${this.canEdit ? '' : 'readonly'}>
                        </div>
                        ${this.canEdit ? `
                        <div class="col-12 text-end">
                          <button class="btn btn-sm btn-outline-danger c-remove"><i class="bi bi-trash"></i> 削除</button>
                        </div>` : ''}
                      </div>
                    </div>
                  </div>
                </div>`;
            }).join("")}
          </div>
        </div>`;
    }).join("");

    wrap.querySelectorAll(".card[data-idx]").forEach(el => {
      const i = +el.dataset.idx;
      const card = this.cards[i];
      if (card.depotId) el.querySelector(".c-depot").value = card.depotId;
      if (this.canEdit) {
        el.querySelector(".c-depot").addEventListener("change", (e) => {
          const newDepotId = e.target.value;
          this.cards[i].depotId = newDepotId;
          this.cards[i].cardNumber = this._nextCardNumber(newDepotId);
          this.renderList();
        });
        el.querySelector(".c-remove").addEventListener("click", async () => {
          const label = card.cardNumber || `カード #${i + 1}`;
          const ok = await showConfirm(
            `「${label}」を削除しますか？\n残高 ¥${(card.balance || 0).toLocaleString()} の情報も失われます。`,
            { title: "プリカ削除", okLabel: "削除する", okClass: "btn-danger" }
          );
          if (!ok) return;
          this.cards.splice(i, 1);
          this.renderList();
        });
      }
    });

    // 頭文字入力の変更ハンドラ
    wrap.querySelectorAll(".depot-prefix").forEach(el => {
      el.addEventListener("change", () => {
        const depotId = el.dataset.depotId;
        this.depotPrefixes[depotId] = el.value.trim();
        // 既存カードの cardNumber を維持 (新規追加時のみ新 prefix ベースで連番)
      });
    });
  },

  // プリカ追加モーダルを開く (必要情報入力 → [追加する] で新規作成)
  addCard() {
    const modalEl = document.getElementById("prepaidAddModal");
    // 提出先プルダウン
    const depotSel = document.getElementById("newPrepaidDepot");
    depotSel.innerHTML = `<option value="">-- 選択 --</option>` +
      this.depots.map(d => `<option value="${d.id || d.name}">${this._esc(d.name)}</option>`).join("");
    // 物件チェックボックス
    const propWrap = document.getElementById("newPrepaidProperties");
    propWrap.innerHTML = this.properties.map(p =>
      `<label class="form-check form-check-inline mb-0 small"><input type="checkbox" class="form-check-input new-prepaid-property" value="${p.id}"> ${renderPropertyNumberBadge(p)}${this._esc(p.name)}</label>`
    ).join("") || `<div class="text-muted small">利用可能な物件がありません</div>`;
    // 初期値リセット
    const prefixInput = document.getElementById("newPrepaidPrefix");
    const numberInput = document.getElementById("newPrepaidNumber");
    const chargeInput = document.getElementById("newPrepaidCharge");
    const balanceInput = document.getElementById("newPrepaidBalance");
    const memoInput = document.getElementById("newPrepaidMemo");
    prefixInput.value = "";
    numberInput.value = "";
    chargeInput.value = 2000;
    balanceInput.value = this._resolveBalance(2000, depotSel.value);
    memoInput.value = "";

    // 購入者プルダウン: オーナーのみ表示、スタッフ/サブオーナーは非表示で自動決定
    const purchaserWrap = document.getElementById("newPrepaidPurchaserWrap");
    const purchaserSel = document.getElementById("newPrepaidPurchaser");
    const role = (Auth.currentUser && Auth.currentUser.role) || "owner";
    const myStaffId = Auth.currentUser?.staffId || "";
    const myName = Auth.currentUser?.displayName || Auth.currentUser?.name || "";
    if (role === "owner") {
      // オーナーはスタッフ一覧+自分を選択可 (デフォルト自分)
      purchaserWrap.classList.remove("d-none");
      const opts = this.staffList.map(s =>
        `<option value="${s.id}" data-name="${this._esc(s.name)}" ${s.id === myStaffId ? "selected" : ""}>${this._esc(s.name)}${s.isOwner ? " (オーナー)" : ""}</option>`
      ).join("");
      purchaserSel.innerHTML = `<option value="">-- 選択 --</option>` + opts;
      // staffList に自分が含まれていない場合 (オーナーが staff 化されていない等) のフォールバック
      if (myStaffId && !this.staffList.some(s => s.id === myStaffId)) {
        purchaserSel.insertAdjacentHTML("beforeend",
          `<option value="${myStaffId}" data-name="${this._esc(myName)}" selected>${this._esc(myName)} (自分)</option>`);
      }
    } else {
      // スタッフ/サブオーナーは UI 非表示、自分に自動設定
      purchaserWrap.classList.add("d-none");
      purchaserSel.innerHTML = `<option value="${myStaffId}" data-name="${this._esc(myName)}" selected>${this._esc(myName)}</option>`;
    }

    // 購入金額 / 提出先変更時、チャージルールに基づき残高を自動計算
    const recalcBalance = () => {
      const charge = Number(chargeInput.value) || 0;
      balanceInput.value = this._resolveBalance(charge, depotSel.value);
    };
    chargeInput.oninput = recalcBalance;
    // depotSel は既に change リスナーがあるが、recalcBalance も呼ぶために追加
    depotSel.addEventListener("change", recalcBalance);

    const refreshNumber = () => {
      const depotId = depotSel.value;
      const prefix = prefixInput.value.trim();
      if (!depotId || !prefix) { numberInput.value = ""; return; }
      // 既存カードから同じ depotId + prefix のマッチ数+1
      const pattern = new RegExp(`^${this._escRegex(prefix)}(\\d{3})$`);
      let max = 0;
      this.cards.forEach(c => {
        if (c.depotId !== depotId) return;
        const m = (c.cardNumber || "").match(pattern);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      });
      numberInput.value = `${prefix}${String(max + 1).padStart(3, "0")}`;
    };

    // 提出先変更時: 頭文字は「提出先名そのまま」を自動設定 (編集可能)
    depotSel.addEventListener("change", () => {
      const depotId = depotSel.value;
      if (!depotId) { prefixInput.value = ""; refreshNumber(); return; }
      // 1. 既に設定済みの頭文字があればそれを使う (ユーザーが変更済みの可能性)
      if (this.depotPrefixes[depotId]) {
        prefixInput.value = this.depotPrefixes[depotId];
      } else {
        // 2. 提出先名そのものを頭文字に採用
        const depot = this.depots.find(d => (d.id || d.name) === depotId);
        prefixInput.value = (depot?.name || "").trim();
      }
      refreshNumber();
    }, { once: false });
    prefixInput.addEventListener("input", refreshNumber);

    // 追加ボタン
    const btn = document.getElementById("btnCreatePrepaid");
    const newHandler = async () => {
      const depotId = depotSel.value;
      const prefix = prefixInput.value.trim();
      const cardNumber = numberInput.value.trim();
      const balance = Number(balanceInput.value) || 0;
      const chargeAmount = Number(chargeInput.value) || 0;
      if (!depotId) { showToast("入力エラー", "提出先を選択してください", "error"); return; }
      if (!prefix) { showToast("入力エラー", "カード番号の頭文字を入力してください", "error"); return; }
      if (!cardNumber) { showToast("入力エラー", "カード番号が採番できませんでした", "error"); return; }
      // 購入者情報を取得 (オーナー時はプルダウン、スタッフ時は自分)
      const purchaserStaffId = purchaserSel.value || "";
      const purchaserOpt = purchaserSel.options[purchaserSel.selectedIndex];
      const purchaserStaffName = purchaserOpt?.dataset?.name || purchaserOpt?.text || "";
      if (!purchaserStaffId) {
        showToast("入力エラー", "購入者を選択してください", "error");
        return;
      }
      const propertyIds = [...document.querySelectorAll(".new-prepaid-property:checked")].map(cb => cb.value);
      const memo = memoInput.value.trim();
      // 頭文字をマスタにキャッシュ
      this.depotPrefixes[depotId] = prefix;
      const newCard = {
        id: "prepaid_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        cardNumber, balance, depotId, propertyIds, memo,
        // 請求書集計用メタデータ
        chargeAmount,
        purchasedAt: firebase.firestore.Timestamp.now(),
        purchasedBy: { staffId: purchaserStaffId, staffName: purchaserStaffName },
      };
      this.cards.push(newCard);
      // this.cards を直接 Firestore へ保存 (save() は DOM から読む仕様で新規カードが含まれないため)
      try {
        await db.collection("settings").doc("prepaidCards").set({
          items: this.cards,
          depotPrefixes: this.depotPrefixes,
          chargeRules: this.chargeRules || [],
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        this.renderList();
        bootstrap.Modal.getInstance(modalEl).hide();
        showToast("追加しました", `${cardNumber} を追加しました (残高 ¥${balance.toLocaleString()})`, "success");
      } catch (e) {
        showToast("保存失敗", e.message, "error");
      }
    };
    // 既存ハンドラを都度リセット (clone で replace)
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
    document.getElementById("btnCreatePrepaid").addEventListener("click", newHandler);

    bootstrap.Modal.getOrCreateInstance(modalEl).show();
  },

  async save() {
    if (!this.canEdit) return;
    const items = [];
    document.querySelectorAll("#prepaidList .card[data-idx]").forEach(el => {
      const i = +el.dataset.idx;
      const existing = this.cards[i] || {};
      const cardNumber = el.querySelector(".c-number").value.trim();
      if (!cardNumber && !existing.cardNumber) return;  // 空スキップ
      const propertyIds = [...el.querySelectorAll(".c-property:checked")].map(cb => cb.value);
      // 既存メタデータ (chargeAmount/purchasedAt/purchasedBy) は保持して上書きしない
      items.push({
        ...existing,
        id: existing.id || ("prepaid_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        cardNumber: cardNumber || existing.cardNumber,
        balance: Number(el.querySelector(".c-balance").value) || 0,
        depotId: el.querySelector(".c-depot").value || "",
        propertyIds,
        memo: el.querySelector(".c-memo").value.trim(),
      });
    });
    const status = document.getElementById("prepaidSaveStatus");
    status.innerHTML = `<i class="bi bi-arrow-repeat text-muted"></i> 保存中...`;
    try {
      await db.collection("settings").doc("prepaidCards").set({
        items,
        depotPrefixes: this.depotPrefixes,
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
