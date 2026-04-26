/**
 * 通知先インライン表示 + 編集モーダル コンポーネント
 *
 * notify-channel-editor.js の送信先チェックボックスの隣に
 * 現在値を読み取り専用で表示し、✏️ 編集ボタンで Bootstrap 5 モーダルを開く。
 *
 * 対象通知先:
 *   グローバル設定 (settings/notifications):
 *     ownerEmail, ownerLine, groupLine, discordOwner
 *   スタッフ単位 (staff/{staffId}):
 *     subOwnerEmail, subOwnerLine, discordSubOwner (isSubOwner=true のスタッフ)
 *   スタッフ一覧表示のみ (編集なし):
 *     staffLine, staffEmail
 */
(function(global) {
  "use strict";

  // ========== 内部キャッシュ ==========
  // Firestoreから取得した settings/notifications スナップショット
  let _notifSettings = null;
  // Firestoreから取得した staff[] スナップショット
  let _staffList = null;

  // ========== Firestore データ取得 ==========

  /**
   * settings/notifications を取得（キャッシュあり）
   * @returns {Promise<object>}
   */
  async function fetchNotifSettings() {
    if (_notifSettings !== null) return _notifSettings;
    try {
      const snap = await db.collection("settings").doc("notifications").get();
      _notifSettings = snap.exists ? snap.data() : {};
    } catch (e) {
      console.warn("[NotifyTargetEditor] settings/notifications 取得失敗:", e.message);
      _notifSettings = {};
    }
    return _notifSettings;
  }

  /**
   * staff コレクションを取得（キャッシュあり）
   * @returns {Promise<Array>}
   */
  async function fetchStaffList() {
    if (_staffList !== null) return _staffList;
    try {
      const snap = await db.collection("staff").get();
      _staffList = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      console.warn("[NotifyTargetEditor] staff 取得失敗:", e.message);
      _staffList = [];
    }
    return _staffList;
  }

  /** キャッシュを破棄（保存後に呼ぶ） */
  function clearCache() {
    _notifSettings = null;
    _staffList = null;
  }

  // ========== 値の取得 ==========

  /**
   * 通知先フィールドの現在値を解決する
   * @param {string} field - "ownerEmail" | "ownerLine" | ...
   * @param {object} notifSettings - settings/notifications データ
   * @param {Array} staffList - staff 配列
   * @returns {string} 表示用文字列
   */
  function resolveCurrentValue(field, notifSettings, staffList) {
    const ns = notifSettings || {};
    const sl = staffList || [];

    switch (field) {
      case "ownerEmail":
        return ns.ownerEmail || "";
      case "ownerLine":
        return ns.lineOwnerUserId || "";
      case "groupLine":
        return ns.lineGroupId || "";
      case "discordOwner":
        return ns.discordOwnerWebhookUrl || "";
      case "subOwnerLine": {
        // subOwnerLineUserId → なければ lineUserId にフォールバック
        const vals = sl
          .filter(s => s.isSubOwner && (s.subOwnerLineUserId || s.lineUserId))
          .map(s => `${s.name || s.id}: ${s.subOwnerLineUserId || s.lineUserId}`);
        return vals.join("\n") || "";
      }
      case "subOwnerEmail": {
        // subOwnerEmail → なければ email にフォールバック
        const vals = sl
          .filter(s => s.isSubOwner && (s.subOwnerEmail || s.email))
          .map(s => `${s.name || s.id}: ${s.subOwnerEmail || s.email}`);
        return vals.join("\n") || "";
      }
      case "discordSubOwner": {
        // subOwnerDiscordWebhookUrl → なければ discordWebhookUrl にフォールバック
        const vals = sl
          .filter(s => s.isSubOwner && (s.subOwnerDiscordWebhookUrl || s.discordWebhookUrl))
          .map(s => `${s.name || s.id}: ${s.subOwnerDiscordWebhookUrl || s.discordWebhookUrl}`);
        return vals.join("\n") || "";
      }
      default:
        return "";
    }
  }

  /**
   * subOwner系フィールドについて、各スタッフの値と採用元を解決する
   * @param {string} field - "subOwnerLine" | "subOwnerEmail" | "discordSubOwner"
   * @param {Array} staffList
   * @returns {Array<{staffId, name, value, isFallback}>}
   *   isFallback=true → スタッフ通常フィールドの値を流用中
   */
  function resolveSubOwnerValues(field, staffList) {
    const sl = (staffList || []).filter(s => s.isSubOwner);
    // フィールド名マッピング: 専用フィールド / フォールバックフィールド
    const FIELD_MAP = {
      subOwnerLine:    { dedicated: "subOwnerLineUserId",      fallback: "lineUserId" },
      subOwnerEmail:   { dedicated: "subOwnerEmail",           fallback: "email" },
      discordSubOwner: { dedicated: "subOwnerDiscordWebhookUrl", fallback: "discordWebhookUrl" },
    };
    const map = FIELD_MAP[field];
    if (!map) return [];
    return sl
      .filter(s => s[map.dedicated] || s[map.fallback])
      .map(s => ({
        staffId: s.id,
        name: s.name || s.id,
        value: s[map.dedicated] || s[map.fallback] || "",
        // 専用フィールドが空の場合はフォールバック扱い
        isFallback: !s[map.dedicated] && !!s[map.fallback],
      }));
  }

  /**
   * スタッフ個別（staffLine/staffEmail）の名前列挙テキストを生成
   * @param {string} field - "staffLine" | "staffEmail"
   * @param {Array} staffList
   * @returns {string}
   */
  function resolveStaffSummary(field, staffList) {
    const sl = (staffList || []).filter(s => s.active !== false);
    let matched = [];
    if (field === "staffLine") {
      matched = sl.filter(s => s.lineUserId).map(s => s.name || s.id);
    } else if (field === "staffEmail") {
      matched = sl.filter(s => s.email).map(s => s.name || s.id);
    }
    if (!matched.length) return "";
    // 4名以上は省略表示
    if (matched.length > 3) {
      return matched.slice(0, 3).join("、") + ` 他${matched.length - 3}名`;
    }
    return matched.join("、");
  }

  // ========== バリデーション ==========

  /**
   * フィールドごとのバリデーション
   * @returns {{ ok: boolean, warn: string | null }}
   */
  function validate(field, value) {
    if (!value) return { ok: true, warn: null };
    if (field === "ownerEmail" || field === "subOwnerEmail") {
      const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
      return { ok: true, warn: valid ? null : "メールアドレスの形式が正しくない可能性があります" };
    }
    if (field === "ownerLine" || field === "groupLine" || field === "subOwnerLine") {
      const isUser = /^U[a-f0-9]{32}$/i.test(value);
      const isGroup = value.startsWith("@");
      if (!isUser && !isGroup) {
        return { ok: true, warn: 'LINE User IDは「U」で始まる32文字英数字、グループIDは「@」で始まります' };
      }
    }
    if (field === "discordOwner" || field === "discordSubOwner") {
      if (!value.startsWith("https://discord.com/api/webhooks/")) {
        return { ok: true, warn: '"https://discord.com/api/webhooks/" で始まるURLではありません' };
      }
    }
    return { ok: true, warn: null };
  }

  // ========== Firestore への保存 ==========

  /**
   * グローバル設定フィールドを保存
   * @param {string} field
   * @param {string} value
   */
  async function saveGlobalField(field, value) {
    const fieldMap = {
      ownerEmail:       "ownerEmail",
      ownerLine:        "lineOwnerUserId",
      groupLine:        "lineGroupId",
      discordOwner:     "discordOwnerWebhookUrl",
    };
    const fsField = fieldMap[field];
    if (!fsField) throw new Error(`未知のグローバルフィールド: ${field}`);
    await db.collection("settings").doc("notifications").update({ [fsField]: value });
    clearCache();
  }

  /**
   * サブオーナースタッフのフィールドを保存
   * @param {string} field
   * @param {string} staffId
   * @param {string} value - 入力値
   * @param {boolean} useShared - true なら専用フィールドを削除（フォールバック継続）
   */
  async function saveSubOwnerField(field, staffId, value, useShared) {
    const fieldMap = {
      subOwnerLine:    "subOwnerLineUserId",
      subOwnerEmail:   "subOwnerEmail",
      discordSubOwner: "subOwnerDiscordWebhookUrl",
    };
    const fsField = fieldMap[field];
    if (!fsField) throw new Error(`未知のサブオーナーフィールド: ${field}`);
    if (useShared) {
      // 専用フィールドを null にしてフォールバックを継続
      await db.collection("staff").doc(staffId).update({ [fsField]: null });
    } else {
      // 個別値を専用フィールドに保存
      await db.collection("staff").doc(staffId).update({ [fsField]: value });
    }
    clearCache();
  }

  // ========== モーダル管理 ==========

  /** モーダルの Bootstrap インスタンスを保持 */
  let _modalInstance = null;
  const MODAL_ID = "notifyTargetEditorModal";

  /** モーダルのDOM要素を生成（初回のみ） */
  function ensureModal() {
    if (document.getElementById(MODAL_ID)) return;
    const el = document.createElement("div");
    el.innerHTML = `
      <div class="modal fade" id="${MODAL_ID}" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header py-2">
              <h6 class="modal-title mb-0" id="${MODAL_ID}Label">
                <i class="bi bi-pencil-square text-primary me-1"></i>
                <span id="${MODAL_ID}Title">通知先を編集</span>
              </h6>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body" id="${MODAL_ID}Body">
              <!-- 動的に生成 -->
            </div>
            <div class="modal-footer py-2">
              <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">キャンセル</button>
              <button type="button" class="btn btn-primary btn-sm" id="${MODAL_ID}SaveBtn">
                <i class="bi bi-check2"></i> 保存
              </button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(el.firstElementChild);
  }

  /**
   * 通知先編集モーダルを開く
   * @param {object} opts
   *   - field: "ownerEmail" | "ownerLine" | "groupLine" | "discordOwner"
   *            | "subOwnerLine" | "subOwnerEmail" | "discordSubOwner"
   *   - currentValue: 現在の値（グローバル）or subOwner の場合は [{staffId, name, value}]
   *   - subOwners: isSubOwner=true のスタッフ配列（subOwner系フィールドで使用）
   *   - onSaved: 保存成功後のコールバック
   */
  function openEditModal(opts) {
    ensureModal();
    const { field, currentValue, subOwners, onSaved } = opts;
    const titleEl   = document.getElementById(`${MODAL_ID}Title`);
    const bodyEl    = document.getElementById(`${MODAL_ID}Body`);
    const saveBtn   = document.getElementById(`${MODAL_ID}SaveBtn`);

    // ラベル定義
    const LABELS = {
      ownerEmail:      { label: "Webアプリ管理者メール", scope: "global", inputType: "email" },
      ownerLine:       { label: "Webアプリ管理者LINE (User ID)", scope: "global", inputType: "text" },
      groupLine:       { label: "グループLINE (Group ID)", scope: "global", inputType: "text" },
      discordOwner:    { label: "Discord Webhook URL (Webアプリ管理者)", scope: "global", inputType: "url" },
      subOwnerLine:    { label: "物件オーナー個別LINE (User ID)", scope: "subOwner", inputType: "text" },
      subOwnerEmail:   { label: "物件オーナー個別メール", scope: "subOwner", inputType: "email" },
      discordSubOwner: { label: "Discord Webhook URL (物件オーナー)", scope: "subOwner", inputType: "url" },
    };
    const def = LABELS[field] || { label: field, scope: "global", inputType: "text" };

    titleEl.textContent = `${def.label} を編集`;

    // 警告ボックス（スコープに応じて）
    const isGlobal = def.scope === "global";
    const warningHtml = isGlobal
      ? `<div class="alert alert-danger py-2 px-3 mb-3" style="font-size:0.82rem;">
           <i class="bi bi-exclamation-triangle-fill me-1"></i>
           <strong>⚠️ この値はアプリ全体に反映されます。</strong><br>
           すべてのフロー・すべての物件で使用されます。変更は即座に保存されます。
         </div>`
      : `<div class="alert alert-warning py-2 px-3 mb-3" style="font-size:0.82rem;">
           <i class="bi bi-person-badge me-1"></i>
           この値は <strong>物件オーナー（サブオーナー）</strong> の個別設定です。
           同じサブオーナーが複数物件に紐づく場合は全物件に反映されます。
         </div>`;

    // 入力フォームを構築
    let inputsHtml = "";
    if (isGlobal) {
      const safeVal = String(currentValue || "").replace(/"/g, "&quot;");
      const placeholder = field === "ownerEmail" ? "例: owner@example.com"
        : field === "ownerLine" ? "例: Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        : field === "groupLine" ? "例: @グループID または Cxxxxxxxx"
        : field === "discordOwner" ? "例: https://discord.com/api/webhooks/..."
        : "";
      inputsHtml = `
        <div class="mb-3">
          <label class="form-label small fw-semibold">${def.label}</label>
          <input type="${def.inputType}" class="form-control form-control-sm"
            id="${MODAL_ID}Input" value="${safeVal}" placeholder="${placeholder}">
          <div class="notify-target-warn text-warning small mt-1" style="display:none;">
            <i class="bi bi-exclamation-triangle"></i> <span></span>
          </div>
        </div>`;
    } else {
      // サブオーナー複数対応 → スタッフごとに入力欄
      if (!subOwners || subOwners.length === 0) {
        inputsHtml = `<div class="text-muted small">
          <i class="bi bi-info-circle"></i> サブオーナー（isSubOwner=true）のスタッフが登録されていません。
          <a href="#/staff">スタッフ管理</a>で設定してください。
        </div>`;
      } else {
        inputsHtml = subOwners.map((so, i) => {
          // isFallback=true → 現在フォールバック中（専用フィールドが空）
          const isCurrentlyFallback = so.isFallback;
          const safeVal = String(so.value || "").replace(/"/g, "&quot;");
          const placeholder = field === "subOwnerEmail" ? "例: subowner@example.com"
            : field === "subOwnerLine" ? "例: Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            : "例: https://discord.com/api/webhooks/...";
          // フォールバック元の値をヒントとして表示
          const fallbackHint = isCurrentlyFallback
            ? `<div class="text-muted mt-1" style="font-size:0.75em;">現在のスタッフ登録値: ${escapeHtml(so.value || "(未登録)")}</div>`
            : "";
          return `
            <div class="mb-3 border rounded p-2">
              <div class="form-label small fw-semibold mb-2">
                <i class="bi bi-person-badge text-success"></i>
                ${escapeHtml(so.name || so.staffId)} さんの ${def.label}
              </div>
              <!-- フォールバック切替チェックボックス -->
              <div class="form-check mb-2">
                <input class="form-check-input notify-target-shared-chk" type="checkbox"
                  id="${MODAL_ID}SharedChk${i}" data-idx="${i}"
                  ${isCurrentlyFallback ? "checked" : ""}>
                <label class="form-check-label small" for="${MODAL_ID}SharedChk${i}">
                  スタッフとして登録した値を共有する
                  <span class="text-muted" style="font-size:0.8em;">（OFFにすると物件オーナー専用の値を保存）</span>
                </label>
              </div>
              ${fallbackHint}
              <!-- 専用値入力欄（共有ON のときはdisabled） -->
              <input type="${def.inputType}"
                class="form-control form-control-sm notify-target-subowner-input"
                data-staff-id="${so.staffId}" data-idx="${i}"
                value="${safeVal}" placeholder="${placeholder}"
                ${isCurrentlyFallback ? "disabled" : ""}>
              <div class="notify-target-warn text-warning small mt-1" style="display:none;" data-for-idx="${i}">
                <i class="bi bi-exclamation-triangle"></i> <span></span>
              </div>
            </div>`;
        }).join("");
      }
    }

    bodyEl.innerHTML = warningHtml + inputsHtml;

    // バリデーション (入力中)
    if (isGlobal) {
      const inp = document.getElementById(`${MODAL_ID}Input`);
      if (inp) {
        inp.addEventListener("input", () => {
          const { warn } = validate(field, inp.value);
          const warnEl = bodyEl.querySelector(".notify-target-warn");
          if (warnEl) {
            warnEl.style.display = warn ? "" : "none";
            const sp = warnEl.querySelector("span");
            if (sp) sp.textContent = warn || "";
          }
        });
      }
    } else {
      // 入力バリデーション
      bodyEl.querySelectorAll(".notify-target-subowner-input").forEach((inp, i) => {
        inp.addEventListener("input", () => {
          const { warn } = validate(field, inp.value);
          const warnEl = bodyEl.querySelector(`.notify-target-warn[data-for-idx="${i}"]`);
          if (warnEl) {
            warnEl.style.display = warn ? "" : "none";
            const sp = warnEl.querySelector("span");
            if (sp) sp.textContent = warn || "";
          }
        });
      });
      // 「スタッフ共通」チェックボックス切替 → 入力欄 disabled 連動
      bodyEl.querySelectorAll(".notify-target-shared-chk").forEach(chk => {
        chk.addEventListener("change", () => {
          const idx = chk.dataset.idx;
          const inp = bodyEl.querySelector(`.notify-target-subowner-input[data-idx="${idx}"]`);
          if (inp) inp.disabled = chk.checked;
        });
      });
    }

    // 保存処理
    // 以前のリスナーを除去するためクローンで差し替え
    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
    newSaveBtn.addEventListener("click", async () => {
      newSaveBtn.disabled = true;
      newSaveBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 保存中...';
      try {
        if (isGlobal) {
          const inp = document.getElementById(`${MODAL_ID}Input`);
          const val = inp ? inp.value.trim() : "";
          await saveGlobalField(field, val);
        } else {
          // サブオーナー全件保存（チェックボックスで共有/個別を判断）
          const inputs = bodyEl.querySelectorAll(".notify-target-subowner-input");
          for (const inp of inputs) {
            const idx = inp.dataset.idx;
            const staffId = inp.dataset.staffId;
            const val = inp.value.trim();
            // 同じ idx のチェックボックスで共有フラグを確認
            const chk = bodyEl.querySelector(`.notify-target-shared-chk[data-idx="${idx}"]`);
            const useShared = chk ? chk.checked : false;
            await saveSubOwnerField(field, staffId, val, useShared);
          }
        }
        // モーダルを閉じる
        const bsModal = bootstrap.Modal.getInstance(document.getElementById(MODAL_ID));
        if (bsModal) bsModal.hide();
        // コールバック
        if (typeof onSaved === "function") onSaved();
        if (window.showAlert) {
          showAlert("保存しました", "success");
        }
      } catch (e) {
        console.error("[NotifyTargetEditor] 保存失敗:", e);
        if (window.showAlert) {
          showAlert(`保存に失敗しました: ${e.message}`, "danger");
        }
      } finally {
        newSaveBtn.disabled = false;
        newSaveBtn.innerHTML = '<i class="bi bi-check2"></i> 保存';
      }
    });

    // モーダル表示
    const modalEl = document.getElementById(MODAL_ID);
    let bsModal = bootstrap.Modal.getInstance(modalEl);
    if (!bsModal) bsModal = new bootstrap.Modal(modalEl);
    bsModal.show();
  }

  // ========== インライン値表示スパンを生成 ==========

  /**
   * チェックボックスの隣に挿入するインライン値表示HTML
   * グローバル / サブオーナー の2種。スタッフ一覧は別関数。
   *
   * @param {string} field
   * @param {string} value  - 現在値（空文字は未設定）
   * @param {boolean} isEditable - true なら✏️ボタン付き
   * @param {boolean} [isFallback] - true なら「スタッフ共通」バッジを付与
   * @returns {string} HTML
   */
  function renderValueBadge(field, value, isEditable, isFallback) {
    const isEmpty = !value;
    // フォールバック時は「スタッフ共通」バッジを値の右に追加
    const fallbackBadge = (!isEmpty && isFallback)
      ? `<span class="badge bg-secondary bg-opacity-25 text-secondary border ms-1"
             style="font-size:0.65em;vertical-align:middle;cursor:help;"
             title="スタッフとしての登録値を流用中">[スタッフ共通]</span>`
      : "";
    const displayVal = isEmpty
      ? `<span class="text-muted" style="font-size:0.72em;font-style:italic;">（未設定）</span>`
      : `<span class="badge bg-light text-dark border ms-1" style="font-size:0.72em;max-width:200px;overflow:hidden;text-overflow:ellipsis;vertical-align:middle;" title="${escapeHtml(value)}">${escapeHtml(truncate(value, 30))}</span>${fallbackBadge}`;

    const editBtn = isEditable
      ? `<button type="button" class="btn btn-link btn-sm p-0 ms-1 notify-target-edit-btn"
           data-field="${field}"
           style="font-size:0.75em;vertical-align:middle;"
           title="通知先を編集">✏️</button>`
      : "";

    return `<span class="notify-target-inline" data-field="${field}">${displayVal}${editBtn}</span>`;
  }

  /**
   * スタッフ個別（staffLine/staffEmail）の名前列挙バッジを生成
   * @param {string} field
   * @param {string} summary - resolveStaffSummary() の返り値
   * @returns {string} HTML
   */
  function renderStaffSummaryBadge(field, summary) {
    const displayVal = summary
      ? `<span class="badge bg-info-subtle text-info border ms-1" style="font-size:0.72em;max-width:250px;overflow:hidden;text-overflow:ellipsis;vertical-align:middle;" title="${escapeHtml(summary)}">${escapeHtml(summary)}に送信</span>`
      : `<span class="text-muted" style="font-size:0.72em;font-style:italic;">（登録済みスタッフなし）</span>`;
    const tooltip = "スタッフ管理画面でメール/LINE IDを設定してください";
    return `<span class="notify-target-inline" data-field="${field}" title="${escapeHtml(tooltip)}">${displayVal}</span>`;
  }

  // ========== 通知先ラベル行の完全な HTML を生成 ==========
  // notify-channel-editor.js の renderNotificationCard から呼ばれる想定

  /**
   * 送信先チェックボックス1行のHTMLを生成する
   * 歯車リンクを廃止し、インライン値表示 + ✏️ ボタンに置き換える
   *
   * @param {object} opts
   *   - dk: data-key 文字列
   *   - field: "ownerLine" | "groupLine" | ...
   *   - checked: boolean
   *   - icon: Bootstrap icon class
   *   - label: 表示ラベル
   *   - subLabel: 薄字の補足 (送信元など)
   * @returns {string} <label> HTML
   */
  function renderTargetRow(opts) {
    const { dk, field, checked, icon, label, subLabel } = opts;
    // 値バッジはサーバーから非同期で差し込むため、まずプレースホルダーを置く
    const placeholder = `<span class="notify-target-inline notify-target-placeholder" data-field="${field}" style="display:inline;"></span>`;
    return `
      <label class="form-check form-check-inline mb-0 d-flex align-items-center flex-wrap gap-1" style="cursor:pointer;">
        <input class="form-check-input" type="checkbox" data-key="${dk}" data-field="${field}" ${checked ? "checked" : ""}>
        <span class="form-check-label small">
          <i class="${icon}"></i> ${label}
          ${subLabel ? `<span class="text-muted" style="font-size:0.75em;">${subLabel}</span>` : ""}
        </span>
        ${placeholder}
      </label>`;
  }

  // ========== 非同期で値バッジを差し込む ==========

  /**
   * カード内の .notify-target-placeholder に値バッジを非同期で差し込む
   * @param {HTMLElement} container - notify-channel-card 要素または親
   * @param {Function} onSaved - 保存後コールバック（再描画用）
   */
  async function hydrateBadges(container, onSaved) {
    const placeholders = container.querySelectorAll(".notify-target-placeholder");
    if (!placeholders.length) return;

    // データ取得（並行）
    const [ns, sl] = await Promise.all([fetchNotifSettings(), fetchStaffList()]);
    const subOwners = sl.filter(s => s.isSubOwner);

    // subOwner系フィールドのフォールバック判定用
    const SUB_OWNER_FIELDS = ["subOwnerLine", "subOwnerEmail", "discordSubOwner"];

    placeholders.forEach(ph => {
      const field = ph.dataset.field;
      let badgeHtml = "";

      if (field === "staffLine" || field === "staffEmail") {
        // スタッフ一覧表示のみ（編集なし）
        const summary = resolveStaffSummary(field, sl);
        badgeHtml = renderStaffSummaryBadge(field, summary);
      } else if (SUB_OWNER_FIELDS.includes(field)) {
        // subOwner系: フォールバック情報を付与して表示
        const resolved = resolveSubOwnerValues(field, sl);
        if (!resolved.length) {
          badgeHtml = renderValueBadge(field, "", true, false);
        } else {
          // 複数サブオーナーがいる場合は最初の1件を代表表示（全件はモーダルで確認）
          const first = resolved[0];
          const hasFallback = resolved.some(r => r.isFallback);
          badgeHtml = renderValueBadge(field, first.value, true, hasFallback);
        }
      } else {
        // グローバルの現在値
        const value = resolveCurrentValue(field, ns, sl);
        badgeHtml = renderValueBadge(field, value, true, false);
      }

      ph.outerHTML = badgeHtml;
    });

    // ✏️ ボタンのクリックイベントをバインド
    container.querySelectorAll(".notify-target-edit-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const field = btn.dataset.field;

        // 最新データを取得
        clearCache();
        const [latestNs, latestSl] = await Promise.all([fetchNotifSettings(), fetchStaffList()]);
        const subOwners = latestSl.filter(s => s.isSubOwner);

        const isSubOwnerField = ["subOwnerLine", "subOwnerEmail", "discordSubOwner"].includes(field);
        const currentValue = isSubOwnerField
          ? null // subOwner の場合は下で組み立て
          : resolveCurrentValue(field, latestNs, latestSl);

        // subOwner系: フォールバック情報込みで渡す
        const subOwnerData = isSubOwnerField
          ? resolveSubOwnerValues(field, latestSl)
          : null;

        openEditModal({
          field,
          currentValue,
          subOwners: subOwnerData,
          onSaved: async () => {
            // バッジを再描画するためキャッシュ破棄して再実行
            clearCache();
            if (typeof onSaved === "function") onSaved();
            // コンテナ内のプレースホルダーを仮置きして再 hydrate
            container.querySelectorAll(".notify-target-inline").forEach(span => {
              const f = span.dataset.field;
              span.className = "notify-target-inline notify-target-placeholder";
              span.innerHTML = "";
              span.dataset.field = f;
            });
            await hydrateBadges(container, onSaved);
          },
        });
      });
    });
  }

  // ========== ユーティリティ ==========

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function truncate(s, n) {
    return String(s || "").length > n ? String(s).slice(0, n) + "…" : String(s || "");
  }

  // ========== 公開 ==========
  global.NotifyTargetEditor = {
    renderTargetRow,
    hydrateBadges,
    resolveCurrentValue,
    resolveSubOwnerValues,
    resolveStaffSummary,
    renderValueBadge,
    renderStaffSummaryBadge,
    clearCache,
  };
})(window);
