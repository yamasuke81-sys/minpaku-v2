/**
 * 司令塔（コマンドセンター）
 * 高レベル指示 → タスク分解 → セッション起動プロンプト自動生成
 * AI部署が自動的にタスクをピックアップして実行する仕組み
 */
const CommandCenterPage = {
  tasks: [],

  // GitHub Issue レジストリ（起動プロンプト付き）
  issueRegistry: [
    {
      id: 11, icon: "🤵", title: "#11 LINE通知基盤を実装", dept: "秘書室（黒子）", branch: "business-os/secretary",
      url: "https://github.com/yamasuke81-sys/minpaku-fix/issues/11",
      command: "秘書にLINE通知基盤を実装させて",
    },
    {
      id: 15, icon: "🤵", title: "#15 住宅宿泊事業法14条 定期報告の自動化", dept: "秘書室（黒子）", branch: "business-os/secretary",
      url: "https://github.com/yamasuke81-sys/minpaku-fix/issues/15",
      command: "住宅宿泊事業法14条の定期報告を自動化して。guestRegistrationsとbookingsから2ヶ月分の宿泊日数・国籍別人数を自動集計、報告書プレビュー画面、期限リマインダー",
    },
    {
      id: 12, icon: "💰", title: "#12 請求書自動生成", dept: "情報システム課", branch: "business-os/main",
      url: "https://github.com/yamasuke81-sys/minpaku-fix/issues/12",
      command: "民泊の請求書自動生成を作って",
    },
    {
      id: 13, icon: "📄", title: "#13 ScanSnap自動仕分け", dept: "経理課", branch: "business-os/scan-sorter",
      url: "https://github.com/yamasuke81-sys/minpaku-fix/issues/13",
      command: "経理のスキャン自動仕分けを始めて",
    },
    {
      id: 14, icon: "🏢", title: "#14 物件自動収集レーダー", dept: "不動産課", branch: "business-os/property-radar",
      url: "https://github.com/yamasuke81-sys/minpaku-fix/issues/14",
      command: "不動産の物件自動収集を作って",
    },
  ],

  // AI部署定義
  departments: {
    "情報システム課": { icon: "💻", branch: "business-os/main", skills: ["民泊管理", "Firebase", "UI", "API"], color: "primary" },
    "秘書室（黒子）": { icon: "🤵", branch: "business-os/secretary", skills: ["LINE通知", "ブリーフィング", "アラート", "定期実行"], color: "dark" },
    "経理課": { icon: "📄", branch: "business-os/scan-sorter", skills: ["スキャン", "OCR", "仕分け", "記帳", "税理士"], color: "success" },
    "不動産課": { icon: "🏢", branch: "business-os/property-radar", skills: ["物件検索", "スコアリング", "価格追跡"], color: "warning" },
  },

  // Gemini設定キャッシュ
  geminiConfig: null,

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-command"></i> 司令塔</h2>
      </div>

      <!-- 指示入力 -->
      <div class="card mb-4 border-primary">
        <div class="card-body">
          <h5 class="mb-3"><i class="bi bi-mic"></i> 社長指示</h5>
          <textarea class="form-control mb-2" id="cmdInput" rows="4"
            placeholder="やりたいことを自由に書いてください。&#10;例: 清掃スタッフの報酬を自動計算して請求書PDFを生成したい。シフトとランドリーの実績から月額を集計。交通費も含める。タイミーは別扱い。"></textarea>
          <div class="d-flex gap-2 mb-2">
            <button class="btn btn-info" id="btnOrganize">
              <i class="bi bi-stars"></i> Geminiで整理
            </button>
            <button class="btn btn-primary" id="btnCommand">
              <i class="bi bi-send"></i> タスク発行
            </button>
          </div>
          <div class="d-flex flex-wrap gap-2">
            <button class="btn btn-sm btn-outline-secondary quick-cmd" data-cmd="秘書にLINE通知を実装させて">🤵 秘書LINE通知</button>
            <button class="btn btn-sm btn-outline-secondary quick-cmd" data-cmd="民泊の請求書自動生成を作って">💰 請求書</button>
            <button class="btn btn-sm btn-outline-secondary quick-cmd" data-cmd="経理のスキャン自動仕分けを始めて">📄 経理自動化</button>
            <button class="btn btn-sm btn-outline-secondary quick-cmd" data-cmd="不動産の物件自動収集を作って">🏢 物件レーダー</button>
          </div>
        </div>
      </div>

      <!-- Gemini整理結果 -->
      <div class="card mb-4 border-info d-none" id="organizedCard">
        <div class="card-header bg-info text-white d-flex justify-content-between align-items-center">
          <strong><i class="bi bi-stars"></i> 整理済み指示</strong>
          <div class="d-flex gap-2">
            <button class="btn btn-sm btn-light" id="btnCopyOrganizedPrompt">
              <i class="bi bi-clipboard"></i> プロンプトをコピー
            </button>
            <button class="btn btn-sm btn-outline-light" id="btnUseOrganized">
              <i class="bi bi-send"></i> タスク発行
            </button>
          </div>
        </div>
        <div class="card-body">
          <textarea class="form-control font-monospace" id="organizedText" rows="10"
            placeholder="Geminiが整理した内容がここに表示されます。編集も可能です。"></textarea>
        </div>
      </div>

      <!-- 組織図 + セッション状態 -->
      <div class="card mb-4">
        <div class="card-header bg-dark text-white py-2 d-flex justify-content-between align-items-center">
          <strong><i class="bi bi-diagram-3"></i> AI組織図</strong>
          <button class="btn btn-sm btn-outline-light" id="btnRefreshOrg"><i class="bi bi-arrow-clockwise"></i></button>
        </div>
        <div class="card-body p-2" id="orgChart">
          <div class="text-center py-3"><div class="spinner-border spinner-border-sm"></div></div>
        </div>
      </div>

      <!-- GitHub Issues（実行可能タスク） -->
      <div class="card mb-4">
        <div class="card-header bg-dark text-white py-2">
          <strong><i class="bi bi-github"></i> GitHub Issues（実行可能タスク）</strong>
        </div>
        <div class="list-group list-group-flush" id="issueList">
          ${this.issueRegistry.map(issue => `
            <div class="list-group-item d-flex align-items-center issue-item" data-issue-id="${issue.id}">
              <span class="me-2 fs-5">${issue.icon}</span>
              <div class="flex-grow-1">
                <strong>${issue.title}</strong>
                <small class="text-muted d-block">${issue.dept} / ${issue.branch}</small>
              </div>
              <a href="${issue.url}" target="_blank" class="btn btn-sm btn-outline-secondary me-2" title="GitHub で見る">
                <i class="bi bi-box-arrow-up-right"></i>
              </a>
              <button class="btn btn-sm btn-primary btn-launch-issue" data-issue-idx="${this.issueRegistry.indexOf(issue)}" title="セッション起動">
                <i class="bi bi-play-fill"></i> 起動
              </button>
            </div>
          `).join("")}
        </div>
      </div>

      <!-- タスクキュー -->
      <h5><i class="bi bi-list-task"></i> タスクキュー</h5>
      <div id="taskQueue">
        <div class="text-center py-3"><div class="spinner-border spinner-border-sm"></div></div>
      </div>

      <!-- セッション起動モーダル -->
      <div class="modal fade" id="sessionModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
          <div class="modal-content">
            <div class="modal-header bg-dark text-white">
              <h5 class="modal-title"><i class="bi bi-terminal"></i> セッション起動</h5>
              <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div id="sessionContent"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
    await Promise.all([this.loadTasks(), this.renderOrgChart()]);
  },

  bindEvents() {
    document.getElementById("btnCommand").addEventListener("click", () => this.processCommand());
    document.getElementById("btnOrganize").addEventListener("click", () => this.organizeWithGemini());
    document.getElementById("btnUseOrganized").addEventListener("click", () => this.processOrganized());
    document.getElementById("btnCopyOrganizedPrompt").addEventListener("click", () => this.copyOrganizedPrompt());
    document.getElementById("btnRefreshOrg").addEventListener("click", () => this.renderOrgChart());
    document.querySelectorAll(".quick-cmd").forEach(btn => {
      btn.addEventListener("click", () => {
        document.getElementById("cmdInput").value = btn.dataset.cmd;
        this.processCommand();
      });
    });

    // GitHub Issue起動ボタン
    document.querySelectorAll(".btn-launch-issue").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.issueIdx);
        const issue = this.issueRegistry[idx];
        if (issue) this.launchFromIssue(issue);
      });
    });
  },

  // === GitHub Issue から直接セッション起動 ===
  launchFromIssue(issue) {
    const dept = this.detectDepartment(issue.command);
    const spec = this.generateSpec(issue.command, dept);
    const task = {
      id: `issue_${issue.id}`,
      command: issue.command,
      department: issue.dept || dept,
      branch: issue.branch,
      spec,
      issueUrl: issue.url,
    };
    this.showSessionLauncher(task);
  },

  // === Gemini APIで指示を整理 ===
  async organizeWithGemini() {
    const raw = document.getElementById("cmdInput").value.trim();
    if (!raw) { showToast("エラー", "指示を入力してください", "error"); return; }

    const btn = document.getElementById("btnOrganize");
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner-border spinner-border-sm me-1"></div> 整理中...';

    try {
      // Gemini設定を毎回Firestoreから取得（設定変更を即反映）
      const doc = await db.collection("settings").doc("gemini").get();
      if (!doc.exists || !doc.data().apiKey) {
        showToast("エラー", "設定画面でGemini APIキーを登録してください", "error");
        return;
      }
      this.geminiConfig = doc.data();

      const organized = await this.callGemini(raw);

      // 整理結果を表示
      document.getElementById("organizedText").value = organized;
      document.getElementById("organizedCard").classList.remove("d-none");
      showToast("完了", "指示を整理しました。内容を確認・編集してタスク発行してください。", "success");
    } catch (e) {
      console.error("Gemini API error:", e);
      this.geminiConfig = null; // エラー時はキャッシュクリア
      showToast("エラー", `Gemini API: ${e.message}`, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-stars"></i> Geminiで整理';
    }
  },

  // Gemini API呼び出し
  async callGemini(rawText) {
    const { apiKey, model } = this.geminiConfig;
    const modelId = model || "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const systemPrompt = `あなたは社長の指示を整理するAIアシスタントです。
社長が自由に書いた指示文を以下の形式に整理してください。

【形式】
## 目的
（この指示で達成したいことを1〜2文で）

## 要件
1. （具体的な要件を番号付きリストで）
2. ...

## 制約・条件
- （あれば。技術的制約、ビジネスルール、除外条件など）

## 補足
- （あれば。参考情報、背景、優先度など）

【ルール】
- 元の指示の意図を正確に保つこと（勝手に要件を追加しない）
- 曖昧な部分は「※要確認:」と注記して残す
- 技術的な用語はそのまま使う
- 簡潔に、箇条書きで整理する
- 不要なセクション（制約や補足が無い場合）は省略してよい`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: rawText }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || `HTTP ${res.status}`);
    }

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "（整理結果なし）";
  },

  // 整理済みテキストでタスク発行
  async processOrganized() {
    const organized = document.getElementById("organizedText").value.trim();
    if (!organized) return;
    const raw = document.getElementById("cmdInput").value.trim();
    await this._createTask(raw, organized);
  },

  // ワンタップ：整理済みテキストからプロンプトを生成してコピー
  copyOrganizedPrompt() {
    const organized = document.getElementById("organizedText").value.trim();
    if (!organized) { showToast("エラー", "整理済みテキストがありません", "error"); return; }
    const raw = document.getElementById("cmdInput").value.trim();

    // 部署・ブランチを判定
    const dept = this.detectDepartment(raw || organized);
    const deptInfo = this.departments[dept];
    const spec = this.generateSpec(raw || organized, dept);
    const issueUrl = this.findIssueUrl(dept);

    // プロンプト生成
    const task = {
      command: raw || organized.split("\n")[0],
      organizedCommand: organized,
      department: dept,
      branch: deptInfo.branch,
      spec,
      issueUrl,
    };
    const prompt = this.buildSessionPrompt(task);

    // クリップボードにコピー
    navigator.clipboard.writeText(prompt).then(() => {
      const btn = document.getElementById("btnCopyOrganizedPrompt");
      btn.innerHTML = '<i class="bi bi-check-lg"></i> コピー済み!';
      btn.classList.replace("btn-light", "btn-success");
      setTimeout(() => {
        btn.innerHTML = '<i class="bi bi-clipboard"></i> プロンプトをコピー';
        btn.classList.replace("btn-success", "btn-light");
      }, 3000);
      showToast("完了", `${dept}向けプロンプトをコピーしました。Claude Codeに貼り付けてください。`, "success");
    });
  },

  // === 指示を処理 → タスク生成 ===
  async processCommand() {
    const input = document.getElementById("cmdInput").value.trim();
    if (!input) return;
    await this._createTask(input, null);
  },

  // 共通タスク生成処理
  async _createTask(rawInput, organizedText) {
    const input = rawInput || "";

    // AI部署を自動判定
    const dept = this.detectDepartment(input);
    const deptInfo = this.departments[dept];

    // タスク仕様を自動生成
    const spec = this.generateSpec(input, dept);

    // Firestoreに保存
    const task = {
      command: input,
      organizedCommand: organizedText || null,
      department: dept,
      branch: deptInfo.branch,
      spec: spec,
      status: "pending",  // pending → in_progress → done
      priority: this.detectPriority(input),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };

    const ref = await db.collection("tasks").add(task);
    task.id = ref.id;

    document.getElementById("cmdInput").value = "";
    document.getElementById("organizedCard").classList.add("d-none");
    showToast("完了", `${dept}にタスクを割り当てました`, "success");

    // GitHub Issue URLがあれば含める（手動で作成済みの場合）
    const issueUrl = this.findIssueUrl(dept);
    if (issueUrl) task.issueUrl = issueUrl;

    // セッション起動プロンプトを表示
    this.showSessionLauncher(task);
    await this.loadTasks();
  },

  // AI部署を自動判定
  detectDepartment(input) {
    const lower = input.toLowerCase();
    for (const [name, dept] of Object.entries(this.departments)) {
      if (dept.skills.some(s => lower.includes(s.toLowerCase()))) return name;
    }
    if (lower.includes("秘書") || lower.includes("黒子") || lower.includes("通知") || lower.includes("line")) return "秘書室（黒子）";
    if (lower.includes("経理") || lower.includes("スキャン") || lower.includes("記帳")) return "経理課";
    if (lower.includes("不動産") || lower.includes("物件")) return "不動産課";
    return "情報システム課";
  },

  detectPriority(input) {
    if (input.includes("至急") || input.includes("緊急") || input.includes("今すぐ")) return "high";
    return "normal";
  },

  // GitHub Issue URLを部署別に返す（既知のIssue）
  findIssueUrl(dept) {
    const issueMap = {
      "秘書室（黒子）": "https://github.com/yamasuke81-sys/minpaku-fix/issues/11",
      "情報システム課": "https://github.com/yamasuke81-sys/minpaku-fix/issues/12",
      "経理課": "https://github.com/yamasuke81-sys/minpaku-fix/issues/13",
      "不動産課": "https://github.com/yamasuke81-sys/minpaku-fix/issues/14",
    };
    return issueMap[dept] || null;
  },

  // タスク仕様書を自動生成（キーワードで具体的な参照コードを特定）
  generateSpec(input, dept) {
    const lower = input.toLowerCase();
    const base = {
      reads: [],
      codeRefs: [],  // 参考にすべき既存コードのパス+説明
      newFiles: [],  // 新規作成すべきファイル
      firestore: [],
      pattern: "",   // 既存コードのどのパターンを踏襲するか
    };

    // 必須設計書（全タスク共通）
    base.reads.push("business-os/CLAUDE.md（全体設計・ルール）");
    base.reads.push("business-os/apps/minpaku-v2/MEMORY.md（現在の状態）");

    // --- 秘書室 ---
    if (dept === "秘書室（黒子）") {
      base.reads.push("business-os/agents/secretary.md（秘書の役割・ブリーフィング仕様）");
      base.reads.push("business-os/agents/secretary-impl.md（実装設計・Cloud Functions構成）");

      if (lower.includes("line") || lower.includes("通知")) {
        base.newFiles.push("functions/utils/lineNotify.js — LINE Messaging API送信ユーティリティ");
        base.newFiles.push("functions/scheduled/morningBriefing.js — 朝ブリーフィング（毎朝6:00 JST）");
        base.newFiles.push("functions/scheduled/alertUnconfirmed.js — 未確定アラート（毎時）");
        base.firestore.push("settings/notifications（LINE設定）", "recruitments（募集状況）", "bookings（予約）");
        base.codeRefs.push("functions/index.js — Cloud Functions登録パターンを参照（onSchedule, onDocumentWritten）");
      }
      if (lower.includes("定期報告") || lower.includes("14条")) {
        base.newFiles.push("public/js/pages/report.js — 定期報告プレビュー画面");
        base.firestore.push("guestRegistrations（宿泊者名簿→国籍別人数集計）", "bookings（宿泊日数集計）");
        base.codeRefs.push("public/js/pages/guests.js — 宿泊者名簿ページのUIパターンを参照");
        base.codeRefs.push("public/js/api.js:342行〜 guests API — Firestoreクエリパターン");
        base.pattern = "guests.js のテーブル表示 + フィルタのパターンを踏襲";
      }
      return base;
    }

    // --- 情報システム課 ---
    if (dept === "情報システム課") {
      base.reads.push("business-os/apps/minpaku-v2/CLAUDE.md（DBスキーマ・技術スタック）");

      if (lower.includes("請求") || lower.includes("報酬") || lower.includes("invoice")) {
        base.newFiles.push("public/js/pages/invoices.js — 請求書ページ（月別一覧・詳細・PDF出力）");
        base.firestore.push("invoices/（請求書）", "shifts/（シフト実績）", "laundry/（ランドリー）", "staff/（報酬単価・交通費）");
        base.codeRefs.push("public/js/pages/recruitment.js — ページ構成パターン（render/bindEvents/loadData/renderList/openModal）");
        base.codeRefs.push("public/js/api.js:200行〜 invoices API — 既存の list/get/confirm を拡張");
        base.codeRefs.push("public/index.html — モーダル追加パターン（recruitmentModal を参考に invoiceModal を追加）");
        base.codeRefs.push("functions/api/invoices.js — バックエンドAPI（generate エンドポイント追加）");
        base.pattern = "recruitment.js のカード一覧+詳細モーダルパターンを踏襲。月選択→集計→明細表示";
      }
      if (lower.includes("宿泊") || lower.includes("名簿") || lower.includes("ゲスト")) {
        base.firestore.push("guestRegistrations/", "bookings/");
        base.codeRefs.push("public/js/pages/guests.js — 宿泊者名簿ページ全体");
        base.codeRefs.push("public/js/data-transformer.js:280行〜 transformGuestRegistrations — データ変換ロジック");
        base.codeRefs.push("public/guest-form.html — ゲスト向け公開フォーム");
        base.pattern = "guests.js の検索+テーブル+詳細モーダルパターン";
      }
      if (lower.includes("カレンダー") || lower.includes("ダッシュボード")) {
        base.codeRefs.push("public/js/pages/dashboard.js — カレンダー+統計カード+要対応パネル");
        base.pattern = "dashboard.js の FullCalendar + モーダル内操作パターン";
      }
      if (lower.includes("募集") || lower.includes("スタッフ")) {
        base.firestore.push("recruitments/（responses[]埋め込み）", "staff/");
        base.codeRefs.push("public/js/pages/recruitment.js — 募集管理（一覧・回答・選定・確定）");
        base.codeRefs.push("public/js/api.js:225行〜 recruitments API — respond/selectStaff/confirm");
        base.pattern = "recruitment.js のカード+詳細モーダル+回答ボタンパターン";
      }
      return base;
    }

    // --- 経理課 ---
    if (dept === "経理課") {
      base.reads.push("business-os/apps/scan-sorter/CLAUDE.md（経理自動化設計）");
      base.newFiles.push("business-os/apps/scan-sorter/ 以下に新規実装");
      base.pattern = "minpaku-v2のCloud Functions構成を参考にする";
      return base;
    }

    // --- 不動産課 ---
    if (dept === "不動産課") {
      base.reads.push("business-os/apps/property-radar/CLAUDE.md（物件レーダー設計）");
      base.newFiles.push("business-os/apps/property-radar/ 以下に新規実装");
      base.pattern = "minpaku-v2のCloud Functions構成を参考にする";
      return base;
    }

    return base;
  },

  // === セッション起動プロンプト表示 ===
  showSessionLauncher(task) {
    const dept = this.departments[task.department];
    const spec = task.spec;

    const prompt = this.buildSessionPrompt(task);

    const content = document.getElementById("sessionContent");
    content.innerHTML = `
      <div class="mb-3">
        <span class="badge bg-${dept.color} fs-6">${dept.icon} ${task.department}</span>
        <span class="badge bg-light text-dark fs-6 ms-2"><i class="bi bi-git"></i> ${task.branch}</span>
      </div>

      <div class="alert alert-info">
        <strong>指示:</strong> ${this.esc(task.command)}
      </div>

      <h6>セッション起動プロンプト</h6>
      <p class="text-muted small">新しいClaude Codeセッションに以下をコピペしてください:</p>
      <div class="position-relative">
        <pre class="bg-dark text-light p-3 rounded" style="white-space:pre-wrap;font-size:0.85rem" id="sessionPrompt">${this.esc(prompt)}</pre>
        <button class="btn btn-sm btn-outline-light position-absolute top-0 end-0 m-2" id="btnCopyPrompt">
          <i class="bi bi-clipboard"></i> コピー
        </button>
      </div>

      <div class="mt-3 small">
        ${(spec.codeRefs || []).length ? `<div class="mb-2"><strong>📍 参考コード:</strong><ul class="mb-1">${spec.codeRefs.map(r => `<li><code>${this.esc(r)}</code></li>`).join("")}</ul></div>` : ""}
        ${(spec.newFiles || []).length ? `<div class="mb-2"><strong>📝 新規作成:</strong><ul class="mb-1">${spec.newFiles.map(f => `<li><code>${this.esc(f)}</code></li>`).join("")}</ul></div>` : ""}
        ${(spec.firestore || []).length ? `<div class="mb-2"><strong>🔥 Firestore:</strong> ${spec.firestore.map(f => `<code>${this.esc(f)}</code>`).join(", ")}</div>` : ""}
        ${spec.pattern ? `<div><strong>📐 設計方針:</strong> ${this.esc(spec.pattern)}</div>` : ""}
      </div>
    `;

    document.getElementById("btnCopyPrompt").addEventListener("click", () => {
      navigator.clipboard.writeText(prompt);
      document.getElementById("btnCopyPrompt").innerHTML = '<i class="bi bi-check"></i> コピー済み';
      showToast("完了", "プロンプトをコピーしました", "success");
    });

    const modal = new bootstrap.Modal(document.getElementById("sessionModal"));
    modal.show();
  },

  buildSessionPrompt(task) {
    const s = task.spec;
    const issueRef = task.issueUrl ? `\n詳細仕様: ${task.issueUrl}` : "";

    const reads = (s.reads || []).map(r => `- ${r}`).join("\n");
    const codeRefs = (s.codeRefs || []).length
      ? `\n【参考コード（これらのパターンを踏襲して実装）】\n${s.codeRefs.map(r => `- ${r}`).join("\n")}`
      : "";
    const newFiles = (s.newFiles || []).length
      ? `\n【新規作成するファイル】\n${s.newFiles.map(f => `- ${f}`).join("\n")}`
      : "";
    const firestore = (s.firestore || []).length
      ? `\n【使用するFirestoreコレクション】\n${s.firestore.map(f => `- ${f}`).join("\n")}`
      : "";
    const pattern = s.pattern ? `\n【設計方針】${s.pattern}` : "";

    // 整理済みテキストがあればプロンプトに組み込む
    const organized = task.organizedCommand
      ? `\n\n【社長指示（整理済み）】\n${task.organizedCommand}`
      : "";

    return `このリポジトリは yamasuke81-sys/minpaku-fix です。

■ 最初に必ず以下を実行してください（設計書はこのブランチにしかありません）:
git fetch origin business-os/main && git checkout business-os/main

■ 次に以下の設計書を読んでください:
${reads}
${issueRef}

■ 読んだら、作業ブランチに切り替えて実装してください:
git checkout ${task.branch}

【タスク】${task.command}
${organized}
${codeRefs}
${newFiles}
${firestore}
${pattern}

■ 完了手順:
1. コミット＆push（ブランチ: ${task.branch}）
2. business-os/main にマージ＆push（GitHub Actionsでデプロイ）`;
  },

  // === タスクキュー表示 ===
  async loadTasks() {
    try {
      const snap = await db.collection("tasks").orderBy("createdAt", "desc").get();
      this.tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      this.renderTasks();
    } catch (e) {
      // createdAtインデックスがない場合のフォールバック
      const snap = await db.collection("tasks").get();
      this.tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      this.tasks.sort((a, b) => {
        const ta = a.createdAt?.seconds || 0;
        const tb = b.createdAt?.seconds || 0;
        return tb - ta;
      });
      this.renderTasks();
    }
  },

  renderTasks() {
    const container = document.getElementById("taskQueue");

    if (!this.tasks.length) {
      container.innerHTML = '<p class="text-muted text-center py-3">タスクなし — 上の入力欄から指示を出してください</p>';
      return;
    }

    container.innerHTML = `
      <div class="list-group">
        ${this.tasks.map(t => {
          const dept = this.departments[t.department] || { icon: "📁", color: "secondary" };
          const statusMap = {
            "pending": '<span class="badge bg-warning text-dark">待機中</span>',
            "in_progress": '<span class="badge bg-primary">作業中</span>',
            "done": '<span class="badge bg-success">完了</span>',
          };
          const status = statusMap[t.status] || statusMap.pending;
          const date = t.createdAt?.toDate ? t.createdAt.toDate().toLocaleString("ja-JP") : "";

          return `
            <div class="list-group-item d-flex align-items-center task-item" data-id="${t.id}">
              <span class="me-2 fs-5">${dept.icon}</span>
              <div class="flex-grow-1">
                <div>${this.esc(t.command)}</div>
                <small class="text-muted">${t.department} / ${t.branch} / ${date}</small>
              </div>
              ${status}
              <div class="btn-group btn-group-sm ms-2">
                ${t.status === "pending" ? `<button class="btn btn-outline-primary btn-launch" title="セッション起動"><i class="bi bi-play-fill"></i></button>` : ""}
                <button class="btn btn-outline-danger btn-del-task" title="削除"><i class="bi bi-x"></i></button>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;

    // イベント
    container.querySelectorAll(".btn-launch").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const t = this.tasks.find(x => x.id === btn.closest(".task-item").dataset.id);
        if (t) this.showSessionLauncher(t);
      });
    });
    container.querySelectorAll(".btn-del-task").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.closest(".task-item").dataset.id;
        await db.collection("tasks").doc(id).delete();
        await this.loadTasks();
      });
    });
  },

  // === 組織図 + セッション状態表示 ===
  async renderOrgChart() {
    const container = document.getElementById("orgChart");

    // Firestoreからセッション情報を取得
    let sessions = [];
    try {
      const snap = await db.collection("sessions").get();
      sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      console.error("セッション取得エラー:", e);
    }

    // 部署ごとにセッションをグループ化（ブランチで紐付け）
    const sessionsByBranch = {};
    sessions.forEach(s => {
      const b = s.branch || "";
      if (!sessionsByBranch[b]) sessionsByBranch[b] = [];
      sessionsByBranch[b].push(s);
    });

    // 稼働中セッション数
    const activeCount = sessions.filter(s => s.status === "working" || s.status === "active").length;
    const waitingCount = sessions.filter(s => s.status === "waiting").length;
    const errorCount = sessions.filter(s => s.status === "error").length;

    // ステータスバッジ
    const statusBadge = (s) => {
      const map = {
        working: "primary", active: "success", waiting: "warning",
        error: "danger", done: "secondary", paused: "secondary",
      };
      const label = {
        working: "実装中", active: "稼働中", waiting: "応答待ち",
        error: "エラー", done: "完了", paused: "停止",
      };
      return `<span class="badge bg-${map[s] || "secondary"} rounded-pill">${label[s] || s}</span>`;
    };

    // セッションカード生成
    const sessionCards = (branch) => {
      const ss = sessionsByBranch[branch] || [];
      if (!ss.length) return '<div class="text-muted small fst-italic">セッションなし</div>';
      return ss.map(s => {
        const updatedAt = s.updatedAt?.toDate
          ? s.updatedAt.toDate().toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
          : "";
        return `
          <div class="org-session border-start border-3 border-${({working:"primary",active:"success",waiting:"warning",error:"danger"})[s.status] || "secondary"} ps-2 py-1 mb-1">
            <div class="d-flex justify-content-between align-items-center">
              <small class="fw-bold">${this.esc(s.name || s.id)}</small>
              ${statusBadge(s.status)}
            </div>
            ${s.currentTask ? `<div class="text-truncate small">${this.esc(s.currentTask)}</div>` : ""}
            ${s.lastError ? `<div class="text-danger small text-truncate"><i class="bi bi-exclamation-triangle-fill"></i> ${this.esc(s.lastError)}</div>` : ""}
            ${s.waitingFor ? `<div class="text-warning small text-truncate"><i class="bi bi-clock-fill"></i> ${this.esc(s.waitingFor)}</div>` : ""}
            <div class="text-muted" style="font-size:0.7rem">${updatedAt}</div>
          </div>`;
      }).join("");
    };

    // 部署定義（CLAUDE.mdの組織図に準拠）
    const deptCards = [
      { key: "民泊部", icon: "🏠", name: "民泊部", branch: "business-os/main", color: "primary",
        roles: ["予約管理", "清掃管理", "スタッフ", "請求書", "タイミー", "ランドリー"] },
      { key: "秘書室", icon: "🤵", name: "秘書室（黒子）", branch: "business-os/secretary", color: "dark",
        roles: ["ブリーフィング", "異常検知", "タスク管理", "LINE通知"] },
      { key: "経理部", icon: "📄", name: "経理部", branch: "business-os/scan-sorter", color: "success",
        roles: ["スキャン仕分け", "記帳", "確定申告", "税理士連携"] },
      { key: "不動産部", icon: "🏢", name: "投資部", branch: "business-os/property-radar", color: "warning",
        roles: ["物件収集", "スコアリング", "価格追跡"] },
    ];

    container.innerHTML = `
      <!-- 社長 -->
      <div class="text-center mb-2">
        <div class="d-inline-block bg-dark text-white rounded-3 px-4 py-2 position-relative">
          <div class="fs-4">👤</div>
          <strong>社長（あなた）</strong>
          <div class="small opacity-75">GOサイン・最終判断のみ</div>
        </div>
        <div class="org-line mx-auto" style="width:2px;height:20px;background:#adb5bd"></div>
      </div>

      <!-- サマリー -->
      <div class="d-flex justify-content-center gap-3 mb-2">
        <span class="badge bg-primary rounded-pill">稼働中 ${activeCount}</span>
        <span class="badge bg-warning text-dark rounded-pill">応答待ち ${waitingCount}</span>
        ${errorCount > 0 ? `<span class="badge bg-danger rounded-pill">エラー ${errorCount}</span>` : ""}
        <span class="badge bg-secondary rounded-pill">全 ${sessions.length} セッション</span>
      </div>

      <!-- 秘書室（統括） -->
      <div class="text-center mb-2">
        <div class="org-line mx-auto" style="width:2px;height:16px;background:#adb5bd"></div>
        <div class="d-inline-block border border-dark rounded-3 px-3 py-2 bg-white" style="min-width:280px">
          <div class="d-flex align-items-center justify-content-center gap-2 mb-1">
            <span class="fs-4">🤵</span>
            <strong>AI秘書「黒子」（統括）</strong>
          </div>
          <div class="small text-muted mb-2">毎朝ブリーフィング / 異常検知 / タスク管理</div>
          ${sessionCards("business-os/secretary")}
        </div>
        <div class="org-line mx-auto" style="width:2px;height:16px;background:#adb5bd"></div>
      </div>

      <!-- 部署グリッド -->
      <div class="org-branch-line text-center mb-2" style="border-top:2px solid #adb5bd;width:80%;margin:0 auto"></div>
      <div class="row g-2">
        ${deptCards.filter(d => d.key !== "秘書室").map(dept => {
          const deptSessions = sessionsByBranch[dept.branch] || [];
          const hasActive = deptSessions.some(s => s.status === "working" || s.status === "active");
          const hasError = deptSessions.some(s => s.status === "error");
          const borderClass = hasError ? "border-danger" : hasActive ? "border-primary" : "";
          return `
          <div class="col-md-4">
            <div class="card h-100 ${borderClass}" style="border-width:${borderClass ? '2px' : '1px'}">
              <div class="card-header py-1 bg-${dept.color} ${dept.color === "warning" ? "text-dark" : "text-white"} text-center">
                <span class="fs-5">${dept.icon}</span> <strong>${dept.name}</strong>
              </div>
              <div class="card-body py-2">
                <div class="mb-2">
                  ${dept.roles.map(r => `<span class="badge bg-light text-dark border me-1 mb-1" style="font-size:0.7rem">${r}</span>`).join("")}
                </div>
                <hr class="my-1">
                <div class="small fw-bold text-muted mb-1"><i class="bi bi-terminal"></i> セッション</div>
                ${sessionCards(dept.branch)}
              </div>
              <div class="card-footer py-1 text-center">
                <small class="text-muted"><i class="bi bi-git"></i> ${dept.branch}</small>
              </div>
            </div>
          </div>`;
        }).join("")}
      </div>
    `;
  },

  esc(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  },
};
