/**
 * 予約フロー構成画面
 *   物件ごとに「予約受付〜チェックイン」までのフロー設定をON/OFF管理する
 *   清掃フロー構成 (cleaning-flow.js) と同じUIパターン
 *
 * データ:
 *   properties/{id}.reservationFlow = {
 *     [stepKey]: { enabled: boolean, memo: string }
 *   }
 *   初期状態: 全ステップ enabled: true
 *
 * ルート: #/reservation-flow
 */
const ReservationFlowPage = {
  properties: [],
  selectedPropertyIds: [],

  // フローステップ定義（追加・並び替えはここだけ編集）
  STEPS: [
    { key: "ical_sync",          label: "予約受付 (iCal同期)",          icon: "bi-calendar-check",   linkHash: "#/settings",       linkLabel: "iCal 設定" },
    { key: "booking_notify",     label: "予約確認メール（宿泊者）",      icon: "bi-envelope",          linkHash: "#/notifications",  linkLabel: "通知設定" },
    { key: "form_url_send",      label: "宿泊者名簿フォームURL送信",     icon: "bi-link-45deg",        linkHash: "#/guests",         linkLabel: "宿泊者名簿→設定" },
    { key: "form_notice",        label: "注意事項・ハウスルール",        icon: "bi-exclamation-circle", linkHash: "#/guests",         linkLabel: "宿泊者名簿→設定" },
    { key: "mini_game",          label: "ミニゲーム（騒音確認）",        icon: "bi-controller",        linkHash: "#/guests",         linkLabel: "宿泊者名簿→設定" },
    { key: "form_input",         label: "宿泊者情報フォーム入力",        icon: "bi-pencil-square",     linkHash: "#/guests",         linkLabel: "宿泊者名簿→設定" },
    { key: "pre_checkin_remind", label: "直前リマインド（名簿未提出）",  icon: "bi-alarm",             linkHash: "#/notifications",  linkLabel: "通知設定" },
    { key: "keybox_email",       label: "キーボックス情報送信",          icon: "bi-key",               linkHash: "#/settings",       linkLabel: "キーボックス設定" },
    { key: "checkin",            label: "チェックイン",                  icon: "bi-door-open",         linkHash: "",                 linkLabel: "" },
  ],

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-arrow-right-circle"></i> 予約フロー構成</h2>
        <span id="rfSaveStatus" class="small text-muted"></span>
      </div>
      <p class="text-muted small">物件ごとに、予約受付からチェックインまでのフローをON/OFFで管理します。変更は自動保存されます。</p>
      <style>
        /* 予約フロー縦配置スタイル (cleaning-flow.js と共通構造) */
        .rf-flow-vertical { display:flex; flex-direction:column; gap:0; }
        .rf-step { background:#f8f9fa; border:1px solid #dee2e6; border-radius:8px; padding:10px 14px; position:relative; }
        .rf-step.active { background:#e7f1ff; border-color:#9fc5ff; }
        .rf-step.disabled { opacity:0.35; background:#f1f3f5; }
        .rf-step-header { display:flex; align-items:center; gap:8px; margin-bottom:4px; }
        .rf-step-num { font-size:0.75rem; color:#6c757d; font-weight:600; min-width:1.6em; }
        .rf-step-label { font-weight:600; font-size:0.88rem; flex:1; }
        .rf-step-body { font-size:0.8rem; color:#495057; padding-left:2.1em; }
        /* 縦矢印 */
        .rf-arrow-down { text-align:center; color:#adb5bd; font-size:1.3rem; line-height:1.4; margin:2px 0; }
        /* メモ欄 */
        .rf-memo { font-size:0.8rem; }
      </style>
      <!-- 物件フィルタ -->
      <div id="propertyFilterHost-reservation-flow"></div>
      <div id="rfList" class="row g-3">
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

    this.selectedPropertyIds = PropertyFilter.getSelectedIds("reservation-flow", this.properties);

    // 物件フィルタ描画
    PropertyFilter.render({
      containerId: "propertyFilterHost-reservation-flow",
      tabKey: "reservation-flow",
      properties: this.properties,
      onChange: (ids) => {
        this.selectedPropertyIds = ids;
        this.renderList();
      },
    });

    this.renderList();
  },

  renderList() {
    const wrap = document.getElementById("rfList");
    if (!this.properties.length) {
      wrap.innerHTML = `<div class="col-12 text-muted">民泊物件がありません</div>`;
      return;
    }

    // 物件フィルタ適用
    const visibleProps = this.properties.filter(p =>
      !this.selectedPropertyIds || this.selectedPropertyIds.length === 0 ||
      this.selectedPropertyIds.includes(p.id)
    );

    if (!visibleProps.length) {
      wrap.innerHTML = `<div class="col-12 text-muted">表示する物件がありません（物件フィルタで全OFFになっています）</div>`;
      return;
    }

    const accordionId = "rfAccordion";
    wrap.innerHTML = `<div class="col-12"><div class="accordion" id="${accordionId}">${
      visibleProps.map((p) => {
        const flow = p.reservationFlow || {};
        // 有効ステップ数をサマリに表示
        const enabledCount = this.STEPS.filter(s => flow[s.key]?.enabled !== false).length;
        const totalCount = this.STEPS.length;

        const collapseId = `rfCollapse-${p.id}`;
        const headerId = `rfHeader-${p.id}`;

        // フロー縦配置HTML生成
        const stepsHtml = this.STEPS.map((step, idx) => {
          const stepData = flow[step.key] || {};
          const enabled = stepData.enabled !== false; // デフォルトtrue
          const memo = stepData.memo || "";
          const isLast = idx === this.STEPS.length - 1;

          const linkBtn = step.linkHash
            ? `<a href="${this._esc(step.linkHash)}" class="btn btn-outline-secondary btn-sm py-0 px-2 ms-1" style="font-size:0.75rem;">${this._esc(step.linkLabel)} <i class="bi bi-arrow-right"></i></a>`
            : "";

          return `
            <div class="rf-step ${enabled ? "active" : "disabled"}" data-step="${step.key}" data-pid="${p.id}">
              <div class="rf-step-header">
                <span class="rf-step-num">${idx + 1}</span>
                <i class="bi ${step.icon} text-primary"></i>
                <span class="rf-step-label">${this._esc(step.label)}</span>
                <div class="form-check form-switch mb-0 ms-auto">
                  <input class="form-check-input rf-toggle" type="checkbox" data-step="${step.key}"
                    id="rf-${p.id}-${step.key}" ${enabled ? "checked" : ""}>
                  <label class="form-check-label small" for="rf-${p.id}-${step.key}">${enabled ? "有効" : "無効"}</label>
                </div>
              </div>
              <div class="rf-step-body">
                ${linkBtn}
                <div class="mt-1">
                  <input type="text" class="form-control form-control-sm rf-memo"
                    data-step="${step.key}" placeholder="物件固有のメモ（任意）"
                    value="${this._esc(memo)}">
                </div>
              </div>
            </div>
            ${isLast ? "" : '<div class="rf-arrow-down"><i class="bi bi-arrow-down"></i></div>'}
          `;
        }).join("");

        return `
        <div class="accordion-item" data-pid="${p.id}">
          <h2 class="accordion-header" id="${headerId}">
            <button class="accordion-button collapsed" type="button"
              data-bs-toggle="collapse" data-bs-target="#${collapseId}"
              aria-expanded="false" aria-controls="${collapseId}">
              <span class="badge me-2" style="background:${p.color || "#6c757d"}">${p.propertyNumber || "-"}</span>
              <span class="fw-semibold">${this._esc(p.name)}</span>
              <span class="badge bg-primary-subtle text-primary border border-primary-subtle ms-2" style="font-size:0.72rem;">
                ${enabledCount}/${totalCount} ステップ有効
              </span>
            </button>
          </h2>
          <div id="${collapseId}" class="accordion-collapse collapse" aria-labelledby="${headerId}" data-bs-parent="#${accordionId}">
            <div class="accordion-body" data-pid="${p.id}">
              <div class="rf-flow-vertical mb-2" style="max-width:500px;">
                ${stepsHtml}
              </div>
            </div>
          </div>
        </div>
        `;
      }).join("")
    }</div></div>`;

    // イベント登録: rf-toggle / rf-memo
    wrap.querySelectorAll(".rf-toggle, .rf-memo").forEach(el => {
      el.addEventListener(el.tagName === "INPUT" && el.type === "checkbox" ? "change" : "input", () => {
        const item = el.closest(".accordion-item");
        if (!item) return;
        const pid = item.dataset.pid;

        // トグル時: ステップカードのactive/disabledクラスとラベルを更新
        if (el.classList.contains("rf-toggle")) {
          const stepKey = el.dataset.step;
          const stepEl = item.querySelector(`.rf-step[data-step="${stepKey}"]`);
          if (stepEl) {
            stepEl.classList.toggle("active", el.checked);
            stepEl.classList.toggle("disabled", !el.checked);
          }
          const lbl = el.nextElementSibling;
          if (lbl) lbl.textContent = el.checked ? "有効" : "無効";

          // ヘッダのバッジを更新
          const enabledCount = item.querySelectorAll(".rf-toggle:checked").length;
          const badge = item.querySelector(".accordion-button .badge.bg-primary-subtle");
          if (badge) badge.textContent = `${enabledCount}/${this.STEPS.length} ステップ有効`;
        }

        this._queueSave(pid);
      });
    });
  },

  _queueSave(propertyId) {
    if (!this._timers) this._timers = {};
    if (this._timers[propertyId]) clearTimeout(this._timers[propertyId]);
    this._showStatus("saving");
    this._timers[propertyId] = setTimeout(() => this._save(propertyId), 800);
  },

  async _save(propertyId) {
    const item = document.querySelector(`.accordion-item[data-pid="${propertyId}"]`);
    if (!item) return;

    // ステップごとに enabled + memo を収集
    const reservationFlow = {};
    this.STEPS.forEach(step => {
      const toggleEl = item.querySelector(`.rf-toggle[data-step="${step.key}"]`);
      const memoEl   = item.querySelector(`.rf-memo[data-step="${step.key}"]`);
      reservationFlow[step.key] = {
        enabled: toggleEl ? !!toggleEl.checked : true,
        memo:    memoEl   ? (memoEl.value || "") : "",
      };
    });

    try {
      await db.collection("properties").doc(propertyId).set({
        reservationFlow,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      // ローカルキャッシュも更新
      const prop = this.properties.find(p => p.id === propertyId);
      if (prop) prop.reservationFlow = reservationFlow;

      this._showStatus("saved");
    } catch (e) {
      this._showStatus("error", e.message);
    }
  },

  _showStatus(kind, msg) {
    const el = document.getElementById("rfSaveStatus");
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

  _esc(s) { const d = document.createElement("div"); d.textContent = String(s || ""); return d.innerHTML; },
};
