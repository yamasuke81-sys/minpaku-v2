/**
 * 清掃フロー構成画面 (v2 再実装 2026-04-20)
 *
 * 3レーンスイムレーン (ゲスト / オーナー / スタッフ) + 19ステップ + 通知統合
 *
 * データ格納先:
 *   - propertyField 系  : properties/{pid}.*
 *   - globalChannel 系  : settings/notifications.channels.{key}.*  (予約フローと共有)
 *   - それ以外          : properties/{pid}.cleaningFlow.{key}.{enabled,memo}
 *
 * ルート: #/cleaning-flow
 */

const CleaningFlowPage = {
  properties: [],
  selectedPropertyIds: [],
  notifChannels: {}, // settings/notifications.channels スナップショット

  // ========== 変数グループ定義 (reservation-flow.js と同内容) ==========
  systemVariables: {
    recruit: [
      { name: "date",     label: "作業日",        sample: "2026/04/20" },
      { name: "property", label: "物件名",        sample: "長浜民泊A" },
      { name: "work",     label: "作業内容",      sample: "清掃" },
      { name: "url",      label: "回答ページURL", sample: "https://minpaku-v2.web.app/#/my-recruitment" },
      { name: "count",    label: "回答数",        sample: "3" },
      { name: "staff",    label: "確定スタッフ名", sample: "山田太郎" },
      { name: "memo",     label: "メモ",          sample: "BBQ後の片付けあり" },
      { name: "response", label: "回答内容",      sample: "◎" },
    ],
    staff: [
      { name: "staff",    label: "スタッフ名",  sample: "山田太郎" },
      { name: "date",     label: "対象日",      sample: "2026/04/20" },
      { name: "property", label: "物件名",      sample: "長浜民泊A" },
      { name: "url",      label: "マイページURL", sample: "https://minpaku-v2.web.app/#/my-dashboard" },
      { name: "reason",   label: "理由",        sample: "直近15回の募集に無回答" },
    ],
    invoice: [
      { name: "month",    label: "対象月",      sample: "4" },
      { name: "staff",    label: "スタッフ名",  sample: "山田太郎" },
      { name: "property", label: "物件名",      sample: "長浜民泊A" },
      { name: "total",    label: "合計金額",    sample: "¥45,000" },
      { name: "url",      label: "確認/作成ページURL", sample: "https://minpaku-v2.web.app/#/my-invoice-create" },
    ],
    cleaning: [
      { name: "date",     label: "清掃日",          sample: "2026/04/20" },
      { name: "property", label: "物件名",          sample: "長浜民泊A" },
      { name: "staff",    label: "スタッフ名",       sample: "山田太郎" },
      { name: "time",     label: "完了時刻",        sample: "14:30" },
      { name: "url",      label: "チェックリストURL", sample: "https://minpaku-v2.web.app/#/my-checklist/xxx" },
    ],
    laundry: [
      { name: "date",     label: "清掃日",          sample: "2026/04/20" },
      { name: "property", label: "物件名",          sample: "長浜民泊A" },
      { name: "staff",    label: "担当スタッフ",     sample: "山田太郎" },
      { name: "time",     label: "実施時刻",         sample: "19:30" },
      { name: "url",      label: "チェックリストURL", sample: "https://minpaku-v2.web.app/#/my-checklist/xxx" },
    ],
  },

  // ========== 通知デフォルト値 ==========
  _notifDefaults: {
    recruit_start:      { defaultMsg: "🧹 {work}スタッフ募集\n\n{date} {property}\n{work}スタッフを募集しています。\n回答をお願いします（◎OK / △微妙 / ×NG）\n\n回答: {url}", defaultTiming: "immediate", varGroup: "recruit" },
    recruit_response:   { defaultMsg: "📋 募集に回答がありました\n\n日付: {date} ({property})\n{staff}: {response}\n候補: {count}名", defaultTiming: "immediate", varGroup: "recruit" },
    recruit_remind:     { defaultMsg: "📋 {work}募集 回答のお願い\n\n{date} {property}\nまだ回答が届いていません（現在{count}件）。\n回答: {url}", defaultTiming: "evening", varGroup: "recruit" },
    staff_undecided:    { defaultMsg: "⚠️ {work}スタッフ未確定\n\n{date} {property}\n作業日が近づいていますが、まだスタッフが確定していません。\n回答状況: {count}件", defaultTiming: "morning", varGroup: "recruit" },
    staff_confirm:      { defaultMsg: "✅ {work}担当が確定しました\n\n{date} {property}\n担当: {staff}\nよろしくお願いします。", defaultTiming: "immediate", varGroup: "recruit" },
    laundry_put_out:    { defaultMsg: "🧺 ランドリー 出した\n\n{date} {property}\n{staff}さんが{time}に洗濯物を出しました。\n詳細: {url}", defaultTiming: "immediate", varGroup: "laundry" },
    laundry_collected:  { defaultMsg: "🧺 ランドリー 回収した\n\n{date} {property}\n{staff}さんが{time}に洗濯物を回収しました。\n詳細: {url}", defaultTiming: "immediate", varGroup: "laundry" },
    laundry_stored:     { defaultMsg: "🧺 ランドリー 収納した\n\n{date} {property}\n{staff}さんが{time}に洗濯物を収納しました。\n詳細: {url}", defaultTiming: "immediate", varGroup: "laundry" },
    cleaning_done:      { defaultMsg: "✨ 清掃完了\n\n{date} {property}\n{staff}さんが{time}に清掃を完了しました。\n詳細: {url}", defaultTiming: "immediate", varGroup: "cleaning" },
    checklist_complete: { defaultMsg: "☑️ チェックリスト完了\n\n{date} {property}\n{staff}さんがチェックリストを完了しました。\n詳細: {url}", defaultTiming: "immediate", varGroup: "cleaning" },
    invoice_request:    { defaultMsg: "💰 {month}月分の請求書作成をお願いします\n\n作業明細をご確認の上、請求書の送信をお願いします。\n作成ページ: {url}", defaultTiming: "morning", varGroup: "invoice" },
    invoice_submitted:  { defaultMsg: "📨 請求書が提出されました\n\n{staff} さんから {month}月分の請求書が届きました。\n合計: {total}\n確認: {url}", defaultTiming: "immediate", varGroup: "invoice" },
    cancel_request:     { defaultMsg: "🙋 出勤キャンセル要望\n\n{staff}さんから{date} {property}の出勤キャンセル要望がありました。", defaultTiming: "immediate", varGroup: "staff" },
    cancel_approve:     { defaultMsg: "✅ キャンセル承認\n\n{date} {property}の出勤キャンセルが承認されました。", defaultTiming: "immediate", varGroup: "staff" },
    cancel_reject:      { defaultMsg: "❌ キャンセル不可\n\n{date} {property}の出勤キャンセルは対応できませんでした。出勤をお願いします。", defaultTiming: "immediate", varGroup: "staff" },
    staff_inactive:     { defaultMsg: "⚠️ スタッフ非アクティブ化\n\n{staff} さんを非アクティブに変更しました。\n理由: {reason}\n解除はスタッフ管理から行えます。", defaultTiming: "immediate", varGroup: "staff" },
  },

  // ========== STEPS 定義 (19項目) ==========
  STEPS: [
    // ---- Phase 1: 募集 ----
    {
      key: "recruit_start",
      label: "スタッフ募集開始",
      icon: "bi-megaphone",
      lane: "owner",
      phase: 1,
      globalChannel: "recruit_start",
      varGroup: "recruit",
      arrowTo: "staff",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "recruit_response",
      label: "スタッフ回答通知",
      icon: "bi-reply",
      lane: "staff",
      phase: 1,
      globalChannel: "recruit_response",
      varGroup: "recruit",
      arrowTo: "owner",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "recruit_remind",
      label: "募集リマインド",
      icon: "bi-alarm",
      lane: "owner",
      phase: 1,
      globalChannel: "recruit_remind",
      varGroup: "recruit",
      arrowTo: "staff",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "staff_undecided",
      label: "スタッフ未決定リマインド",
      icon: "bi-exclamation-triangle",
      lane: "owner",
      phase: 1,
      globalChannel: "staff_undecided",
      varGroup: "recruit",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "staff_confirm",
      label: "スタッフ確定通知",
      icon: "bi-person-check",
      lane: "owner",
      phase: 1,
      globalChannel: "staff_confirm",
      varGroup: "recruit",
      arrowTo: "staff",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },

    // ---- Phase 2: 清掃当日準備 ----
    {
      key: "inspection",
      label: "直前点検 (pre_inspection)",
      icon: "bi-search",
      lane: "owner",
      phase: 2,
      propertyField: "inspection.enabled",
      hint: "有効にすると、チェックアウト同日に直前点検シフトが自動生成されます (workType=pre_inspection)。点検設定は物件管理ページで詳細設定できます。",
      linkHash: "#/properties",
      linkLabel: "物件編集→点検設定",
    },

    // ---- Phase 3: 清掃実施 ----
    {
      key: "cleaning_start",
      label: "清掃開始",
      icon: "bi-play-circle",
      lane: "staff",
      phase: 3,
      hint: "スタッフがチェックリストを開いて清掃を開始します。ステータス表示のみ（通知なし）。",
      linkHash: "#/my-checklist",
      linkLabel: "チェックリスト",
    },
    {
      key: "laundry_put_out",
      label: "ランドリー 出した",
      icon: "bi-arrow-up-circle",
      lane: "staff",
      phase: 3,
      globalChannel: "laundry_put_out",
      varGroup: "laundry",
      arrowTo: "owner",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "laundry_collected",
      label: "ランドリー 回収した",
      icon: "bi-arrow-down-circle",
      lane: "staff",
      phase: 3,
      globalChannel: "laundry_collected",
      varGroup: "laundry",
      arrowTo: "owner",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "laundry_stored",
      label: "ランドリー 収納した",
      icon: "bi-check2-circle",
      lane: "staff",
      phase: 3,
      globalChannel: "laundry_stored",
      varGroup: "laundry",
      arrowTo: "owner",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "checklist_progress",
      label: "チェックリスト入力中",
      icon: "bi-list-check",
      lane: "staff",
      phase: 3,
      hint: "スタッフがチェックリストに入力中のステータス。通知なし。",
      linkHash: "#/my-checklist",
      linkLabel: "チェックリスト",
    },
    {
      key: "cleaning_done",
      label: "清掃完了通知",
      icon: "bi-clipboard-check",
      lane: "staff",
      phase: 3,
      globalChannel: "cleaning_done",
      varGroup: "cleaning",
      arrowTo: "owner",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "checklist_complete",
      label: "チェックリスト完了通知",
      icon: "bi-check-all",
      lane: "staff",
      phase: 3,
      globalChannel: "checklist_complete",
      varGroup: "cleaning",
      arrowTo: "owner",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },

    // ---- Phase 4: 月末 ----
    {
      key: "invoice_request",
      label: "請求書要請",
      icon: "bi-receipt",
      lane: "owner",
      phase: 4,
      globalChannel: "invoice_request",
      varGroup: "invoice",
      arrowTo: "staff",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "invoice_submitted",
      label: "請求書提出通知",
      icon: "bi-send-check",
      lane: "staff",
      phase: 4,
      globalChannel: "invoice_submitted",
      varGroup: "invoice",
      arrowTo: "owner",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },

    // ---- 分岐 A: 出勤キャンセル ----
    {
      key: "cancel_request",
      label: "出勤キャンセル要望",
      icon: "bi-person-dash",
      lane: "staff",
      branch: "staff_cancel",
      globalChannel: "cancel_request",
      varGroup: "staff",
      arrowTo: "owner",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "cancel_approve",
      label: "キャンセル承認通知",
      icon: "bi-check-circle",
      lane: "owner",
      branch: "staff_cancel",
      globalChannel: "cancel_approve",
      varGroup: "staff",
      arrowTo: "staff",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
    {
      key: "cancel_reject",
      label: "キャンセル却下通知",
      icon: "bi-dash-circle",
      lane: "owner",
      branch: "staff_cancel",
      globalChannel: "cancel_reject",
      varGroup: "staff",
      arrowTo: "staff",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },

    // ---- 分岐 B: 監視 ----
    {
      key: "staff_inactive",
      label: "スタッフ非アクティブ化通知",
      icon: "bi-person-slash",
      lane: "owner",
      branch: "monitor",
      globalChannel: "staff_inactive",
      varGroup: "staff",
      linkHash: "#/notifications",
      linkLabel: "通知設定",
    },
  ],

  // ========== ユーティリティ ==========
  _esc(s) {
    const d = document.createElement("div");
    d.textContent = String(s || "");
    return d.innerHTML;
  },

  // 有効状態を返す (propertyField > globalChannel > cleaningFlow)
  _isEnabled(property, step) {
    if (step.propertyField) {
      // ドット記法対応 (例: "inspection.enabled")
      const parts = step.propertyField.split(".");
      let v = property;
      for (const p of parts) { v = v?.[p]; }
      return typeof v === "boolean" ? v : true;
    }
    if (step.globalChannel) {
      const c = this.notifChannels[step.globalChannel];
      return c ? c.enabled !== false : true;
    }
    const flow = property.cleaningFlow || {};
    return flow[step.key]?.enabled !== false;
  },

  // ========== render / load ==========
  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-diagram-3"></i> 清掃フロー構成</h2>
        <span id="cfSaveStatus" class="small text-muted"></span>
      </div>
      <p class="text-muted small mb-3">
        オーナー / スタッフの3レーンで募集〜月末請求までの清掃フローを管理します。
        🌐 バッジのステップは通知設定タブ・予約フロー画面と共有データです。
        各カードを展開すると通知設定（文言・タイミング・送信先）を直接編集できます。
      </p>
      ${this._renderStyles()}
      <!-- 物件フィルタ -->
      <div id="propertyFilterHost-cleaning-flow"></div>
      <!-- モバイルタブ -->
      <div class="rf-mobile-tabs d-md-none mb-2">
        <ul class="nav nav-pills nav-fill rf-lane-tabs">
          <li class="nav-item"><a class="nav-link active" href="#" data-lane="all">すべて</a></li>
          <li class="nav-item"><a class="nav-link" href="#" data-lane="guest">👤 ゲスト</a></li>
          <li class="nav-item"><a class="nav-link" href="#" data-lane="owner">🏠 オーナー</a></li>
          <li class="nav-item"><a class="nav-link" href="#" data-lane="staff">🧹 スタッフ</a></li>
          <li class="nav-item"><a class="nav-link" href="#" data-lane="branch">🔴 分岐</a></li>
        </ul>
      </div>
      <!-- 物件セレクタ (スイムレーン用) -->
      <div id="cfPropertySelector" class="mb-3"></div>
      <!-- メインスイムレーン -->
      <div id="cfSwimLane"></div>
    `;

    // モバイルタブのイベント
    container.querySelectorAll(".rf-lane-tabs .nav-link").forEach(a => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        container.querySelectorAll(".rf-lane-tabs .nav-link").forEach(x => x.classList.remove("active"));
        a.classList.add("active");
        this._currentMobileLane = a.dataset.lane;
        this._renderSwimLane();
      });
    });
    this._currentMobileLane = "all";

    await this.load();
  },

  async load() {
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

    try {
      const nDoc = await db.collection("settings").doc("notifications").get();
      this.notifChannels = nDoc.exists ? (nDoc.data().channels || {}) : {};
    } catch (e) {
      console.warn("notifications 取得失敗:", e.message);
      this.notifChannels = {};
    }

    this.selectedPropertyIds = PropertyFilter.getSelectedIds("cleaning-flow", this.properties);

    // 物件フィルタ
    PropertyFilter.render({
      containerId: "propertyFilterHost-cleaning-flow",
      tabKey: "cleaning-flow",
      properties: this.properties,
      onChange: (ids) => {
        this.selectedPropertyIds = ids;
        this._renderPropertySelector();
        this._renderSwimLane();
      },
    });

    this._renderPropertySelector();
    this._renderSwimLane();
  },

  // 物件ドロップダウン
  _renderPropertySelector() {
    const wrap = document.getElementById("cfPropertySelector");
    if (!wrap) return;
    const visible = this._visibleProperties();
    if (visible.length === 0) { wrap.innerHTML = ""; return; }

    if (!this._selectedPid || !visible.find(p => p.id === this._selectedPid)) {
      this._selectedPid = visible[0].id;
    }

    wrap.innerHTML = `
      <div class="d-flex align-items-center gap-2 flex-wrap">
        <label class="form-label mb-0 small fw-semibold">物件メモ対象:</label>
        ${visible.map(p => `
          <button class="btn btn-sm ${p.id === this._selectedPid ? "btn-primary" : "btn-outline-secondary"} cf-prop-btn"
            data-pid="${p.id}" style="font-size:0.78rem;">
            <span class="badge me-1" style="background:${p.color || "#6c757d"}">${p.propertyNumber || "-"}</span>
            ${this._esc(p.name)}
          </button>
        `).join("")}
        <span class="text-muted small ms-1">※ 物件メモは物件ごとに保存されます。通知設定は全物件共通です。</span>
      </div>
    `;

    wrap.querySelectorAll(".cf-prop-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        this._selectedPid = btn.dataset.pid;
        this._renderPropertySelector();
        this._renderSwimLane();
      });
    });
  },

  _visibleProperties() {
    return this.properties.filter(p =>
      !this.selectedPropertyIds || this.selectedPropertyIds.length === 0 ||
      this.selectedPropertyIds.includes(p.id)
    );
  },

  // ========== スイムレーン描画 ==========
  _renderSwimLane() {
    const wrap = document.getElementById("cfSwimLane");
    if (!wrap) return;

    const visible = this._visibleProperties();
    if (!visible.length) {
      wrap.innerHTML = `<div class="text-muted">民泊物件がありません</div>`;
      return;
    }

    const property = visible.find(p => p.id === this._selectedPid) || visible[0];
    this._selectedPid = property.id;

    // メインフロー (branch なし)
    const mainSteps = this.STEPS.filter(s => !s.branch);
    // 分岐
    const branchASteps = this.STEPS.filter(s => s.branch === "staff_cancel");
    const branchBSteps = this.STEPS.filter(s => s.branch === "monitor");

    const phases = [1, 2, 3, 4];
    const phaseLabels = {
      1: "Phase 1: 募集",
      2: "Phase 2: 清掃当日準備",
      3: "Phase 3: 清掃実施",
      4: "Phase 4: 月末請求",
    };

    let html = `<div class="rf-swimlane-scroll"><div class="rf-swimlane-root">`;

    // ヘッダー行
    html += `
      <div class="rf-swimlane-grid rf-swimlane-header">
        <div class="rf-lane-header rf-lane-guest">👤 ゲスト</div>
        <div class="rf-lane-header rf-lane-owner">🏠 オーナー</div>
        <div class="rf-lane-header rf-lane-staff">🧹 スタッフ</div>
      </div>
    `;

    phases.forEach(phase => {
      const phaseSteps = mainSteps.filter(s => s.phase === phase);
      if (!phaseSteps.length) return;

      html += `
        <div class="rf-phase-divider">
          <span>━━━ ${this._esc(phaseLabels[phase])} ━━━</span>
        </div>
      `;
      html += this._renderStepRows(phaseSteps, property, null);
    });

    // 分岐 A: 出勤キャンセル
    html += `
      <div class="rf-phase-divider rf-branch-divider">
        <span>━━━ 分岐 A: 出勤キャンセル（確定後） ━━━</span>
      </div>
    `;
    html += this._renderStepRows(branchASteps, property, null);

    // 分岐 B: 監視
    html += `
      <div class="rf-phase-divider rf-branch-divider">
        <span>━━━ 分岐 B: 監視 ━━━</span>
      </div>
    `;
    html += this._renderStepRows(branchBSteps, property, null);

    html += `</div></div>`;

    wrap.innerHTML = html;

    // イベント登録
    this._attachEvents(wrap, property);
  },

  // ステップ配列からグリッド行HTMLを生成
  _renderStepRows(steps, property, trackHint) {
    if (!steps.length) return "";
    let html = "";
    steps.forEach((step) => {
      const enabled = this._isEnabled(property, step);
      const flow = property.cleaningFlow || {};
      const memo = flow[step.key]?.memo || "";

      html += `
        <div class="rf-swimlane-grid rf-step-row" data-step-key="${step.key}" data-lane="${step.lane}" ${step.branch ? `data-branch="${step.branch}"` : ""}>
          <div class="rf-lane-cell rf-col-guest ${step.lane === "guest" ? "rf-cell-active" : "rf-cell-empty"}">
            ${step.lane === "guest" ? this._renderCard(step, property, enabled, memo) : ""}
          </div>
          <div class="rf-lane-cell rf-col-owner ${step.lane === "owner" ? "rf-cell-active" : "rf-cell-empty"}">
            ${step.lane === "owner" ? this._renderCard(step, property, enabled, memo) : ""}
          </div>
          <div class="rf-lane-cell rf-col-staff ${step.lane === "staff" ? "rf-cell-active" : "rf-cell-empty"}">
            ${step.lane === "staff" ? this._renderCard(step, property, enabled, memo) : ""}
          </div>
        </div>
      `;

      if (step.arrowTo || step.arrowFrom) {
        html += this._renderArrowRow(step);
      }
    });
    return html;
  },

  // 矢印行
  _renderArrowRow(step) {
    const laneOrder = { guest: 0, owner: 1, staff: 2 };
    const fromLane = step.arrowFrom || step.lane;
    const toLane = step.arrowTo;
    if (!toLane) return "";

    const fromIdx = laneOrder[fromLane];
    const toIdx = laneOrder[toLane];
    const goRight = toIdx > fromIdx;
    const icon = goRight ? "bi-arrow-right" : "bi-arrow-left";
    const label = toLane === "guest" ? "👤" : toLane === "owner" ? "🏠" : "🧹";

    const cols = ["", "", ""];
    cols[fromIdx] = `<span class="rf-arrow-badge rf-arrow-${toLane}"><i class="bi ${icon}"></i> ${label}</span>`;

    return `
      <div class="rf-swimlane-grid rf-arrow-row">
        <div class="rf-lane-cell">${cols[0]}</div>
        <div class="rf-lane-cell">${cols[1]}</div>
        <div class="rf-lane-cell">${cols[2]}</div>
      </div>
    `;
  },

  // カード1枚のHTML
  _renderCard(step, property, enabled, memo) {
    const ch = this.notifChannels[step.globalChannel] || {};
    const nd = this._notifDefaults[step.globalChannel] || {};

    // バッジ類
    const statusBadge = step.status === "未実装"
      ? `<span class="badge bg-warning text-dark ms-1" style="font-size:10px;"><i class="bi bi-hammer"></i> 未実装</span>`
      : "";
    let syncBadge = "";
    if (step.propertyField) {
      syncBadge = `<span class="badge bg-success-subtle text-success border border-success-subtle ms-1 rf-sync-badge" style="font-size:9px;" title="properties.${step.propertyField} に保存 (物件ごと)"><i class="bi bi-arrow-left-right"></i> 同期</span>`;
    } else if (step.globalChannel) {
      syncBadge = `<span class="badge bg-warning-subtle text-warning border border-warning-subtle ms-1 rf-sync-badge" style="font-size:9px;" title="settings/notifications.channels.${step.globalChannel} (全物件共通・予約フロー画面と同期)"><i class="bi bi-globe"></i> 全共通</span>`;
    }
    const arrowBadge = step.arrowTo
      ? `<span class="badge bg-light text-dark border ms-1" style="font-size:9px;"><i class="bi bi-arrow-right"></i> ${step.arrowTo === "guest" ? "👤" : step.arrowTo === "owner" ? "🏠" : "🧹"}</span>`
      : (step.arrowFrom ? `<span class="badge bg-light text-dark border ms-1" style="font-size:9px;"><i class="bi bi-arrow-left"></i> ${step.arrowFrom === "guest" ? "👤" : step.arrowFrom === "owner" ? "🏠" : "🧹"}</span>` : "");

    const foldId = `cfc-${step.key}`;
    const toggleChecked = enabled ? "checked" : "";
    const toggleId = `cf-tog-${step.key}`;

    const notifEditorHtml = step.globalChannel ? this._renderNotifEditor(step, ch, nd) : "";

    const guestBtn = (typeof step.guestUrlFn === "function")
      ? `<a href="${this._esc(step.guestUrlFn(property.id))}" target="_blank" rel="noopener" class="btn btn-outline-info btn-sm py-0 px-2 me-1" style="font-size:0.72rem;" title="新規タブでゲスト画面を開く"><i class="bi bi-box-arrow-up-right"></i> ゲスト画面</a>`
      : "";
    const linkBtn = step.linkHash
      ? `<a href="${this._esc(step.linkHash)}" class="btn btn-outline-secondary btn-sm py-0 px-2" style="font-size:0.72rem;">${this._esc(step.linkLabel || "設定")} <i class="bi bi-arrow-right"></i></a>`
      : "";
    const hintHtml = step.hint
      ? `<div class="small text-muted mt-1" style="font-size:11px;"><i class="bi bi-info-circle"></i> ${this._esc(step.hint)}</div>`
      : "";

    return `
      <div class="rf-card ${enabled ? "rf-card-enabled" : "rf-card-disabled"}" data-step="${step.key}" data-pid="${property.id}">
        <!-- ヘッダー (常時表示) -->
        <div class="rf-card-header" data-fold="${foldId}" style="cursor:pointer;">
          <i class="bi ${step.icon} rf-card-icon"></i>
          <span class="rf-card-title" title="${this._esc(step.label)}">${this._esc(step.label)}</span>
          ${statusBadge}${syncBadge}${arrowBadge}
          <div class="ms-auto d-flex align-items-center gap-1">
            <div class="form-check form-switch mb-0">
              <input class="form-check-input rf-toggle" type="checkbox" id="${toggleId}"
                data-step="${step.key}" data-pid="${property.id}" ${toggleChecked}
                title="${step.globalChannel ? "全物件共通のON/OFF" : step.propertyField ? "この物件のON/OFF" : "このフローのON/OFF"}">
            </div>
            <i class="bi bi-chevron-down rf-chevron" data-fold="${foldId}" style="font-size:0.75rem;transition:transform 0.2s;"></i>
          </div>
        </div>
        <!-- 展開コンテンツ (デフォルト非表示) -->
        <div class="rf-card-body" id="${foldId}" style="display:none;">
          ${hintHtml}
          ${notifEditorHtml}
          <!-- リンクボタン -->
          ${(guestBtn || linkBtn) ? `<div class="mt-2 d-flex flex-wrap gap-1">${guestBtn}${linkBtn}</div>` : ""}
          <!-- 物件固有メモ -->
          <div class="mt-2">
            <label class="form-label small text-muted mb-1"><i class="bi bi-pencil"></i> 物件メモ（${this._esc(property.name)}用）</label>
            <input type="text" class="form-control form-control-sm rf-memo"
              data-step="${step.key}" data-pid="${property.id}"
              placeholder="物件固有のメモ（任意）"
              value="${this._esc(memo)}">
          </div>
        </div>
      </div>
    `;
  },

  // 通知編集UI
  _renderNotifEditor(step, ch, nd) {
    const varGroup = step.varGroup || nd.varGroup || "cleaning";
    const vars = this.systemVariables[varGroup] || [];
    const customMessage = ch.customMessage || "";
    const msgValue = customMessage || nd.defaultMsg || "";

    // プレビュー
    let preview = msgValue;
    vars.forEach(v => {
      preview = preview.replace(new RegExp(`\\{${v.name}\\}`, "g"), v.sample);
    });

    // タイミング
    let timings = Array.isArray(ch.timings) && ch.timings.length
      ? ch.timings
      : [{ mode: ch.mode || "event", timing: ch.timing || nd.defaultTiming || "immediate", timingMinutes: ch.timingMinutes || "", beforeDays: ch.beforeDays || 3, beforeTime: ch.beforeTime || "09:00", schedulePattern: ch.schedulePattern || "monthEnd", scheduleDay: ch.scheduleDay || 1, scheduleDow: ch.scheduleDow || 0, scheduleTime: ch.scheduleTime || "09:00" }];

    // 送信先チェックボックス
    const ownerLine  = ch.ownerLine  !== undefined ? ch.ownerLine  !== false : true;
    const groupLine  = ch.groupLine  !== undefined ? !!ch.groupLine  : false;
    const staffLine  = ch.staffLine  !== undefined ? !!ch.staffLine  : false;
    const ownerEmail = ch.ownerEmail !== undefined ? !!ch.ownerEmail : false;
    const discordOwner = !!ch.discordOwner;
    const discordSubOwner = !!ch.discordSubOwner;

    // 変数タグ
    const varTags = vars.map(v =>
      `<span class="badge bg-light text-dark border me-1 mb-1 rf-var-tag" role="button"
        data-var="{${v.name}}" data-notif-key="${step.globalChannel}"
        title="${v.label}">{${v.name}} <small class="text-muted">${v.label}</small></span>`
    ).join("");

    const key = step.globalChannel;
    return `
      <div class="rf-notif-editor mt-2" data-notif-key="${key}">
        <div class="small text-muted mb-2"><i class="bi bi-bell"></i> 通知設定 (全物件共通・通知設定タブ・予約フロー画面と同期)</div>

        <!-- 送信先 -->
        <div class="mb-2">
          <div class="small text-muted mb-1"><i class="bi bi-send"></i> 送信先</div>
          <div class="d-flex flex-wrap gap-2">
            <label class="form-check form-check-inline mb-0 small">
              <input class="form-check-input rf-notif-field" type="checkbox" data-notif-key="${key}" data-field="ownerLine" ${ownerLine ? "checked" : ""}>
              <span><i class="bi bi-person-circle text-success"></i> オーナーLINE</span>
            </label>
            <label class="form-check form-check-inline mb-0 small">
              <input class="form-check-input rf-notif-field" type="checkbox" data-notif-key="${key}" data-field="groupLine" ${groupLine ? "checked" : ""}>
              <span><i class="bi bi-people-fill text-primary"></i> グループLINE</span>
            </label>
            <label class="form-check form-check-inline mb-0 small">
              <input class="form-check-input rf-notif-field" type="checkbox" data-notif-key="${key}" data-field="staffLine" ${staffLine ? "checked" : ""}>
              <span><i class="bi bi-person-lines-fill text-info"></i> スタッフLINE</span>
            </label>
            <label class="form-check form-check-inline mb-0 small">
              <input class="form-check-input rf-notif-field" type="checkbox" data-notif-key="${key}" data-field="ownerEmail" ${ownerEmail ? "checked" : ""}>
              <span><i class="bi bi-envelope text-warning"></i> オーナーメール</span>
            </label>
            <label class="form-check form-check-inline mb-0 small">
              <input class="form-check-input rf-notif-field" type="checkbox" data-notif-key="${key}" data-field="discordOwner" ${discordOwner ? "checked" : ""}>
              <span><i class="bi bi-discord" style="color:#5865F2"></i> Discord(オーナー)</span>
            </label>
            <label class="form-check form-check-inline mb-0 small">
              <input class="form-check-input rf-notif-field" type="checkbox" data-notif-key="${key}" data-field="discordSubOwner" ${discordSubOwner ? "checked" : ""}>
              <span><i class="bi bi-discord" style="color:#8da0f8"></i> Discord(サブ)</span>
            </label>
          </div>
        </div>

        <!-- タイミング -->
        <div class="mb-2">
          <div class="small text-muted mb-1"><i class="bi bi-clock"></i> 通知タイミング</div>
          <div class="rf-notif-timings" data-notif-key="${key}">
            ${timings.map((t, idx) => this._renderTimingRow(key, t, idx)).join("")}
          </div>
          <button type="button" class="btn btn-sm btn-outline-primary mt-1 rf-add-timing" data-notif-key="${key}" style="font-size:0.75rem;">
            <i class="bi bi-plus"></i> タイミングを追加
          </button>
        </div>

        <!-- 変数ヒント + メッセージ -->
        <div class="mb-1">
          <div class="small text-muted mb-1"><i class="bi bi-pencil"></i> メッセージテンプレート
            <small class="text-muted ms-1">💡 利用可変数 (クリックで挿入):</small>
          </div>
          <div class="d-flex flex-wrap mb-1">${varTags}</div>
          <div class="row g-2">
            <div class="col-md-6">
              <textarea class="form-control form-control-sm rf-notif-msg"
                data-notif-key="${key}" data-var-group="${varGroup}" data-field="customMessage"
                rows="4" style="font-size:0.8rem;">${this._esc(msgValue)}</textarea>
            </div>
            <div class="col-md-6">
              <div class="border rounded p-2 bg-light small rf-notif-preview" data-preview="${key}"
                style="white-space:pre-wrap;min-height:90px;font-size:0.78rem;">${this._esc(preview)}</div>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  // タイミング行
  _renderTimingRow(key, t, idx) {
    const mode = t.mode || "event";
    const timing = t.timing || "immediate";
    const showEventBlock = mode === "event";
    const showDateBlock  = mode === "date";
    const showMinutes    = showEventBlock && timing === "custom";
    const showBefore     = showEventBlock && timing === "beforeEvent";
    const pat = t.schedulePattern || "monthEnd";
    return `
      <div class="notify-timing-row d-flex flex-wrap align-items-center gap-1 p-2 mb-1 border rounded" data-notif-key="${key}" data-idx="${idx}">
        <div class="btn-group btn-group-sm">
          <input type="radio" class="btn-check rf-mode-radio" name="cfmode-${key}-${idx}" id="cfmode-ev-${key}-${idx}" value="event" ${mode==="event"?"checked":""} data-notif-key="${key}" data-idx="${idx}">
          <label class="btn btn-outline-secondary btn-sm" for="cfmode-ev-${key}-${idx}" style="font-size:0.75rem;">都度</label>
          <input type="radio" class="btn-check rf-mode-radio" name="cfmode-${key}-${idx}" id="cfmode-dt-${key}-${idx}" value="date" ${mode==="date"?"checked":""} data-notif-key="${key}" data-idx="${idx}">
          <label class="btn btn-outline-secondary btn-sm" for="cfmode-dt-${key}-${idx}" style="font-size:0.75rem;">日付</label>
        </div>
        <div class="rf-mode-event align-items-center gap-1 ${showEventBlock?"d-flex":"d-none"}" data-notif-key="${key}" data-idx="${idx}">
          <select class="form-select form-select-sm rf-timing-select" style="width:auto;font-size:0.75rem;" data-notif-key="${key}" data-idx="${idx}" data-field="timing">
            ${[["immediate","即時"],["5min","5分後"],["15min","15分後"],["30min","30分後"],["1hour","1時間後"],["morning","翌朝6時"],["evening","当日18時"],["custom","カスタム（分）"],["beforeEvent","N日前のHH:MM"]].map(([v,l])=>`<option value="${v}" ${timing===v?"selected":""}>${l}</option>`).join("")}
          </select>
          <input type="number" class="form-control form-control-sm rf-timing-minutes ${showMinutes?"":"d-none"}" style="width:80px;font-size:0.75rem;" data-notif-key="${key}" data-idx="${idx}" data-field="timingMinutes" value="${t.timingMinutes||""}" min="1" placeholder="分数">
          <input type="number" class="form-control form-control-sm rf-before-days ${showBefore?"":"d-none"}" style="width:65px;font-size:0.75rem;" data-notif-key="${key}" data-idx="${idx}" data-field="beforeDays" value="${t.beforeDays||3}" min="0" placeholder="日">
          <span class="small rf-before-suffix ${showBefore?"":"d-none"}" data-notif-key="${key}" data-idx="${idx}">日前の</span>
          <input type="time" class="form-control form-control-sm rf-before-time ${showBefore?"":"d-none"}" style="width:105px;font-size:0.75rem;" data-notif-key="${key}" data-idx="${idx}" data-field="beforeTime" value="${t.beforeTime||"09:00"}">
        </div>
        <div class="rf-mode-date align-items-center gap-1 ${showDateBlock?"d-flex":"d-none"}" data-notif-key="${key}" data-idx="${idx}">
          <select class="form-select form-select-sm rf-schedule-pattern" style="width:auto;font-size:0.75rem;" data-notif-key="${key}" data-idx="${idx}" data-field="schedulePattern">
            <option value="monthEnd" ${pat==="monthEnd"?"selected":""}>毎月 月末</option>
            <option value="monthlyDay" ${pat==="monthlyDay"?"selected":""}>毎月 N日</option>
            <option value="weekly" ${pat==="weekly"?"selected":""}>毎週 曜日</option>
            <option value="daily" ${pat==="daily"?"selected":""}>毎日</option>
          </select>
          <input type="number" class="form-control form-control-sm rf-schedule-day ${pat==="monthlyDay"?"":"d-none"}" style="width:65px;font-size:0.75rem;" data-notif-key="${key}" data-idx="${idx}" data-field="scheduleDay" value="${t.scheduleDay||1}" min="1" max="31">
          <select class="form-select form-select-sm rf-schedule-dow ${pat==="weekly"?"":"d-none"}" style="width:auto;font-size:0.75rem;" data-notif-key="${key}" data-idx="${idx}" data-field="scheduleDow">
            ${["日","月","火","水","木","金","土"].map((d,i)=>`<option value="${i}" ${(t.scheduleDow||0)==i?"selected":""}>${d}</option>`).join("")}
          </select>
          <input type="time" class="form-control form-control-sm rf-schedule-time" style="width:105px;font-size:0.75rem;" data-notif-key="${key}" data-idx="${idx}" data-field="scheduleTime" value="${t.scheduleTime||"09:00"}">
        </div>
        <button type="button" class="btn btn-sm btn-link text-danger ms-auto rf-remove-timing p-0" data-notif-key="${key}" data-idx="${idx}" title="このタイミングを削除"><i class="bi bi-x-circle"></i></button>
      </div>
    `;
  },

  // ========== イベント登録 ==========
  _attachEvents(wrap, property) {
    // カード折りたたみトグル
    wrap.addEventListener("click", (e) => {
      const header = e.target.closest(".rf-card-header[data-fold]");
      if (header && !e.target.closest("input") && !e.target.closest("button") && !e.target.closest("a")) {
        const foldId = header.dataset.fold;
        const body = document.getElementById(foldId);
        const chev = header.querySelector(".rf-chevron");
        if (body) {
          const isOpen = body.style.display !== "none";
          body.style.display = isOpen ? "none" : "";
          if (chev) chev.style.transform = isOpen ? "" : "rotate(180deg)";
        }
      }

      // タイミング追加
      const addBtn = e.target.closest(".rf-add-timing");
      if (addBtn) {
        const notifKey = addBtn.dataset.notifKey;
        const list = wrap.querySelector(`.rf-notif-timings[data-notif-key="${notifKey}"]`);
        if (!list) return;
        const idx = list.querySelectorAll(".notify-timing-row").length;
        const emptyT = { mode: "event", timing: "immediate", timingMinutes: "", beforeDays: 3, beforeTime: "09:00", schedulePattern: "monthEnd", scheduleDay: 1, scheduleDow: 0, scheduleTime: "09:00" };
        list.insertAdjacentHTML("beforeend", this._renderTimingRow(notifKey, emptyT, idx));
      }

      // タイミング削除
      const rmBtn = e.target.closest(".rf-remove-timing");
      if (rmBtn) {
        const row = rmBtn.closest(".notify-timing-row");
        const list = row?.parentElement;
        row?.remove();
        list?.querySelectorAll(".notify-timing-row").forEach((r, i) => {
          r.dataset.idx = i;
          r.querySelectorAll("[data-idx]").forEach(el => el.dataset.idx = i);
        });
        const notifKey = rmBtn.dataset.notifKey;
        if (notifKey) this._queueSaveNotif(notifKey);
      }

      // 変数タグクリック → textarea に挿入
      const tag = e.target.closest(".rf-var-tag");
      if (tag) {
        const notifKey = tag.dataset.notifKey;
        const ta = wrap.querySelector(`textarea.rf-notif-msg[data-notif-key="${notifKey}"]`);
        if (ta) {
          const pos = ta.selectionStart || ta.value.length;
          ta.value = ta.value.slice(0, pos) + tag.dataset.var + ta.value.slice(pos);
          ta.focus();
          ta.selectionStart = ta.selectionEnd = pos + tag.dataset.var.length;
          this._updatePreview(notifKey, wrap);
        }
      }
    });

    // change イベント
    wrap.addEventListener("change", (e) => {
      // rf-toggle: ON/OFF
      if (e.target.classList.contains("rf-toggle")) {
        const stepKey = e.target.dataset.step;
        const pid = e.target.dataset.pid;
        const card = wrap.querySelector(`.rf-card[data-step="${stepKey}"]`);
        if (card) {
          card.classList.toggle("rf-card-enabled", e.target.checked);
          card.classList.toggle("rf-card-disabled", !e.target.checked);
        }
        // globalChannel ステップは notifChannel にも enabled を保存する
        const step = this.STEPS.find(s => s.key === stepKey);
        if (step?.globalChannel) {
          this._queueSaveNotif(step.globalChannel);
        } else {
          this._queueSave(pid, stepKey);
        }
        return;
      }

      // タイミング行: モード切替
      const notifKey = e.target.dataset.notifKey;
      const idx = e.target.dataset.idx;
      if (notifKey && idx !== undefined) {
        const row = wrap.querySelector(`.notify-timing-row[data-notif-key="${notifKey}"][data-idx="${idx}"]`);
        if (row) {
          if (e.target.classList.contains("rf-mode-radio")) {
            const mode = e.target.value;
            row.querySelector(".rf-mode-event")?.classList.toggle("d-flex", mode === "event");
            row.querySelector(".rf-mode-event")?.classList.toggle("d-none", mode !== "event");
            row.querySelector(".rf-mode-date")?.classList.toggle("d-flex", mode === "date");
            row.querySelector(".rf-mode-date")?.classList.toggle("d-none", mode !== "date");
          }
          if (e.target.classList.contains("rf-timing-select")) {
            const val = e.target.value;
            row.querySelector(".rf-timing-minutes")?.classList.toggle("d-none", val !== "custom");
            row.querySelector(".rf-before-days")?.classList.toggle("d-none", val !== "beforeEvent");
            row.querySelector(".rf-before-suffix")?.classList.toggle("d-none", val !== "beforeEvent");
            row.querySelector(".rf-before-time")?.classList.toggle("d-none", val !== "beforeEvent");
          }
          if (e.target.classList.contains("rf-schedule-pattern")) {
            const val = e.target.value;
            row.querySelector(".rf-schedule-day")?.classList.toggle("d-none", val !== "monthlyDay");
            row.querySelector(".rf-schedule-dow")?.classList.toggle("d-none", val !== "weekly");
          }
        }
        this._queueSaveNotif(notifKey);
      }

      // 送信先チェックボックス
      if (e.target.classList.contains("rf-notif-field")) {
        this._queueSaveNotif(e.target.dataset.notifKey);
      }
    });

    // input イベント: textarea/input
    wrap.addEventListener("input", (e) => {
      if (e.target.classList.contains("rf-notif-msg")) {
        this._updatePreview(e.target.dataset.notifKey, wrap);
        this._queueSaveNotif(e.target.dataset.notifKey);
      }
      if (e.target.classList.contains("rf-memo")) {
        this._queueSave(e.target.dataset.pid, e.target.dataset.step);
      }
      // タイミング数値入力
      if (e.target.dataset.notifKey && e.target.dataset.idx !== undefined) {
        this._queueSaveNotif(e.target.dataset.notifKey);
      }
    });
  },

  // プレビュー更新
  _updatePreview(notifKey, wrap) {
    const ta = wrap.querySelector(`textarea.rf-notif-msg[data-notif-key="${notifKey}"]`);
    const el = wrap.querySelector(`[data-preview="${notifKey}"]`);
    if (!ta || !el) return;
    const varGroup = ta.dataset.varGroup;
    const vars = this.systemVariables[varGroup] || [];
    let msg = ta.value || "";
    vars.forEach(v => {
      msg = msg.replace(new RegExp(`\\{${v.name}\\}`, "g"), v.sample);
    });
    el.textContent = msg;
  },

  // ========== 保存キュー ==========
  _queueSave(pid, stepKey) {
    if (!this._saveTimers) this._saveTimers = {};
    const timerKey = `prop-${pid}`;
    if (this._saveTimers[timerKey]) clearTimeout(this._saveTimers[timerKey]);
    this._showStatus("saving");
    this._saveTimers[timerKey] = setTimeout(() => this._saveProperty(pid), 800);
  },

  _queueSaveNotif(notifKey) {
    if (!this._saveTimers) this._saveTimers = {};
    const timerKey = `notif-${notifKey}`;
    if (this._saveTimers[timerKey]) clearTimeout(this._saveTimers[timerKey]);
    this._showStatus("saving");
    this._saveTimers[timerKey] = setTimeout(() => this._saveNotifChannel(notifKey), 800);
  },

  // ========== 保存: 物件ドキュメント ==========
  async _saveProperty(pid) {
    const wrap = document.getElementById("cfSwimLane");
    if (!wrap) return;

    const cleaningFlow = {};
    const propertyFields = {};

    this.STEPS.forEach(step => {
      const toggleEl = wrap.querySelector(`.rf-toggle[data-step="${step.key}"][data-pid="${pid}"]`);
      const memoEl   = wrap.querySelector(`.rf-memo[data-step="${step.key}"][data-pid="${pid}"]`);
      const enabled  = toggleEl ? !!toggleEl.checked : true;
      const memo     = memoEl   ? (memoEl.value || "") : "";

      if (step.propertyField) {
        // ドット記法対応: "inspection.enabled" → inspection オブジェクトに merge
        const parts = step.propertyField.split(".");
        if (parts.length === 2) {
          if (!propertyFields[parts[0]]) propertyFields[parts[0]] = {};
          propertyFields[parts[0]][parts[1]] = enabled;
        } else {
          propertyFields[step.propertyField] = enabled;
        }
        cleaningFlow[step.key] = { memo };
      } else if (step.globalChannel) {
        // ON/OFFは globalChannel 側で保存するため、ここではメモのみ
        cleaningFlow[step.key] = { memo };
      } else {
        cleaningFlow[step.key] = { enabled, memo };
      }
    });

    try {
      await db.collection("properties").doc(pid).set({
        ...propertyFields,
        cleaningFlow,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      // ローカルキャッシュ更新
      const prop = this.properties.find(p => p.id === pid);
      if (prop) {
        prop.cleaningFlow = cleaningFlow;
        Object.assign(prop, propertyFields);
      }
      this._showStatus("saved");
    } catch (e) {
      this._showStatus("error", e.message);
    }
  },

  // ========== 保存: globalChannel (settings/notifications.channels.{key}) ==========
  async _saveNotifChannel(notifKey) {
    const wrap = document.getElementById("cfSwimLane");
    if (!wrap) return;

    const editor = wrap.querySelector(`.rf-notif-editor[data-notif-key="${notifKey}"]`);
    if (!editor) return;

    const get = (field) => {
      const el = editor.querySelector(`[data-notif-key="${notifKey}"][data-field="${field}"]`);
      return el ? !!el.checked : false;
    };
    const ta = editor.querySelector(`textarea.rf-notif-msg[data-notif-key="${notifKey}"]`);

    // タイミング収集
    const timingRows = editor.querySelectorAll(`.rf-notif-timings[data-notif-key="${notifKey}"] .notify-timing-row`);
    const timings = [];
    timingRows.forEach((row) => {
      const modeChecked = row.querySelector(`input.rf-mode-radio:checked`);
      const mode = modeChecked ? modeChecked.value : "event";
      const q = (sel) => row.querySelector(sel);
      const t = { mode };
      if (mode === "event") {
        const timing = q(`select[data-field="timing"]`)?.value || "immediate";
        t.timing = timing;
        if (timing === "custom") {
          t.timingMinutes = parseInt(q(`input[data-field="timingMinutes"]`)?.value, 10) || 0;
        } else if (timing === "beforeEvent") {
          t.beforeDays = parseInt(q(`input[data-field="beforeDays"]`)?.value, 10) || 0;
          t.beforeTime = q(`input[data-field="beforeTime"]`)?.value || "09:00";
        }
      } else {
        t.schedulePattern = q(`select[data-field="schedulePattern"]`)?.value || "monthEnd";
        t.scheduleTime = q(`input[data-field="scheduleTime"]`)?.value || "09:00";
        if (t.schedulePattern === "monthlyDay") {
          t.scheduleDay = parseInt(q(`input[data-field="scheduleDay"]`)?.value, 10) || 1;
        } else if (t.schedulePattern === "weekly") {
          t.scheduleDow = parseInt(q(`select[data-field="scheduleDow"]`)?.value, 10) || 0;
        }
      }
      timings.push(t);
    });

    // enabled はトグルから取得
    const toggleEl = wrap.querySelector(`.rf-toggle[data-step="${this.STEPS.find(s => s.globalChannel === notifKey)?.key}"]`);
    const enabled = toggleEl ? !!toggleEl.checked : true;

    const entry = {
      enabled,
      ownerLine:      get("ownerLine"),
      groupLine:      get("groupLine"),
      staffLine:      get("staffLine"),
      ownerEmail:     get("ownerEmail"),
      discordOwner:   get("discordOwner"),
      discordSubOwner: get("discordSubOwner"),
      customMessage:  ta ? ta.value : "",
      timings,
    };

    // 後方互換: 代表値
    if (timings[0]) {
      const t0 = timings[0];
      if (t0.timing)            entry.timing          = t0.timing;
      if (t0.mode)              entry.mode            = t0.mode;
      if (t0.timingMinutes !== undefined) entry.timingMinutes = t0.timingMinutes;
      if (t0.beforeDays    !== undefined) entry.beforeDays    = t0.beforeDays;
      if (t0.beforeTime)        entry.beforeTime      = t0.beforeTime;
      if (t0.schedulePattern)   entry.schedulePattern = t0.schedulePattern;
      if (t0.scheduleDay   !== undefined) entry.scheduleDay   = t0.scheduleDay;
      if (t0.scheduleDow   !== undefined) entry.scheduleDow   = t0.scheduleDow;
      if (t0.scheduleTime)      entry.scheduleTime    = t0.scheduleTime;
    }

    try {
      await db.collection("settings").doc("notifications").set({
        channels: { [notifKey]: entry },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      // ローカルキャッシュ更新
      this.notifChannels[notifKey] = { ...(this.notifChannels[notifKey] || {}), ...entry };

      // 同一 notifKey を持つ他のトグルを同期
      document.querySelectorAll(`.rf-toggle[data-step="${this.STEPS.find(s => s.globalChannel === notifKey)?.key}"]`).forEach(el => {
        if (el !== toggleEl) {
          el.checked = enabled;
          const card = el.closest(".rf-card");
          if (card) {
            card.classList.toggle("rf-card-enabled", enabled);
            card.classList.toggle("rf-card-disabled", !enabled);
          }
        }
      });

      this._showStatus("saved");
    } catch (e) {
      this._showStatus("error", e.message);
    }
  },

  // ========== ステータス表示 ==========
  _showStatus(kind, msg) {
    const el = document.getElementById("cfSaveStatus");
    if (!el) return;
    if (kind === "saving") {
      el.innerHTML = `<i class="bi bi-arrow-repeat"></i> 保存中…`;
    } else if (kind === "saved") {
      el.innerHTML = `<span class="text-success"><i class="bi bi-check-circle-fill"></i> 保存済み</span>`;
      setTimeout(() => { if (el.innerHTML.includes("保存済み")) el.innerHTML = ""; }, 2000);
    } else if (kind === "error") {
      el.innerHTML = `<span class="text-danger">保存失敗: ${this._esc(msg || "")}</span>`;
    }
  },

  // ========== CSS ==========
  _renderStyles() {
    return `
    <style>
    /* ===== スイムレーン全体 ===== */
    /* overflow-x: auto をここに置くと sticky が効かなくなるため分離 */
    .rf-swimlane-root {
      width: 100%;
    }
    .rf-swimlane-scroll {
      overflow-x: auto;
    }

    /* 3列グリッド */
    .rf-swimlane-grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 0;
    }

    /* ヘッダー行 */
    .rf-swimlane-header {
      position: sticky;
      top: 56px;
      z-index: 10;
      background: #fff;
    }
    .rf-lane-header {
      padding: 8px 12px;
      font-weight: 700;
      font-size: 0.9rem;
      text-align: center;
      border: 1px solid #dee2e6;
    }
    .rf-lane-header.rf-lane-guest  { background: #dbeafe; color: #1d4ed8; border-color: #93c5fd; }
    .rf-lane-header.rf-lane-owner  { background: #dcfce7; color: #166534; border-color: #86efac; }
    .rf-lane-header.rf-lane-staff  { background: #ffedd5; color: #9a3412; border-color: #fdba74; }

    /* Phase区切り */
    .rf-phase-divider {
      grid-column: 1 / -1;
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-left: 4px solid #64748b;
      padding: 6px 14px;
      font-size: 0.8rem;
      font-weight: 600;
      color: #475569;
      margin: 4px 0;
    }
    .rf-branch-divider {
      background: #fef9c3;
      border-color: #fcd34d;
      border-left-color: #f59e0b;
      color: #92400e;
    }

    /* トラックラベル */
    .rf-track-label {
      grid-column: 1 / -1;
      padding: 4px 12px;
    }
    .rf-track-badge {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 20px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .rf-track-guest { background: #bfdbfe; color: #1e40af; }
    .rf-track-staff { background: #fed7aa; color: #7c2d12; }

    /* セル */
    .rf-lane-cell {
      padding: 4px 6px;
      min-height: 36px;
      border-right: 1px dashed #e2e8f0;
    }
    .rf-cell-empty { background: #fafafa; }
    .rf-cell-active { background: transparent; }

    /* ステップ行 */
    .rf-step-row { align-items: start; }

    /* 矢印行 */
    .rf-arrow-row {
      height: 20px;
    }
    .rf-arrow-row .rf-lane-cell {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 4px;
    }
    .rf-arrow-badge {
      font-size: 0.7rem;
      padding: 1px 6px;
      border-radius: 10px;
    }
    .rf-arrow-guest  { background: #bfdbfe; color: #1e40af; }
    .rf-arrow-owner  { background: #bbf7d0; color: #14532d; }
    .rf-arrow-staff  { background: #fed7aa; color: #7c2d12; }

    /* カード */
    .rf-card {
      border-radius: 8px;
      border: 1px solid #dee2e6;
      background: #fff;
      margin: 3px 2px;
      font-size: 0.82rem;
      transition: box-shadow 0.15s;
    }
    .rf-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .rf-card-enabled { border-color: #94a3b8; }
    .rf-card-disabled { opacity: 0.45; background: #f8fafc; }

    .rf-card-header {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px 10px;
      flex-wrap: nowrap; /* 折り返し禁止 */
      min-width: 0;      /* flex child の縮小を許可 */
    }
    .rf-card-icon { font-size: 1rem; color: #3b82f6; flex-shrink: 0; }
    .rf-card-title {
      font-weight: 600;
      font-size: 0.8rem;
      flex: 1 1 auto;
      min-width: 0;          /* overflow を有効にするため必須 */
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* バッジ群は縮小しない */
    .rf-card-header .badge { flex-shrink: 0; }
    .rf-card-header .ms-auto { flex-shrink: 0; }

    .rf-card-body {
      padding: 6px 10px 10px;
      border-top: 1px dashed #e2e8f0;
      background: #f8fafc;
      border-radius: 0 0 8px 8px;
    }
    .rf-chevron { color: #94a3b8; }

    /* 通知エディタ */
    .rf-notif-editor {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 10px;
    }

    /* モバイル対応 */
    @media (max-width: 767px) {
      .rf-swimlane-grid {
        display: block;
      }
      .rf-lane-cell.rf-cell-empty {
        display: none;
      }
      .rf-swimlane-header { display: none; }
      .rf-phase-divider { margin: 6px 0; }

      /* モバイルタブフィルタ */
      .rf-step-row[data-lane] { display: block; }

      /* モバイルではタイトル折り返しOK */
      .rf-card-title {
        white-space: normal;
        overflow: visible;
        text-overflow: clip;
      }
    }

    /* モバイルタブ */
    .rf-lane-tabs .nav-link { font-size: 0.75rem; padding: 4px 6px; }

    /* フォームスイッチ小型化 */
    .rf-card .form-check-input { width: 2rem; height: 1rem; }

    /* 物件選択ボタン */
    .cf-prop-btn { border-radius: 20px; }
    </style>
    `;
  },
};
