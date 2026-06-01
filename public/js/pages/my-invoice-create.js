/**
 * 請求書作成ページ (スタッフ + Webアプリ管理者両用) — 2026-04-21 リファクタ版
 *   - 過去の請求書一覧 (my-invoice を統合)
 *   - 月指定 → 自動集計を縦テーブル (日付/項目/単価/備考) で表示
 *   - 追加明細: 日付/項目/金額/メモ の 4 列
 *   - 請求書記載情報 (銀行口座等) は折りたたみ式
 *   - 必須項目未入力時は自動展開 + 赤枠 + トースト + 送信キャンセル
 *
 * ルート: #/my-invoice-create
 */
const MyInvoiceCreatePage = {
  CF_BASE: "https://api-5qrfx7ujcq-an.a.run.app",
  staffId: null,
  staffDoc: null,
  isOwner: false,
  staffOptions: [],    // Webアプリ管理者用スタッフ一覧
  workItemOptions: [], // { key, label, amount } 報酬プルダウン用
  _summaryRows: [],    // 集計行キャッシュ (縦テーブル表示用)
  propertyId: null,    // 選択中の物件ID (物件別請求書)
  propertyMap: {},     // { id: {name, ...} } 物件マスタキャッシュ
  _editingInvoiceId: null, // 送信済み請求書を編集再送中の invoiceId (null=新規作成)

  // 請求書記載情報の必須項目
  REQUIRED_STAFF_FIELDS: ["name", "address", "email", "bankName", "branchName", "accountNumber", "accountHolder"],

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
    // viewAsStaff (管理者のスタッフ視点閲覧) で上書き
    this._viewAsStaffId = (typeof App !== "undefined" && App.getViewAsStaffId) ? App.getViewAsStaffId() : null;
    if (this._viewAsStaffId) this.staffId = this._viewAsStaffId;

    const today = new Date();
    const defaultYM = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0");

    // スタッフ一覧 (Webアプリ管理者の場合セレクタを出す)
    let staffSelectorHtml = "";
    if (this.isOwner) {
      const snap = await db.collection("staff").orderBy("displayOrder", "asc").get();
      this.staffOptions = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.name);
      // impersonation 中: 物件オーナーが担当する物件の担当スタッフのみ表示
      if (typeof App !== "undefined" && App.impersonating && App.impersonatingData) {
        const ownedA = new Set(App.impersonatingData.ownedPropertyIds || []);
        this.staffOptions = this.staffOptions.filter(s => {
          const assigned = Array.isArray(s.assignedPropertyIds) ? s.assignedPropertyIds : [];
          return assigned.some(pid => ownedA.has(pid));
        });
        // 現在の staffId が候補外ならリセット
        if (this.staffId && !this.staffOptions.find(s => s.id === this.staffId)) {
          this.staffId = null;
        }
      }
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
        <h2><i class="bi bi-receipt"></i> 請求書${this.isOwner ? ' <small class="text-muted">(Webアプリ管理者テスト)</small>' : ''}</h2>
        <div class="d-flex align-items-center gap-2 flex-wrap">
          ${staffSelectorHtml}
          <input type="month" class="form-control form-control-sm" id="invMonth" value="${defaultYM}" style="width:160px;">
          <select id="invPropertySel" class="form-select form-select-sm" style="width:180px;">
            <option value="">物件を選択</option>
          </select>
          <button class="btn btn-sm btn-outline-primary" id="btnRecalc"><i class="bi bi-arrow-clockwise"></i> 再集計</button>
          <!-- プレビューボタン: PDF 同等の見た目を新タブ的モーダルで表示 -->
          <button class="btn btn-sm btn-outline-info" id="btnPreviewPdf" title="PDFプレビュー">
            <i class="bi bi-file-earmark-pdf"></i> プレビュー
          </button>
          <!-- 歯車アイコン: 請求書記載情報モーダルを開く -->
          <button class="btn btn-sm btn-outline-secondary" id="btnStaffInfoSettings" title="請求書記載情報" data-bs-toggle="tooltip">
            <i class="bi bi-gear"></i>
          </button>
        </div>
      </div>

      <!-- PDF プレビュー モーダル -->
      <div class="modal fade" id="pdfPreviewModal" tabindex="-1" aria-labelledby="pdfPreviewModalTitle">
        <div class="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header py-2">
              <h5 class="modal-title" id="pdfPreviewModalTitle"><i class="bi bi-file-earmark-pdf"></i> 請求書プレビュー</h5>
              <div class="ms-auto d-flex gap-2 me-2">
                <a class="btn btn-sm btn-outline-primary" id="btnPdfOpenNewTab" href="#" target="_blank" rel="noopener">
                  <i class="bi bi-box-arrow-up-right"></i> 新タブで開く
                </a>
                <a class="btn btn-sm btn-outline-success" id="btnPdfDownload" href="#" download>
                  <i class="bi bi-download"></i> ダウンロード
                </a>
              </div>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body p-0" style="min-height:80vh;">
              <iframe id="pdfPreviewIframe" src="about:blank" style="width:100%;height:80vh;border:0;"></iframe>
            </div>
          </div>
        </div>
      </div>

      <!-- 編集モードバナー (送信済み請求書の編集再送時に表示) -->
      <div id="editModeBanner" class="d-none"></div>

      <!-- あなたの報酬単価 (本人個別単価のみ表示、お盆/正月の特別加算も併記) -->
      <div id="myRatesPanel"></div>

      <!-- 自動集計 (縦テーブル) -->
      <div class="card mb-3">
        <div class="card-body">
          <h6 class="mb-2"><i class="bi bi-list-ul"></i> 自動集計</h6>
          <div id="invSummary"><div class="text-muted small">読込中...</div></div>
        </div>
      </div>

      <!-- 追加明細 -->
      <div class="card mb-3">
        <div class="card-body">
          <h6 class="mb-2">追加明細</h6>
          <div class="table-responsive">
            <table class="table table-sm align-middle" style="min-width:720px;">
              <thead>
                <tr>
                  <th style="width:150px;">日付</th>
                  <th style="min-width:200px;">項目</th>
                  <th style="width:140px;">金額(円)</th>
                  <th style="min-width:180px;">メモ</th>
                  <th style="width:60px;"></th>
                </tr>
              </thead>
              <tbody id="manualRows"></tbody>
            </table>
          </div>
          <button class="btn btn-sm btn-outline-secondary" id="btnAddRow"><i class="bi bi-plus"></i> 行を追加</button>
        </div>
      </div>

      <!-- メモ (スタッフ→Webアプリ管理者) — 毎月内容を変えて OK、staff には保存しない -->
      <div class="card mb-3">
        <div class="card-body">
          <label class="form-label mb-1" for="invoiceMemoText">
            <i class="bi bi-chat-left-text"></i> メモ
          </label>
          <div class="small text-muted mb-2">請求書のメモ欄に表示されます。</div>
          <textarea id="invoiceMemoText" class="form-control form-control-sm" rows="3"></textarea>
        </div>
      </div>

      <!-- 合計 + 送信ボタン -->
      <div class="card mb-3 border-primary">
        <div class="card-body d-flex justify-content-between align-items-center">
          <div>
            <div class="small text-muted">合計金額</div>
            <div class="fs-3 fw-bold" id="invTotal">¥0</div>
          </div>
          <button class="btn btn-primary btn-lg" id="btnSubmitInvoice">
            <i class="bi bi-send"></i> Webアプリ管理者へ送信
          </button>
        </div>
      </div>
      <div id="invResult"></div>

      <!-- 過去の請求書 -->
      <div class="card mb-3">
        <div class="card-body">
          <h6 class="mb-2"><i class="bi bi-clock-history"></i> 過去の請求書</h6>
          <div id="pastInvoicesList" class="small">
            <div class="text-muted"><span class="spinner-border spinner-border-sm"></span> 読込中...</div>
          </div>
        </div>
      </div>

      <!-- 請求書記載情報モーダル (歯車アイコンで開く) -->
      <div class="modal fade" id="staffInfoModal" tabindex="-1" aria-labelledby="staffInfoModalLabel" aria-hidden="true">
        <div class="modal-dialog modal-lg modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="staffInfoModalLabel">
                <i class="bi bi-person-vcard"></i> 請求書記載情報
                <span id="staffInfoSaveStatus" class="small ms-2"></span>
              </h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="閉じる"></button>
            </div>
            <div class="modal-body">
              <div class="small text-muted mb-2">この情報は<strong>スタッフマスタと同期</strong>しています。編集すると自動でスタッフタブにも反映されます。</div>
              <div class="row g-2" id="staffInfoFields">
                <div class="col-md-6"><label class="form-label small mb-1">氏名 <span class="text-danger">*</span></label><input type="text" class="form-control form-control-sm s-field" data-field="name"></div>
                <div class="col-md-6"><label class="form-label small mb-1">電話</label><input type="tel" class="form-control form-control-sm s-field" data-field="phone"></div>
                <div class="col-md-12"><label class="form-label small mb-1">住所 <span class="text-danger">*</span></label><input type="text" class="form-control form-control-sm s-field" data-field="address"></div>
                <div class="col-md-6"><label class="form-label small mb-1">メールアドレス <span class="text-danger">*</span></label><input type="email" class="form-control form-control-sm s-field" data-field="email"></div>
                <div class="col-md-6"></div>
                <div class="col-md-6"><label class="form-label small mb-1">金融機関名 <span class="text-danger">*</span></label><input type="text" class="form-control form-control-sm s-field" data-field="bankName"></div>
                <div class="col-md-6"><label class="form-label small mb-1">支店名 <span class="text-danger">*</span></label><input type="text" class="form-control form-control-sm s-field" data-field="branchName"></div>
                <div class="col-md-4"><label class="form-label small mb-1">口座種類</label>
                  <select class="form-select form-select-sm s-field" data-field="accountType">
                    <option value="普通">普通</option><option value="当座">当座</option>
                  </select>
                </div>
                <div class="col-md-4"><label class="form-label small mb-1">口座番号 <span class="text-danger">*</span></label><input type="text" class="form-control form-control-sm s-field" data-field="accountNumber"></div>
                <div class="col-md-4"><label class="form-label small mb-1">口座名義 <span class="text-danger">*</span></label><input type="text" class="form-control form-control-sm s-field" data-field="accountHolder"></div>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">閉じる</button>
            </div>
          </div>
        </div>
      </div>
    `;

    if (this.isOwner) {
      // viewAsStaff 中はサイドバー側プルダウンが優先。本ページ内 select は無効化
      if (this._viewAsStaffId) {
        const sel = document.getElementById("invStaffSel");
        if (sel) { sel.disabled = true; sel.title = "サイドバーの『○○として閲覧』で切替中"; }
      }
      document.getElementById("invStaffSel").addEventListener("change", async (e) => {
        this.staffId = e.target.value;
        this.propertyId = null; // スタッフ切替で物件選択リセット
        await this.loadStaffDoc();
        await this.loadWorkItemOptions();
        await this.rebuildPropertySelect();
        this.renderMyRates(); // propertyId 確定後に描画
        await this.loadSummary();
        await this.loadPastInvoices();
      });
    }
    document.getElementById("btnAddRow").addEventListener("click", () => this.addManualRow());
    document.getElementById("btnRecalc").addEventListener("click", () => this.loadSummary());
    document.getElementById("invMonth").addEventListener("change", () => this.loadSummary());
    document.getElementById("invPropertySel").addEventListener("change", (e) => {
      this.propertyId = e.target.value || null;
      this.renderMyRates();
      this.loadSummary();
    });
    document.getElementById("btnSubmitInvoice").addEventListener("click", () => this.submit());
    document.getElementById("btnPreviewPdf").addEventListener("click", () => this.previewPdf());

    // プレビューモーダルが閉じたら iframe の Blob URL を解放 + backdrop クリーンアップ
    document.getElementById("pdfPreviewModal").addEventListener("hidden.bs.modal", () => {
      if (this._previewBlobUrl) {
        URL.revokeObjectURL(this._previewBlobUrl);
        this._previewBlobUrl = null;
      }
      const ifr = document.getElementById("pdfPreviewIframe");
      if (ifr) ifr.src = "about:blank";
      // 念のため backdrop と body class を強制削除 (PDF ビューア起動で
      // ライフサイクルが切れて backdrop が残るバグへの保険)
      document.querySelectorAll(".modal-backdrop").forEach(el => el.remove());
      document.body.classList.remove("modal-open");
      document.body.style.overflow = "";
      document.body.style.paddingRight = "";
    });
    // タブ復帰時に backdrop が残っていたら強制掃除
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      const modalEl = document.getElementById("pdfPreviewModal");
      if (modalEl && !modalEl.classList.contains("show")) {
        document.querySelectorAll(".modal-backdrop").forEach(el => el.remove());
        document.body.classList.remove("modal-open");
        document.body.style.overflow = "";
        document.body.style.paddingRight = "";
      }
    });
    // 歯車アイコン: 請求書記載情報モーダルを開く
    document.getElementById("btnStaffInfoSettings").addEventListener("click", () => this.toggleStaffInfo(true));

    if (!this.staffId) {
      container.innerHTML = `<div class="alert alert-warning">スタッフ情報が確認できません</div>`;
      return;
    }

    await this.loadStaffDoc();
    await this.loadWorkItemOptions();
    await this.rebuildPropertySelect();
    this.renderMyRates(); // propertyId 確定後に描画
    await this.loadSummary();
    await this.loadPastInvoices();
  },

  // 物件プルダウンを担当物件のみで再構築
  // スタッフ: 自分の assignedPropertyIds、Webアプリ管理者: 選択中スタッフの assignedPropertyIds
  async rebuildPropertySelect() {
    const sel = document.getElementById("invPropertySel");
    if (!sel) return;
    // 物件マスタを 1 回だけ取得
    if (!Object.keys(this.propertyMap).length) {
      try {
        const snap = await db.collection("properties").where("active", "==", true).get();
        snap.docs.forEach(d => { this.propertyMap[d.id] = { id: d.id, ...d.data() }; });
      } catch (e) {
        console.warn("物件マスタ読込失敗:", e.message);
      }
    }
    const assigned = Array.isArray(this.staffDoc?.assignedPropertyIds) ? this.staffDoc.assignedPropertyIds : [];
    let targetIds = assigned.filter(id => this.propertyMap[id]);
    // impersonation 中: 物件オーナー所有物件のみに絞り込み
    if (typeof App !== "undefined" && App.impersonating && App.impersonatingData) {
      const ownedA = new Set(App.impersonatingData.ownedPropertyIds || []);
      targetIds = targetIds.filter(id => ownedA.has(id));
    }
    const opts = [`<option value="">物件を選択</option>`].concat(
      targetIds.map(id => {
        const p = this.propertyMap[id];
        const selected = this.propertyId === id ? " selected" : "";
        return `<option value="${this._esc(id)}"${selected}>${this._esc(p.name || id)}</option>`;
      })
    ).join("");
    sel.innerHTML = opts;
    // 選択中の propertyId が候補外なら null 化
    if (this.propertyId && !targetIds.includes(this.propertyId)) {
      this.propertyId = null;
    }
    // 担当物件が 1件なら自動選択
    if (!this.propertyId && targetIds.length === 1) {
      this.propertyId = targetIds[0];
      sel.value = this.propertyId;
    }
  },

  // モーダル開閉 (既存 API 互換: forceOpen=true→開く / false→閉じる / null→トグル)
  toggleStaffInfo(forceOpen = null) {
    const modalEl = document.getElementById("staffInfoModal");
    if (!modalEl) return;
    // Bootstrap Modal インスタンスを取得 or 生成
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    const isShown = modalEl.classList.contains("show");
    const shouldOpen = forceOpen === null ? !isShown : forceOpen;
    if (shouldOpen) modal.show();
    else modal.hide();
  },

  // 歯車アイコンの tooltip に記載情報の要約を反映 (未入力なら赤点)
  _updateStaffInfoSummary() {
    const btn = document.getElementById("btnStaffInfoSettings");
    if (!btn) return;
    const d = this.staffDoc || {};
    const acc = d.accountNumber ? String(d.accountNumber).slice(-4) : "";
    const parts = [];
    if (d.name) parts.push(d.name);
    if (d.bankName) parts.push(d.bankName);
    if (acc) parts.push(`末尾${acc}`);
    const summary = parts.length ? parts.join(" / ") : "未入力";
    btn.setAttribute("title", `請求書記載情報 (${summary})`);
    btn.setAttribute("data-bs-original-title", `請求書記載情報 (${summary})`);
  },

  async loadStaffDoc() {
    try {
      const d = await db.collection("staff").doc(this.staffId).get();
      this.staffDoc = d.exists ? { id: d.id, ...d.data() } : {};
    } catch (_) { this.staffDoc = {}; }
    this._renderStaffInfoFields();
    this._updateStaffInfoSummary();
  },

  // スタッフ情報パネルの値を流し込み + 自動保存をセット
  _renderStaffInfoFields() {
    const fields = ["name", "phone", "address", "email", "bankName", "branchName", "accountType", "accountNumber", "accountHolder"];
    fields.forEach(f => {
      const el = document.querySelector(`.s-field[data-field="${f}"]`);
      if (!el) return;
      let v = this.staffDoc[f];
      // 住所の互換: memo に入っているケース
      if (f === "address" && !v) v = this.staffDoc.memo || "";
      el.value = v || (f === "accountType" ? "普通" : "");
      // 入力時に赤枠を解除
      el.classList.remove("is-invalid");
      // 自動保存 (debounced)
      if (!el._saveBound) {
        el._saveBound = true;
        el.addEventListener("input", () => {
          el.classList.remove("is-invalid");
          this._queueStaffSave();
        });
        el.addEventListener("change", () => this._queueStaffSave());
      }
    });
  },

  _queueStaffSave() {
    if (this._staffSaveTimer) clearTimeout(this._staffSaveTimer);
    const status = document.getElementById("staffInfoSaveStatus");
    if (status) status.innerHTML = `<i class="bi bi-arrow-repeat text-muted"></i> 保存中...`;
    this._staffSaveTimer = setTimeout(() => this._saveStaffInfo(), 800);
  },

  async _saveStaffInfo() {
    if (!this.staffId) return;
    const patch = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    document.querySelectorAll(".s-field").forEach(el => {
      patch[el.dataset.field] = el.value || "";
    });
    const status = document.getElementById("staffInfoSaveStatus");
    try {
      await db.collection("staff").doc(this.staffId).set(patch, { merge: true });
      Object.assign(this.staffDoc, patch);
      this._updateStaffInfoSummary();
      if (status) {
        status.innerHTML = `<span class="text-success"><i class="bi bi-check-circle-fill"></i> 保存済み</span>`;
        setTimeout(() => { if (status.innerHTML.includes("保存済み")) status.innerHTML = ""; }, 2000);
      }
    } catch (e) {
      if (status) status.innerHTML = `<span class="text-danger">保存失敗: ${e.message}</span>`;
    }
  },

  // 報酬単価マスタから、このスタッフに適用されるレートを収集
  // ついでに「あなたの報酬単価」セクション用のキャッシュも構築 (specialRates 含む)
  //
  // データ構造 (rates.js / propertyWorkItems):
  //   item.type = "cleaning_by_count" | "pre_inspection" | "other"
  //   item.rateMode = "common" | "perStaff"
  //   item.commonRates = { 1: 5000, 2: 4500, 3: 4000 } (人数別) ※旧 commonRate(scalar) もフォールバック
  //   item.staffRates = { [staffId]: { 1, 2, 3 } } ※旧 scalar もフォールバック
  //   item.specialRates = [{name, addAmount, recurYearly, recurStart, recurEnd, start, end}]
  async loadWorkItemOptions() {
    this.workItemOptions = [];
    this._myRatesByProperty = []; // [{propertyName, items:[{name, type, rates:{1,2,3}, specialRates}]}]
    // 指定 item / count に対する自分の単価を解決 (perStaff > common, scalar → object フォールバック)
    const resolveRate = (it, count) => {
      // staffRates 取得 (rateMode 関係なく perStaff データがあれば優先)
      const sr = it.staffRates && it.staffRates[this.staffId];
      if (sr != null) {
        if (typeof sr === "number") return sr; // 旧 scalar 形式
        if (sr[count] != null) return Number(sr[count]) || 0;
        // 当該 count の値がない場合 perStaff としては未設定 → common にフォールバック
      }
      // commonRates (人数別 object)
      if (it.commonRates && it.commonRates[count] != null) return Number(it.commonRates[count]) || 0;
      // 旧 commonRate (scalar)
      if (typeof it.commonRate === "number") return it.commonRate;
      return 0;
    };
    try {
      const propSnap = await db.collection("properties").get();
      const propMap = {};
      propSnap.docs.forEach(d => { propMap[d.id] = d.data().name || d.id; });

      const itemsSnap = await db.collection("propertyWorkItems").get();
      for (const doc of itemsSnap.docs) {
        const propertyId = doc.id;
        const propertyName = propMap[propertyId] || propertyId;
        const items = (doc.data().items || []).filter(i => i && i.name);
        const myItems = [];
        for (const it of items) {
          const isCleaningByCount = it.type === "cleaning_by_count";
          // 清掃 (人数別) は 1/2/3 人それぞれの単価、それ以外は 1 のみ
          const counts = isCleaningByCount ? [1, 2, 3] : [1];
          const rates = {};
          for (const c of counts) {
            const r = resolveRate(it, c);
            if (r > 0) rates[c] = r;
          }
          if (Object.keys(rates).length === 0) continue; // 自分には単価設定がない

          // workItemOptions (請求書作成プルダウン用) — 人数別の場合は 3 行に分けて追加
          for (const c of Object.keys(rates).map(Number).sort((a,b) => a-b)) {
            const suffix = isCleaningByCount ? `${c}人作業` : "";
            const itemLabel = suffix ? `${it.name}${suffix}` : it.name;
            this.workItemOptions.push({
              key: `${propertyId}:${it.id || it.name}:${c}`,
              propertyId,
              label: `${propertyName} / ${itemLabel}`,
              amount: rates[c],
            });
          }

          myItems.push({
            name: it.name,
            type: it.type || "other",
            isCleaningByCount,
            rates,
            specialRates: (it.specialRates || []).filter(s => s && s.name && Number(s.addAmount) > 0),
          });
        }
        if (myItems.length > 0) {
          // type 表示順: pre_inspection → cleaning_by_count → other
          const order = { pre_inspection: 1, cleaning_by_count: 2, other: 3 };
          myItems.sort((a, b) => (order[a.type] || 9) - (order[b.type] || 9));
          // propertyId キーで引けるよう object 形式でも保持
          this._myRatesByProperty.push({ propertyId, propertyName, items: myItems });
        }
      }
      this._myRatesIndex = {};
      for (const g of this._myRatesByProperty) this._myRatesIndex[g.propertyId] = g;
    } catch (e) {
      console.warn("報酬単価マスタ読込失敗:", e.message);
    }
  },

  // 「報酬単価」セクション描画 (プルダウンで選択中の物件のみ)
  // 表示対象 item:
  //   - type === "pre_inspection" (直前点検)
  //   - type === "cleaning_by_count" (清掃 1/2/3人別)
  //   - type === "other" のうち、name に「ランドリー」+ 補助語 (出し / 受け取り / 搬出 / 回収) を含むもの
  // ランドリー単体 (name === "ランドリー") は除外
  renderMyRates() {
    const el = document.getElementById("myRatesPanel");
    if (!el) return;

    // 共通カード描画ヘルパ (フォールバック / 通常表示で共有)
    const renderCard = (innerHtml) => `
      <div class="card mb-3">
        <div class="card-body py-2" style="font-size:0.8rem;">
          <button class="btn btn-link p-0 text-decoration-none w-100 text-start collapsed d-flex align-items-center"
                  type="button" data-bs-toggle="collapse" data-bs-target="#myRatesCollapse"
                  aria-expanded="false" aria-controls="myRatesCollapse"
                  style="font-size:0.9rem; color:inherit;">
            <i class="bi bi-chevron-right me-1 myrates-caret" style="transition:transform 0.2s;"></i>
            <i class="bi bi-cash-stack me-1"></i> 報酬単価
          </button>
          <div class="collapse" id="myRatesCollapse">
            ${innerHtml}
          </div>
        </div>
      </div>
    `;
    const bindCaret = () => {
      const collapseEl = document.getElementById("myRatesCollapse");
      const caret = el.querySelector(".myrates-caret");
      if (collapseEl && caret) {
        collapseEl.addEventListener("show.bs.collapse", () => { caret.style.transform = "rotate(90deg)"; });
        collapseEl.addEventListener("hide.bs.collapse", () => { caret.style.transform = "rotate(0deg)"; });
      }
    };

    if (!this.propertyId) {
      el.innerHTML = renderCard(`<div class="text-muted mt-2">物件を選択すると単価が表示されます。</div>`);
      bindCaret();
      return;
    }
    const group = this._myRatesIndex && this._myRatesIndex[this.propertyId];
    if (!group) {
      el.innerHTML = renderCard(`<div class="text-muted mt-2">この物件にはあなた向けの単価が登録されていません。</div>`);
      bindCaret();
      return;
    }

    const includeAsLaundry = (name) => {
      const n = String(name || "");
      if (n === "ランドリー") return false; // 単体は除外
      return /ランドリー/.test(n) && /(出し|受け取り|受取|搬出|回収)/.test(n);
    };

    const rows = [];
    for (const it of group.items) {
      const okType =
        it.type === "pre_inspection" ||
        it.type === "cleaning_by_count" ||
        (it.type === "other" && includeAsLaundry(it.name));
      if (!okType) continue;

      const sortedCounts = Object.keys(it.rates).map(Number).sort((a, b) => a - b);
      for (const c of sortedCounts) {
        const suffix = it.isCleaningByCount ? `${c}人作業` : "";
        const label = suffix ? `${this._esc(it.name)}${suffix}` : this._esc(it.name);
        rows.push(`
          <tr>
            <td>${label}</td>
            <td class="text-end">¥${it.rates[c].toLocaleString()}</td>
          </tr>
        `);
      }
      // 特別加算 (お盆 / 正月など) は item 単位で 1 回表示
      if ((it.specialRates || []).length > 0) {
        const specialHtml = it.specialRates.map(s => {
          let range;
          if (s.recurYearly) {
            const [rsm, rsd] = String(s.recurStart || "").split("-");
            const [rem, red] = String(s.recurEnd || "").split("-");
            range = `${parseInt(rsm,10)||"?"}/${parseInt(rsd,10)||"?"}〜${parseInt(rem,10)||"?"}/${parseInt(red,10)||"?"} (毎年)`;
          } else {
            range = `${s.start || "?"}〜${s.end || "?"}`;
          }
          return `<div class="text-muted ps-3" style="border-left:2px solid #ffc107; font-size:0.75rem;">
            └ ${this._esc(s.name)} (${range}): +¥${Number(s.addAmount || 0).toLocaleString()}
          </div>`;
        }).join("");
        rows.push(`<tr><td colspan="2" class="pt-0 pb-2 border-0">${specialHtml}</td></tr>`);
      }
    }

    if (rows.length === 0) {
      el.innerHTML = renderCard(`<div class="text-muted mt-2">表示対象の単価項目がありません。</div>`);
      bindCaret();
      return;
    }

    el.innerHTML = renderCard(`
      <table class="table table-sm mb-0 mt-2" style="font-size:0.8rem;">
        <tbody>${rows.join("")}</tbody>
      </table>
    `);
    bindCaret();
  },

  addManualRow(data = { date: "", key: "", label: "", amount: "", memo: "" }) {
    const tbody = document.getElementById("manualRows");
    const tr = document.createElement("tr");
    // プルダウン (work item) + 「その他」: 選択中の物件の項目のみ表示
    const options = this.workItemOptions
      .filter(o => !this.propertyId || o.propertyId === this.propertyId)
      .map(o =>
        `<option value="${o.key}" data-amount="${o.amount}" data-label="${this._esc(o.label)}">${this._esc(o.label)} (¥${o.amount.toLocaleString()})</option>`
      ).join("");
    // デフォルト日付は今月の 1 日
    const ym = document.getElementById("invMonth")?.value || "";
    const defaultDate = data.date || (ym ? `${ym}-01` : "");
    tr.innerHTML = `
      <td><input type="date" class="form-control form-control-sm m-date" value="${this._esc(defaultDate)}"></td>
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
    const dateInput = tr.querySelector(".m-date");

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
    [labelInput, amountInput, memoInput, dateInput].forEach(i => i.addEventListener("input", () => this.updateTotal()));

    // 復元データがあれば値を流し込む (送信済み請求書の編集再送など)
    // ラベル表記ゆれを避けるため「その他(手入力)」として復元する
    if (data && (data.label || (data.amount !== "" && data.amount != null) || data.memo)) {
      presetSel.value = "__custom__";
      labelInput.classList.remove("d-none");
      labelInput.value = data.label || "";
      amountInput.value = (data.amount != null && data.amount !== "") ? data.amount : "";
      memoInput.value = data.memo || "";
      this.updateTotal();
    }
  },

  async loadSummary() {
    const ym = document.getElementById("invMonth").value;
    if (!ym) return;

    const sumEl = document.getElementById("invSummary");

    // 物件未選択時はガイド表示 + 再集計ボタン無効化
    const recalcBtn = document.getElementById("btnRecalc");
    if (!this.propertyId) {
      sumEl.innerHTML = `<div class="alert alert-info mb-0 small"><i class="bi bi-info-circle"></i> 物件を選択してください</div>`;
      if (recalcBtn) recalcBtn.disabled = true;
      // 合計もリセット
      this._previewShiftAmount = 0;
      this._previewLaundryAmount = 0;
      this._previewSpecialAmount = 0;
      this._previewTransportFee = 0;
      this._previewPrepaidExpense = 0;
      this._previewShiftCount = 0;
      this._summaryRows = [];
      this.updateTotal();
      return;
    }
    if (recalcBtn) recalcBtn.disabled = false;

    sumEl.innerHTML = `<div class="text-muted small"><span class="spinner-border spinner-border-sm"></span> 集計中...</div>`;

    try {
      const token = await firebase.auth().currentUser.getIdToken();
      const body = { yearMonth: ym, propertyId: this.propertyId };
      if (this.isOwner && this.staffId) body.staffId = this.staffId;

      const res = await fetch(`${this.CF_BASE}/invoices/compute-preview`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const preview = await res.json();

      // キャッシュ更新
      this._previewShiftAmount = preview.shiftAmount || 0;
      this._previewLaundryAmount = preview.laundryAmount || 0;
      this._previewSpecialAmount = preview.specialAmount || 0;
      this._previewTransportFee = preview.transportationFee || 0;
      this._previewPrepaidExpense = preview.prepaidExpense || 0;
      this._previewShiftCount = preview.shiftCount || 0;
      this._summaryRows = preview.rows || [];

      // 縦テーブル描画
      this._renderSummaryTable(sumEl, preview);
    } catch (e) {
      sumEl.innerHTML = `<div class="alert alert-danger mb-0"><i class="bi bi-exclamation-triangle"></i> 集計に失敗しました: ${(e && e.message) || e}</div>`;
      console.error("loadSummary エラー:", e);
      this._previewShiftAmount = 0;
      this._previewLaundryAmount = 0;
      this._previewSpecialAmount = 0;
      this._previewTransportFee = 0;
      this._previewPrepaidExpense = 0;
      this._previewShiftCount = 0;
      this._summaryRows = [];
      return;
    }
    this.updateTotal();
  },

  // 縦 5 列テーブル (日付 | 項目 | 単価 | 備考 | 操作) を描画
  _renderSummaryTable(el, preview) {
    const rows = preview.rows || [];
    const excludedRows = preview.excludedRows || [];
    if (!rows.length && !excludedRows.length) {
      el.innerHTML = `<div class="text-muted small">対象月の実績はありません</div>`;
      return;
    }
    const total = (preview.shiftAmount || 0) + (preview.laundryAmount || 0)
      + (preview.specialAmount || 0) + (preview.transportationFee || 0)
      + (preview.prepaidExpense || 0);
    const body = rows.map(r => {
      // プリカ購入行は控えめに黄色背景+カードアイコン
      const isPrepaid = r.category === "プリカ購入";
      const trCls = isPrepaid ? ' style="background:#fffbea;"' : "";
      const catHtml = isPrepaid
        ? `<i class="bi bi-credit-card-2-front text-warning"></i> ${this._esc(r.category || "")}`
        : this._esc(r.category || "");
      // 除外ボタン (type/refId があるもののみ)
      const hasRef = r.type && r.refId;
      const excludeBtn = hasRef
        ? `<button class="btn btn-sm btn-outline-danger btn-exclude" data-type="${this._esc(r.type)}" data-ref-id="${this._esc(r.refId)}" title="請求書から除外"><i class="bi bi-dash-circle"></i> 除外</button>`
        : "";
      return `
      <tr${trCls}>
        <td class="small" style="white-space:nowrap;">${this._esc(r.date || "")}</td>
        <td class="small" style="white-space:nowrap;">${catHtml}</td>
        <td class="text-end small" style="white-space:nowrap;">¥${Number(r.unitPrice || 0).toLocaleString()}</td>
        <td class="text-muted small" style="white-space:nowrap;">${this._esc(r.note || "")}</td>
        <td class="text-end" style="white-space:nowrap;">${excludeBtn}</td>
      </tr>
    `;
    }).join("");

    // 除外済み行 (折りたたみ)
    let excludedHtml = "";
    if (excludedRows.length) {
      const exBody = excludedRows.map(r => {
        const by = r.excludedBy?.staffName || "";
        return `
          <tr class="text-muted">
            <td class="small"><s>${this._esc(r.date || "")}</s></td>
            <td class="small"><s>${this._esc(r.category || "")}</s></td>
            <td class="text-end small"><s>¥${Number(r.unitPrice || 0).toLocaleString()}</s></td>
            <td class="small"><s>${this._esc(r.note || "")}</s>${by ? ` <span class="badge bg-light text-muted">除外: ${this._esc(by)}</span>` : ""}</td>
            <td class="text-end">
              <button class="btn btn-sm btn-outline-secondary btn-unexclude" data-type="${this._esc(r.type || "")}" data-ref-id="${this._esc(r.refId || "")}"><i class="bi bi-arrow-counterclockwise"></i> 除外解除</button>
            </td>
          </tr>
        `;
      }).join("");
      excludedHtml = `
        <details class="mt-2">
          <summary class="text-muted small" style="cursor:pointer;">除外済み ${excludedRows.length}件 ▸</summary>
          <div class="table-responsive mt-2">
            <table class="table table-sm table-borderless align-middle mb-0" style="min-width:640px;">
              <tbody>${exBody}</tbody>
            </table>
          </div>
        </details>
      `;
    }

    el.innerHTML = `
      <div class="table-responsive">
        <table class="table table-sm table-hover align-middle mb-0" style="min-width:640px;">
          <thead class="table-light">
            <tr>
              <th style="width:110px; white-space:nowrap;">日付</th>
              <th style="min-width:120px; white-space:nowrap;">項目</th>
              <th class="text-end" style="width:110px; white-space:nowrap;">単価</th>
              <th style="min-width:140px;">備考</th>
              <th style="width:100px; white-space:nowrap;"></th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
          <tfoot>
            <tr class="fw-bold table-light">
              <td colspan="2">自動集計 合計</td>
              <td class="text-end">¥${total.toLocaleString()}</td>
              <td colspan="2"></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="text-muted small mt-1">※ 階段制単価・workType別・タイミー時給・特別加算を含む正確な計算です</div>
      ${excludedHtml}
    `;

    // 除外ボタン handler
    el.querySelectorAll(".btn-exclude").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const t = e.currentTarget;
        this._handleExclude(t.dataset.type, t.dataset.refId);
      });
    });
    // 除外解除ボタン handler
    el.querySelectorAll(".btn-unexclude").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const t = e.currentTarget;
        this._handleUnexclude(t.dataset.type, t.dataset.refId);
      });
    });
  },

  // 項目を請求書から除外
  async _handleExclude(type, refId) {
    if (!type || !refId) return;
    if (!this.propertyId) { await showAlert("物件を選択してください"); return; }
    const ok = await showConfirm("この項目を請求書から除外しますか?\n(情報自体は削除されません)", { title: "除外" });
    if (!ok) return;
    try {
      const ym = document.getElementById("invMonth").value;
      if (!ym) return;
      const docId = `${ym}_${this.staffId}_${this.propertyId}`;
      const ref = db.collection("invoiceExclusions").doc(docId);
      const entry = {
        type,
        refId,
        excludedAt: new Date(),
        excludedBy: {
          staffId: this.staffId || "",
          staffName: this.staffDoc?.name || Auth.currentUser?.displayName || "",
        },
      };
      // ドキュメントが無い場合に備え set(merge) + arrayUnion
      await ref.set({
        staffId: this.staffId,
        yearMonth: ym,
        propertyId: this.propertyId,
        exclusions: firebase.firestore.FieldValue.arrayUnion(entry),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      if (typeof showToast === "function") showToast("除外しました", "再集計します", "success");
      await this.loadSummary();
    } catch (e) {
      console.error("除外エラー:", e);
      await showAlert("除外に失敗しました: " + (e.message || e));
    }
  },

  // 除外を解除
  async _handleUnexclude(type, refId) {
    if (!type || !refId) return;
    if (!this.propertyId) { await showAlert("物件を選択してください"); return; }
    try {
      const ym = document.getElementById("invMonth").value;
      if (!ym) return;
      const docId = `${ym}_${this.staffId}_${this.propertyId}`;
      const ref = db.collection("invoiceExclusions").doc(docId);
      // arrayRemove は完全一致が必要なので、現状を読んで type/refId 一致分を削除
      const snap = await ref.get();
      if (!snap.exists) { await this.loadSummary(); return; }
      const cur = Array.isArray(snap.data().exclusions) ? snap.data().exclusions : [];
      const removed = cur.filter(x => !(x && x.type === type && x.refId === refId));
      await ref.set({
        staffId: this.staffId,
        yearMonth: ym,
        propertyId: this.propertyId,
        exclusions: removed,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      if (typeof showToast === "function") showToast("除外を解除しました", "再集計します", "success");
      await this.loadSummary();
    } catch (e) {
      console.error("除外解除エラー:", e);
      await showAlert("除外解除に失敗しました: " + (e.message || e));
    }
  },

  updateTotal() {
    const apiBase = (this._previewShiftAmount || 0)
      + (this._previewLaundryAmount || 0)
      + (this._previewSpecialAmount || 0)
      + (this._previewTransportFee || 0)
      + (this._previewPrepaidExpense || 0);
    const manualTotal = [...document.querySelectorAll("#manualRows .m-amount")]
      .reduce((s, i) => s + (Number(i.value) || 0), 0);
    const total = apiBase + manualTotal;
    document.getElementById("invTotal").textContent = "¥" + total.toLocaleString();
  },

  // 必須項目チェック。未入力があれば true を返し、該当欄を赤枠にする
  _validateStaffInfo() {
    const missing = [];
    const d = this.staffDoc || {};
    // フィールド対応 (住所は memo フォールバック)
    for (const f of this.REQUIRED_STAFF_FIELDS) {
      let v = d[f];
      if (f === "address" && !v) v = d.memo || "";
      if (!v || String(v).trim() === "") {
        missing.push(f);
        const el = document.querySelector(`.s-field[data-field="${f}"]`);
        if (el) el.classList.add("is-invalid");
      }
    }
    return missing;
  },

  async submit() {
    const ym = document.getElementById("invMonth").value;

    // 物件選択チェック
    if (!this.propertyId) {
      if (typeof showToast === "function") {
        showToast("物件が未選択です", "請求書を作成する物件を選んでください", "error");
      } else {
        await showAlert("物件を選択してください");
      }
      return;
    }

    // 必須項目チェック
    const missing = this._validateStaffInfo();
    if (missing.length) {
      this.toggleStaffInfo(true);  // 折りたたみ展開
      if (typeof showToast === "function") {
        showToast("記入が必要な項目があります", `未入力: ${missing.join(", ")}`, "error");
      } else {
        await showAlert(`記入が必要な項目があります: ${missing.join(", ")}`);
      }
      return;
    }

    // 行から date/label/amount/memo を収集
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
        date: tr.querySelector(".m-date")?.value || "",
        label,
        amount: Number(tr.querySelector(".m-amount")?.value) || 0,
        memo: tr.querySelector(".m-memo")?.value || "",
      };
    }).filter(i => i.label || i.amount);

    const editing = !!this._editingInvoiceId;
    const ok = await showConfirm(
      editing
        ? `${ym} の請求書を上書きして再送します。よろしいですか？`
        : `${ym} の請求書をWebアプリ管理者へ送信します。よろしいですか？`,
      { title: editing ? "再送確認" : "送信確認" }
    );
    if (!ok) return;

    const btn = document.getElementById("btnSubmitInvoice");
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 送信中...';
    try {
      // Webアプリ管理者へのメッセージ (請求書メモ) — 毎月可変
      const invoiceMemo = document.getElementById("invoiceMemoText")?.value || "";
      const body = { yearMonth: ym, propertyId: this.propertyId, manualItems, invoiceMemo };
      if (this.isOwner && this.staffId) body.asStaffId = this.staffId;
      // 編集再送: 既存IDを上書き (重複発行しない)
      if (editing) body.overwriteId = this._editingInvoiceId;

      let result = await this._postSubmit(body);
      // 新規作成で既に送信済み (409) → 重複発行するか確認して再送信
      if (!editing && !result.ok && result.status === 409 && result.data.code === "ALREADY_SUBMITTED") {
        const dup = await showConfirm(
          `${ym} の請求書は既に送信済みです。\n重複して新しく発行しますか？\n（古い請求書には後で「間違い」マークを付けられます）`,
          { title: "重複発行の確認" }
        );
        if (!dup) return;
        result = await this._postSubmit({ ...body, allowDuplicate: true });
      }
      if (!result.ok) throw new Error(result.data.error || "送信失敗");
      const data = result.data;
      document.getElementById("invResult").innerHTML = `
        <div class="alert alert-success">
          <i class="bi bi-check-circle"></i> 請求書 <strong>${data.id}</strong> を${editing ? "上書き・再送" : "送信"}しました（合計 ¥${(data.total||0).toLocaleString()}）
        </div>
      `;
      showToast(editing ? "再送完了" : "送信完了", editing ? "請求書を上書きして再送しました" : "Webアプリ管理者へ請求書を送信しました", "success");
      // 編集モードを解除して通常状態に戻す
      if (editing) this._exitEditMode(true);
      // 送信成功後は折りたたみを閉じる
      this.toggleStaffInfo(false);
      // 過去一覧をリフレッシュ
      await this.loadPastInvoices();
    } catch (e) {
      showToast("エラー", e.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  },

  // my-submit を呼んで {ok, status, data} を返す
  async _postSubmit(body) {
    const token = await firebase.auth().currentUser.getIdToken();
    const res = await fetch(`${this.CF_BASE}/invoices/my-submit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  },

  // 間違いマーク / 解除
  async _markVoid(id, makeVoid) {
    const msg = makeVoid
      ? "この請求書を「間違い」としてマークしますか？\n新しい請求書と混同しないよう打ち消し表示になります。"
      : "「間違い」マークを解除しますか？";
    const ok = await showConfirm(msg, { title: makeVoid ? "間違いマーク" : "マーク解除" });
    if (!ok) return;
    try {
      const token = await firebase.auth().currentUser.getIdToken();
      const res = await fetch(`${this.CF_BASE}/invoices/${id}/${makeVoid ? "void" : "unvoid"}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "操作に失敗しました");
      showToast("完了", data.message || "更新しました", "success");
      await this.loadPastInvoices();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  // 送信済み請求書を編集モードに切替: 月・物件・追加明細・メモを復元しフォームへ読込
  async _editInvoice(inv) {
    if (!inv || !inv.id) return;
    // 月をセット
    const monthEl = document.getElementById("invMonth");
    if (monthEl && inv.yearMonth) monthEl.value = inv.yearMonth;
    // 物件をセット
    this.propertyId = inv.propertyId || null;
    await this.rebuildPropertySelect();
    const propSel = document.getElementById("invPropertySel");
    if (propSel && this.propertyId) propSel.value = this.propertyId;
    // 編集モード ON (月・物件はロックして取り違えを防ぐ)
    this._editingInvoiceId = inv.id;
    if (monthEl) monthEl.disabled = true;
    if (propSel) propSel.disabled = true;
    // 自動集計を再計算 (除外も最新で反映)
    this.renderMyRates();
    await this.loadSummary();
    // 追加明細を復元
    const tbody = document.getElementById("manualRows");
    if (tbody) tbody.innerHTML = "";
    const items = (inv.details && inv.details.manualItems) || inv.manualItems || [];
    items.forEach(mi => this.addManualRow({
      date: mi.date || "", label: mi.label || "", amount: mi.amount || "", memo: mi.memo || "",
    }));
    // メモ復元
    const memoEl = document.getElementById("invoiceMemoText");
    if (memoEl) memoEl.value = inv.invoiceMemo || "";
    this.updateTotal();
    // 送信ボタン文言変更 + バナー表示
    const btn = document.getElementById("btnSubmitInvoice");
    if (btn) btn.innerHTML = '<i class="bi bi-pencil-square"></i> 編集を保存して再送';
    this._renderEditBanner(inv);
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (typeof showToast === "function") showToast("編集モード", `${inv.yearMonth} の請求書を編集しています`, "info");
  },

  // 編集モードバナーを描画
  _renderEditBanner(inv) {
    const el = document.getElementById("editModeBanner");
    if (!el) return;
    el.className = "alert alert-warning d-flex justify-content-between align-items-center flex-wrap gap-2";
    el.innerHTML = `
      <div>
        <i class="bi bi-pencil-square"></i> <strong>${this._esc(inv.yearMonth || "")} の請求書を編集中</strong>
        <span class="small text-muted ms-2">保存すると同じ請求書が上書き・再送されます。</span>
      </div>
      <button class="btn btn-sm btn-outline-secondary" id="btnCancelEdit"><i class="bi bi-x"></i> 編集をやめる</button>
    `;
    document.getElementById("btnCancelEdit")?.addEventListener("click", () => this._exitEditMode(true));
  },

  // 編集モードを解除して通常作成状態に戻す
  _exitEditMode(resetForm) {
    this._editingInvoiceId = null;
    const monthEl = document.getElementById("invMonth");
    const propSel = document.getElementById("invPropertySel");
    if (monthEl) monthEl.disabled = false;
    if (propSel) propSel.disabled = false;
    const btn = document.getElementById("btnSubmitInvoice");
    if (btn) btn.innerHTML = '<i class="bi bi-send"></i> Webアプリ管理者へ送信';
    const banner = document.getElementById("editModeBanner");
    if (banner) { banner.className = "d-none"; banner.innerHTML = ""; }
    if (resetForm) {
      const tbody = document.getElementById("manualRows");
      if (tbody) tbody.innerHTML = "";
      const memoEl = document.getElementById("invoiceMemoText");
      if (memoEl) memoEl.value = "";
      this.loadSummary();
    }
  },

  // Firestore タイムスタンプ ({_seconds}/{seconds}/toDate/文字列) を yyyy/MM/dd HH:mm に整形
  _fmtTs(ts) {
    if (!ts) return "";
    let d;
    if (ts.toDate) d = ts.toDate();
    else if (typeof ts === "object" && (ts._seconds != null || ts.seconds != null)) d = new Date((ts._seconds ?? ts.seconds) * 1000);
    else d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  // PDFプレビュー: /my-preview-pdf を POST で呼んで PDF Blob を取得、
  // モーダル内の iframe に表示する (Storage には保存しない)
  async previewPdf() {
    const ym = document.getElementById("invMonth").value;
    if (!ym) { showToast("エラー", "対象年月を指定してください", "error"); return; }
    if (!this.propertyId) { showToast("エラー", "物件を選択してください", "warning"); return; }

    // manual 行の収集 (submit() と同じロジック)
    const manualItems = [...document.querySelectorAll("#manualRows tr")].map(tr => {
      const preset = tr.querySelector(".m-preset");
      const v = preset?.value || "";
      let label = "";
      if (v === "__custom__") {
        label = tr.querySelector(".m-label")?.value.trim() || "";
      } else if (v) {
        const opt = preset.options[preset.selectedIndex];
        label = opt?.dataset?.label || opt?.text || "";
      }
      return {
        date: tr.querySelector(".m-date")?.value || "",
        label,
        amount: Number(tr.querySelector(".m-amount")?.value) || 0,
        memo: tr.querySelector(".m-memo")?.value || "",
      };
    }).filter(i => i.label || i.amount);

    const btn = document.getElementById("btnPreviewPdf");
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 生成中...';

    try {
      const token = await firebase.auth().currentUser.getIdToken();
      // Webアプリ管理者へのメッセージ (請求書メモ)
      const invoiceMemo = document.getElementById("invoiceMemoText")?.value || "";
      const body = { yearMonth: ym, propertyId: this.propertyId, manualItems, invoiceMemo };
      if (this.isOwner && this.staffId) body.asStaffId = this.staffId;
      const res = await fetch(`${this.CF_BASE}/invoices/my-preview-pdf`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      // 直前に貼ってあった Blob URL があれば解放
      if (this._previewBlobUrl) URL.revokeObjectURL(this._previewBlobUrl);
      this._previewBlobUrl = URL.createObjectURL(blob);
      // モバイル判定: iframe で PDF 表示できないため新タブで直接開く
      const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
      if (isMobile) {
        // 新タブで PDF を開く (モーダル経由しない → backdrop 残り問題も回避)
        const a = document.createElement("a");
        a.href = this._previewBlobUrl;
        a.target = "_blank";
        a.rel = "noopener";
        a.download = `invoice_preview_${ym}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return;
      }
      const ifr = document.getElementById("pdfPreviewIframe");
      ifr.src = this._previewBlobUrl;
      document.getElementById("btnPdfOpenNewTab").href = this._previewBlobUrl;
      const dlBtn = document.getElementById("btnPdfDownload");
      dlBtn.href = this._previewBlobUrl;
      dlBtn.setAttribute("download", `invoice_preview_${ym}.pdf`);
      bootstrap.Modal.getOrCreateInstance(document.getElementById("pdfPreviewModal")).show();
    } catch (e) {
      showToast("プレビュー失敗", e.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = orig;
    }
  },

  // ================ 過去の請求書一覧 (my-invoice から統合) ================
  async loadPastInvoices() {
    const listEl = document.getElementById("pastInvoicesList");
    if (!listEl) return;
    try {
      const token = await firebase.auth().currentUser.getIdToken();
      const res = await fetch(`${this.CF_BASE}/invoices`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      let invoices = await res.json();
      // Webアプリ管理者モードで staffId 絞り込み
      if (this.isOwner && this.staffId) {
        invoices = invoices.filter(inv => inv.staffId === this.staffId);
      }
      // impersonation 中: 物件オーナー所有物件が対象の請求書のみ
      if (typeof App !== "undefined" && App.impersonating && App.impersonatingData) {
        const ownedA = new Set(App.impersonatingData.ownedPropertyIds || []);
        invoices = invoices.filter(inv => {
          if (inv.propertyId && ownedA.has(inv.propertyId)) return true;
          const byProp = Array.isArray(inv.byProperty) ? inv.byProperty : [];
          if (byProp.some(bp => bp && ownedA.has(bp.propertyId))) return true;
          const shifts = Array.isArray(inv.details?.shifts) ? inv.details.shifts : [];
          if (shifts.some(s => s && ownedA.has(s.propertyId))) return true;
          return false;
        });
      }
      if (!invoices.length) {
        listEl.innerHTML = `<div class="text-muted small">過去の請求書はまだありません。</div>`;
        return;
      }
      // yearMonth 降順 → 同月内は propertyName 昇順で並べる (同月複数物件があれば並ぶ)
      invoices.sort((a, b) => {
        const ym = (b.yearMonth || "").localeCompare(a.yearMonth || "");
        if (ym !== 0) return ym;
        const an = a.propertyName || this.propertyMap[a.propertyId]?.name || "";
        const bn = b.propertyName || this.propertyMap[b.propertyId]?.name || "";
        return an.localeCompare(bn);
      });
      listEl.innerHTML = invoices.map(inv => this._renderPastRow(inv)).join("");
      // 明細トグル
      listEl.querySelectorAll(".past-toggle-detail").forEach(btn => {
        btn.addEventListener("click", () => {
          const detailEl = document.getElementById(btn.dataset.target);
          if (!detailEl) return;
          const isOpen = !detailEl.classList.contains("d-none");
          detailEl.classList.toggle("d-none", isOpen);
          const ch = btn.querySelector(".past-chevron");
          if (ch) ch.style.transform = isOpen ? "" : "rotate(180deg)";
        });
      });
      // 間違いマーク / 解除
      listEl.querySelectorAll(".past-void").forEach(btn => {
        btn.addEventListener("click", () => this._markVoid(btn.dataset.id, true));
      });
      listEl.querySelectorAll(".past-unvoid").forEach(btn => {
        btn.addEventListener("click", () => this._markVoid(btn.dataset.id, false));
      });
      // 編集して再送
      listEl.querySelectorAll(".past-edit").forEach(btn => {
        const inv = invoices.find(i => i.id === btn.dataset.id);
        btn.addEventListener("click", () => this._editInvoice(inv));
      });
    } catch (e) {
      listEl.innerHTML = `<div class="alert alert-danger mb-0 small"><i class="bi bi-exclamation-triangle"></i> 読み込みエラー: ${this._esc(e.message)}</div>`;
    }
  },

  _renderPastRow(inv) {
    const statusMap = {
      draft: { label: "下書き", cls: "bg-secondary" },
      submitted: { label: "送信済み", cls: "bg-primary" },
      confirmed: { label: "確認済み", cls: "bg-info text-dark" },
      paid: { label: "支払済み", cls: "bg-success" },
    };
    const st = statusMap[inv.status] || { label: inv.status || "不明", cls: "bg-secondary" };
    const detailId = `pastDetail_${inv.id}`;
    const pdfBtn = inv.pdfUrl
      ? `<a href="${this._esc(inv.pdfUrl)}" target="_blank" class="btn btn-sm btn-outline-secondary"><i class="bi bi-file-earmark-pdf"></i> PDF</a>`
      : "";

    // 発行日 (submittedAt 優先、なければ createdAt)
    const issuedStr = this._fmtTs(inv.submittedAt || inv.createdAt);
    // 間違いマーク状態
    const isVoided = !!inv.voided;
    const voidBadge = isVoided
      ? `<span class="badge bg-danger ms-2"><i class="bi bi-exclamation-triangle"></i> 間違い</span>`
      : "";
    const voidBtn = isVoided
      ? `<button class="btn btn-sm btn-outline-secondary past-unvoid" data-id="${this._esc(inv.id)}"><i class="bi bi-arrow-counterclockwise"></i> 間違い解除</button>`
      : `<button class="btn btn-sm btn-outline-danger past-void" data-id="${this._esc(inv.id)}"><i class="bi bi-exclamation-triangle"></i> 間違い</button>`;

    // 編集して再送ボタン: 送信済み (submitted) かつ間違いマークなしの本人請求書のみ
    // (確認済み・支払済みはオーナー処理後のため対象外)
    const canEdit = inv.status === "submitted" && !isVoided;
    const editBtn = canEdit
      ? `<button class="btn btn-sm btn-outline-primary past-edit" data-id="${this._esc(inv.id)}"><i class="bi bi-pencil"></i> 編集して再送</button>`
      : "";

    // 明細テーブル
    const shiftRows = (inv.details?.shifts || inv.shifts || []).map(s => {
      const typeLabel = {
        cleaning_by_count: "清掃", pre_inspection: "直前点検", other: "その他",
        laundry_put_out: "ランドリー出し", laundry_collected: "ランドリー受取", laundry_expense: "ランドリー立替",
      }[s.workType] || s.workItemName || "清掃";
      const d = s.date && s.date.toDate ? s.date.toDate() : (s.date ? new Date(s.date) : null);
      const dStr = d ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}` : "";
      return `<tr><td>${this._esc(dStr)}</td><td>${this._esc(typeLabel)}</td><td class="text-end">¥${(s.amount||0).toLocaleString()}</td><td class="small text-muted">${this._esc(s.propertyName||"")}</td></tr>`;
    }).join("");
    const manualRows = (inv.details?.manualItems || inv.manualItems || []).map(m => `
      <tr><td>${this._esc(m.date||"")}</td><td>${this._esc(m.label||"")}</td><td class="text-end">¥${(m.amount||0).toLocaleString()}</td><td class="small text-muted">${this._esc(m.memo||"")}</td></tr>
    `).join("");
    const hasDetail = shiftRows || manualRows;

    // 物件名 (propertyName 優先、なければ propertyId から解決)
    let propLabel = inv.propertyName || "";
    if (!propLabel && inv.propertyId && this.propertyMap[inv.propertyId]) {
      propLabel = this.propertyMap[inv.propertyId].name || "";
    }
    const propBadge = propLabel
      ? `<span class="badge bg-light text-dark border ms-2"><i class="bi bi-house-door"></i> ${this._esc(propLabel)}</span>`
      : "";

    return `
      <div class="border rounded p-2 mb-2 ${isVoided ? "border-danger bg-danger bg-opacity-10" : ""}" ${isVoided ? 'style="opacity:.75;"' : ""}>
        <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
          <div>
            <strong ${isVoided ? 'style="text-decoration:line-through;"' : ""}>${this._esc(inv.yearMonth || "")}</strong>
            <span class="badge ${st.cls} ms-2">${st.label}</span>
            ${voidBadge}
            ${propBadge}
            ${issuedStr ? `<div class="text-muted small mt-1"><i class="bi bi-calendar-check"></i> 発行日: ${this._esc(issuedStr)}</div>` : ""}
          </div>
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <span class="fw-bold ${isVoided ? "text-decoration-line-through text-muted" : ""}">¥${(inv.total||0).toLocaleString()}</span>
            ${pdfBtn}
            ${hasDetail ? `<button class="btn btn-sm btn-outline-secondary past-toggle-detail" data-target="${detailId}"><i class="bi bi-chevron-down past-chevron" style="transition:transform 0.2s;"></i> 明細</button>` : ""}
            ${editBtn}
            ${voidBtn}
          </div>
        </div>
        ${hasDetail ? `
        <div id="${detailId}" class="d-none mt-2">
          <table class="table table-sm mb-0">
            <thead class="table-light">
              <tr><th>日付</th><th>項目</th><th class="text-end">金額</th><th>備考</th></tr>
            </thead>
            <tbody>${shiftRows}${manualRows}</tbody>
          </table>
        </div>` : ""}
      </div>
    `;
  },

  _esc(s) { const d = document.createElement("div"); d.textContent = String(s || ""); return d.innerHTML; },
};
