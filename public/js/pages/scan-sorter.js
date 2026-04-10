/**
 * スキャン自動仕分け — フロントエンドUI
 * Firestore直接接続 + Cloud Functions API（Drive/Gemini操作）
 */
const ScanSorterPage = {
  logs: [],
  stats: {},
  processing: false,

  async render(container) {
    container.innerHTML = `
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h4 class="mb-0"><i class="bi bi-robot"></i> 経理自動仕分け</h4>
        <div class="d-flex gap-2">
          <button class="btn btn-primary" id="btnScanStart" title="受信BOXの未処理PDFを一括処理">
            <i class="bi bi-play-fill"></i> スキャン開始
          </button>
          <button class="btn btn-success" id="btnApproveAll" title="確認待ちを一括承認">
            <i class="bi bi-check2-all"></i> 一括承認
          </button>
          <button class="btn btn-outline-secondary" id="btnRefresh">
            <i class="bi bi-arrow-clockwise"></i> 更新
          </button>
          <button class="btn btn-outline-info" id="btnRebuildLearning" title="処理ログから学習データを再構築">
            <i class="bi bi-mortarboard"></i> 学習更新
          </button>
          <button class="btn btn-outline-warning" id="btnSettings">
            <i class="bi bi-gear"></i> 設定
          </button>
        </div>
      </div>

      <!-- 統計カード -->
      <div class="row g-3 mb-3" id="statsRow">
        <div class="col-auto">
          <span class="badge bg-primary fs-6" id="statTotal" title="処理済み合計">0</span>
          <small class="text-muted ms-1">処理済み</small>
        </div>
        <div class="col-auto">
          <span class="badge bg-success fs-6" id="statAuto" title="自動承認">0</span>
          <small class="text-muted ms-1">自動承認</small>
        </div>
        <div class="col-auto">
          <span class="badge bg-warning text-dark fs-6" id="statPending" title="確認待ち">0</span>
          <small class="text-muted ms-1">確認待ち</small>
        </div>
        <div class="col-auto">
          <span class="badge bg-danger fs-6" id="statError" title="エラー">0</span>
          <small class="text-muted ms-1">エラー</small>
        </div>
      </div>

      <!-- 進捗バー（処理中のみ表示） -->
      <div class="progress mb-3 d-none" id="processProgress" style="height:24px">
        <div class="progress-bar progress-bar-striped progress-bar-animated" id="progressBar" style="width:0%">
          <span id="progressText">0/0</span>
        </div>
      </div>

      <!-- フィルタ -->
      <div class="btn-group mb-3" role="group" id="filterGroup">
        <button class="btn btn-outline-secondary btn-sm active" data-filter="all">すべて</button>
        <button class="btn btn-outline-warning btn-sm" data-filter="pending">確認待ち</button>
        <button class="btn btn-outline-success btn-sm" data-filter="completed">完了</button>
        <button class="btn btn-outline-danger btn-sm" data-filter="error">エラー</button>
      </div>

      <!-- メインテーブル -->
      <div class="table-responsive">
        <table class="table table-hover table-sm align-middle" id="scanTable">
          <thead class="table-dark">
            <tr>
              <th style="width:40px"><input type="checkbox" id="checkAll" class="form-check-input"></th>
              <th>スキャンファイル名</th>
              <th>AI要約</th>
              <th>リネーム予定名</th>
              <th>書類種別</th>
              <th>取引先</th>
              <th>金額</th>
              <th>科目</th>
              <th style="width:80px">信頼度</th>
              <th>ステータス</th>
              <th style="width:80px">操作</th>
            </tr>
          </thead>
          <tbody id="scanTableBody">
            <tr><td colspan="11" class="text-center py-4 text-muted">
              <div class="spinner-border spinner-border-sm me-2"></div>読み込み中...
            </td></tr>
          </tbody>
        </table>
      </div>

      <!-- 設定モーダル -->
      <div class="modal fade" id="scanSettingsModal" tabindex="-1">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-gear"></i> 自動仕分け設定</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="mb-3">
                <label class="form-label">Gemini APIキー <span class="text-danger">*</span></label>
                <input type="password" class="form-control" id="settGeminiKey" placeholder="AIza...">
                <small class="text-muted"><a href="https://aistudio.google.com/apikey" target="_blank">Google AI Studio</a>で取得</small>
              </div>
              <hr>
              <h6>Googleドライブ フォルダID</h6>
              <small class="text-muted d-block mb-2">フォルダURLの <code>folders/</code> の後の文字列。URLをそのまま貼ってもOK</small>
              <div class="mb-3">
                <label class="form-label">スキャン受信BOX <span class="text-danger">*</span></label>
                <div class="input-group">
                  <input type="text" class="form-control" id="settFolderInbox" placeholder="フォルダIDまたはURL">
                  <button class="btn btn-outline-secondary" type="button" onclick="ScanSorterPage.openDriveFolder_('settFolderInbox')" title="Driveフォルダを開く"><i class="bi bi-box-arrow-up-right"></i></button>
                </div>
              </div>
              <div class="mb-3">
                <label class="form-label">処理済みフォルダ <span class="text-danger">*</span></label>
                <div class="input-group">
                  <input type="text" class="form-control" id="settFolderProcessed" placeholder="フォルダIDまたはURL">
                  <button class="btn btn-outline-secondary" type="button" onclick="ScanSorterPage.openDriveFolder_('settFolderProcessed')" title="Driveフォルダを開く"><i class="bi bi-box-arrow-up-right"></i></button>
                </div>
              </div>
              <!-- 税理士共有フォルダは下部の複数登録UIで管理 -->
              <div class="mb-3">
                <label class="form-label">分類エラーフォルダ</label>
                <div class="input-group">
                  <input type="text" class="form-control" id="settFolderError" placeholder="フォルダIDまたはURL（任意）">
                  <button class="btn btn-outline-secondary" type="button" onclick="ScanSorterPage.openDriveFolder_('settFolderError')" title="Driveフォルダを開く"><i class="bi bi-box-arrow-up-right"></i></button>
                </div>
              </div>
              <hr>
              <h6>税理士共有フォルダ（複数登録可）</h6>
              <small class="text-muted d-block mb-2">個人用・法人用など複数の共有先を登録。仕分け時にどのフォルダにコピーするか選べます</small>
              <div id="taxFolderList" class="mb-2"></div>
              <div class="input-group input-group-sm mb-3">
                <input type="text" class="form-control" id="newTaxName" placeholder="名前（例: 個人用(高山市分)）">
                <input type="text" class="form-control" id="newTaxFolderId" placeholder="フォルダIDまたはURL">
                <button class="btn btn-outline-success" type="button" id="btnAddTaxFolder"><i class="bi bi-plus-lg"></i> 追加</button>
              </div>
              <hr>
              <div class="d-flex gap-2">
                <button class="btn btn-sm btn-outline-primary" id="btnInitCategories">
                  <i class="bi bi-database-add"></i> 科目マスタ初期化（10科目）
                </button>
                <button class="btn btn-sm btn-outline-info" id="btnRunDiag">
                  <i class="bi bi-wrench"></i> 接続診断
                </button>
              </div>
              <pre id="diagResult" class="mt-2 small bg-light p-2 d-none" style="max-height:200px;overflow:auto"></pre>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary" data-bs-dismiss="modal">キャンセル</button>
              <button class="btn btn-primary" id="btnSaveSettings">
                <i class="bi bi-check-lg"></i> 保存
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.bindEvents_();
    await this.loadData_();
  },

  bindEvents_() {
    document.getElementById("btnScanStart").onclick = () => this.startProcessing_();
    document.getElementById("btnApproveAll").onclick = () => this.approveAllPending_();
    document.getElementById("btnRefresh").onclick = () => this.loadData_();
    document.getElementById("btnRebuildLearning").onclick = () => this.rebuildLearning_();
    document.getElementById("btnSettings").onclick = () => this.openSettings_();
    document.getElementById("btnSaveSettings").onclick = () => this.saveSettings_();
    document.getElementById("btnInitCategories").onclick = () => this.initCategories_();
    document.getElementById("btnAddTaxFolder").onclick = () => this.addTaxFolder_();
    document.getElementById("btnRunDiag").onclick = () => this.runDiagnostics_();
    document.getElementById("checkAll").onchange = (e) => {
      document.querySelectorAll(".row-check").forEach((cb) => { cb.checked = e.target.checked; });
    };
    document.getElementById("filterGroup").onclick = (e) => {
      const btn = e.target.closest("[data-filter]");
      if (!btn) return;
      document.querySelectorAll("#filterGroup .btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      this.renderTable_(btn.dataset.filter);
    };
  },

  // ========================================
  // Firestore直接接続: データ読み込み
  // ========================================
  async loadData_() {
    try {
      // Firestoreからログ取得
      const snap = await db.collection("scanLogs").orderBy("processDate", "desc").limit(200).get();
      this.logs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      // 統計を計算
      let total = 0, autoApproved = 0, pending = 0, errors = 0;
      this.logs.forEach((l) => {
        total++;
        const s = String(l.status || "");
        if (s.includes("自動完了")) autoApproved++;
        else if (s.includes("確認待ち")) pending++;
        else if (s.includes("エラー")) errors++;
      });
      this.stats = { total, autoApproved, pending, errors, completed: total - pending - errors };

      this.renderStats_();
      this.renderTable_("all");
    } catch (e) {
      console.error("データ読み込みエラー:", e);
      document.getElementById("scanTableBody").innerHTML =
        `<tr><td colspan="11" class="text-center text-danger py-4">読み込みエラー: ${e.message}</td></tr>`;
    }
  },

  renderStats_() {
    const s = this.stats;
    document.getElementById("statTotal").textContent = s.completed || 0;
    document.getElementById("statAuto").textContent = s.autoApproved || 0;
    document.getElementById("statPending").textContent = s.pending || 0;
    document.getElementById("statError").textContent = s.errors || 0;
  },

  renderTable_(filter) {
    const tbody = document.getElementById("scanTableBody");
    let filtered = this.logs;

    if (filter === "pending") filtered = this.logs.filter((l) => String(l.status).includes("確認待ち"));
    else if (filter === "completed") filtered = this.logs.filter((l) => String(l.status).includes("完了"));
    else if (filter === "error") filtered = this.logs.filter((l) => String(l.status).includes("エラー"));

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="11" class="text-center py-4 text-muted">
        ${filter === "all" ? "処理ログがありません。「スキャン開始」で受信BOXのPDFを処理してください。" : "該当するログがありません"}
      </td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map((log) => {
      const isPending = String(log.status).includes("確認待ち");
      const isCompleted = String(log.status).includes("完了");
      const isError = String(log.status).includes("エラー");
      const rowClass = isPending ? "table-warning" : isError ? "table-danger" : "";
      const conf = log.confidence || 0;
      const confClass = conf >= 80 ? "bg-success" : conf >= 50 ? "bg-warning text-dark" : "bg-danger";

      return `<tr class="${rowClass}">
        <td><input type="checkbox" class="form-check-input row-check" data-id="${log.id}"></td>
        <td class="text-truncate" style="max-width:180px" title="${this.esc_(log.origName)}">${this.esc_(log.origName)}</td>
        <td class="text-truncate" style="max-width:150px" title="${this.esc_(log.summary)}">${this.esc_(log.summary || "")}</td>
        <td class="text-truncate" style="max-width:200px"><code>${this.esc_(log.newName)}</code></td>
        <td><span class="badge bg-secondary">${this.esc_(log.docType)}</span></td>
        <td>${this.esc_(log.vendor)}</td>
        <td class="text-end">${log.amount ? "¥" + Number(log.amount).toLocaleString() : "-"}</td>
        <td>${this.esc_(log.category)}</td>
        <td><span class="badge ${confClass}">${conf}%</span></td>
        <td><small>${this.esc_(log.status)}</small></td>
        <td>
          ${isPending ? `<button class="btn btn-success btn-sm" onclick="ScanSorterPage.approveOne_('${log.id}')" title="承認"><i class="bi bi-check-lg"></i></button>` : ""}
        </td>
      </tr>`;
    }).join("");
  },

  // ========================================
  // Cloud Functions API経由: スキャン開始
  // ========================================
  async startProcessing_() {
    if (this.processing) return;
    this.processing = true;
    const btn = document.getElementById("btnScanStart");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 処理中...';

    try {
      const inbox = await this.cfApi_("GET", "/scan-sorter/inbox");
      const files = inbox.files.filter((f) => !f.processed);

      if (files.length === 0) {
        showToast("スキャン", "受信BOXに未処理のPDFがありません", "info");
        return;
      }

      const progressDiv = document.getElementById("processProgress");
      const progressBar = document.getElementById("progressBar");
      const progressText = document.getElementById("progressText");
      progressDiv.classList.remove("d-none");

      let processed = 0;
      for (const file of files) {
        progressText.textContent = `${processed + 1}/${files.length} ${file.name}`;
        progressBar.style.width = `${((processed + 1) / files.length) * 100}%`;

        try {
          await this.cfApi_("POST", `/scan-sorter/process/${file.id}`);
          processed++;
        } catch (e) {
          console.error("処理エラー:", file.name, e);
        }

        if (processed < files.length) await new Promise((r) => setTimeout(r, 2000));
      }

      progressDiv.classList.add("d-none");
      showToast("スキャン完了", `${processed}件を処理しました`, "success");
      await this.loadData_();
    } catch (e) {
      showToast("エラー", e.message, "error");
    } finally {
      this.processing = false;
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-play-fill"></i> スキャン開始';
      document.getElementById("processProgress").classList.add("d-none");
    }
  },

  // ========================================
  // Cloud Functions API経由: 承認（Drive操作が必要）
  // ========================================
  async approveOne_(logId) {
    try {
      await this.cfApi_("POST", `/scan-sorter/approve/${logId}`);
      showToast("承認", "ファイルを移動しました", "success");
      await this.loadData_();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  async approveAllPending_() {
    const pending = this.logs.filter((l) => String(l.status).includes("確認待ち"));
    if (pending.length === 0) {
      showToast("一括承認", "確認待ちのファイルがありません", "info");
      return;
    }
    if (!confirm(`${pending.length}件の確認待ちファイルを一括承認しますか？`)) return;

    let approved = 0;
    for (const log of pending) {
      try {
        await this.cfApi_("POST", `/scan-sorter/approve/${log.id}`);
        approved++;
      } catch (e) {
        console.error("承認エラー:", log.id, e);
      }
    }

    showToast("一括承認完了", `${approved}/${pending.length}件を承認しました`, "success");
    await this.loadData_();
  },

  // ========================================
  // Firestore直接: 学習データ再構築
  // ========================================
  async rebuildLearning_() {
    try {
      const logSnap = await db.collection("scanLogs").get();
      const vendorMap = {};
      logSnap.forEach((doc) => {
        const d = doc.data();
        if (!d.status || !String(d.status).includes("完了")) return;
        const v = this.normalizeVendor_(d.vendor);
        const c = d.category;
        if (!v || !c) return;
        if (!vendorMap[v]) vendorMap[v] = {};
        vendorMap[v][c] = (vendorMap[v][c] || 0) + 1;
      });

      // 既存クリア
      const oldSnap = await db.collection("scanLearning").get();
      const batch = db.batch();
      oldSnap.forEach((doc) => batch.delete(doc.ref));

      let count = 0;
      for (const [vendor, cats] of Object.entries(vendorMap)) {
        let best = "", bestCount = 0;
        for (const [c, cnt] of Object.entries(cats)) {
          if (cnt > bestCount) { best = c; bestCount = cnt; }
        }
        batch.set(db.collection("scanLearning").doc(), { vendor, category: best, count: bestCount });
        count++;
      }
      await batch.commit();
      showToast("学習更新", `${count}件の学習データを再構築しました`, "success");
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  normalizeVendor_(vendor) {
    if (!vendor) return "";
    return String(vendor).replace(/[\s\u3000]+/g, "").replace(/[（(][^)）]*[)）]/g, "").replace(/株式会社|有限会社|合同会社/g, "");
  },

  // ========================================
  // Firestore直接: 設定
  // ========================================
  async openSettings_() {
    try {
      const doc = await db.collection("settings").doc("scanSorter").get();
      const settings = doc.exists ? doc.data() : {};
      document.getElementById("settGeminiKey").value = settings.geminiApiKey || "";
      document.getElementById("settFolderInbox").value = settings.folderInbox || "";
      document.getElementById("settFolderProcessed").value = settings.folderProcessed || "";
      document.getElementById("settFolderTaxShare").value = settings.folderTaxShare || "";
      document.getElementById("settFolderError").value = settings.folderError || "";
    } catch (e) {
      // 初回は設定なしでOK
    }
    // 税理士フォルダ一覧を表示
    await this.renderTaxFolderList_();
    new bootstrap.Modal(document.getElementById("scanSettingsModal")).show();
  },

  async saveSettings_() {
    const settings = {
      geminiApiKey: document.getElementById("settGeminiKey").value.trim(),
      folderInbox: this.extractFolderId_(document.getElementById("settFolderInbox").value),
      folderProcessed: this.extractFolderId_(document.getElementById("settFolderProcessed").value),
      folderError: this.extractFolderId_(document.getElementById("settFolderError").value),
    };
    try {
      await db.collection("settings").doc("scanSorter").set(settings, { merge: true });
      bootstrap.Modal.getInstance(document.getElementById("scanSettingsModal")).hide();
      showToast("設定", "保存しました", "success");
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  // ========================================
  // 税理士共有フォルダ管理（複数登録）
  // ========================================
  async renderTaxFolderList_() {
    const el = document.getElementById("taxFolderList");
    const snap = await db.collection("settings").doc("scanSorter").collection("taxFolders").orderBy("name").get();
    if (snap.empty) {
      el.innerHTML = '<small class="text-muted">登録なし</small>';
      return;
    }
    el.innerHTML = snap.docs.map((doc) => {
      const f = doc.data();
      return `<div class="d-flex justify-content-between align-items-center border rounded px-2 py-1 mb-1">
        <small><i class="bi bi-folder text-warning"></i> ${this.esc_(f.name)} <span class="text-muted">(${f.folderId.substring(0, 12)}...)</span></small>
        <div>
          <a href="https://drive.google.com/drive/folders/${f.folderId}" target="_blank" class="btn btn-outline-secondary btn-sm py-0 px-1" title="開く"><i class="bi bi-box-arrow-up-right"></i></a>
          <button class="btn btn-outline-danger btn-sm py-0 px-1" onclick="ScanSorterPage.removeTaxFolder_('${doc.id}')" title="削除"><i class="bi bi-x"></i></button>
        </div>
      </div>`;
    }).join("");
  },

  async addTaxFolder_() {
    const name = document.getElementById("newTaxName").value.trim();
    const rawId = document.getElementById("newTaxFolderId").value.trim();
    const folderId = this.extractFolderId_(rawId);
    if (!name || !folderId) { showToast("エラー", "名前とフォルダIDを入力してください", "error"); return; }
    await db.collection("settings").doc("scanSorter").collection("taxFolders").add({ name, folderId });
    document.getElementById("newTaxName").value = "";
    document.getElementById("newTaxFolderId").value = "";
    await this.renderTaxFolderList_();
    showToast("税理士フォルダ", `「${name}」を追加しました`, "success");
  },

  async removeTaxFolder_(docId) {
    if (!confirm("この税理士フォルダ登録を削除しますか？")) return;
    await db.collection("settings").doc("scanSorter").collection("taxFolders").doc(docId).delete();
    await this.renderTaxFolderList_();
  },

  // ========================================
  // 接続診断
  // ========================================
  async runDiagnostics_() {
    const el = document.getElementById("diagResult");
    el.classList.remove("d-none");
    const lines = [];
    const log = (msg) => { lines.push(msg); el.textContent = lines.join("\n"); };

    const cfBase = "https://api-5qrfx7ujcq-an.a.run.app";

    // Step 1: Cloud Run疎通
    log("【1】Cloud Run疎通テスト...");
    try {
      const r = await fetch(cfBase + "/scan-sorter/stats", {
        headers: { Authorization: "Bearer test-token" },
      });
      log(`  → HTTP ${r.status} ${r.statusText}`);
      const text = await r.text();
      log(`  → レスポンス: ${text.substring(0, 300)}`);
    } catch (e) {
      log(`  → ❌ ${e.message}`);
      log("\n原因: Cloud Runに到達できません。");
      log("対処: Cloud Run → api → セキュリティ → 「公開アクセスを許可する」");
      return;
    }

    // Step 2: inbox API（直接テスト）
    log("\n【2】受信BOX API...");
    try {
      const r2 = await fetch(cfBase + "/scan-sorter/inbox", {
        headers: { Authorization: "Bearer test-token" },
      });
      log(`  → HTTP ${r2.status}`);
      const text2 = await r2.text();
      log(`  → レスポンス: ${text2.substring(0, 500)}`);
    } catch (e) {
      log(`  → ❌ ${e.message}`);
    }

    // Step 3: Firestore設定確認
    log("\n【3】Firestore設定...");
    try {
      const doc = await db.collection("settings").doc("scanSorter").get();
      const s = doc.exists ? doc.data() : {};
      log("  → folderInbox: " + (s.folderInbox || "(未設定)"));
      log("  → folderProcessed: " + (s.folderProcessed || "(未設定)"));
      log("  → geminiApiKey: " + (s.geminiApiKey ? "設定済み(" + s.geminiApiKey.substring(0, 8) + "...)" : "未設定"));
    } catch (e) {
      log("  → ❌ " + e.message);
    }
  },

  // URLからフォルダIDを抽出（URLそのまま貼り付け対応）
  extractFolderId_(input) {
    if (!input) return "";
    const trimmed = input.trim();
    const match = trimmed.match(/[-\w]{25,}/);
    return match ? match[0] : trimmed;
  },

  // ========================================
  // Firestore直接: 科目マスタ初期化
  // ========================================
  async initCategories_() {
    try {
      const defaults = [
        { code: "110", name: "消耗品費", keywords: "ヤマダ電機,ビックカメラ,Amazon,ニトリ,ホームセンター", taxRate: 10, taxShare: true },
        { code: "120", name: "水道光熱費", keywords: "電力,ガス,水道,東京電力,関西電力,大阪ガス", taxRate: 10, taxShare: true },
        { code: "130", name: "通信費", keywords: "NTT,ソフトバンク,au,KDDI,docomo,Wi-Fi", taxRate: 10, taxShare: true },
        { code: "140", name: "地代家賃", keywords: "家賃,賃料,管理費,共益費", taxRate: 10, taxShare: true },
        { code: "150", name: "損害保険料", keywords: "火災保険,地震保険,損害保険", taxRate: 10, taxShare: true },
        { code: "160", name: "租税公課", keywords: "固定資産税,都市計画税,所得税,住民税", taxRate: 0, taxShare: true },
        { code: "170", name: "修繕費", keywords: "修理,修繕,工事,リフォーム", taxRate: 10, taxShare: true },
        { code: "180", name: "交通費", keywords: "交通,タクシー,JR,電車,バス", taxRate: 10, taxShare: true },
        { code: "190", name: "交際費", keywords: "飲食,会食,贈答", taxRate: 10, taxShare: true },
        { code: "200", name: "雑費", keywords: "", taxRate: 10, taxShare: true },
      ];
      const batch = db.batch();
      for (const cat of defaults) {
        const existing = await db.collection("scanCategories").where("code", "==", cat.code).limit(1).get();
        if (existing.empty) {
          batch.set(db.collection("scanCategories").doc(), cat);
        }
      }
      await batch.commit();
      showToast("科目マスタ", "10科目の初期データを作成しました", "success");
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  // ========================================
  // Cloud Functions API（Drive/Gemini操作用）
  // ========================================
  async cfApi_(method, path, body) {
    let token = "test-token";
    if (!Auth.testMode && Auth.currentUser && Auth.currentUser.getIdToken) {
      token = await Auth.currentUser.getIdToken();
    }
    const opts = {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    };
    if (body) opts.body = JSON.stringify(body);

    const cfBase = "https://api-5qrfx7ujcq-an.a.run.app";
    let res;
    try {
      res = await fetch(`${cfBase}${path}`, opts);
    } catch (e) {
      throw new Error(`ネットワークエラー: ${e.message} (URL: ${cfBase}${path})`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let errMsg = `HTTP ${res.status}`;
      try { const j = JSON.parse(text); errMsg += ": " + (j.error || text); } catch (e) { errMsg += ": " + text.substring(0, 200); }
      throw new Error(errMsg);
    }
    return res.json();
  },

  // Driveフォルダを新しいタブで開く
  openDriveFolder_(inputId) {
    const val = document.getElementById(inputId).value.trim();
    if (!val) { showToast("エラー", "フォルダIDが入力されていません", "error"); return; }
    const folderId = this.extractFolderId_(val);
    window.open(`https://drive.google.com/drive/folders/${folderId}`, "_blank");
  },

  esc_(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  },
};
