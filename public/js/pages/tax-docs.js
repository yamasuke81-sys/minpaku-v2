/**
 * 税理士資料ダッシュボード
 * 名義別にチェックリスト表示、Driveファイル存在確認、手動チェック
 */
const TaxDocsPage = {
  yearMonth: "",
  checklist: {},  // entityId → { entityName, items, completedCount, totalCount }
  loading: false,

  async render(container) {
    // 初期値: 今月
    const now = new Date();
    this.yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-folder-check"></i> 税理士資料</h2>
        <div class="d-flex gap-2 align-items-center">
          <button class="btn btn-sm btn-outline-secondary" id="btnPrevMonth"><i class="bi bi-chevron-left"></i></button>
          <span class="fw-bold" id="taxDocsYm" style="min-width:100px;text-align:center;"></span>
          <button class="btn btn-sm btn-outline-secondary" id="btnNextMonth"><i class="bi bi-chevron-right"></i></button>
          <button class="btn btn-sm btn-primary" id="btnScanNow" title="Driveフォルダをスキャンして自動チェック + Gmail収集">
            <i class="bi bi-arrow-repeat"></i> スキャン&収集
          </button>
        </div>
      </div>

      <!-- 全体サマリ -->
      <div class="card mb-3" id="taxDocsSummary">
        <div class="card-body py-2">
          <div class="d-flex align-items-center gap-3">
            <span class="fw-bold" id="taxDocsOverall">-</span>
            <div class="progress flex-grow-1" style="height:8px;">
              <div class="progress-bar" id="taxDocsProgressBar" style="width:0%"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 名義別チェックリスト -->
      <div id="taxDocsEntities">
        <div class="text-center py-4 text-muted">
          <div class="spinner-border spinner-border-sm me-2"></div>読み込み中...
        </div>
      </div>

      <!-- 設定パネル -->
      <div class="card mt-3" id="taxDocsSetupPanel">
        <div class="card-header py-2 d-flex justify-content-between align-items-center" role="button" onclick="document.getElementById('setupBody').classList.toggle('d-none')">
          <span><i class="bi bi-gear"></i> 設定・セットアップ</span>
          <span class="badge bg-secondary" id="setupStatusBadge">確認中...</span>
        </div>
        <div class="card-body d-none" id="setupBody">
          <div id="setupContent">読み込み中...</div>
        </div>
      </div>

      <!-- 下部リンク -->
      <div class="mt-3 text-center d-flex gap-2 justify-content-center">
        <a href="https://scan-sorter-minpaku-v2.web.app/#/entities" target="_blank" class="btn btn-outline-secondary btn-sm">
          <i class="bi bi-building"></i> 名義・法人管理（scan-sorterで編集）
          <i class="bi bi-box-arrow-up-right ms-1" style="font-size:0.7rem;"></i>
        </a>
        <button class="btn btn-outline-warning btn-sm" id="btnSeedItems">
          <i class="bi bi-database-add"></i> 初期データ投入
        </button>
      </div>
    `;

    document.getElementById("btnPrevMonth").onclick = () => this.changeMonth(-1);
    document.getElementById("btnNextMonth").onclick = () => this.changeMonth(1);
    document.getElementById("btnScanNow").onclick = () => this.scanAndCollect();
    document.getElementById("btnSeedItems").onclick = () => this.seedItems();

    this.updateYmLabel();
    await this.loadData();
    this.loadSetupStatus();
  },

  updateYmLabel() {
    const [y, m] = this.yearMonth.split("-");
    document.getElementById("taxDocsYm").textContent = `${y}年${parseInt(m)}月`;
  },

  changeMonth(delta) {
    const [y, m] = this.yearMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    this.yearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    this.updateYmLabel();
    this.loadData();
  },

  async loadData() {
    if (this.loading) return;
    this.loading = true;
    try {
      const data = await this.cfApi_("GET", `/tax-docs/checklist/${this.yearMonth}`);
      this.checklist = data.entities || {};
      this.renderEntities();
    } catch (e) {
      document.getElementById("taxDocsEntities").innerHTML =
        `<div class="alert alert-danger">読み込みエラー: ${e.message}</div>`;
    } finally {
      this.loading = false;
    }
  },

  renderEntities() {
    const el = document.getElementById("taxDocsEntities");
    const entries = Object.entries(this.checklist);

    if (entries.length === 0) {
      el.innerHTML = `<div class="text-center py-4 text-muted">
        <i class="bi bi-building" style="font-size:2rem;"></i>
        <p class="mt-2">名義が未登録です</p>
        <a href="https://scan-sorter-minpaku-v2.web.app/#/entities" target="_blank" class="btn btn-success btn-sm">
          名義を登録する
        </a>
      </div>`;
      this.updateSummary(0, 0);
      return;
    }

    // ソート: order順（entityNameでフォールバック）
    entries.sort((a, b) => (a[1].entityName || "").localeCompare(b[1].entityName || ""));

    let totalAll = 0;
    let completedAll = 0;

    el.innerHTML = entries.map(([entityId, cl]) => {
      const items = cl.items || [];
      const completed = cl.completedCount || items.filter((i) => i.collected).length;
      const total = cl.totalCount || items.length;
      totalAll += total;
      completedAll += completed;

      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
      const icon = cl.entityType === "法人" ? "bi-building" : "bi-person";
      const statusIcon = total === 0 ? "text-muted" : pct === 100 ? "text-success" : pct >= 50 ? "text-warning" : "text-danger";
      const statusEmoji = total === 0 ? "dash-circle" : pct === 100 ? "check-circle-fill" : pct >= 50 ? "exclamation-triangle-fill" : "x-circle-fill";

      const itemsHtml = total === 0
        ? `<div class="text-center py-2 text-muted small">
            <i class="bi bi-info-circle"></i> 口座・プラットフォームが未登録です。
            <a href="https://scan-sorter-minpaku-v2.web.app/#/entities" target="_blank">名義・法人管理</a>で追加してください。
          </div>`
        : items.map((item) => {
        const checked = item.collected ? "checked" : "";
        const driveStatus = item.driveFileExists
          ? `<span class="badge bg-success-subtle text-success">Drive</span>`
          : item.driveCheckedAt
            ? `<span class="badge bg-danger-subtle text-danger">Drive</span>`
            : "";
        const sourceBadge = item.source === "gmail"
          ? `<span class="badge bg-info-subtle text-info">Gmail</span>`
          : item.source === "moneyforward"
            ? `<span class="badge bg-primary-subtle text-primary">MF</span>`
            : `<span class="badge bg-secondary-subtle text-secondary">手動</span>`;
        const fileCount = item.fileCount > 0
          ? `<small class="text-muted">${item.fileCount}件</small>` : "";

        return `
          <div class="d-flex align-items-center gap-2 py-1 border-bottom" style="font-size:0.9rem;">
            <input type="checkbox" class="form-check-input" ${checked}
                   onchange="TaxDocsPage.toggleItem('${entityId}', '${item.name.replace(/'/g, "\\'")}', this.checked)">
            <span class="${item.collected ? 'text-decoration-line-through text-muted' : ''}">${item.name}</span>
            ${sourceBadge}
            ${driveStatus}
            ${fileCount}
          </div>`;
      }).join("");

      return `
        <div class="card mb-3">
          <div class="card-header d-flex justify-content-between align-items-center py-2">
            <div>
              <i class="bi ${icon}"></i>
              <strong>${cl.entityName || entityId}</strong>
              <span class="badge bg-light text-dark border ms-1" style="font-size:0.7rem;">${cl.entityType || ""}</span>
            </div>
            <div class="d-flex align-items-center gap-2">
              <span class="${statusIcon}"><i class="bi bi-${statusEmoji}"></i></span>
              <span class="fw-bold">${completed}/${total}</span>
              <div class="progress" style="width:60px;height:6px;">
                <div class="progress-bar ${pct === 100 ? 'bg-success' : pct >= 50 ? 'bg-warning' : 'bg-danger'}" style="width:${pct}%"></div>
              </div>
            </div>
          </div>
          <div class="card-body py-2">
            ${itemsHtml}
          </div>
        </div>`;
    }).join("");

    this.updateSummary(completedAll, totalAll);
  },

  updateSummary(completed, total) {
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    document.getElementById("taxDocsOverall").textContent = `全体: ${completed}/${total}件 (${pct}%)`;
    const bar = document.getElementById("taxDocsProgressBar");
    bar.style.width = `${pct}%`;
    bar.className = `progress-bar ${pct === 100 ? "bg-success" : pct >= 50 ? "bg-warning" : "bg-danger"}`;
  },

  async toggleItem(entityId, itemName, collected) {
    try {
      await this.cfApi_("PUT", `/tax-docs/checklist/${this.yearMonth}/${entityId}/item`, {
        itemName,
        collected,
      });
      // ローカル更新
      const cl = this.checklist[entityId];
      if (cl) {
        const item = (cl.items || []).find((i) => i.name === itemName);
        if (item) {
          item.collected = collected;
          item.collectedAt = collected ? new Date().toISOString() : null;
          cl.completedCount = (cl.items || []).filter((i) => i.collected).length;
        }
      }
      this.renderEntities();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  async scanAndCollect() {
    const btn = document.getElementById("btnScanNow");
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner-border spinner-border-sm"></div> スキャン中...';
    const msgs = [];
    try {
      // 1. Driveフォルダスキャン（必ず実行）
      const driveResult = await this.cfApi_("POST", `/tax-docs/check-drive-files/${this.yearMonth}`);
      let driveFound = 0;
      let driveMissing = 0;
      for (const [, r] of Object.entries(driveResult.results || {})) {
        if (!r.error) { driveFound += r.found; driveMissing += (r.total - r.found); }
      }
      msgs.push(`Drive: ${driveFound}件検出 / ${driveMissing}件不足`);

      // 2. Gmail収集（設定されていれば実行）
      btn.innerHTML = '<div class="spinner-border spinner-border-sm"></div> Gmail収集中...';
      try {
        const gmailResult = await this.cfApi_("POST", "/tax-docs/collect-now");
        if (gmailResult.skipped) {
          msgs.push("Gmail: 未設定（settings/gmailを設定してください）");
        } else {
          msgs.push("Gmail: 収集完了");
        }
      } catch (e) {
        if (e.message.includes("Gmail監視が無効")) {
          msgs.push("Gmail: 未設定（自動収集するにはGmail APIの設定が必要です）");
        } else {
          msgs.push(`Gmail: ${e.message}`);
        }
      }

      await this.loadData();
      showToast("スキャン&収集完了", msgs.join("\n"), "success");
    } catch (e) {
      showToast("エラー", e.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> スキャン&収集';
    }
  },

  async loadSetupStatus() {
    try {
      const status = await this.cfApi_("GET", "/tax-docs/setup-status");
      this.setupStatus = status;
      this.renderSetup(status);
    } catch (e) {
      document.getElementById("setupContent").innerHTML = `<div class="text-danger small">${e.message}</div>`;
      document.getElementById("setupStatusBadge").textContent = "エラー";
      document.getElementById("setupStatusBadge").className = "badge bg-danger";
    }
  },

  renderSetup(s) {
    const checks = [s.line?.configured, s.gmail?.configured, s.drive?.serviceAccountAuto];
    const ok = checks.filter(Boolean).length;
    const badge = document.getElementById("setupStatusBadge");
    badge.textContent = `${ok}/${checks.length} 設定済み`;
    badge.className = `badge ${ok === checks.length ? "bg-success" : ok > 0 ? "bg-warning" : "bg-danger"}`;

    // Gmail: Firestoreだけ設定済みの場合は警告アイコン
    const gmailIcon = s.gmail?.configured
      ? (s.gmail?.firestoreOnly ? '<i class="bi bi-exclamation-triangle-fill text-warning"></i>' : '<i class="bi bi-check-circle-fill text-success"></i>')
      : '<i class="bi bi-x-circle-fill text-danger"></i>';

    const statusIcon = (ok) => ok ? '<i class="bi bi-check-circle-fill text-success"></i>' : '<i class="bi bi-x-circle-fill text-danger"></i>';

    document.getElementById("setupContent").innerHTML = `
      <!-- 通知方法ON/OFF -->
      <div class="card mb-3 border-primary">
        <div class="card-body py-2">
          <h6 class="mb-2"><i class="bi bi-bell"></i> 通知方法</h6>
          <div class="d-flex gap-4 align-items-center flex-wrap">
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="setupEnableLine" ${s.line?.enableLine ? "checked" : ""}>
              <label class="form-check-label" for="setupEnableLine"><i class="bi bi-line"></i> LINE通知</label>
            </div>
            <div class="form-check form-switch">
              <input class="form-check-input" type="checkbox" id="setupEnableEmail" ${s.email?.enableEmail ? "checked" : ""}>
              <label class="form-check-label" for="setupEnableEmail"><i class="bi bi-envelope"></i> メール通知</label>
            </div>
          </div>
          <div class="mt-2 ${s.email?.enableEmail ? '' : 'd-none'}" id="emailListSection">
            <label class="form-label small mb-1">通知先メールアドレス</label>
            <div id="notifyEmailList">
              ${(s.email?.notifyEmails || []).map((e, i) => `
                <div class="input-group input-group-sm mb-1 notify-email-row">
                  <input type="email" class="form-control notify-email-input" value="${e}" placeholder="example@gmail.com">
                  <button class="btn btn-outline-danger" type="button" onclick="this.closest('.notify-email-row').remove()"><i class="bi bi-x"></i></button>
                </div>
              `).join("") || `
                <div class="input-group input-group-sm mb-1 notify-email-row">
                  <input type="email" class="form-control notify-email-input" value="" placeholder="yamasuke81@gmail.com">
                  <button class="btn btn-outline-danger" type="button" onclick="this.closest('.notify-email-row').remove()"><i class="bi bi-x"></i></button>
                </div>
              `}
            </div>
            <button class="btn btn-outline-success btn-sm" type="button" id="btnAddNotifyEmail">
              <i class="bi bi-plus"></i> アドレス追加
            </button>
          </div>
        </div>
      </div>

      <div class="row g-3">
        <!-- LINE通知 -->
        <div class="col-md-4">
          <h6>${statusIcon(s.line?.configured)} LINE通知</h6>
          <div class="small text-muted mb-2">朝ブリーフィング・アラート通知に必要</div>
          <div class="mb-2">
            <label class="form-label small mb-0">Channel Access Token ${s.line?.hasToken ? '<span class="text-success">✓</span>' : ''}</label>
            <input type="password" class="form-control form-control-sm" id="setupLineToken" placeholder="${s.line?.hasToken ? '(設定済み・変更する場合のみ入力)' : 'LINE Developers で発行'}">
          </div>
          <div class="mb-2">
            <label class="form-label small mb-0">Channel Secret ${s.line?.hasSecret ? '<span class="text-success">✓</span>' : ''}</label>
            <input type="password" class="form-control form-control-sm" id="setupLineSecret" placeholder="${s.line?.hasSecret ? '(設定済み・変更する場合のみ入力)' : 'LINE Developers で確認'}">
          </div>
          <div class="mb-2">
            <label class="form-label small mb-0">Owner User ID ${s.line?.hasUserId ? '<span class="text-success">✓</span>' : ''}</label>
            <input type="text" class="form-control form-control-sm" id="setupLineUserId" placeholder="${s.line?.hasUserId ? '(設定済み・変更する場合のみ入力)' : 'Uxxxx... (LINE Bot友達追加で自動取得可)'}">
          </div>
          <details class="small">
            <summary class="text-primary" style="cursor:pointer">取得手順</summary>
            <ol class="mt-1">
              <li><a href="https://developers.line.biz/console/" target="_blank">LINE Developers Console</a> → プロバイダー作成</li>
              <li><a href="https://developers.line.biz/console/" target="_blank">Messaging API チャネル作成</a></li>
              <li>チャネル設定 → 「<a href="https://developers.line.biz/console/" target="_blank">チャネルアクセストークン</a>」を発行 → 上にペースト</li>
              <li>「チャネルシークレット」（Basic settings内）を確認 → 上にペースト</li>
              <li><a href="https://developers.line.biz/console/" target="_blank">Webhook設定</a> → URL: <code>https://asia-northeast1-minpaku-v2.cloudfunctions.net/lineWebhook</code></li>
              <li>Botを友達追加 → Owner User IDが自動登録されます</li>
            </ol>
          </details>
        </div>

        <!-- Gmail収集 -->
        <div class="col-md-4">
          <h6>${gmailIcon} Gmail自動収集</h6>
          <div class="small text-muted mb-2">Airbnb/Booking.comの送金メールを自動収集</div>
          <div id="gmailAuthAccounts" class="mb-2">読み込み中...</div>
          <div class="d-flex gap-1 flex-wrap mb-2">
            <button class="btn btn-outline-success btn-sm" id="btnGmailConnect">
              <i class="bi bi-google"></i> Gmailアカウント連携
            </button>
          </div>
          <div class="form-check mb-2">
            <input class="form-check-input" type="checkbox" id="setupGmailEnabled" ${s.gmail?.enabled ? "checked" : ""}>
            <label class="form-check-label small">Gmail監視を有効にする</label>
          </div>
          <details class="small">
            <summary class="text-primary" style="cursor:pointer">初回セットアップ手順</summary>
            <ol class="mt-1">
              <li><a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=minpaku-v2" target="_blank">Gmail API を有効化</a></li>
              <li><a href="https://console.cloud.google.com/apis/credentials?project=minpaku-v2" target="_blank">OAuth同意画面 + OAuthクライアントID作成</a>
                <ul>
                  <li>種類: ウェブアプリケーション</li>
                  <li>リダイレクトURI: <code>https://api-5qrfx7ujcq-an.a.run.app/gmail-auth/callback</code></li>
                </ul>
              </li>
              <li>クライアントID/シークレットを下の設定欄に入力して保存</li>
              <li>「Gmailアカウント連携」ボタンで認証</li>
            </ol>
          </details>
          <div class="mt-2">
            <label class="form-label small mb-0">OAuth クライアントID ${s.gmail?.hasOAuthClient ? '<span class="text-success">✓</span>' : ''}</label>
            <input type="text" class="form-control form-control-sm" id="setupOAuthClientId" placeholder="${s.gmail?.hasOAuthClient ? `(設定済み: ${s.gmail.oauthClientIdMask}) 変更する場合のみ入力` : 'xxxx.apps.googleusercontent.com'}">
          </div>
          <div class="mt-1">
            <label class="form-label small mb-0">OAuth クライアントシークレット ${s.gmail?.hasOAuthClient ? '<span class="text-success">✓</span>' : ''}</label>
            <input type="password" class="form-control form-control-sm" id="setupOAuthClientSecret" placeholder="${s.gmail?.hasOAuthClient ? '(設定済み・変更する場合のみ入力)' : 'GOCSPX-...'}">
          </div>
        </div>

        <!-- Drive -->
        <div class="col-md-4">
          <h6>${statusIcon(true)} Driveスキャン</h6>
          <div class="small text-success mb-2">自動設定済み（サービスアカウント使用）</div>
          <div class="small text-muted">税理士共有フォルダにサービスアカウントが「編集者」として共有されている必要があります</div>
          <div class="small text-muted mt-1">SA: <code>minpaku-v2@appspot.gserviceaccount.com</code>
            <a href="https://console.cloud.google.com/iam-admin/serviceaccounts?project=minpaku-v2" target="_blank" class="ms-1"><i class="bi bi-box-arrow-up-right"></i></a>
          </div>
          <div class="small text-muted mt-1">
            <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com?project=minpaku-v2" target="_blank">Drive API 確認</a>
          </div>
        </div>
      </div>

      <div class="mt-3 d-flex gap-2">
        <button class="btn btn-success btn-sm" id="btnSaveSetup"><i class="bi bi-check-lg"></i> 設定を保存</button>
        <button class="btn btn-outline-secondary btn-sm" onclick="TaxDocsPage.loadSetupStatus()"><i class="bi bi-arrow-clockwise"></i> 再チェック</button>
      </div>
    `;

    const saveBtn = document.getElementById("btnSaveSetup");
    if (saveBtn) saveBtn.onclick = () => this.saveSetup();

    // メールON/OFF切り替えでメールリスト表示/非表示
    const emailToggle = document.getElementById("setupEnableEmail");
    if (emailToggle) {
      emailToggle.onchange = () => {
        document.getElementById("emailListSection").classList.toggle("d-none", !emailToggle.checked);
      };
    }

    // メールアドレス追加ボタン
    const addEmailBtn = document.getElementById("btnAddNotifyEmail");
    if (addEmailBtn) {
      addEmailBtn.onclick = () => {
        const row = document.createElement("div");
        row.className = "input-group input-group-sm mb-1 notify-email-row";
        row.innerHTML = '<input type="email" class="form-control notify-email-input" placeholder="example@gmail.com"><button class="btn btn-outline-danger" type="button"><i class="bi bi-x"></i></button>';
        row.querySelector("button").onclick = () => row.remove();
        document.getElementById("notifyEmailList").appendChild(row);
      };
    }

    // 既存の削除ボタンにイベント付与
    document.querySelectorAll(".notify-email-row button").forEach((btn) => {
      btn.onclick = () => btn.closest(".notify-email-row").remove();
    });

    // Gmail連携ボタン
    const gmailConnectBtn = document.getElementById("btnGmailConnect");
    if (gmailConnectBtn) {
      gmailConnectBtn.onclick = () => {
        const email = prompt("連携するGmailアドレスを入力してください:");
        if (!email) return;
        window.open(`https://api-5qrfx7ujcq-an.a.run.app/gmail-auth/start?email=${encodeURIComponent(email)}`, "_blank");
      };
    }

    // Gmail認証済みアカウント一覧を読み込み
    this.loadGmailAccounts();
  },

  async loadGmailAccounts() {
    const el = document.getElementById("gmailAuthAccounts");
    if (!el) return;
    try {
      const data = await this.cfApi_("GET", "/gmail-auth/accounts");
      if (data.accounts.length === 0) {
        el.innerHTML = '<div class="small text-muted">認証済みアカウントなし</div>';
        return;
      }
      el.innerHTML = data.accounts.map((a) => `
        <div class="d-flex align-items-center gap-1 mb-1">
          <span class="badge bg-success-subtle text-success"><i class="bi bi-check-circle"></i></span>
          <span class="small">${a.email}</span>
          <button class="btn btn-outline-danger btn-sm py-0 px-1" onclick="TaxDocsPage.removeGmailAccount('${a.email}')" title="連携解除"><i class="bi bi-x"></i></button>
        </div>
      `).join("");
    } catch (e) {
      el.innerHTML = `<div class="small text-muted">${e.message}</div>`;
    }
  },

  async removeGmailAccount(email) {
    if (!confirm(`「${email}」のGmail連携を解除しますか？`)) return;
    try {
      await this.cfApi_("DELETE", `/gmail-auth/accounts/${encodeURIComponent(email)}`);
      showToast("Gmail連携", `${email} の連携を解除しました`, "info");
      this.loadGmailAccounts();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  async saveSetup() {
    const body = {};

    // LINE/メール ON/OFF
    const enableLine = document.getElementById("setupEnableLine");
    const enableEmail = document.getElementById("setupEnableEmail");

    // 通知先メールアドレス収集
    const notifyEmails = [];
    document.querySelectorAll(".notify-email-input").forEach((input) => {
      const v = input.value.trim();
      if (v) notifyEmails.push(v);
    });

    const lineToken = document.getElementById("setupLineToken");
    const lineSecret = document.getElementById("setupLineSecret");
    const lineUserId = document.getElementById("setupLineUserId");

    body.line = {};
    if (lineToken?.value.trim()) body.line.lineChannelToken = lineToken.value.trim();
    if (lineSecret?.value.trim()) body.line.lineChannelSecret = lineSecret.value.trim();
    if (lineUserId?.value.trim()) body.line.lineOwnerUserId = lineUserId.value.trim();
    body.line.enableLine = enableLine?.checked ?? true;
    body.line.enableEmail = enableEmail?.checked ?? false;
    body.line.notifyEmails = notifyEmails;

    const gmailEnabled = document.getElementById("setupGmailEnabled");
    if (gmailEnabled) {
      body.gmail = { enabled: gmailEnabled?.checked || false };
    }

    // OAuth2クライアント設定
    const oauthId = document.getElementById("setupOAuthClientId");
    const oauthSecret = document.getElementById("setupOAuthClientSecret");
    if (oauthId?.value.trim()) body.oauthClientId = oauthId.value.trim();
    if (oauthSecret?.value.trim()) body.oauthClientSecret = oauthSecret.value.trim();

    try {
      await this.cfApi_("PUT", "/tax-docs/setup", body);
      showToast("設定保存", "設定を保存しました", "success");
      await this.loadSetupStatus();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  async seedItems() {
    if (!confirm("全名義にデフォルトの口座・プラットフォームデータを投入しますか？\n（既にデータがある名義はスキップされます）")) return;
    const btn = document.getElementById("btnSeedItems");
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner-border spinner-border-sm"></div> 投入中...';
    try {
      const result = await this.cfApi_("POST", "/tax-docs/seed-entity-items");
      const lines = (result.results || []).map((r) =>
        `${r.name}: ${r.status === "seeded" ? `${r.accounts}口座 + ${r.platforms}PF + ${r.manualItems}手動` : "スキップ（既存データあり）"}`
      );
      showToast("初期データ投入", lines.join("\n"), "success");
      await this.loadData();
    } catch (e) {
      showToast("エラー", e.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-database-add"></i> 初期データ投入';
    }
  },

  // Cloud Functions API
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
      throw new Error(`ネットワークエラー: ${e.message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let errMsg = `HTTP ${res.status}`;
      try { const j = JSON.parse(text); errMsg += ": " + (j.error || text); } catch (_) { errMsg += ": " + text.substring(0, 200); }
      throw new Error(errMsg);
    }
    return res.json();
  },
};
