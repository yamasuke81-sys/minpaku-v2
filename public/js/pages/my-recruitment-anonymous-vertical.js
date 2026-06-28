/**
 * 【テスト】匿名カレンダー（縦版）
 * my-recruitment-vertical.js の MyRecruitmentPageVertical を継承し、
 * renderCalendar() のみオーバーライドする。
 *
 * 通常の縦カレンダーとの違い:
 *  - スタッフ個人の回答列を撤廃 — 誰が何を答えたかは一切表示しない
 *  - 各募集セルに「●(まる) ▲(さんかく) ✖(ばつ) −(未回答)」の集計のみ表示
 *  - 集計の母数(登録スタッフ総数) = その物件の担当スタッフ(担当未設定スタッフ含む、オーナー除外)
 *  - セルをタップすると「自分の回答」入力のみ可能(他人の回答は見えない)
 *
 * detach() / スクロール・リサイズ・矢印などの土台は親(縦版)を流用する。
 */
const MyRecruitmentPageAnonymousVertical = Object.assign(Object.create(MyRecruitmentPageVertical), {

  // detach は縦版の実装を流用せず自前で持つ。
  // 縦版 detach は Object.getPrototypeOf(this).detach で親を辿るが、
  // 本ページは縦版を継承するため this が常に本ページ → getPrototypeOf(this) が
  // 縦版を指し続けて無限再帰する。そこで祖父(MyRecruitmentPage.detach)を明示的に呼ぶ。
  detach() {
    if (typeof MyRecruitmentPage.detach === "function") MyRecruitmentPage.detach.call(this);
    const container = document.getElementById("myCalContainer");
    if (container) {
      container.classList.remove("v-mode");
      ["position", "top", "max-height", "overflow-y", "overflow-x"].forEach(p => {
        container.style.removeProperty(p);
      });
      container.style.removeProperty("--v-thead-h");
    }
    document.getElementById("myCalVerticalStyle")?.remove();
    document.getElementById("myCalVEdgePrev")?.remove();
    document.getElementById("myCalVEdgeNext")?.remove();
    document.querySelectorAll(".v-toolbar").forEach(el => el.remove());
    const fb = document.getElementById("myCalFloatingMonth");
    if (fb) fb.style.removeProperty("display");
    const ep = document.getElementById("myCalEdgePrev");
    if (ep) ep.style.removeProperty("display");
    const en = document.getElementById("myCalEdgeNext");
    if (en) en.style.removeProperty("display");
  },

  // 集計の母数となる「その物件の担当スタッフ」を返す。
  //  - オーナーは母数から除外
  //  - 担当物件(assignedPropertyIds)に当該物件を含むスタッフ
  //  - 担当未設定(空配列)のスタッフは全物件対応とみなし含める(既存スタッフ画面と同じ集合)
  _anonEligibleStaff(pid) {
    const list = Array.isArray(this.staffList) ? this.staffList : [];
    return list.filter(s => {
      if (s.isOwner) return false;
      if (s.active === false) return false;
      const a = Array.isArray(s.assignedPropertyIds) ? s.assignedPropertyIds : [];
      return a.includes(pid) || a.length === 0;
    });
  },

  // ログイン中スタッフ自身の回答を返す。'◎'|'△'|'×'|'未回答'
  _anonMyResponse(recruit) {
    const responses = Array.isArray(recruit.responses) ? recruit.responses : [];
    const myId = this.staffId;
    const myName = this.staffDoc?.name;
    const myEmail = (this.staffDoc?.email || "").toLowerCase();
    for (const r of responses) {
      if (r.staffId && myId && r.staffId === myId) return r.response || "未回答";
      if (r.staffName && myName && r.staffName === myName) return r.response || "未回答";
      if (r.staffEmail && myEmail && r.staffEmail.toLowerCase() === myEmail) return r.response || "未回答";
    }
    return "未回答";
  },

  // 募集の回答を集計する。返り値: { maru, sankaku, batsu, mikaito, total }
  _anonTally(recruit, pid) {
    const eligible = this._anonEligibleStaff(pid);
    const counts = { maru: 0, sankaku: 0, batsu: 0, mikaito: 0, total: eligible.length };
    const responses = Array.isArray(recruit.responses) ? recruit.responses : [];
    for (const s of eligible) {
      const sEmail = (s.email || "").toLowerCase();
      let resp = "未回答";
      for (const r of responses) {
        const idM = r.staffId && s.id && r.staffId === s.id;
        const nameM = r.staffName && s.name && r.staffName === s.name;
        const emailM = r.staffEmail && sEmail && r.staffEmail.toLowerCase() === sEmail;
        if (idM || nameM || emailM) { resp = r.response || "未回答"; break; }
      }
      if (resp === "◎") counts.maru++;
      else if (resp === "△") counts.sankaku++;
      else if (resp === "×") counts.batsu++;
      else counts.mikaito++;
    }
    return counts;
  },

  // 自分の回答だけを入力するモーダルを開く(responseModal を流用)。
  // 他スタッフの回答は一切表示しない。
  _openSelfRespond(recruit, dateStr, propName) {
    if (this._isInactive) {
      showToast("非アクティブ", this.staffDoc?.inactiveReason || "直近15回の清掃募集について回答がなかったため、非アクティブとなりました。解除する場合はWebアプリ管理者までご連絡ください。", "warning");
      return;
    }
    if (!recruit) return;
    if (recruit.status === "スタッフ確定済み") {
      showToast("確定済み", "この募集は確定済みのため回答できません。", "info");
      return;
    }
    this._pendingRecruitId = recruit.id;
    this._pendingDate = dateStr;
    this._pendingStaffId = this.staffId;
    this._pendingStaffName = this.staffDoc?.name;
    this._pendingStaffEmail = this.staffDoc?.email;
    this._pendingIsMe = true;
    const pName = propName || recruit.propertyName || "";
    const titleEl = document.getElementById("responseModalTitle");
    const infoEl = document.getElementById("responseModalInfo");
    if (titleEl) titleEl.textContent = `${this.fmtDate(dateStr)} ${pName} 回答`;
    if (infoEl) infoEl.textContent = pName ? `${this.fmtDate(dateStr)} / ${pName}` : this.fmtDate(dateStr);
    document.getElementById("triangleReasonArea")?.classList.add("d-none");
    const tr = document.getElementById("triangleReason");
    if (tr) tr.value = "";

    // 既存回答があれば「取消」ボタンを表示
    const pendingEmail = (this._pendingStaffEmail || "").toLowerCase();
    const existing = (recruit.responses || []).find(r => {
      if (r.staffId && this._pendingStaffId && r.staffId === this._pendingStaffId) return true;
      if (r.staffName && this._pendingStaffName && r.staffName === this._pendingStaffName) return true;
      if (r.staffEmail && pendingEmail && r.staffEmail.toLowerCase() === pendingEmail) return true;
      return false;
    });
    let cancelBtn = document.getElementById("btnCancelMyResponse");
    if (!cancelBtn) {
      const body = document.querySelector("#responseModal .modal-body");
      if (body) {
        body.insertAdjacentHTML("beforeend", `
          <div class="text-center mt-2"><button type="button" id="btnCancelMyResponse" class="btn btn-outline-secondary btn-sm">回答を取消（未回答に戻す）</button></div>
        `);
        cancelBtn = document.getElementById("btnCancelMyResponse");
        cancelBtn.addEventListener("click", () => this.cancelMyResponse());
      }
    }
    if (cancelBtn) cancelBtn.parentElement.style.display = existing ? "" : "none";

    // 匿名画面では Webアプリ管理者操作ブロックは隠す(回答者名が見える経路を遮断)
    const ownerWrap = document.getElementById("ownerOpsFromResponseWrap");
    if (ownerWrap) ownerWrap.style.display = "none";

    new bootstrap.Modal(document.getElementById("responseModal")).show();
  },

  // 匿名版の募集詳細モーダルを開く。
  // RecruitmentPage.openDetailModal に anonymous フラグを渡し、回答者の個人名を伏せたまま
  // 募集情報・集計・自分の回答(◎/△/×)を表示する。集計値はカレンダーのセルと一致させるため
  // 算出済み tally を anonymousTally で渡す(母数=その物件の担当スタッフ)。
  async _openAnonDetail(recruit) {
    if (this._isInactive) {
      showToast("非アクティブ", this.staffDoc?.inactiveReason || "直近15回の清掃募集について回答がなかったため、非アクティブとなりました。解除する場合はWebアプリ管理者までご連絡ください。", "warning");
      return;
    }
    if (!recruit || typeof RecruitmentPage === "undefined" || !RecruitmentPage.openDetailModal) return;
    // RecruitmentPage 側が参照するデータを供給
    if (Array.isArray(this.staffList) && this.staffList.length) RecruitmentPage.staffList = this.staffList;
    if (Array.isArray(this.recruitments) && this.recruitments.length) RecruitmentPage.recruitments = this.recruitments;
    if (Array.isArray(this.minpakuProperties) && this.minpakuProperties.length) RecruitmentPage.properties = this.minpakuProperties;
    const tally = this._anonTally(recruit, recruit.propertyId);
    try {
      if (typeof RecruitmentPage.ensureLoaded === "function") await RecruitmentPage.ensureLoaded();
      RecruitmentPage.openDetailModal(recruit, {
        viewMode: "staff",
        anonymous: true,
        anonymousTally: tally,
      });
    } catch (e) {
      showToast("エラー", e.message || String(e), "error");
    }
  },

  renderCalendar() {
    // 管理者(オーナー)・物件オーナーは従来どおり個人別の回答状況を見る → 縦版描画に委譲。
    // 匿名集計はスタッフ閲覧時のみ適用する。
    if (this.isOwnerView) {
      return MyRecruitmentPageVertical.renderCalendar.call(this);
    }

    const container = document.getElementById("myCalContainer");
    if (!container) return;
    // 縦版マーカー: CSS を .v-mode でスコープ限定するため(親の縦版CSSを流用)
    container.classList.add("v-mode");

    // 再描画前のスクロール位置を保持
    const prevScrollTop = container.scrollTop;

    const ym = (this._calMonth || "").split("-");
    const year = parseInt(ym[0]) || new Date().getFullYear();
    const month = parseInt(ym[1]) || (new Date().getMonth() + 1);
    const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
    const todayStr = new Date().toLocaleDateString("sv-SE");

    // ===== データ準備 (縦版と共通) =====
    const months = [];
    for (let mi = -1; mi <= 1; mi++) {
      const mDate = new Date(year, month - 1 + mi, 1);
      months.push({
        year: mDate.getFullYear(),
        month: mDate.getMonth() + 1,
        days: new Date(mDate.getFullYear(), mDate.getMonth() + 1, 0).getDate(),
      });
    }

    const allDates = [];
    months.forEach(m => {
      for (let d = 1; d <= m.days; d++) {
        allDates.push({
          year: m.year, month: m.month, day: d,
          dateStr: `${m.year}-${String(m.month).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
          isCurrent: m.month === month && m.year === year,
        });
      }
    });

    // 募集マップ (物件別)
    const recruitByPropDate = {};
    this.recruitments.forEach(r => {
      const s = String(r.status || "");
      if (["キャンセル", "キャンセル済み", "期限切れ", "cancelled"].includes(s)) return;
      const d = r.checkoutDate;
      if (!d) return;
      const pid = r.propertyId || "";
      if (pid) {
        (recruitByPropDate[pid] = recruitByPropDate[pid] || {})[d] = r;
      }
    });

    // 予約ソース別の色
    const bookingColor = (bOrSrc, fallback) => {
      const b = (bOrSrc && typeof bOrSrc === "object") ? bOrSrc : null;
      const haystack = b
        ? `${b.source || ""} ${b.bookingSite || ""} ${b.guestName || ""} ${b.notes || ""}`.toLowerCase()
        : String(bOrSrc || "").toLowerCase();
      if (haystack.includes("airbnb")) return "#ff5a5f";
      if (haystack.includes("booking")) return "#003580";
      return fallback;
    };
    const bookingDisplayColor = (b, fallback) => {
      if (b && typeof b === "object") {
        const s = String(b.status || "").toLowerCase();
        if (s.includes("cancel") || b.status === "キャンセル" || b.status === "キャンセル済み") {
          return "#9aa0a6";
        }
        if (b.pendingApproval === true) {
          return "#ffc107";
        }
      }
      return bookingColor(b, fallback);
    };
    const bookingBarDecor = (b) => {
      if (!b || typeof b !== "object") return "";
      const s = String(b.status || "").toLowerCase();
      if (s.includes("cancel") || b.status === "キャンセル" || b.status === "キャンセル済み") {
        return "opacity:0.6;background-image:linear-gradient(to right, transparent calc(50% - 1px), rgba(0,0,0,0.55) calc(50% - 1px), rgba(0,0,0,0.55) calc(50% + 1px), transparent calc(50% + 1px));";
      }
      if (b.pendingApproval === true) {
        return "background-image:repeating-linear-gradient(45deg, rgba(255,255,255,0.45) 0 6px, transparent 6px 12px);";
      }
      if (b.unverified === true) {
        return "border-left:1.5px dashed #fb8500;border-right:1.5px dashed #fb8500;box-sizing:border-box;";
      }
      return "";
    };

    // 担当物件フィルタ
    const myAssigned = Array.isArray(this.staffDoc?.assignedPropertyIds)
      ? this.staffDoc.assignedPropertyIds
      : [];
    const displayProperties = this.isOwnerView
      ? this.minpakuProperties
      : this.minpakuProperties.filter(p => myAssigned.includes(p.id));

    const hiddenProps = displayProperties.filter(p => this._propertyVisibility[p.id] === false);
    const visibleProps = displayProperties.filter(p => this._propertyVisibility[p.id] !== false);

    // ===== レイアウト定数 =====
    const stickyWN = 44;
    const stickyW = stickyWN + "px";
    this._rowH = 44;
    const rowHN = this._rowH;
    const rowH = rowHN + "px";
    const HEADER_H_KEY = "myCalVHeaderH_v3";
    if (this._headerH === undefined) {
      try {
        const v = parseInt(localStorage.getItem(HEADER_H_KEY), 10);
        this._headerH = (isFinite(v) && v >= 20 && v <= 500) ? v : 200;
      } catch (_) { this._headerH = 200; }
    }
    const monthRowH = "22px";
    const propColW = "32px";   // 宿泊バー列
    const aggColW = "210px";   // 集計列(清/直 + 自分 + ✓確定 + 集計 を左寄せ横一列に並べる幅)

    const isOwner = this.isOwnerView === true;

    // 回答シンボル→色
    const respColor = (resp) => {
      if (resp === "◎") return "#198754";
      if (resp === "△") return "#cc9a06";
      if (resp === "×") return "#dc3545";
      return "#6c757d";
    };

    // 募集ステータス→色(集計セルの左帯)
    const statusColorOf = (r) => {
      const isPre = r.workType === "pre_inspection";
      if (isPre) {
        if (r.status === "スタッフ確定済み") return "#7c3aed";
        return "#a78bfa";
      }
      if (r.status === "スタッフ確定済み") return "#198754";
      if (r.status === "選定済") return "#ffc107";
      if (r.status === "募集中") return "#fd7e14";
      return "#adb5bd";
    };

    // ===== CSS注入 (親の縦版CSSと共有) =====
    const STYLE_VER = "v34";
    if (container._verticalStyleVer !== STYLE_VER) {
      container._verticalStyleVer = STYLE_VER;
      const oldStyle = document.getElementById("myCalVerticalStyle");
      if (oldStyle) oldStyle.remove();
      const styleEl = document.createElement("style");
      styleEl.id = "myCalVerticalStyle";
      styleEl.textContent = `
        #myCalContainer.v-mode { --v-thead-h: 200px; }
        #myCalContainer.v-mode table { border-collapse:separate; border-spacing:0; }
        #myCalContainer.v-mode table td, #myCalContainer.v-mode table th { border:0; background-clip:padding-box; }
        #myCalContainer.v-mode .row-hover { box-shadow: inset 0 0 0 9999px rgba(13,110,253,0.07); }
        #myCalContainer.v-mode .sticky-col { border-right:2px solid #dee2e6; }
        #myCalContainer.v-mode td.prop-block-end, #myCalContainer.v-mode th.prop-block-end { border-right:1px solid #dee2e6; }
        #myCalContainer.v-mode tbody tr > th[data-cal-date], #myCalContainer.v-mode tbody tr > td.v-date-cell { border-top:1px solid #e9ecef; }
        #myCalContainer.v-mode tbody tr[data-row-date] > td,
        #myCalContainer.v-mode tbody tr[data-row-date] > th { border-bottom: 1px solid #eef0f2; }
        #myCalContainer.v-mode tr.month-section > td { border-top:2px solid #adb5bd; border-bottom:2px solid #adb5bd; }
        #myCalContainer.v-mode thead th { border-right: 1px solid #e9ecef; }
        #myCalContainer.v-mode tbody td { border-right: 1px solid #f1f3f5; }
        #myCalContainer.v-mode th.prop-block-end,
        #myCalContainer.v-mode td.prop-block-end { border-right: 1px solid #dee2e6 !important; }
        #myCalContainer.v-mode thead th.sticky-col { border-right: 2px solid #dee2e6; }
        #myCalContainer.v-mode thead th {
          position: sticky !important; top: 0 !important; z-index: 50;
          background: #ffffff;
          vertical-align: top;
          height: var(--v-thead-h) !important;
          max-height: var(--v-thead-h) !important;
          min-height: 0 !important;
          overflow: hidden !important;
          box-sizing: border-box;
          background-clip: padding-box;
        }
        #myCalContainer.v-mode thead th.sticky-col { z-index: 60; vertical-align: middle; background: #f8f9fa; }
        #myCalContainer.v-mode .header-resizer { opacity: 0.7; transition: opacity 0.15s; }
        #myCalContainer.v-mode .header-resizer:hover, #myCalContainer.v-mode .header-resizer:active { opacity: 1; }
        #myCalContainer.v-mode .v-text-block {
          overflow: hidden;
          text-align: center;
          padding: 0 1px;
        }
        #myCalContainer.v-mode thead th > div {
          height: 100%;
          max-height: 100%;
          overflow: hidden;
          justify-content: flex-start;
          min-height: 0;
        }
        #myCalContainer.v-mode thead th .badge,
        #myCalContainer.v-mode thead th .prop-toggle { flex-shrink: 0; }
      `;
      document.head.appendChild(styleEl);
    }

    // ===== ツールバー HTML(スタッフ個人フィルタは撤廃、集計凡例を表示) =====
    const isSubOwnerContext = this._viewMode === "owner" &&
      (this._isSubOwnerView || (typeof App !== "undefined" && App.impersonating && App.impersonatingData));
    const active_propFilter = this._propFilter === "myProp";
    const myPropFilterBtn = isSubOwnerContext
      ? `<button type="button" id="btnPropMyOnly" style="border:1px solid ${active_propFilter ? '#0d6efd' : '#ced4da'};background:${active_propFilter ? '#0d6efd' : '#fff'};color:${active_propFilter ? '#fff' : '#495057'};border-radius:4px;padding:2px 10px;font-size:12px;font-weight:600;cursor:pointer;">${active_propFilter ? '✓ ' : ''}自物件だけ <i class="bi bi-house-door"></i></button>`
      : "";
    const restoreButtons = hiddenProps.length
      ? hiddenProps.map(p => `<button type="button" class="prop-restore" data-prop-id="${p.id}" title="${this.esc(p.name)} を再表示" style="border:1px solid #ced4da;background:#fff;border-radius:4px;padding:2px 6px;font-size:12px;cursor:pointer;"><span class="badge" style="background:${p._color};color:#fff;">${p._num}</span> <i class="bi bi-eye text-muted"></i></button>`).join("")
      : "";

    const legendHtml = `
      <span class="ms-2" style="font-weight:600;"><i class="bi bi-bar-chart"></i> 人数:</span>
      <span style="color:#198754;font-weight:700;">●可</span>
      <span style="color:#cc9a06;font-weight:700;">▲条件付</span>
      <span style="color:#dc3545;font-weight:700;">✖不可</span>
      <span style="color:#6c757d;font-weight:700;">未=未回答</span>
      <span style="background:#eef3ff;border:1px solid #b6ccff;border-radius:3px;padding:0 4px;font-size:11px;font-weight:700;">自分=あなたの回答</span>
      <span class="text-muted" style="font-size:11px;">(他の人が誰かは表示されません)</span>`;

    const toolbarHtml = `<div class="v-toolbar d-flex flex-wrap gap-2 align-items-center mb-2 px-2 py-1" style="position:sticky;top:0;z-index:200;font-size:12px;background:#eef5ff;border:1px solid #cfe2ff;border-radius:4px;box-shadow:0 2px 4px rgba(0,0,0,0.06);">
      <span><i class="bi bi-building"></i> 物件:</span>
      ${myPropFilterBtn}
      ${hiddenProps.length ? `<span class="text-muted" style="font-weight:normal;font-size:11px;">非表示${hiddenProps.length}件:</span>${restoreButtons}` : `<small class="text-muted">(目アイコンで表示切替)</small>`}
      ${legendHtml}
    </div>`;

    // ===== テーブルヘッダー構築 =====
    // 全列数 = 1(日付) + visibleProps * 2(宿泊 + 集計)
    const totalCols = 1 + visibleProps.length * 2;

    let html = `<table style="font-size:13px;white-space:nowrap;border-collapse:separate;border-spacing:0;">`;
    html += `<thead>`;
    html += `<tr>`;
    html += `<th rowspan="2" class="text-center sticky-col" style="position:sticky;left:0;top:0;z-index:15;background:#f8f9fa;min-width:${stickyW};max-width:${stickyW};vertical-align:middle;padding:4px 6px;font-size:13px;font-weight:600;">
      日付
      <div class="header-resizer" title="ドラッグで宿名行の高さを変更" style="position:absolute;bottom:0;left:0;right:0;height:10px;cursor:row-resize;z-index:5;user-select:none;background:repeating-linear-gradient(to right, rgba(13,110,253,0.5) 0 6px, transparent 6px 12px);touch-action:none;"></div>
    </th>`;

    // 手動縦書き(1文字ずつ div に)
    const verticalText = (text, fontSize) => {
      const alnumFontSize = Math.round(fontSize * 0.85);
      const alnumDivH = Math.round(fontSize * 0.75);
      const chars = String(text).split('');
      const items = chars.map(ch => {
        if (ch === ' ' || ch === '　') return `<div style="height:3px;flex-shrink:0;"></div>`;
        const isAlnum = /[A-Za-z0-9]/.test(ch);
        if (isAlnum) {
          return `<div style="height:${alnumDivH}px;display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:visible;"><span style="display:inline-block;transform:rotate(90deg);transform-origin:center;font-size:${alnumFontSize}px;line-height:1;font-family:Arial,sans-serif;letter-spacing:0;">${this.esc(ch)}</span></div>`;
        }
        return `<div style="height:${fontSize}px;line-height:${fontSize}px;font-size:${fontSize}px;text-align:center;flex-shrink:0;">${this.esc(ch)}</div>`;
      });
      return items.join('');
    };

    // 物件ヘッダ (rowspan=2 colspan=2: 宿泊列 + 集計列)
    visibleProps.forEach((p, i) => {
      const isLast = i === visibleProps.length - 1;
      html += `<th rowspan="2" colspan="2" class="text-center${isLast ? " prop-block-end" : ""}" style="background:#ffffff !important;border-top:4px solid ${p._color};padding:3px 1px 0;font-size:12px;font-weight:600;overflow:hidden;">
        <div style="display:flex;flex-direction:column;align-items:center;height:100%;width:100%;">
          <div style="display:flex;align-items:center;justify-content:center;gap:2px;flex-shrink:0;height:18px;">
            <button type="button" class="prop-toggle" data-prop-id="${p.id}" title="非表示にする" style="padding:0 2px;border:1px solid #ced4da;background:#fff;border-radius:3px;cursor:pointer;line-height:1;height:14px;"><i class="bi bi-eye" style="color:#6c757d;font-size:9px;"></i></button>
            <span class="badge" style="background:${p._color};color:#fff;font-size:9px;padding:1px 4px;line-height:1.2;">${p._num}</span>
          </div>
          <div class="v-text-block" style="flex:1 1 0;min-height:0;overflow:hidden;font-weight:600;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;width:100%;">${verticalText(p.name, 12)}</div>
        </div>
      </th>`;
    });

    html += `</tr>`;
    html += `</thead><tbody>`;

    // ===== tbody: 月境界 + 日付行 =====
    const rangeStart = allDates[0].dateStr;
    const rangeEnd = allDates[allDates.length - 1].dateStr;

    const isCancelled = (b) => {
      const s = String(b.status || "").toLowerCase();
      return s.includes("cancel") || b.status === "キャンセル" || b.status === "キャンセル済み";
    };
    const isPlaceholder = (n) => {
      const s = String(n || "").toLowerCase().trim();
      return !s || /^(reserved|not available|airbnb|booking|airbnb予約|booking\.com予約|\(no name\))/i.test(s);
    };

    let prevMonthKey = null;
    allDates.forEach(dd => {
      const monthKey = `${dd.year}-${dd.month}`;
      if (monthKey !== prevMonthKey) {
        prevMonthKey = monthKey;
        const isCurMonth = dd.month === month && dd.year === year;
        html += `<tr class="month-section"><td colspan="${totalCols}" style="background:${isCurMonth ? '#dde6f9' : '#e9ecef'};text-align:center;font-weight:bold;font-size:13px;padding:3px;height:${monthRowH};">${dd.year}年${dd.month}月</td></tr>`;
      }

      const dow = new Date(dd.year, dd.month - 1, dd.day).getDay();
      const isToday = dd.dateStr === todayStr;
      const dowColor = dow === 0 ? "#dc3545" : (dow === 6 ? "#0d6efd" : "#333");
      const dateBg = isToday ? "#e8f0fe" : (!dd.isCurrent ? "#e9ecef" : "#f8f9fa");

      html += `<tr data-row-date="${dd.dateStr}">`;

      // 日付セル (sticky左列)
      html += `<th class="sticky-col v-date-cell" data-cal-date="${dd.dateStr}" data-col-date="${dd.dateStr}" style="position:sticky;left:0;z-index:10;background:${dateBg};min-width:${stickyW};max-width:${stickyW};height:${rowH};padding:2px 6px;vertical-align:middle;font-size:12px;">
        <span style="font-weight:600;">${dd.day}</span> <span style="color:${dowColor};font-size:11px;">${dayNames[dow]}</span>
      </th>`;

      // ===== 物件列 (宿泊バー + 集計) =====
      visibleProps.forEach((p, pi) => {
        const isLastProp = pi === visibleProps.length - 1;
        const propBookings = this.bookings.filter(b =>
          b.propertyId === p.id && b.checkIn && b.checkOut &&
          b.checkIn <= rangeEnd && b.checkOut >= rangeStart
        );
        const fallbackColor = p._color || "#0d6efd";
        const d = dd.dateStr;
        const isHdToday = isToday;
        const tdBg = isHdToday ? "#e8f0fe" : (!dd.isCurrent ? "#e9ecef" : "#fff");

        // 予約セグメント計算
        let aStart = null, aEnd = null, aMid = null;
        for (const b of propBookings) {
          if (isCancelled(b)) continue;
          if (b.checkIn === d) aStart = b;
          else if (b.checkOut === d) aEnd = b;
          else if (b.checkIn < d && d < b.checkOut) aMid = b;
        }
        const leftOcc = !!aEnd || !!aMid;
        const rightOcc = !!aStart || !!aMid;
        let cStart = null, cEnd = null, cMid = null;
        for (const b of propBookings) {
          if (!isCancelled(b)) continue;
          if (b.checkIn === d) { if (!rightOcc) cStart = b; }
          else if (b.checkOut === d) { if (!leftOcc) cEnd = b; }
          else if (b.checkIn < d && d < b.checkOut) { if (!leftOcc && !rightOcc) cMid = b; }
        }
        const starting = aStart || cStart;
        const ending = aEnd || cEnd;
        const middle = aMid || cMid;

        let segs = "";
        const barStyle = "position:absolute;left:4px;right:4px;pointer-events:none;z-index:8;";
        if (ending) {
          const c = bookingDisplayColor(ending, fallbackColor);
          const dec = bookingBarDecor(ending);
          segs += `<div style="${barStyle}top:-1px;bottom:50%;background:${c};${dec}border-bottom-left-radius:999px;border-bottom-right-radius:999px;"></div>`;
        }
        if (middle) {
          const c = bookingDisplayColor(middle, fallbackColor);
          const dec = bookingBarDecor(middle);
          segs += `<div style="${barStyle}top:-1px;bottom:-1px;background:${c};${dec}"></div>`;
        }
        if (starting) {
          const c = bookingDisplayColor(starting, fallbackColor);
          const dec = bookingBarDecor(starting);
          segs += `<div style="${barStyle}top:50%;bottom:-1px;background:${c};${dec}border-top-left-radius:999px;border-top-right-radius:999px;"></div>`;

          let hasGuest = false;
          if (!isPlaceholder(starting.guestName)) {
            const key = starting.propertyId
              ? `${starting.propertyId}_${starting.checkIn}`
              : starting.checkIn;
            const g = this.guestMap[key];
            if (g && !isPlaceholder(g.guestName)) {
              if (!g.bookingId || g.bookingId === starting.id) hasGuest = true;
            }
          }
          const dotColor = hasGuest ? "#198754" : "#dc3545";
          const dotTitle = hasGuest ? "名簿提出済み" : "名簿未提出";
          segs += `<span style="position:absolute;left:50%;top:calc(50% + 4px);transform:translateX(-50%);width:8px;height:8px;border-radius:50%;background:${dotColor};border:1.5px solid #fff;z-index:10;pointer-events:none;" title="${dotTitle}"></span>`;
        }

        // 人数ラベル(縦書き)
        let labelHtml = "";
        const vLabelStyle = "position:absolute;left:50%;transform:translateX(-50%);color:#fff;font-size:10px;font-weight:700;z-index:9;pointer-events:none;writing-mode:vertical-rl;-webkit-writing-mode:vertical-rl;text-orientation:mixed;-webkit-text-orientation:mixed;line-height:1;letter-spacing:0;";
        if (middle) {
          const ciNext = new Date(middle.checkIn + "T00:00:00");
          ciNext.setDate(ciNext.getDate() + 1);
          if (d === ciNext.toLocaleDateString("sv-SE")) {
            const cnt = middle.guestCount > 0 ? `${middle.guestCount}名` : "";
            if (cnt) labelHtml = `<span style="${vLabelStyle}top:0;height:100%;display:flex;align-items:center;">${cnt}</span>`;
          }
        } else if (starting) {
          const coD = new Date(starting.checkOut + "T00:00:00");
          const ciD = new Date(starting.checkIn + "T00:00:00");
          const n = Math.round((coD - ciD) / 86400000);
          if (n === 1) {
            const cnt = starting.guestCount > 0 ? `${starting.guestCount}名` : "";
            if (cnt) labelHtml = `<span style="${vLabelStyle}top:100%;transform:translate(-50%,-50%);display:flex;align-items:center;justify-content:center;height:${Math.round(rowHN * 0.8)}px;">${cnt}</span>`;
          }
        }

        const ref = starting || middle || ending;
        const clickAttr = ref ? ` class="cal-date-hd" data-cal-date="${ref.checkIn}" data-booking-id="${this.esc(ref.id)}"` : ` class=""`;
        const cursor = ref ? "cursor:pointer;" : "";
        html += `<td${clickAttr} data-col-date="${dd.dateStr}" style="position:relative;height:${rowH};background:${tdBg};padding:0;overflow:visible;min-width:${propColW};max-width:${propColW};${cursor}">${segs}${labelHtml}</td>`;

        // ===== 集計列 (旧 清掃pill 列) =====
        const recruitByD = recruitByPropDate[p.id] || {};
        const r = recruitByD[dd.dateStr];
        const cellBg = isHdToday ? "#e8f0fe" : (!dd.isCurrent ? "#e9ecef" : "#fff");
        if (r) {
          const t = this._anonTally(r, p.id);
          const sc = statusColorOf(r);
          const wt = r.workType === "pre_inspection" ? "直前点検" : "清掃";
          const wtChar = r.workType === "pre_inspection" ? "直" : "清";
          const answered = t.maru + t.sankaku + t.batsu;
          const cellTitle = `${wt}・${r.status || ""}（回答 ${answered}/${t.total}名 ・ 未回答 ${t.mikaito}名）`;
          // 清/直 ピル(文字入り。黄/薄紫は文字を濃色に)
          const pillText = (sc === "#ffc107" || sc === "#a78bfa" || sc === "#c4b5fd") ? "#333" : "#fff";
          const pill = `<span title="${this.esc(wt)}" style="display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 3px;background:${sc};color:${pillText};border-radius:3px;font-weight:700;font-size:10px;line-height:1;">${wtChar}</span>`;
          // 自分の回答(ハイライト表示)
          const myResp = this._anonMyResponse(r);
          const myLabel = myResp === "未回答" ? "未回答" : myResp;
          // 自分が選定/確定されているか(匿名化前の縦版と同じ判定)。確定ならセルを青で塗りつぶす。
          let myConfirmed = false;
          const selRaw = (r.selectedStaff || "").trim();
          if (selRaw && (r.status === "選定済" || r.status === "スタッフ確定済み")) {
            const selNames = selRaw.split(/[,、\s]+/).map(s => s.trim()).filter(Boolean);
            const selIds = Array.isArray(r.selectedStaffIds) ? r.selectedStaffIds : [];
            myConfirmed = (this.staffId && selIds.includes(this.staffId))
              || (this.staffDoc?.name && selNames.includes(this.staffDoc.name));
          }
          const isFinalized = r.status === "スタッフ確定済み";
          const confLabel = isFinalized ? "確定" : "選定";
          // 確定/選定セルは匿名化前と同じく青(#a7c7ff)で塗りつぶす
          const finalBg = myConfirmed ? "#a7c7ff" : cellBg;
          // 自分の回答チップ(回答記号は色付きのまま見やすく) + 確定/選定チップ(分離して併記)
          const myAnsChip = `<span title="あなたの回答" style="display:inline-flex;align-items:center;gap:3px;background:#fff;border:1px solid #b6ccff;border-radius:3px;padding:1px 5px;font-size:11px;font-weight:700;line-height:1.3;"><span style="font-size:9px;color:#5b7cc0;">自分</span><span style="color:${respColor(myResp)};font-size:12px;">${myLabel}</span></span>`;
          const confChip = myConfirmed
            ? `<span title="あなたは${confLabel}されています" style="display:inline-flex;align-items:center;gap:2px;background:#198754;color:#fff;border-radius:3px;padding:1px 6px;font-size:10px;font-weight:700;line-height:1.3;white-space:nowrap;">✓${confLabel}</span>`
            : "";
          const myBadge = myAnsChip + confChip;
          html += `<td class="anon-agg-cell${isLastProp ? " prop-block-end" : ""}" data-recruit-id="${this.esc(r.id)}" data-prop-id="${this.esc(p.id)}" data-prop-name="${this.esc(p.name || "")}" data-date="${dd.dateStr}" data-col-date="${dd.dateStr}" title="${this.esc(cellTitle)}" style="height:${rowH};background:${finalBg};padding:2px 6px;vertical-align:middle;cursor:pointer;min-width:${aggColW};max-width:${aggColW};overflow:hidden;">
            <div style="display:flex;flex-direction:row;align-items:center;justify-content:flex-start;gap:6px;line-height:1.1;white-space:nowrap;">
              ${pill}${myBadge}
              <span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;">
                <span style="color:#198754;">●${t.maru}</span>
                <span style="color:#cc9a06;">▲${t.sankaku}</span>
                <span style="color:#dc3545;">✖${t.batsu}</span>
                <span style="color:#6c757d;">未${t.mikaito}</span>
              </span>
            </div>
          </td>`;
        } else {
          html += `<td data-col-date="${dd.dateStr}" class="${isLastProp ? "prop-block-end" : ""}" style="height:${rowH};background:${cellBg};padding:0;min-width:${aggColW};max-width:${aggColW};"></td>`;
        }
      });

      html += `</tr>`;
    });

    html += `</tbody></table>`;

    // コンテナ更新 — toolbar は container の外に sticky:top:0 で貼り付ける
    container.innerHTML = html;
    document.querySelectorAll(".v-toolbar").forEach(el => el.remove());
    const tbWrap = document.createElement("div");
    tbWrap.innerHTML = toolbarHtml;
    const tbInner = tbWrap.firstElementChild;
    container.parentElement.insertBefore(tbInner, container);

    // ===== リスナバインド =====

    // 行 hover: 同じ日付の全セルをハイライト
    if (!container._rowHoverBound) {
      container._rowHoverBound = true;
      container.addEventListener("mouseover", (ev) => {
        const cell = ev.target.closest("[data-col-date]");
        const key = cell ? cell.dataset.colDate : null;
        if (container._lastHoverRow === key) return;
        container.querySelectorAll(".row-hover").forEach(el => el.classList.remove("row-hover"));
        if (key) {
          container.querySelectorAll(`[data-col-date="${key}"]`).forEach(el => el.classList.add("row-hover"));
        }
        container._lastHoverRow = key;
      });
      container.addEventListener("mouseleave", () => {
        container.querySelectorAll(".row-hover").forEach(el => el.classList.remove("row-hover"));
        container._lastHoverRow = null;
      });
    }

    // floating month バッジ / 横移動矢印は縦版では非表示
    const floatBadge = document.getElementById("myCalFloatingMonth");
    if (floatBadge) floatBadge.style.display = "none";
    const edgePrev = document.getElementById("myCalEdgePrev");
    const edgeNext = document.getElementById("myCalEdgeNext");
    if (edgePrev) edgePrev.style.display = "none";
    if (edgeNext) edgeNext.style.display = "none";

    // 縦版用の上下矢印
    const wrap = container.parentElement;
    if (wrap && getComputedStyle(wrap).position === "static") wrap.style.position = "relative";
    const ensureVerticalArrow = (id, side, icon, onClick) => {
      let btn = document.getElementById(id);
      if (!btn) {
        btn = document.createElement("button");
        btn.id = id;
        btn.type = "button";
        btn.innerHTML = `<i class="bi ${icon}"></i>`;
        btn.style.cssText = [
          "position:absolute",
          side === "top" ? "top:6px" : "bottom:6px",
          "right:12px",
          "z-index:25", "width:36px", "height:28px",
          "border:1px solid rgba(13,110,253,0.4)", "background:rgba(255,255,255,0.95)",
          "color:#0d6efd", "border-radius:14px", "font-size:14px",
          "display:none", "align-items:center", "justify-content:center",
          "cursor:pointer", "box-shadow:0 1px 4px rgba(0,0,0,0.15)",
        ].join(";");
        (wrap || container.parentElement || document.body).appendChild(btn);
        btn.addEventListener("click", onClick);
      } else {
        btn.style.display = "none";
      }
      return btn;
    };
    const btnVPrev = ensureVerticalArrow("myCalVEdgePrev", "top", "bi-chevron-up", () => {
      const [y, m] = (this._calMonth || "").split("-").map(Number);
      const dt = new Date(y, (m || 1) - 1 - 1, 1);
      this._calMonth = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0");
      const mi = document.getElementById("myCalMonth");
      if (mi) mi.value = this._calMonth;
      this._initialScrollDone = false;
      this.renderCalendar();
    });
    const btnVNext = ensureVerticalArrow("myCalVEdgeNext", "bottom", "bi-chevron-down", () => {
      const [y, m] = (this._calMonth || "").split("-").map(Number);
      const dt = new Date(y, (m || 1) - 1 + 1, 1);
      this._calMonth = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0");
      const mi = document.getElementById("myCalMonth");
      if (mi) mi.value = this._calMonth;
      this._initialScrollDone = false;
      this.renderCalendar();
    });

    const THRESHOLD = 5;
    const refreshVEdges = () => {
      const st = container.scrollTop;
      const max = container.scrollHeight - container.clientHeight;
      btnVPrev.style.display = (st <= THRESHOLD) ? "flex" : "none";
      btnVNext.style.display = (max > 0 && st >= max - THRESHOLD) ? "flex" : "none";
    };
    if (!container._vEdgeListenerBound) {
      container._vEdgeListenerBound = true;
      container.addEventListener("scroll", refreshVEdges, { passive: true });
      window.addEventListener("resize", refreshVEdges, { passive: true });
    }
    setTimeout(refreshVEdges, 100);
    setTimeout(refreshVEdges, 600);

    // ===== 行高リサイズ =====
    const applyRowH = (newH) => {
      container.querySelectorAll('tr[data-row-date]').forEach(tr => {
        tr.style.height = newH + 'px';
        tr.querySelectorAll('td, th').forEach(cell => { cell.style.height = newH + 'px'; });
      });
    };
    container.querySelectorAll('.row-resizer').forEach(handle => {
      if (handle.dataset.wired === "1") return;
      handle.dataset.wired = "1";
      const onStart = (startY) => {
        const startH = this._rowH || 28;
        const onMove = (y) => {
          const newH = Math.max(16, Math.min(80, startH + (y - startY)));
          this._rowH = newH;
          applyRowH(newH);
        };
        const mouseMove = (e) => onMove(e.clientY);
        const touchMove = (e) => {
          if (e.touches && e.touches[0]) { e.preventDefault(); onMove(e.touches[0].clientY); }
        };
        const end = () => {
          document.removeEventListener('mousemove', mouseMove);
          document.removeEventListener('mouseup', end);
          document.removeEventListener('touchmove', touchMove);
          document.removeEventListener('touchend', end);
          document.body.style.userSelect = '';
          try { localStorage.setItem('myCalRowH', String(this._rowH)); } catch (_) {}
        };
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', mouseMove);
        document.addEventListener('mouseup', end);
        document.addEventListener('touchmove', touchMove, { passive: false });
        document.addEventListener('touchend', end);
      };
      handle.addEventListener('mousedown', (e) => { e.preventDefault(); onStart(e.clientY); });
      handle.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches[0]) { e.preventDefault(); onStart(e.touches[0].clientY); }
      }, { passive: false });
    });

    // ===== 列名固定 + テーブル本体のみ縦スクロール =====
    container.style.setProperty("position", "sticky", "important");
    container.style.setProperty("overflow-y", "auto", "important");
    container.style.setProperty("overflow-x", "auto", "important");
    let parent = container.parentElement;
    while (parent && parent !== document.body) {
      if (parent.id === "pageContainer" || parent.classList?.contains("app-main")) {
        parent.style.setProperty("overflow", "visible", "important");
      }
      parent = parent.parentElement;
    }
    const updateContainerTop = () => {
      const tb = document.querySelector(".v-toolbar");
      let topPx = 0;
      if (tb) {
        topPx = Math.round(tb.getBoundingClientRect().height) + 4;
      }
      if (topPx < 30) topPx = 44;
      container.style.setProperty("top", topPx + "px", "important");
      container.style.setProperty("max-height", `calc(100vh - ${topPx + 10}px)`, "important");
    };
    updateContainerTop();
    setTimeout(updateContainerTop, 50);
    setTimeout(updateContainerTop, 300);
    if (!container._vTopBound) {
      container._vTopBound = true;
      window.addEventListener("resize", updateContainerTop, { passive: true });
    }

    // ===== ヘッダ高さ =====
    container.style.setProperty("--v-thead-h", (this._headerH || 170) + "px");
    container.querySelectorAll('.header-resizer').forEach(handle => {
      if (handle.dataset.wired === "1") return;
      handle.dataset.wired = "1";
      const onStart = (startY) => {
        const startH = this._headerH || 170;
        const onMove = (y) => {
          const newH = Math.max(20, Math.min(500, startH + (y - startY)));
          this._headerH = newH;
          container.style.setProperty("--v-thead-h", newH + "px");
        };
        const mouseMove = (e) => onMove(e.clientY);
        const touchMove = (e) => {
          if (e.touches && e.touches[0]) { e.preventDefault(); onMove(e.touches[0].clientY); }
        };
        const end = () => {
          document.removeEventListener('mousemove', mouseMove);
          document.removeEventListener('mouseup', end);
          document.removeEventListener('touchmove', touchMove);
          document.removeEventListener('touchend', end);
          document.body.style.userSelect = '';
          try { localStorage.setItem("myCalVHeaderH_v3", String(this._headerH)); } catch (_) {}
        };
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', mouseMove);
        document.addEventListener('mouseup', end);
        document.addEventListener('touchmove', touchMove, { passive: false });
        document.addEventListener('touchend', end);
      };
      handle.addEventListener('mousedown', (e) => { e.preventDefault(); onStart(e.clientY); });
      handle.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches[0]) { e.preventDefault(); onStart(e.touches[0].clientY); }
      }, { passive: false });
    });

    if (edgePrev && !edgePrev.dataset.wired) edgePrev.dataset.wired = "1";
    if (edgeNext && !edgeNext.dataset.wired) edgeNext.dataset.wired = "1";

    // キャンセル・保留中トグル (共通)
    const togC = document.getElementById("toggleShowCancelled");
    const togP = document.getElementById("toggleShowPending");
    if (togC && !togC._bound) {
      togC.checked = this._showCancelled !== false;
      togC._bound = true;
      togC.addEventListener("change", () => {
        this._showCancelled = togC.checked;
        this._saveSettings();
        this._refilterBookings();
      });
    } else if (togC) {
      togC.checked = this._showCancelled !== false;
    }
    if (togP && !togP._bound) {
      togP.checked = this._showPending !== false;
      togP._bound = true;
      togP.addEventListener("change", () => {
        this._showPending = togP.checked;
        this._saveSettings();
        this._refilterBookings();
      });
    } else if (togP) {
      togP.checked = this._showPending !== false;
    }

    // 「自物件だけ」ボタン
    document.getElementById("btnPropMyOnly")?.addEventListener("click", () => {
      if (this._propFilter === "myProp") {
        if (this._propertyVisibilityBackup) {
          this._propertyVisibility = { ...this._propertyVisibilityBackup };
        }
        this._propFilter = "all";
        this._propertyVisibilityBackup = null;
      } else {
        this._propertyVisibilityBackup = { ...(this._propertyVisibility || {}) };
        const ownedIds = (typeof App !== "undefined" && App.impersonating && App.impersonatingData)
          ? new Set(App.impersonatingData.ownedPropertyIds || [])
          : new Set(this._ownedPropertyIds || []);
        const newVis = {};
        this.minpakuProperties.forEach(p => { newVis[p.id] = ownedIds.has(p.id); });
        if (!Object.values(newVis).some(v => v)) return;
        this._propertyVisibility = newVis;
        this._propFilter = "myProp";
      }
      this._saveSettings();
      this.renderCalendar();
    });

    // 物件表示トグル (.prop-toggle は thead 内)
    container.querySelectorAll(".prop-toggle").forEach(btn => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const pid = btn.dataset.propId;
        this._propertyVisibility[pid] = !this._propertyVisibility[pid];
        this._saveSettings();
        this.renderCalendar();
      });
    });

    // 非表示物件の復旧ボタン
    document.querySelectorAll(".v-toolbar .prop-restore").forEach(btn => {
      btn.addEventListener("click", () => {
        const pid = btn.dataset.propId;
        this._propertyVisibility[pid] = true;
        this._saveSettings();
        this.renderCalendar();
      });
    });

    // 集計セルのタップ → 匿名版の募集詳細モーダル(他人の回答は見えない)
    if (!container._anonAggBound) {
      container._anonAggBound = true;
      container.addEventListener("click", (ev) => {
        const td = ev.target.closest(".anon-agg-cell");
        if (!td) return;
        ev.stopPropagation();
        const recruitId = td.dataset.recruitId;
        const recruit = this.recruitments.find(x => x.id === recruitId);
        if (!recruit) return;
        this._openAnonDetail(recruit);
      });
    }

    // 予約バーセルのクリック (cal-date-hd) → 予約詳細(回答者名は含まない)
    const isOwnerView = this.isOwnerView;
    container.querySelectorAll(".cal-date-hd").forEach(el => {
      el.addEventListener("click", () => {
        const bookingId = el.dataset.bookingId;
        if (!bookingId) return;
        const targetBooking = this.bookings.find(x => x.id === bookingId)
          || (this._rawBookings && this._rawBookings.find(x => x.id === bookingId))
          || null;
        if (!targetBooking) return;
        if (typeof DashboardPage !== "undefined" && DashboardPage.showBookingModal) {
          DashboardPage.showBookingModal(targetBooking, {
            bookings: this.bookings,
            recruitments: this.recruitments,
            guestMap: this.guestMap,
            properties: this.minpakuProperties || [],
            viewMode: isOwnerView ? "owner" : "staff",
            onGuestCountSaved: () => this.renderCalendar && this.renderCalendar(),
          });
        }
      });
    });

    // 自動スクロール: 今日へ (初回のみ)
    if (this._initialScrollDone) {
      container.scrollTop = prevScrollTop;
    } else {
      const todayRow = container.querySelector(`tr[data-row-date="${todayStr}"]`);
      if (todayRow) {
        const rowRect = todayRow.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const theadEl = container.querySelector("thead");
        const theadH = theadEl ? theadEl.getBoundingClientRect().height : 90;
        const delta = rowRect.top - containerRect.top - theadH - 10;
        container.scrollTop = Math.max(0, container.scrollTop + delta);
      }
      this._initialScrollDone = true;
    }

    // 要対応 / お知らせ描画 (親メソッドを流用)
    if (typeof this.renderToActions_ === "function") this.renderToActions_();
  },
});
