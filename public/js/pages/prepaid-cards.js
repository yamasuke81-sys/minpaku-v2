/**
 * プリペイドカード管理
 *   コインランドリー店舗ごとに自動連番(ex: 小柴001, 小柴002) でカード登録
 *   残高は洗濯物を出す時に自動減算
 *
 * データ: settings/prepaidCards.items = [{ id, label, cardNumber, balance, depotId, memo }]
 * ルート: #/prepaid-cards
 */
const PrepaidCardsPage = {
  cards: [],
  depots: [],  // コインランドリー種別のみ

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
      <p class="text-muted small">コインランドリー店舗ごとに複数のプリカを管理できます。カード番号は<strong>店舗ごとに自動採番</strong>されます (例: 小柴001, 小柴002)。残高は洗濯物を出した時に自動減算、残高不足時はエラーで使用不可となります。</p>
      <div class="form-check form-switch mb-3">
        <input class="form-check-input" type="checkbox" id="showUsedCards">
        <label class="form-check-label small" for="showUsedCards">使用済み(残高0)のカードも表示</label>
      </div>
      <div id="prepaidList" class="row g-3">
        <div class="col-12 text-muted">読込中...</div>
      </div>
    `;
    document.getElementById("btnAddPrepaid").addEventListener("click", () => this.addCard());
    document.getElementById("btnSavePrepaid").addEventListener("click", () => this.save());
    document.getElementById("showUsedCards").addEventListener("change", () => this.renderList());
    await this.load();
  },

  async load() {
    try {
      const doc = await db.collection("settings").doc("prepaidCards").get();
      this.cards = (doc.exists && Array.isArray(doc.data().items)) ? doc.data().items : [];
    } catch (_) { this.cards = []; }
    // 提出先マスター: コインランドリーのみを表示対象に
    try {
      const doc = await db.collection("settings").doc("laundryDepots").get();
      const all = (doc.exists && Array.isArray(doc.data().items)) ? doc.data().items : [];
      this.depots = all.filter(d => d.kind === "coin_laundry");
    } catch (_) { this.depots = []; }
    this.renderList();
  },

  // 店舗ごと(depotIdベース)に自動連番を生成。prefix は店舗名の先頭キーワード。
  _nextCardNumber(depot) {
    if (!depot) return "";
    const depotId = depot.id || depot.name;
    const depotName = depot.name || "";
    // 店舗名の先頭キーワードを取り出す (例: "小柴 藤三広店" → "小柴")
    const keyword = (depotName.match(/[一-龯ぁ-んァ-ヴー]+/)?.[0] || depotName.slice(0, 6)).trim() || "CARD";
    const pattern = new RegExp(`^${keyword}(\\d{3})$`);
    let max = 0;
    // 同じ depotId に紐づくカードの中で最大値+1
    this.cards.forEach(c => {
      if (c.depotId !== depotId) return;
      const m = (c.cardNumber || "").match(pattern);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return `${keyword}${String(max + 1).padStart(3, "0")}`;
  },

  // 表示用ソート: 紐付け提出先 → カード番号(自動振分) → 残高 → メモ
  _sortedCards() {
    const depotOrder = {};
    this.depots.forEach((d, i) => { depotOrder[d.id || d.name] = i; });
    return [...this.cards]
      .map((c, _idx) => ({ c, _idx }))
      .sort((a, b) => {
        const ao = depotOrder[a.c.depotId] ?? 999;
        const bo = depotOrder[b.c.depotId] ?? 999;
        if (ao !== bo) return ao - bo;
        return String(a.c.cardNumber || "").localeCompare(String(b.c.cardNumber || ""), "ja");
      });
  },

  renderList() {
    const wrap = document.getElementById("prepaidList");
    if (!this.cards.length) {
      wrap.innerHTML = `<div class="col-12 text-muted">プリカが登録されていません。「プリカ追加」から登録してください。</div>`;
      return;
    }
    if (!this.depots.length) {
      wrap.innerHTML = `<div class="col-12"><div class="alert alert-warning">コインランドリー種別の提出先が登録されていません。<a href="#/laundry">ランドリーページ</a>で提出先マスターに「種別=コインランドリー」の業者を追加してください。</div></div>`;
      return;
    }
    const depotOpts = `<option value="">-- 選択 --</option>` +
      this.depots.map(d => `<option value="${d.id || d.name}">${this._esc(d.name)}</option>`).join("");

    const showUsed = document.getElementById("showUsedCards")?.checked || false;
    const sorted = this._sortedCards().filter(({ c }) => showUsed || (Number(c.balance) || 0) > 0);
    // カードを紐付け提出先でグルーピング表示
    const grouped = {};
    sorted.forEach(({ c, _idx }) => {
      const key = c.depotId || "__unassigned__";
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push({ c, _idx });
    });
    if (!sorted.length) {
      wrap.innerHTML = `<div class="col-12 text-muted">${showUsed ? 'カードがありません' : '使用済み以外のカードがありません。上の「使用済みも表示」をONにすると表示されます。'}</div>`;
      return;
    }

    wrap.innerHTML = Object.entries(grouped).map(([depotId, list]) => {
      const depot = this.depots.find(d => (d.id || d.name) === depotId);
      const title = depot ? depot.name : "紐付け未設定";
      return `
        <div class="col-12">
          <h6 class="mt-2"><i class="bi bi-shop"></i> ${this._esc(title)} <span class="badge bg-secondary">${list.length}枚</span></h6>
          <div class="row g-2">
            ${list.map(({ c, _idx }) => {
              const isUsed = (Number(c.balance) || 0) <= 0;
              return `
              <div class="col-md-6 col-lg-4">
                <div class="card ${isUsed ? 'border-secondary' : ''}" data-idx="${_idx}" style="${isUsed ? 'opacity:0.55;background:#f1f3f5;' : ''}">
                  <div class="card-body">
                    ${isUsed ? '<span class="badge bg-secondary mb-2"><i class="bi bi-x-circle"></i> 使用済み (残高0)</span>' : ''}
                    <div class="row g-2">
                      <div class="col-12">
                        <label class="form-label small mb-1">紐付け提出先 (コインランドリー)</label>
                        <select class="form-select form-select-sm c-depot">${depotOpts}</select>
                      </div>
                      <div class="col-12">
                        <label class="form-label small mb-1">カード番号 (自動採番)</label>
                        <input type="text" class="form-control form-control-sm c-number" value="${this._esc(c.cardNumber || '')}" readonly style="background:#f8f9fa;">
                      </div>
                      <div class="col-12">
                        <label class="form-label small mb-1">残高 (円)</label>
                        <input type="number" class="form-control form-control-sm c-balance" value="${c.balance || 0}" min="0">
                      </div>
                      <div class="col-12">
                        <label class="form-label small mb-1">メモ</label>
                        <input type="text" class="form-control form-control-sm c-memo" value="${this._esc(c.memo || '')}" placeholder="例: 購入日、使用頻度 etc.">
                      </div>
                      <div class="col-12 text-end">
                        <button class="btn btn-sm btn-outline-danger c-remove"><i class="bi bi-trash"></i> 削除</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>`;
            }).join("")}
          </div>
        </div>`;
    }).join("");

    // depot値を反映
    wrap.querySelectorAll(".card[data-idx]").forEach(el => {
      const i = +el.dataset.idx;
      const card = this.cards[i];
      if (card.depotId) el.querySelector(".c-depot").value = card.depotId;
      // depot 変更時にカード番号を再採番
      el.querySelector(".c-depot").addEventListener("change", (e) => {
        const newDepotId = e.target.value;
        const depot = this.depots.find(d => (d.id || d.name) === newDepotId);
        this.cards[i].depotId = newDepotId;
        if (depot) {
          this.cards[i].cardNumber = this._nextCardNumber(depot);
        }
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
    });
  },

  addCard() {
    // デフォルト: 最初のコインランドリー店舗 + 自動採番
    const defaultDepot = this.depots[0];
    const depotId = defaultDepot ? (defaultDepot.id || defaultDepot.name) : "";
    const cardNumber = defaultDepot ? this._nextCardNumber(defaultDepot) : "";
    this.cards.push({
      id: "prepaid_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      cardNumber,
      balance: 0,
      depotId,
      memo: "",
    });
    this.renderList();
  },

  async save() {
    const items = [];
    document.querySelectorAll("#prepaidList .card[data-idx]").forEach(el => {
      const i = +el.dataset.idx;
      const existing = this.cards[i] || {};
      items.push({
        id: existing.id || ("prepaid_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        cardNumber: el.querySelector(".c-number").value.trim(),
        balance: Number(el.querySelector(".c-balance").value) || 0,
        depotId: el.querySelector(".c-depot").value || "",
        memo: el.querySelector(".c-memo").value.trim(),
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
