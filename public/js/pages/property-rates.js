/**
 * 宿泊料金（直販）ページ — propertyRates (ゲスト向け1泊料金) の編集UI
 *
 * 予約サイト setouchi-stay.com の料金表示・見積 (/public/quote, /public/availability) の元データ。
 * ※ 報酬単価 (#/rates = propertyWorkItems, スタッフ報酬) とは別物。混同しないこと。
 *
 * 構成: 物件選択 → 基本設定 / 連泊割引 / シーズン料金 → 保存
 *       ＋ 日別上書きカレンダー (overrides/{YYYY-MM-DD})
 *       ＋ 見積プレビュー (本番 /public/quote を呼んで検算)
 * 料金計算の正は functions/api/pricing-logic.js。ここでの日別表示は表示用の簡易複製。
 */
const PropertyRatesPage = {
  properties: [],
  currentPropertyId: null,
  rates: null,       // propertyRates ドキュメント (null = 未設定)
  overrides: {},     // 表示月の日別上書き { "YYYY-MM-DD": {price, note} }
  gridYm: "",        // 上書きカレンダーの表示月 "YYYY-MM"
  dirty: false,

  esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  },
  yen(n) { return "¥" + Number(n || 0).toLocaleString("ja-JP"); },

  async render(container, pathParams) {
    this.dirty = false;
    this.gridYm = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
    container.innerHTML = `
      <div class="container-fluid py-3">
        <div class="d-flex align-items-center flex-wrap gap-2 mb-2">
          <h4 class="mb-0"><i class="bi bi-tags"></i> 宿泊料金（直販）</h4>
        </div>
        <div class="alert alert-info py-2 small mb-3">
          この料金は<strong>予約サイト (setouchi-stay.com) のゲスト向け表示・見積</strong>に使われます。
          スタッフの報酬単価（#/報酬単価）とは別物です。保存後、予約サイトへの反映は最大5分（キャッシュ）です。
        </div>
        <div id="prPropSelector" class="mb-3"></div>
        <div id="prBody"><p class="text-muted">物件を選択してください。</p></div>
      </div>
    `;

    this.properties = await API.properties.listMinpakuNumbered();
    if (!this.properties.length) {
      document.getElementById("prBody").innerHTML = `<p class="text-muted">対象物件がありません。</p>`;
      return;
    }
    // URL クエリ ?propertyId=xxx があれば初期選択 (rates.js と同じ流儀)
    const qs = new URLSearchParams((location.hash.split("?")[1] || ""));
    const qpid = qs.get("propertyId");
    this.currentPropertyId = this.properties.some(p => p.id === qpid) ? qpid : this.properties[0].id;

    this.renderPropertySelector();
    await this.loadProperty();
  },

  renderPropertySelector() {
    const wrap = document.getElementById("prPropSelector");
    if (!wrap) return;
    wrap.innerHTML = `
      <div class="d-flex align-items-center gap-2 flex-wrap">
        <label class="form-label mb-0 small fw-semibold">物件:</label>
        ${this.properties.map(p => `
          <button class="btn btn-sm ${p.id === this.currentPropertyId ? "btn-primary" : "btn-outline-secondary"} pr-prop-btn"
            data-pid="${p.id}" style="font-size:0.78rem;">
            <span class="badge me-1" style="background:${p._color || "#6c757d"};color:#fff;min-width:22px;">${p._num || "-"}</span>
            ${this.esc(p.name)}
          </button>
        `).join("")}
      </div>
    `;
    wrap.querySelectorAll(".pr-prop-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const pid = btn.dataset.pid;
        if (pid === this.currentPropertyId) return;
        if (this.dirty) {
          const ok = await showConfirm("未保存の変更があります。破棄して物件を切り替えますか？", { okLabel: "破棄して切替", okClass: "btn-danger" });
          if (!ok) return;
        }
        this.dirty = false;
        this.currentPropertyId = pid;
        this.renderPropertySelector();
        await this.loadProperty();
      });
    });
  },

  async loadProperty() {
    const body = document.getElementById("prBody");
    body.innerHTML = `<p class="text-muted">読み込み中…</p>`;
    this.rates = await API.properties.getPropertyRates(this.currentPropertyId);
    if (!this.rates) {
      const prop = this.properties.find(p => p.id === this.currentPropertyId);
      body.innerHTML = `
        <div class="card"><div class="card-body">
          <p class="mb-2">「${this.esc(prop?.name || "")}」の宿泊料金は<strong>未設定</strong>です。予約サイトには料金が表示されません。</p>
          <button class="btn btn-primary btn-sm" id="prCreateBtn"><i class="bi bi-plus-lg"></i> 料金を設定する</button>
        </div></div>
      `;
      document.getElementById("prCreateBtn").addEventListener("click", () => {
        // 既定テンプレ (返金不可-10%・金土週末) から編集を開始。保存するまで書き込まれない
        this.rates = {
          currency: "JPY", basePrice: null, weekendPrice: null, weekendDays: [5, 6],
          seasons: [], lengthOfStayDiscounts: [],
          guestSurcharge: { includedGuests: null, perExtraGuest: 0 },
          planModifiers: { standard: 0, nonrefundable: -10 },
          minNights: 1, maxNights: 365,
        };
        this.dirty = true;
        this.renderEditor();
        this.loadOverridesAndGrid();
      });
      return;
    }
    this.renderEditor();
    await this.loadOverridesAndGrid();
  },

  // ---------- エディタ描画 ----------
  renderEditor() {
    const r = this.rates;
    const gs = r.guestSurcharge || {};
    const pm = r.planModifiers || {};
    const wdays = Array.isArray(r.weekendDays) ? r.weekendDays : [5, 6];
    const DOW = ["日", "月", "火", "水", "木", "金", "土"];
    const body = document.getElementById("prBody");
    body.innerHTML = `
      <div class="row g-3">
        <div class="col-12 col-xl-7">
          <div class="card mb-3"><div class="card-body">
            <h6 class="fw-bold mb-3">基本設定</h6>
            <div class="row g-2 align-items-end">
              <div class="col-6 col-md-3">
                <label class="form-label small mb-1">平日1泊 基準料金</label>
                <input type="number" class="form-control form-control-sm pr-in" id="prBase" min="0" step="100" value="${r.basePrice ?? ""}" placeholder="例 15000">
              </div>
              <div class="col-6 col-md-3">
                <label class="form-label small mb-1">週末料金 (空=平日と同額)</label>
                <input type="number" class="form-control form-control-sm pr-in" id="prWeekend" min="0" step="100" value="${r.weekendPrice ?? ""}">
              </div>
              <div class="col-12 col-md-6">
                <label class="form-label small mb-1">週末とみなす曜日</label>
                <div class="d-flex gap-2 flex-wrap">
                  ${DOW.map((d, i) => `
                    <label class="form-check form-check-inline mb-0 small">
                      <input class="form-check-input pr-in pr-wday" type="checkbox" value="${i}" ${wdays.includes(i) ? "checked" : ""}> ${d}
                    </label>`).join("")}
                </div>
              </div>
              <div class="col-6 col-md-3">
                <label class="form-label small mb-1">最低泊数</label>
                <input type="number" class="form-control form-control-sm pr-in" id="prMinN" min="1" value="${r.minNights ?? 1}">
              </div>
              <div class="col-6 col-md-3">
                <label class="form-label small mb-1">最大泊数</label>
                <input type="number" class="form-control form-control-sm pr-in" id="prMaxN" min="1" value="${r.maxNights ?? 365}">
              </div>
              <div class="col-6 col-md-3">
                <label class="form-label small mb-1">基本料金に含む人数</label>
                <input type="number" class="form-control form-control-sm pr-in" id="prInclG" min="1" value="${gs.includedGuests ?? ""}" placeholder="例 2">
              </div>
              <div class="col-6 col-md-3">
                <label class="form-label small mb-1">追加1名あたり/泊</label>
                <input type="number" class="form-control form-control-sm pr-in" id="prPerG" min="0" step="100" value="${gs.perExtraGuest ?? 0}">
              </div>
              <div class="col-6 col-md-3">
                <label class="form-label small mb-1">スタンダード調整%</label>
                <input type="number" class="form-control form-control-sm pr-in" id="prPmStd" step="1" value="${pm.standard ?? 0}">
              </div>
              <div class="col-6 col-md-3">
                <label class="form-label small mb-1">返金不可プラン調整%</label>
                <input type="number" class="form-control form-control-sm pr-in" id="prPmNr" step="1" value="${pm.nonrefundable ?? -10}">
              </div>
            </div>
          </div></div>

          <div class="card mb-3"><div class="card-body">
            <h6 class="fw-bold mb-2">連泊割引</h6>
            <div id="prLosRows"></div>
            <button class="btn btn-outline-secondary btn-sm mt-1" id="prLosAdd"><i class="bi bi-plus"></i> 追加</button>
          </div></div>

          <div class="card mb-3"><div class="card-body">
            <h6 class="fw-bold mb-2">シーズン料金 <span class="text-muted small fw-normal">(期間中は基準料金を差し替え。日別上書きより弱い)</span></h6>
            <div id="prSeasonRows"></div>
            <button class="btn btn-outline-secondary btn-sm mt-1" id="prSeasonAdd"><i class="bi bi-plus"></i> 追加</button>
          </div></div>

          <div class="d-flex align-items-center gap-3 mb-3">
            <button class="btn btn-primary" id="prSave"><i class="bi bi-check-lg"></i> 保存</button>
            <span class="small text-muted" id="prSaveStatus"></span>
          </div>
        </div>

        <div class="col-12 col-xl-5">
          <div class="card mb-3"><div class="card-body">
            <div class="d-flex align-items-center justify-content-between mb-2">
              <h6 class="fw-bold mb-0">日別の上書き料金</h6>
              <div class="btn-group btn-group-sm">
                <button class="btn btn-outline-secondary" id="prGridPrev">&laquo;</button>
                <button class="btn btn-outline-secondary" disabled id="prGridYm"></button>
                <button class="btn btn-outline-secondary" id="prGridNext">&raquo;</button>
              </div>
            </div>
            <p class="text-muted small mb-2">日付をタップすると、その日だけの料金を設定できます（イベント日など）。<span class="badge" style="background:#c9a24b;">金枠</span>=上書きあり。</p>
            <div id="prGrid"></div>
          </div></div>

          <div class="card"><div class="card-body">
            <h6 class="fw-bold mb-2">見積プレビュー <span class="text-muted small fw-normal">(本番APIで検算)</span></h6>
            <div class="row g-2 align-items-end mb-2">
              <div class="col-6 col-md-3"><label class="form-label small mb-1">チェックイン</label><input type="date" class="form-control form-control-sm" id="prQCi"></div>
              <div class="col-6 col-md-3"><label class="form-label small mb-1">チェックアウト</label><input type="date" class="form-control form-control-sm" id="prQCo"></div>
              <div class="col-4 col-md-2"><label class="form-label small mb-1">人数</label><input type="number" class="form-control form-control-sm" id="prQG" min="1" value="2"></div>
              <div class="col-8 col-md-3">
                <label class="form-label small mb-1">プラン</label>
                <select class="form-select form-select-sm" id="prQPlan">
                  <option value="standard">スタンダード</option>
                  <option value="nonrefundable">返金不可(-10%)</option>
                </select>
              </div>
              <div class="col-12 col-md-1"><button class="btn btn-sm btn-outline-primary w-100" id="prQGo">計算</button></div>
            </div>
            <div id="prQOut" class="small"></div>
          </div></div>
        </div>
      </div>
    `;

    this.renderLosRows();
    this.renderSeasonRows();

    // 入力変更で dirty (oninput 代入で再描画時のリスナー累積を防ぐ)
    body.oninput = (e) => { if (e.target.closest(".pr-in")) this.markDirty(); };
    document.getElementById("prLosAdd").addEventListener("click", () => {
      (this.rates.lengthOfStayDiscounts ||= []).push({ minNights: 7, discountPercent: 10 });
      this.markDirty(); this.renderLosRows();
    });
    document.getElementById("prSeasonAdd").addEventListener("click", () => {
      (this.rates.seasons ||= []).push({ name: "", start: "", end: "", price: null, weekendPrice: null });
      this.markDirty(); this.renderSeasonRows();
    });
    document.getElementById("prSave").addEventListener("click", () => this.save());
    document.getElementById("prGridPrev").addEventListener("click", () => this.moveGrid(-1));
    document.getElementById("prGridNext").addEventListener("click", () => this.moveGrid(1));
    document.getElementById("prQGo").addEventListener("click", () => this.runQuote());
  },

  markDirty() {
    this.dirty = true;
    const st = document.getElementById("prSaveStatus");
    if (st) st.textContent = "未保存の変更があります";
  },

  renderLosRows() {
    const list = this.rates.lengthOfStayDiscounts || [];
    const wrap = document.getElementById("prLosRows");
    wrap.innerHTML = list.length ? list.map((d, i) => `
      <div class="d-flex align-items-center gap-2 mb-1 small">
        <input type="number" class="form-control form-control-sm pr-in pr-los-n" data-i="${i}" min="2" value="${d.minNights ?? ""}" style="width:80px">
        <span>泊以上で</span>
        <input type="number" class="form-control form-control-sm pr-in pr-los-p" data-i="${i}" min="0" max="100" value="${d.discountPercent ?? ""}" style="width:80px">
        <span>% OFF</span>
        <button class="btn btn-sm btn-outline-danger pr-los-del" data-i="${i}"><i class="bi bi-trash"></i></button>
      </div>
    `).join("") : `<p class="text-muted small mb-1">連泊割引なし</p>`;
    wrap.querySelectorAll(".pr-los-n").forEach(el => el.addEventListener("input", () => { list[+el.dataset.i].minNights = parseInt(el.value, 10) || 0; }));
    wrap.querySelectorAll(".pr-los-p").forEach(el => el.addEventListener("input", () => { list[+el.dataset.i].discountPercent = Number(el.value) || 0; }));
    wrap.querySelectorAll(".pr-los-del").forEach(el => el.addEventListener("click", () => { list.splice(+el.dataset.i, 1); this.markDirty(); this.renderLosRows(); }));
  },

  renderSeasonRows() {
    const list = this.rates.seasons || [];
    const wrap = document.getElementById("prSeasonRows");
    wrap.innerHTML = list.length ? list.map((s, i) => `
      <div class="row g-1 align-items-center mb-1 small">
        <div class="col-6 col-md-2"><input type="text" class="form-control form-control-sm pr-in pr-se" data-i="${i}" data-k="name" value="${this.esc(s.name || "")}" placeholder="名称(例 お盆)"></div>
        <div class="col-6 col-md-3"><input type="date" class="form-control form-control-sm pr-in pr-se" data-i="${i}" data-k="start" value="${s.start || ""}"></div>
        <div class="col-6 col-md-3"><input type="date" class="form-control form-control-sm pr-in pr-se" data-i="${i}" data-k="end" value="${s.end || ""}"></div>
        <div class="col-5 col-md-2"><input type="number" class="form-control form-control-sm pr-in pr-se" data-i="${i}" data-k="price" min="0" step="100" value="${s.price ?? ""}" placeholder="平日"></div>
        <div class="col-5 col-md-1"><input type="number" class="form-control form-control-sm pr-in pr-se" data-i="${i}" data-k="weekendPrice" min="0" step="100" value="${s.weekendPrice ?? ""}" placeholder="週末"></div>
        <div class="col-2 col-md-1"><button class="btn btn-sm btn-outline-danger pr-se-del" data-i="${i}"><i class="bi bi-trash"></i></button></div>
      </div>
    `).join("") : `<p class="text-muted small mb-1">シーズン料金なし</p>`;
    wrap.querySelectorAll(".pr-se").forEach(el => el.addEventListener("input", () => {
      const s = list[+el.dataset.i]; const k = el.dataset.k;
      s[k] = (k === "name" || k === "start" || k === "end") ? el.value : (el.value === "" ? null : Number(el.value));
    }));
    wrap.querySelectorAll(".pr-se-del").forEach(el => el.addEventListener("click", () => { list.splice(+el.dataset.i, 1); this.markDirty(); this.renderSeasonRows(); }));
  },

  // フォーム値を rates オブジェクトへ収集 (検証込み)
  collect() {
    const num = (id) => { const v = document.getElementById(id).value; return v === "" ? null : Number(v); };
    const basePrice = num("prBase");
    if (!Number.isFinite(basePrice) || basePrice <= 0) return { ok: false, error: "平日1泊の基準料金を入力してください" };
    const weekendDays = [...document.querySelectorAll(".pr-wday:checked")].map(el => +el.value);
    const seasons = (this.rates.seasons || []).filter(s => s.start && s.end && Number.isFinite(Number(s.price)));
    for (const s of seasons) { if (s.end < s.start) return { ok: false, error: `シーズン「${s.name || s.start}」の終了日が開始日より前です` }; }
    const los = (this.rates.lengthOfStayDiscounts || [])
      .filter(d => d.minNights >= 2 && d.discountPercent > 0)
      .sort((a, b) => a.minNights - b.minNights);
    const data = {
      currency: "JPY",
      basePrice,
      weekendPrice: num("prWeekend"),
      weekendDays: weekendDays.length ? weekendDays : [5, 6],
      seasons: seasons.map(s => ({ name: s.name || "", start: s.start, end: s.end, price: Number(s.price), weekendPrice: Number.isFinite(Number(s.weekendPrice)) ? Number(s.weekendPrice) : null })),
      lengthOfStayDiscounts: los.map(d => ({ minNights: d.minNights, discountPercent: d.discountPercent })),
      guestSurcharge: { includedGuests: num("prInclG"), perExtraGuest: num("prPerG") || 0 },
      planModifiers: { standard: num("prPmStd") || 0, nonrefundable: num("prPmNr") || 0 },
      minNights: num("prMinN") || 1,
      maxNights: num("prMaxN") || 365,
    };
    if (this.rates.source) data.source = this.rates.source; // 由来メモ (Airbnb listingId 等) は保持
    return { ok: true, data };
  },

  async save() {
    const r = this.collect();
    if (!r.ok) { await showAlert(r.error); return; }
    const btn = document.getElementById("prSave");
    btn.disabled = true;
    try {
      await API.properties.savePropertyRates(this.currentPropertyId, r.data);
      this.rates = { ...r.data };
      this.dirty = false;
      const now = new Date();
      document.getElementById("prSaveStatus").textContent =
        `保存しました ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} (予約サイト反映は最大5分)`;
      this.renderGrid(); // 基準/週末変更を日別表示に反映
    } catch (e) {
      console.error("[property-rates] 保存失敗:", e);
      await showAlert("保存に失敗しました: " + e.message);
    } finally {
      btn.disabled = false;
    }
  },

  // ---------- 日別上書きカレンダー ----------
  async loadOverridesAndGrid() {
    const ym = this.gridYm;
    try {
      this.overrides = await API.properties.getRateOverrides(this.currentPropertyId, `${ym}-01`, `${ym}-31`);
    } catch (e) {
      console.warn("[property-rates] overrides 取得失敗:", e.message);
      this.overrides = {};
    }
    this.renderGrid();
  },

  async moveGrid(delta) {
    const [y, m] = this.gridYm.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    this.gridYm = d.toISOString().slice(0, 7);
    await this.loadOverridesAndGrid();
  },

  // その日の実効1泊料金 (表示用の簡易版。正は functions/api/pricing-logic.js)
  effectiveRate(ymd) {
    const r = this.rates;
    if (!r || !Number.isFinite(Number(r.basePrice))) return null;
    const ov = this.overrides[ymd];
    if (ov && Number.isFinite(Number(ov.price))) return { price: Number(ov.price), override: true };
    const dow = new Date(ymd + "T00:00:00Z").getUTCDay();
    const weekendDays = (Array.isArray(r.weekendDays) && r.weekendDays.length) ? r.weekendDays : [5, 6];
    const isWe = weekendDays.includes(dow);
    const season = (r.seasons || []).find(s => s.start && s.end && ymd >= s.start && ymd <= s.end);
    if (season) {
      const p = isWe && Number.isFinite(Number(season.weekendPrice)) ? Number(season.weekendPrice) : Number(season.price);
      if (Number.isFinite(p)) return { price: p, season: true };
    }
    if (isWe && Number.isFinite(Number(r.weekendPrice))) return { price: Number(r.weekendPrice) };
    return { price: Number(r.basePrice) };
  },

  renderGrid() {
    const wrap = document.getElementById("prGrid");
    const ymBtn = document.getElementById("prGridYm");
    if (!wrap) return;
    const [y, m] = this.gridYm.split("-").map(Number);
    if (ymBtn) ymBtn.textContent = `${y}年${m}月`;
    const first = new Date(Date.UTC(y, m - 1, 1));
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const DOW = ["日", "月", "火", "水", "木", "金", "土"];
    let html = `<table class="table table-sm table-bordered text-center mb-0" style="table-layout:fixed;font-size:0.75rem;">
      <thead><tr>${DOW.map(d => `<th class="p-1 fw-normal text-muted">${d}</th>`).join("")}</tr></thead><tbody><tr>`;
    for (let i = 0; i < first.getUTCDay(); i++) html += `<td class="p-1"></td>`;
    let col = first.getUTCDay();
    for (let d = 1; d <= daysInMonth; d++) {
      const ymd = `${this.gridYm}-${String(d).padStart(2, "0")}`;
      const eff = this.effectiveRate(ymd);
      const ov = !!(this.overrides[ymd]);
      const style = ov ? "box-shadow:inset 0 0 0 2px #c9a24b;background:#fdf8ec;cursor:pointer;" : "cursor:pointer;";
      html += `<td class="p-1 pr-day" data-date="${ymd}" style="${style}">
        <div>${d}</div>
        <div class="text-muted" style="font-size:0.62rem;white-space:nowrap;">${eff ? this.yen(eff.price) : "-"}</div>
      </td>`;
      col++;
      if (col === 7 && d < daysInMonth) { html += `</tr><tr>`; col = 0; }
    }
    while (col > 0 && col < 7) { html += `<td class="p-1"></td>`; col++; }
    html += `</tr></tbody></table>`;
    wrap.innerHTML = html;
    wrap.querySelectorAll(".pr-day").forEach(td => td.addEventListener("click", () => this.openOverrideDialog(td.dataset.date)));
  },

  async openOverrideDialog(ymd) {
    const cur = this.overrides[ymd] || {};
    const eff = this.effectiveRate(ymd);
    // 既存モーダルを使い回し (無ければ生成)
    let el = document.getElementById("prOvModal");
    if (!el) {
      el = document.createElement("div");
      el.id = "prOvModal";
      el.className = "modal fade";
      el.tabIndex = -1;
      el.innerHTML = `
        <div class="modal-dialog modal-sm"><div class="modal-content">
          <div class="modal-header py-2"><h6 class="modal-title" id="prOvTitle"></h6>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
          <div class="modal-body py-2">
            <label class="form-label small mb-1">この日の1泊料金 (空にして保存=上書き解除)</label>
            <input type="number" class="form-control form-control-sm mb-2" id="prOvPrice" min="0" step="100">
            <label class="form-label small mb-1">メモ (任意)</label>
            <input type="text" class="form-control form-control-sm" id="prOvNote" placeholder="例 花火大会">
          </div>
          <div class="modal-footer py-2">
            <button class="btn btn-sm btn-outline-danger me-auto d-none" id="prOvDel">上書き解除</button>
            <button class="btn btn-sm btn-secondary" data-bs-dismiss="modal">キャンセル</button>
            <button class="btn btn-sm btn-primary" id="prOvSave">保存</button>
          </div>
        </div></div>`;
      document.body.appendChild(el);
    }
    el.querySelector("#prOvTitle").textContent = `${ymd} の料金上書き`;
    const priceIn = el.querySelector("#prOvPrice");
    const noteIn = el.querySelector("#prOvNote");
    priceIn.value = cur.price ?? "";
    priceIn.placeholder = eff ? `現在 ${this.yen(eff.price)}` : "";
    noteIn.value = cur.note || "";
    const delBtn = el.querySelector("#prOvDel");
    delBtn.classList.toggle("d-none", !this.overrides[ymd]);
    const modal = bootstrap.Modal.getOrCreateInstance(el);

    // ハンドラを毎回貼り替え (クローンで既存リスナーを剥がす)
    const saveBtn = el.querySelector("#prOvSave");
    const newSave = saveBtn.cloneNode(true); saveBtn.replaceWith(newSave);
    const newDel = delBtn.cloneNode(true); delBtn.replaceWith(newDel);
    newDel.classList.toggle("d-none", !this.overrides[ymd]);

    newSave.addEventListener("click", async () => {
      const v = priceIn.value;
      try {
        if (v === "") {
          if (this.overrides[ymd]) await API.properties.deleteRateOverride(this.currentPropertyId, ymd);
          delete this.overrides[ymd];
        } else {
          const price = Number(v);
          if (!Number.isFinite(price) || price <= 0) { await showAlert("料金は正の数値で入力してください"); return; }
          const data = { price };
          if (noteIn.value.trim()) data.note = noteIn.value.trim().slice(0, 100);
          await API.properties.setRateOverride(this.currentPropertyId, ymd, data);
          this.overrides[ymd] = data;
        }
        modal.hide();
        this.renderGrid();
      } catch (e) {
        console.error("[property-rates] 上書き保存失敗:", e);
        await showAlert("保存に失敗しました: " + e.message);
      }
    });
    newDel.addEventListener("click", async () => {
      try {
        await API.properties.deleteRateOverride(this.currentPropertyId, ymd);
        delete this.overrides[ymd];
        modal.hide();
        this.renderGrid();
      } catch (e) {
        await showAlert("解除に失敗しました: " + e.message);
      }
    });
    modal.show();
  },

  // ---------- 見積プレビュー (本番 /public/quote で検算) ----------
  async runQuote() {
    const out = document.getElementById("prQOut");
    const ci = document.getElementById("prQCi").value;
    const co = document.getElementById("prQCo").value;
    const g = document.getElementById("prQG").value || 2;
    const plan = document.getElementById("prQPlan").value;
    if (!ci || !co || co <= ci) { out.innerHTML = `<span class="text-danger">日付を正しく指定してください</span>`; return; }
    out.textContent = "計算中…";
    try {
      const CF_BASE = "https://api-5qrfx7ujcq-an.a.run.app";
      // cb= でCDN/ブラウザの5分キャッシュを回避 (編集直後の検算用)
      const url = `${CF_BASE}/public/quote/${encodeURIComponent(this.currentPropertyId)}?checkIn=${ci}&checkOut=${co}&guests=${g}&plan=${plan}&cb=${Date.now()}`;
      const res = await fetch(url);
      const q = await res.json();
      if (!res.ok) { out.innerHTML = `<span class="text-danger">${this.esc(q.error || ("HTTP " + res.status))}</span>`; return; }
      if (!q.hasRates) { out.innerHTML = `<span class="text-warning">この物件の料金は未設定です (保存後にお試しください)</span>`; return; }
      const row = (l, v) => `<div class="d-flex justify-content-between"><span>${l}</span><span>${v}</span></div>`;
      out.innerHTML = [
        row(`宿泊料 小計 (${q.nights}泊)`, this.yen(q.subtotal)),
        q.lengthOfStayDiscountAmount > 0 ? row(`連泊割引 (${q.lengthOfStayDiscountPercent}%)`, "-" + this.yen(q.lengthOfStayDiscountAmount)) : "",
        q.guestSurcharge > 0 ? row(`追加人数料金 (+${q.extraGuests}名)`, "+" + this.yen(q.guestSurcharge)) : "",
        q.planModifierAmount !== 0 ? row(`プラン調整`, (q.planModifierAmount < 0 ? "-" : "+") + this.yen(Math.abs(q.planModifierAmount))) : "",
        `<hr class="my-1">`,
        row(`<strong>合計</strong>`, `<strong>${this.yen(q.total)}</strong>`),
      ].filter(Boolean).join("");
    } catch (e) {
      out.innerHTML = `<span class="text-danger">取得失敗: ${this.esc(e.message)}</span>`;
    }
  },
};
