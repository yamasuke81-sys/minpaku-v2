/**
 * CTO ダッシュボード
 * 全セッション・全タスクの進捗をリアルタイム一元管理
 * データソース: Firestore sessions/ + projects/ + GitHub Issuesの状態
 */
const ProjectsPage = {

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-clipboard-data"></i> CTO ダッシュボード</h2>
        <button class="btn btn-primary" id="btnRefreshStatus">
          <i class="bi bi-arrow-clockwise"></i> 更新
        </button>
      </div>
      <div id="ctoContent">
        <div class="text-center py-4"><div class="spinner-border text-primary"></div></div>
      </div>
    `;
    document.getElementById("btnRefreshStatus").addEventListener("click", () => this.loadAndRender());
    await this.loadAndRender();
  },

  async loadAndRender() {
    document.getElementById("ctoContent").innerHTML = '<div class="text-center py-4"><div class="spinner-border text-primary"></div></div>';

    // Firestoreから全データ取得
    const [sessionsSnap, issuesSnap] = await Promise.all([
      db.collection("sessions").get(),
      db.collection("tasks").get(),
    ]);
    const sessions = sessionsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const tasks = issuesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    this.renderAll(sessions, tasks);
  },

  renderAll(sessions, tasks) {
    const content = document.getElementById("ctoContent");

    // --- アクティブセッション ---
    const sessionHtml = sessions.length > 0
      ? sessions.sort((a, b) => {
          const ta = a.updatedAt?.seconds || 0;
          const tb = b.updatedAt?.seconds || 0;
          return tb - ta;
        }).map(s => this.renderSessionCard(s)).join("")
      : this.renderNoSessions();

    // --- プロジェクト進捗 ---
    const projects = this.buildProjectList();
    const totalFeatures = projects.reduce((s, p) => s + p.features.length, 0);
    const doneFeatures = projects.reduce((s, p) => s + p.features.filter(f => f.status === "done").length, 0);
    const overallProgress = totalFeatures > 0 ? Math.round((doneFeatures / totalFeatures) * 100) : 0;

    // --- 未処理タスク ---
    const pendingTasks = tasks.filter(t => t.status === "pending");

    content.innerHTML = `
      <!-- サマリー -->
      <div class="row g-3 mb-4">
        <div class="col-6 col-md-3">
          <div class="card card-stat primary"><div class="card-body py-2">
            <div class="text-muted small">全体進捗</div>
            <div class="fs-3 fw-bold">${overallProgress}%</div>
            <div class="progress" style="height:4px"><div class="progress-bar" style="width:${overallProgress}%"></div></div>
          </div></div>
        </div>
        <div class="col-6 col-md-3">
          <div class="card card-stat success"><div class="card-body py-2">
            <div class="text-muted small">完了機能</div>
            <div class="fs-3 fw-bold">${doneFeatures}/${totalFeatures}</div>
          </div></div>
        </div>
        <div class="col-6 col-md-3">
          <div class="card card-stat warning"><div class="card-body py-2">
            <div class="text-muted small">稼働セッション</div>
            <div class="fs-3 fw-bold">${sessions.length}</div>
          </div></div>
        </div>
        <div class="col-6 col-md-3">
          <div class="card card-stat danger"><div class="card-body py-2">
            <div class="text-muted small">未着手タスク</div>
            <div class="fs-3 fw-bold">${pendingTasks.length}</div>
          </div></div>
        </div>
      </div>

      <!-- セッション状況 -->
      <h5 class="mb-3"><i class="bi bi-terminal"></i> セッション状況</h5>
      <div class="row g-3 mb-4">${sessionHtml}</div>

      <!-- プロジェクト別進捗 -->
      <h5 class="mb-3"><i class="bi bi-kanban"></i> プロジェクト別進捗</h5>
      <div class="row g-3 mb-4">
        ${projects.map(p => this.renderProjectCard(p)).join("")}
      </div>

      <!-- 未処理タスクキュー -->
      ${pendingTasks.length > 0 ? `
        <h5 class="mb-3"><i class="bi bi-list-task"></i> 未着手タスク（${pendingTasks.length}件）</h5>
        <div class="list-group mb-4">
          ${pendingTasks.map(t => `
            <div class="list-group-item d-flex align-items-center">
              <span class="badge bg-warning text-dark me-2">待機中</span>
              <div class="flex-grow-1">${this.esc(t.command || t.title || "")}<br><small class="text-muted">${t.department || ""} / ${t.branch || ""}</small></div>
            </div>
          `).join("")}
        </div>
      ` : ""}
    `;

    // 手動登録ボタン
    const seedBtn = document.getElementById("btnSeedSessions");
    if (seedBtn) {
      seedBtn.addEventListener("click", () => this.seedCurrentSessions());
    }

    // セッション編集ボタン
    content.querySelectorAll(".btn-edit-session").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const sid = btn.dataset.sid;
        const s = sessions.find(x => x.id === sid);
        if (s) this.editSession(s);
      });
    });
  },

  async seedCurrentSessions() {
    const sessions = [
      {
        name: "民泊v2 本体",
        icon: "🏠",
        branch: "business-os/main",
        status: "working",
        currentTask: "CTO ダッシュボード改善",
        latestCommit: "セッション状況トラッキング追加",
        lastError: "",
        waitingFor: "",
      },
      {
        name: "秘書通知a",
        icon: "🤵",
        branch: "business-os/secretary",
        status: "done",
        currentTask: "",
        latestCommit: "v0401w LINE通知機能+定期報告+TZバグ修正",
        lastError: "",
        waitingFor: "mainへマージ待ち",
      },
      {
        name: "経理scan-sorter",
        icon: "📄",
        branch: "business-os/scan-sorter",
        status: "paused",
        currentTask: "API+UI作成途中",
        latestCommit: "wip: scan-sorter Firebase版（未統合）",
        lastError: "",
        waitingFor: "方針検討中で停止",
      },
      {
        name: "PDFリネームapp260402a",
        icon: "📎",
        branch: "claude/setup-project-review-j02bm",
        status: "working",
        currentTask: "Firestore直接接続方式に書き換え中",
        latestCommit: "Auth.currentUser.getIdToken エラー修正（ハイブリッド方式）",
        lastError: "Auth.currentUser.getIdToken is not a function",
        waitingFor: "デプロイ後、スキャン開始を試してくださいの回答待ち",
      },
      {
        name: "旧民泊管理app0401c",
        icon: "🏠",
        branch: "main",
        status: "paused",
        currentTask: "",
        latestCommit: "旧GASアプリ（並行運用中）",
        lastError: "",
        waitingFor: "",
      },
    ];
    for (const s of sessions) {
      s.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await db.collection("sessions").doc(s.name.replace(/\s+/g, "-")).set(s);
    }
    showToast("完了", "3セッションを登録しました", "success");
    await this.loadAndRender();
  },

  editSession(s) {
    let modalEl = document.getElementById("calendarEventModal");
    if (!modalEl) {
      const div = document.createElement("div");
      div.innerHTML = '<div class="modal fade" id="calendarEventModal" tabindex="-1"><div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h5 class="modal-title" id="calEventTitle"></h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body" id="calEventBody"></div></div></div></div>';
      document.body.appendChild(div.firstElementChild);
      modalEl = document.getElementById("calendarEventModal");
    }
    document.getElementById("calEventTitle").textContent = s.name + " — 状況更新";
    document.getElementById("calEventBody").innerHTML = `
      <div class="mb-2"><label class="form-label small fw-bold">ステータス</label>
        <select class="form-select form-select-sm" id="sesStatus">
          ${["working","waiting","error","done","paused"].map(v =>
            '<option value="' + v + '"' + (s.status === v ? " selected" : "") + '>' + v + '</option>'
          ).join("")}
        </select></div>
      <div class="mb-2"><label class="form-label small fw-bold">現在のタスク</label>
        <input class="form-control form-control-sm" id="sesTask" value="${this.esc(s.currentTask || "")}"></div>
      <div class="mb-2"><label class="form-label small fw-bold">最新コミット</label>
        <input class="form-control form-control-sm" id="sesCommit" value="${this.esc(s.latestCommit || "")}"></div>
      <div class="mb-2"><label class="form-label small fw-bold">エラー</label>
        <input class="form-control form-control-sm" id="sesError" value="${this.esc(s.lastError || "")}"></div>
      <div class="mb-2"><label class="form-label small fw-bold">待ち状態</label>
        <input class="form-control form-control-sm" id="sesWaiting" value="${this.esc(s.waitingFor || "")}"></div>
      <button class="btn btn-primary btn-sm" id="sesSave">保存</button>
      <button class="btn btn-outline-danger btn-sm ms-2" id="sesDelete">削除</button>
    `;
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();
    document.getElementById("sesSave").addEventListener("click", async () => {
      await db.collection("sessions").doc(s.id).update({
        status: document.getElementById("sesStatus").value,
        currentTask: document.getElementById("sesTask").value.trim(),
        latestCommit: document.getElementById("sesCommit").value.trim(),
        lastError: document.getElementById("sesError").value.trim(),
        waitingFor: document.getElementById("sesWaiting").value.trim(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      modal.hide();
      showToast("完了", "セッション情報を更新しました", "success");
      await this.loadAndRender();
    });
    document.getElementById("sesDelete").addEventListener("click", async () => {
      if (!confirm(s.name + " を削除しますか？")) return;
      await db.collection("sessions").doc(s.id).delete();
      modal.hide();
      await this.loadAndRender();
    });
  },

  renderNoSessions() {
    return `
      <div class="col-12">
        <div class="alert alert-info">
          <strong>セッション情報なし</strong> — 各Claude Codeセッションが起動時にFirestoreの sessions/ に状況を書き込むと、ここに表示されます。
          <hr>
          <button class="btn btn-sm btn-primary" id="btnSeedSessions">現在の状況を手動登録</button>
        </div>
      </div>
    `;
  },

  renderSessionCard(s) {
    const statusColor = {
      "active": "success", "working": "primary", "waiting": "warning",
      "error": "danger", "done": "secondary", "paused": "secondary",
    }[s.status] || "secondary";
    const statusLabel = {
      "active": "作業中", "working": "実装中", "waiting": "応答待ち",
      "error": "エラー", "done": "完了", "paused": "停止中",
    }[s.status] || s.status;

    const updatedAt = s.updatedAt?.toDate
      ? s.updatedAt.toDate().toLocaleString("ja-JP")
      : (s.updatedAt || "");
    const errorHtml = s.lastError
      ? `<div class="mt-1 small text-danger"><i class="bi bi-exclamation-triangle"></i> ${this.esc(s.lastError)}</div>`
      : "";

    return `
      <div class="col-md-6 col-lg-4">
        <div class="card border-${statusColor}">
          <div class="card-header py-2 d-flex justify-content-between align-items-center">
            <div>
              <span class="fs-5">${s.icon || "🤖"}</span>
              <strong>${this.esc(s.name || s.id)}</strong>
            </div>
            <span class="badge bg-${statusColor}">${statusLabel}</span>
          </div>
          <div class="card-body py-2">
            <div class="small"><i class="bi bi-git"></i> ${this.esc(s.branch || "")}</div>
            ${s.currentTask ? `<div class="small mt-1"><i class="bi bi-arrow-right-short"></i> <strong>${this.esc(s.currentTask)}</strong></div>` : ""}
            ${s.latestCommit ? `<div class="small mt-1 text-muted"><i class="bi bi-check-circle"></i> ${this.esc(s.latestCommit)}</div>` : ""}
            ${errorHtml}
            ${s.waitingFor ? `<div class="small mt-1 text-warning"><i class="bi bi-clock"></i> 待ち: ${this.esc(s.waitingFor)}</div>` : ""}
            <div class="d-flex justify-content-between mt-1">
              <small class="text-muted">${updatedAt}</small>
              <button class="btn btn-sm btn-outline-secondary btn-edit-session py-0" data-sid="${s.id}"><i class="bi bi-pencil"></i></button>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  buildProjectList() {
    return [
      {
        name: "民泊管理v2", icon: "🏠", branch: "business-os/main",
        features: [
          { name: "スタッフ管理", status: "done" },
          { name: "物件管理", status: "done" },
          { name: "募集管理", status: "done" },
          { name: "カレンダー+直接操作", status: "done" },
          { name: "宿泊者名簿", status: "done" },
          { name: "ゲスト公開フォーム", status: "done" },
          { name: "データ整形・重複削除", status: "done" },
          { name: "N+1解消", status: "done" },
          { name: "司令塔+CTO", status: "done" },
          { name: "請求書自動生成", status: "wip", issue: 12 },
          { name: "BEDS24連携", status: "planned" },
        ],
      },
      {
        name: "AI秘書「黒子」", icon: "🤵", branch: "business-os/secretary",
        features: [
          { name: "定期報告（14条）", status: "done", issue: 15 },
          { name: "名簿マージ+TZバグ修正", status: "done" },
          { name: "LINE通知基盤", status: "done", issue: 11 },
          { name: "朝ブリーフィング", status: "done", issue: 11 },
          { name: "未確定アラート", status: "done", issue: 11 },
          { name: "mainへマージ", status: "todo" },
          { name: "GOサイン待ちフロー", status: "planned" },
        ],
      },
      {
        name: "経理自動化", icon: "📄", branch: "business-os/scan-sorter",
        features: [
          { name: "PDFリネーム GAS版（稼働中）", status: "done" },
          { name: "PDFリネーム Firebase版", status: "wip" },
          { name: "スキャン自動仕分け API+UI", status: "wip", issue: 13 },
          { name: "OCR(Vision API/Gemini)", status: "wip" },
          { name: "Google Drive操作", status: "wip" },
          { name: "MF連携", status: "planned" },
          { name: "税理士共有", status: "planned" },
        ],
      },
      {
        name: "不動産レーダー", icon: "🏢", branch: "business-os/property-radar",
        features: [
          { name: "物件自動収集", status: "todo", issue: 14 },
          { name: "スコアリング", status: "planned" },
        ],
      },
    ];
  },

  renderProjectCard(p) {
    const done = p.features.filter(f => f.status === "done").length;
    const total = p.features.length;
    const progress = total > 0 ? Math.round((done / total) * 100) : 0;

    const featureList = p.features.map(f => {
      const icon = { done: "✅", wip: "🔧", todo: "⬜", planned: "📋" }[f.status] || "⬜";
      const link = f.issue ? ` <a href="https://github.com/yamasuke81-sys/minpaku-fix/issues/${f.issue}" target="_blank" class="text-muted">#${f.issue}</a>` : "";
      const cls = f.status === "wip" ? "fw-bold text-primary" : f.status === "done" ? "" : "";
      return `<div class="${cls}">${icon} ${this.esc(f.name)}${link}</div>`;
    }).join("");

    return `
      <div class="col-md-6">
        <div class="card h-100">
          <div class="card-header py-2 d-flex justify-content-between">
            <div><span class="fs-5">${p.icon}</span> <strong>${this.esc(p.name)}</strong></div>
            <span class="fw-bold">${progress}%</span>
          </div>
          <div class="card-body py-2">
            <div class="progress mb-2" style="height:6px"><div class="progress-bar" style="width:${progress}%"></div></div>
            <small class="text-muted"><i class="bi bi-git"></i> ${this.esc(p.branch)}</small>
            <div class="small mt-2">${featureList}</div>
          </div>
        </div>
      </div>
    `;
  },

  esc(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  },
};
