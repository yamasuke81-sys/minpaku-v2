/**
 * 縦版 予約・清掃スケジュールカレンダー
 * my-recruitment.js の MyRecruitmentPage を Object.create() で継承し、
 * renderCalendar() のみオーバーライドする。
 *
 * 横版との差異:
 *  - 縦軸 = 日付、横軸 = 物件(宿泊+清掃) + スタッフ
 *  - 予約バーは縦方向の半セル吸収(CI=下半, CO=上半, 中日=全体)
 *  - フローティング月バッジは縦スクロールで切替
 *  - 端到達ヒントも縦スクロールで判定
 *  - 列幅ドラッグは初版では省略(実装予定)
 */
const MyRecruitmentPageVertical = Object.assign(Object.create(MyRecruitmentPage), {

  // 縦版描画中だけ container に "v-mode" クラスを付け、縦版 CSS をスコープ限定する。
  // ページ切替時 (detach) には全て掃除して、横版に汚染が残らないようにする。
  detach() {
    const parentDetach = Object.getPrototypeOf(this).detach;
    if (typeof parentDetach === "function") parentDetach.call(this);
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
    // container 外に出した toolbar も削除
    document.querySelector(".v-toolbar")?.remove();
    const fb = document.getElementById("myCalFloatingMonth");
    if (fb) fb.style.removeProperty("display");
    const ep = document.getElementById("myCalEdgePrev");
    if (ep) ep.style.removeProperty("display");
    const en = document.getElementById("myCalEdgeNext");
    if (en) en.style.removeProperty("display");
  },

  renderCalendar() {
    const container = document.getElementById("myCalContainer");
    if (!container) return;
    // 縦版マーカー: CSS を .v-mode でスコープ限定するため
    container.classList.add("v-mode");

    // 再描画前のスクロール位置を保持
    const prevScrollTop = container.scrollTop;

    const ym = (this._calMonth || "").split("-");
    const year = parseInt(ym[0]) || new Date().getFullYear();
    const month = parseInt(ym[1]) || (new Date().getMonth() + 1);
    const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
    const todayStr = new Date().toLocaleDateString("sv-SE");

    // ===== データ準備 (横版と共通) =====

    // 前月・当月・翌月
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

    // 募集マップ (全体 + 物件別)
    const recruitByDate = {};
    const recruitByPropDate = {};
    this.recruitments.forEach(r => {
      const s = String(r.status || "");
      if (["キャンセル", "キャンセル済み", "期限切れ", "cancelled"].includes(s)) return;
      const d = r.checkoutDate;
      if (!d) return;
      if (!recruitByDate[d]) recruitByDate[d] = r;
      const pid = r.propertyId || "";
      if (pid) {
        (recruitByPropDate[pid] = recruitByPropDate[pid] || {})[d] = r;
      }
    });

    // 予約マップ (全体 + 物件別)
    const bookingsByDate = {};
    const bookingsByStart = {};
    const bookingsByPropStart = {};
    const bookingsByPropDate = {};
    const datesInRange = new Set(allDates.map(d => d.dateStr));
    this.bookings.forEach(b => {
      if (!b.checkIn || !b.checkOut) return;
      const pid = b.propertyId || "";
      const ci = new Date(b.checkIn + "T00:00:00");
      const co = new Date(b.checkOut + "T00:00:00");
      const bucket = {
        id: b.id,
        source: (b.source || "").toLowerCase(), guestCount: b.guestCount || 0,
        propertyName: b.propertyName || "", propertyId: pid,
        checkIn: b.checkIn, checkOut: b.checkOut,
        emailMessageId: b.emailMessageId || null,
        emailThreadId: b.emailThreadId || null,
        emailSubject: b.emailSubject || null,
        emailVerifiedAt: b.emailVerifiedAt || null,
      };
      for (let d = new Date(ci); d < co; d.setDate(d.getDate() + 1)) {
        const ds = d.toLocaleDateString("sv-SE");
        (bookingsByDate[ds] = bookingsByDate[ds] || []).push(bucket);
        if (pid) ((bookingsByPropDate[pid] = bookingsByPropDate[pid] || {})[ds] = (bookingsByPropDate[pid][ds] || [])).push(bucket);
      }
      if (datesInRange.has(b.checkIn)) {
        (bookingsByStart[b.checkIn] = bookingsByStart[b.checkIn] || []).push(bucket);
        if (pid) ((bookingsByPropStart[pid] = bookingsByPropStart[pid] || {})[b.checkIn] = (bookingsByPropStart[pid][b.checkIn] || [])).push(bucket);
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

    // 状態を考慮した表示色
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

    // バー装飾 (縦カレンダー版 — 線の向きを縦に)
    const bookingBarDecor = (b) => {
      if (!b || typeof b !== "object") return "";
      const s = String(b.status || "").toLowerCase();
      if (s.includes("cancel") || b.status === "キャンセル" || b.status === "キャンセル済み") {
        // 縦の打消し線 (バー中央に縦線)
        return "opacity:0.6;background-image:linear-gradient(to right, transparent calc(50% - 1px), rgba(0,0,0,0.55) calc(50% - 1px), rgba(0,0,0,0.55) calc(50% + 1px), transparent calc(50% + 1px));";
      }
      if (b.pendingApproval === true) {
        return "background-image:repeating-linear-gradient(45deg, rgba(255,255,255,0.45) 0 6px, transparent 6px 12px);";
      }
      if (b.unverified === true) {
        // 縦版では左右に dashed 線 (連泊で縦に連続するため)
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
    const stickyWN = 44; // 日付列幅 (px)
    const stickyW = stickyWN + "px";
    this._rowH = 28;
    const rowHN = this._rowH;
    const rowH = rowHN + "px";
    // thead 高さ (ユーザードラッグで伸縮、localStorage 永続化、下限なし)
    // 初期値 200px に変更 + key を v3 に上げて以前の小さい値をリセット
    const HEADER_H_KEY = "myCalVHeaderH_v3";
    if (this._headerH === undefined) {
      try {
        const v = parseInt(localStorage.getItem(HEADER_H_KEY), 10);
        this._headerH = (isFinite(v) && v >= 20 && v <= 500) ? v : 200;
      } catch (_) { this._headerH = 200; }
    }
    const headerH = this._headerH;
    const monthRowH = "22px";
    const propColW = "32px";   // 宿泊列の幅 (バー視認性向上で拡大)
    const pillColW = "22px";   // 清掃pill列の幅
    const staffColW = "33px";  // スタッフ列の幅

    // 縦版用の小型 pill (横版の min-width:30px / padding:0 10px だと20px列に収まらない)
    const recruitPillVertical = (r) => {
      if (!r) return "";
      const isPre = r.workType === "pre_inspection";
      let bg, color;
      if (isPre) {
        if (r.status === "スタッフ確定済み") { bg = "#7c3aed"; color = "#fff"; }
        else if (r.status === "選定済") { bg = "#c4b5fd"; color = "#1e0a3c"; }
        else if (r.status === "募集中") { bg = "#a78bfa"; color = "#1e0a3c"; }
        else { bg = "#8b5cf6"; color = "#fff"; }
      } else {
        bg = "#adb5bd"; color = "#fff";
        if (r.status === "スタッフ確定済み") { bg = "#198754"; color = "#fff"; }
        else if (r.status === "選定済") { bg = "#ffc107"; color = "#333"; }
        else if (r.status === "募集中") { bg = "#fd7e14"; color = "#fff"; }
      }
      const wtChar = isPre ? "直" : "清";
      // 列幅18px×行高22pxの円形寄りpill。padding無し、min-widthも指定しない。
      return `<span style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:20px;background:${bg};color:${color};border-radius:4px;font-weight:700;font-size:11px;line-height:1;box-sizing:border-box;">${wtChar}</span>`;
    };

    // ===== スタッフリスト構築 =====
    const myPropIdsSet = (() => {
      if (this._isSubOwnerView) return new Set(this._ownedPropertyIds || []);
      if (this.isOwnerView) return new Set(this.minpakuProperties.map(p => p.id));
      const a = Array.isArray(this.staffDoc?.assignedPropertyIds) ? this.staffDoc.assignedPropertyIds : [];
      return new Set(a);
    })();
    const isOwner = this.isOwnerView === true;
    const visiblePropIds = new Set(
      displayProperties.filter(p => this._propertyVisibility[p.id] !== false).map(p => p.id)
    );
    const visibleStaffList = isOwner
      ? this.staffList
      : this.staffList.filter(s => {
          if (s.id === this.staffId) return true;
          if (s.isOwner) return true;
          const theirAssigned = Array.isArray(s.assignedPropertyIds) ? s.assignedPropertyIds : [];
          return theirAssigned.some(pid => visiblePropIds.has(pid));
        });
    const orderedStaff = [
      ...visibleStaffList.filter(s => s.id === this.staffId),
      ...visibleStaffList.filter(s => s.id !== this.staffId),
    ];
    // フィルタ適用後の表示スタッフリスト
    const filteredStaff = orderedStaff.filter(staff => {
      const isMe = staff.id === this.staffId;
      if (this._showOnlyMe && !isMe) return false;
      if (!isMe && this._staffFilter && this._staffFilter !== "all") {
        const theirAssigned = Array.isArray(staff.assignedPropertyIds) ? staff.assignedPropertyIds : [];
        const filterSet = this._staffFilter === "myProp" ? myPropIdsSet : visiblePropIds;
        if (theirAssigned.length === 0 || !theirAssigned.some(pid => filterSet.has(pid))) return false;
      }
      return true;
    });

    // ===== CSS注入 (バージョン管理) =====
    const STYLE_VER = "v27";
    if (container._verticalStyleVer !== STYLE_VER) {
      container._verticalStyleVer = STYLE_VER;
      // 旧 style 要素を除去してから再注入 (CSS 更新を確実に反映)
      const oldStyle = document.getElementById("myCalVerticalStyle");
      if (oldStyle) oldStyle.remove();
      const styleEl = document.createElement("style");
      styleEl.id = "myCalVerticalStyle";
      // すべて #myCalContainer.v-mode でスコープ限定 — 横版に絶対に効かせない
      styleEl.textContent = `
        #myCalContainer.v-mode { --v-thead-h: 200px; }
        #myCalContainer.v-mode table { border-collapse:separate; border-spacing:0; }
        #myCalContainer.v-mode table td, #myCalContainer.v-mode table th { border:0; background-clip:padding-box; }
        #myCalContainer.v-mode .row-hover { box-shadow: inset 0 0 0 9999px rgba(13,110,253,0.07); }
        #myCalContainer.v-mode .sticky-col { border-right:2px solid #dee2e6; }
        #myCalContainer.v-mode td.prop-block-end, #myCalContainer.v-mode th.prop-block-end { border-right:1px solid #dee2e6; }
        #myCalContainer.v-mode tbody tr > th[data-cal-date], #myCalContainer.v-mode tbody tr > td.v-date-cell { border-top:1px solid #e9ecef; }
        #myCalContainer.v-mode tr.month-section > td { border-top:2px solid #adb5bd; border-bottom:2px solid #adb5bd; }
        /* 列間の縦線 (薄い区切り) — thead 全列 + tbody スタッフ列 */
        #myCalContainer.v-mode thead th { border-right: 1px solid #e9ecef; }
        #myCalContainer.v-mode tbody td { border-right: 1px solid #f1f3f5; }
        /* 物件ブロック (宿泊+清掃 colspan=2) の右端は他列と同じ薄さで統一 */
        #myCalContainer.v-mode th.prop-block-end,
        #myCalContainer.v-mode td.prop-block-end { border-right: 1px solid #dee2e6 !important; }
        /* sticky 左列 (日付列) の右側は既に sticky-col rule で太線 — 上書きしない */
        #myCalContainer.v-mode thead th.sticky-col { border-right: 2px solid #dee2e6; }
        /* thead 高さは絶対値で強制制御 — 内容が高くても切り詰め */
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
        /* 縦書き text の高さは ヘッダ th の max-height で必ず切り詰められる */
        /* 手動縦書き (1文字ずつ div で縦並び) — writing-mode は使わない */
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

    // ===== ツールバー HTML =====
    const isSubOwnerContext = this._viewMode === "owner" &&
      (this._isSubOwnerView || (typeof App !== "undefined" && App.impersonating && App.impersonatingData));
    const active_propFilter = this._propFilter === "myProp";
    const myPropFilterBtn = isSubOwnerContext
      ? `<button type="button" id="btnPropMyOnly" style="border:1px solid ${active_propFilter ? '#0d6efd' : '#ced4da'};background:${active_propFilter ? '#0d6efd' : '#fff'};color:${active_propFilter ? '#fff' : '#495057'};border-radius:4px;padding:2px 10px;font-size:12px;font-weight:600;cursor:pointer;">${active_propFilter ? '✓ ' : ''}自物件だけ <i class="bi bi-house-door"></i></button>`
      : "";
    const restoreButtons = hiddenProps.length
      ? hiddenProps.map(p => `<button type="button" class="prop-restore" data-prop-id="${p.id}" title="${this.esc(p.name)} を再表示" style="border:1px solid #ced4da;background:#fff;border-radius:4px;padding:2px 6px;font-size:12px;cursor:pointer;"><span class="badge" style="background:${p._color};color:#fff;">${p._num}</span> <i class="bi bi-eye text-muted"></i></button>`).join("")
      : "";
    const isPureOwner = this.isOwnerView && !this._isSubOwnerView
      && !(typeof App !== "undefined" && App.impersonating && App.impersonatingData)
      && !this._viewAsStaffId;
    const showSelfBtn = !isPureOwner;
    const selfBtnHtml = showSelfBtn
      ? `<button type="button" id="btnShowOnlyMe" style="border:1px solid ${this._showOnlyMe ? '#0d6efd' : '#ced4da'};background:${this._showOnlyMe ? '#0d6efd' : '#fff'};color:${this._showOnlyMe ? '#fff' : '#495057'};border-radius:4px;padding:2px 10px;font-size:12px;font-weight:600;cursor:pointer;">${this._showOnlyMe ? '✓ ' : ''}自分だけ <i class="bi bi-eye"></i></button>`
      : "";
    const visiblePropActive = this._staffFilter === "visibleProp";
    const visiblePropBtnHtml = `<button type="button" class="staff-filter-btn" data-filter="visibleProp" style="border:1px solid ${visiblePropActive ? '#0d6efd' : '#ced4da'};background:${visiblePropActive ? '#0d6efd' : '#fff'};color:${visiblePropActive ? '#fff' : '#495057'};border-radius:4px;padding:2px 10px;font-size:12px;font-weight:600;cursor:pointer;">${visiblePropActive ? '✓ ' : ''}表示中物件だけ <i class="bi bi-eye-fill"></i></button>`;

    const toolbarHtml = `<div class="v-toolbar d-flex flex-wrap gap-2 align-items-center mb-2 px-2 py-1" style="position:sticky;top:0;z-index:200;font-size:12px;background:#eef5ff;border:1px solid #cfe2ff;border-radius:4px;box-shadow:0 2px 4px rgba(0,0,0,0.06);">
      <span><i class="bi bi-building"></i> 物件:</span>
      ${myPropFilterBtn}
      ${hiddenProps.length ? `<span class="text-muted" style="font-weight:normal;font-size:11px;">非表示${hiddenProps.length}件:</span>${restoreButtons}` : `<small class="text-muted">(目アイコンで表示切替)</small>`}
      <span class="ms-2"><i class="bi bi-people"></i> スタッフ:</span>
      ${selfBtnHtml}
      ${visiblePropBtnHtml}
    </div>`;

    // ===== テーブルヘッダー構築 =====
    // 全列数 = 1(日付) + visibleProps * 2(宿泊+清掃) + filteredStaff.length
    const totalCols = 1 + visibleProps.length * 2 + filteredStaff.length;

    let html = `<table style="font-size:13px;white-space:nowrap;border-collapse:separate;border-spacing:0;">`;
    html += `<thead>`;

    // ヘッダ行1: 日付列 + 物件名(colspan=2) + スタッフ名
    html += `<tr>`;
    // 日付列 (rowspan=2) — 下端にヘッダ高さリサイズハンドル
    html += `<th rowspan="2" class="text-center sticky-col" style="position:sticky;left:0;top:0;z-index:15;background:#f8f9fa;min-width:${stickyW};max-width:${stickyW};vertical-align:middle;padding:4px 6px;font-size:13px;font-weight:600;">
      日付
      <div class="header-resizer" title="ドラッグで宿名・スタッフ名行の高さを変更" style="position:absolute;bottom:0;left:0;right:0;height:10px;cursor:row-resize;z-index:5;user-select:none;background:repeating-linear-gradient(to right, rgba(13,110,253,0.5) 0 6px, transparent 6px 12px);touch-action:none;"></div>
    </th>`;

    // 手動縦書き: 1文字ずつ div に。英数字は 90度回転して横倒し (省スペース)
    const verticalText = (text, fontSize) => {
      const chars = String(text).split('');
      const items = chars.map(ch => {
        if (ch === ' ' || ch === '　') return `<div style="height:4px;flex-shrink:0;"></div>`;
        const isAlnum = /[A-Za-z0-9]/.test(ch);
        if (isAlnum) {
          return `<div style="height:${fontSize}px;line-height:${fontSize}px;display:flex;align-items:center;justify-content:center;flex-shrink:0;"><span style="display:inline-block;transform:rotate(90deg);transform-origin:center;font-size:${fontSize}px;line-height:1;">${this.esc(ch)}</span></div>`;
        }
        return `<div style="height:${fontSize}px;line-height:${fontSize}px;font-size:${fontSize}px;text-align:center;flex-shrink:0;">${this.esc(ch)}</div>`;
      });
      return items.join('');
    };

    // 物件ヘッダ (rowspan=2 colspan=2) — flex column で上=ボタン群/下=縦書きテキスト
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

    // スタッフヘッダ (rowspan=2) — スタッフ名(縦書き)は absolute 配置で th 高さから独立
    filteredStaff.forEach((staff, i) => {
      const isMe = staff.id === this.staffId;
      const assigned = Array.isArray(staff.assignedPropertyIds) ? staff.assignedPropertyIds : [];
      const assignedBadges = (!staff.isOwner && assigned.length > 0)
        ? assigned.map(pid => {
            const p = this.propertyMap[pid];
            if (!p) return "";
            const num = p._num != null ? p._num : (p.propertyNumber != null ? p.propertyNumber : "");
            if (num === "") return "";
            const color = p._color || p.color || "#6c757d";
            return `<span class="badge" title="${this.esc(p.name || "")}" style="background:${this.esc(color)};color:#fff;font-size:9px;padding:1px 4px;line-height:1.2;">${this.esc(String(num))}</span>`;
          }).join("")
        : "";
      // バッジ群+OWN+👤 の高さを概算 (個数で可変)
      const topRowH = (assigned.length * 14) + (isMe ? 16 : 0) + (staff.isOwner ? 14 : 0) + 4;
      html += `<th rowspan="2" class="text-center" style="background:${isMe ? "#e3f2fd" : "#ffffff"} !important;min-width:${staffColW};max-width:${staffColW};padding:3px 2px 0;font-size:11px;font-weight:600;overflow:hidden;" title="${this.esc(staff.name)}">
        <div style="display:flex;flex-direction:column;align-items:center;height:100%;width:100%;">
          <div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0;">
            ${assignedBadges}
            ${isMe ? '<span style="font-size:13px;line-height:1;">👤</span>' : ''}
            ${staff.isOwner ? '<span class="badge bg-info" style="font-size:8px;">OWN</span>' : ''}
          </div>
          <div class="v-text-block" style="flex:1 1 0;min-height:0;overflow:hidden;font-weight:600;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;width:100%;">${verticalText(staff.name, 12)}</div>
        </div>
      </th>`;
    });

    html += `</tr>`;
    // ヘッダ行2 (泊/清 サブヘッダ) は廃止 — 物件 th を rowspan=2 にして 1 段で完結
    html += `</thead><tbody>`;

    // ===== tbody: 月境界 + 日付行 =====
    const rangeStart = allDates[0].dateStr;
    const rangeEnd = allDates[allDates.length - 1].dateStr;

    // キャンセル判定ヘルパー
    const isCancelled = (b) => {
      const s = String(b.status || "").toLowerCase();
      return s.includes("cancel") || b.status === "キャンセル" || b.status === "キャンセル済み";
    };

    // 名簿ドット判定ヘルパー
    const isPlaceholder = (n) => {
      const s = String(n || "").toLowerCase().trim();
      return !s || /^(reserved|not available|airbnb|booking|airbnb予約|booking\.com予約|\(no name\))/i.test(s);
    };

    let prevMonthKey = null;
    allDates.forEach(dd => {
      const monthKey = `${dd.year}-${dd.month}`;

      // 月境界行
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

      // ===== 物件列 (宿泊バー + 清掃pill) =====
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

        // 予約セグメント計算 (横版と同じロジック)
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
        const starting = aStart || cStart;  // CI
        const ending = aEnd || cEnd;         // CO
        const middle = aMid || cMid;         // 中日

        // ===== 縦版 予約バーセグメント =====
        // CI (starting): 下半分 (top:50%→bottom:0)、上端を角丸
        // CO (ending):   上半分 (top:0→bottom:50%)、下端を角丸
        // 中日 (middle): 全体  (top:0→bottom:0)
        let segs = "";
        const barStyle = "position:absolute;left:4px;right:4px;pointer-events:none;z-index:2;";
        if (ending) {
          const c = bookingDisplayColor(ending, fallbackColor);
          const dec = bookingBarDecor(ending);
          segs += `<div style="${barStyle}top:0;bottom:50%;background:${c};${dec}border-bottom-left-radius:999px;border-bottom-right-radius:999px;"></div>`;
        }
        if (middle) {
          const c = bookingDisplayColor(middle, fallbackColor);
          const dec = bookingBarDecor(middle);
          segs += `<div style="${barStyle}top:0;bottom:0;background:${c};${dec}"></div>`;
        }
        if (starting) {
          const c = bookingDisplayColor(starting, fallbackColor);
          const dec = bookingBarDecor(starting);
          segs += `<div style="${barStyle}top:50%;bottom:0;background:${c};${dec}border-top-left-radius:999px;border-top-right-radius:999px;"></div>`;

          // 名簿ドット (starting セル内、CI下半中央あたり)
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
          // 名簿ドット: CIセル(下半)の上端寄りに配置 → 人数ラベルがその下に来る
          segs += `<span style="position:absolute;left:50%;top:calc(50% + 4px);transform:translateX(-50%);width:8px;height:8px;border-radius:50%;background:${dotColor};border:1.5px solid #fff;z-index:4;pointer-events:none;" title="${dotTitle}"></span>`;
        }

        // 人数ラベル (縦書き) — 名簿ドットの下に配置
        let labelHtml = "";
        const vLabelStyle = "position:absolute;left:50%;transform:translateX(-50%);color:#fff;font-size:10px;font-weight:700;z-index:3;pointer-events:none;writing-mode:vertical-rl;-webkit-writing-mode:vertical-rl;text-orientation:mixed;-webkit-text-orientation:mixed;line-height:1;letter-spacing:0;";
        if (middle) {
          // 連泊: CI+1日のセル中央に縦書き
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
            // 1泊: CIセル下半 のドット直下〜下端に縦書き (ドットが上、人数が下)
            const cnt = starting.guestCount > 0 ? `${starting.guestCount}名` : "";
            if (cnt) labelHtml = `<span style="${vLabelStyle}top:calc(50% + 16px);bottom:1px;display:flex;align-items:flex-start;justify-content:center;overflow:hidden;">${cnt}</span>`;
          }
        }

        const ref = starting || middle || ending;
        const clickAttr = ref ? ` class="cal-date-hd${isLastProp ? " prop-block-end" : ""}" data-cal-date="${ref.checkIn}" data-booking-id="${this.esc(ref.id)}"` : ` class="${isLastProp ? "prop-block-end" : ""}"`;
        const cursor = ref ? "cursor:pointer;" : "";
        html += `<td${clickAttr} data-col-date="${dd.dateStr}" style="position:relative;height:${rowH};background:${tdBg};padding:0;overflow:visible;min-width:${propColW};max-width:${propColW};${cursor}">${segs}${labelHtml}</td>`;

        // 清掃pill列
        const recruitByD = recruitByPropDate[p.id] || {};
        const r = recruitByD[dd.dateStr];
        const cellBg = isHdToday ? "#e8f0fe" : (!dd.isCurrent ? "#e9ecef" : "#fff");
        if (r) {
          html += `<td class="text-center cal-recruit-cell${isLastProp ? " prop-block-end" : ""}" data-recruitment-id="${this.esc(r.id)}" data-col-date="${dd.dateStr}" style="height:${rowH};background:${cellBg};padding:0;vertical-align:middle;cursor:pointer;min-width:${pillColW};max-width:${pillColW};overflow:hidden;">${recruitPillVertical(r)}</td>`;
        } else {
          html += `<td data-col-date="${dd.dateStr}" class="${isLastProp ? "prop-block-end" : ""}" style="height:${rowH};background:${cellBg};padding:0;min-width:${pillColW};max-width:${pillColW};"></td>`;
        }
      });

      // ===== スタッフ列 (回答記号) =====
      filteredStaff.forEach(staff => {
        const isMe = staff.id === this.staffId;
        const assigned = Array.isArray(staff.assignedPropertyIds) ? staff.assignedPropertyIds : [];
        const hasAssignments = assigned.length > 0;
        const targetPropIds = hasAssignments
          ? assigned
          : this.minpakuProperties.map(p => p.id);

        // この日の該当募集を全て収集 (物件単位)
        const cellRecruits = [];
        for (const pid of targetPropIds) {
          const byD = recruitByPropDate[pid];
          if (byD && byD[dd.dateStr]) {
            cellRecruits.push({ recruit: byD[dd.dateStr], prop: this.propertyMap[pid] });
          }
        }

        if (cellRecruits.length === 0) {
          const bg = isToday ? "#e8f0fe" : (!dd.isCurrent ? "#e9ecef" : "#f9f9f9");
          const ownerAddAttr = isOwner
            ? ` data-owner-add="1" data-date="${dd.dateStr}" style="background:${bg};color:#adb5bd;height:${rowH};vertical-align:middle;cursor:pointer;text-align:center;min-width:${staffColW};max-width:${staffColW};"`
            : ` style="background:${bg};color:#adb5bd;height:${rowH};vertical-align:middle;text-align:center;min-width:${staffColW};max-width:${staffColW};"`;
          html += `<td${ownerAddAttr}>-</td>`;
          return;
        }

        // 回答記号生成 (横版と同じロジック)
        let anyConfirmed = false;
        let cellClickTarget = null;
        const items = cellRecruits.map(({ recruit, prop }) => {
          const responses = recruit.responses || [];
          let resp = "未回答";
          for (const r of responses) {
            const idMatch = r.staffId && staff.id && r.staffId === staff.id;
            const nameMatch = !r.staffId && r.staffName && staff.name && r.staffName === staff.name;
            if (idMatch || nameMatch) { resp = r.response || "未回答"; break; }
          }
          let symbol = "−", symColor = "#adb5bd";
          if (resp === "◎") { symbol = "●"; symColor = "#198754"; }
          else if (resp === "△") { symbol = "▲"; symColor = "#cc9a06"; }
          else if (resp === "×") { symbol = "✖"; symColor = "#dc3545"; }

          let confirmed = false;
          const sel = (recruit.selectedStaff || "").trim();
          if (sel && (recruit.status === "選定済" || recruit.status === "スタッフ確定済み")) {
            confirmed = sel.split(/[,、\s]+/).map(s => s.trim()).includes(staff.name);
          }
          if (confirmed) anyConfirmed = true;

          const isFinalized = recruit.status === "スタッフ確定済み";
          if (isFinalized && resp !== "未回答" && !confirmed) { symColor = "#495057"; }

          const isOwnedByMe = !this._isSubOwnerView || (prop && this._ownedPropertyIds.includes(prop.id));
          const clickable = isMe || (isOwner && isOwnedByMe);
          const clickMode = (recruit.status === "スタッフ確定済み") ? "detail" : "respond";
          if (clickable && !cellClickTarget) {
            cellClickTarget = { recruitId: recruit.id, propId: prop ? prop.id : "", propName: prop ? prop.name : "", clickMode };
          }
          // 物件番号バッジは回答済みのときのみ表示 — 縦版では symbol の「上」に配置
          const propBadge = (resp !== "未回答" && prop)
            ? `<span style="color:#fff;background:${prop._color};padding:0 3px;border-radius:3px;font-size:9px;font-weight:700;line-height:1.2;">${prop._num}</span>`
            : "";
          let symHtml;
          if (symbol === "●") {
            symHtml = `<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${symColor};vertical-align:middle;"></span>`;
          } else if (symbol === "▲") {
            symHtml = `<span style="display:inline-block;color:${symColor};font-size:15px;font-weight:bold;line-height:14px;vertical-align:middle;">▲</span>`;
          } else if (symbol === "✖") {
            symHtml = `<span style="display:inline-block;color:${symColor};font-size:15px;font-weight:bold;line-height:14px;vertical-align:middle;">✖</span>`;
          } else {
            symHtml = `<span style="display:inline-block;color:${symColor};font-size:12px;font-weight:bold;line-height:14px;vertical-align:middle;">−</span>`;
          }
          return `<span class="${clickable ? 'cal-cell-item' : ''}" data-recruit-id="${recruit.id}" data-prop-id="${prop ? prop.id : ''}" data-prop-name="${prop ? this.esc(prop.name) : ''}" data-click-mode="${clickMode}" data-staff-id="${staff.id}" data-staff-name="${this.esc(staff.name)}" data-staff-email="${this.esc(staff.email || '')}" data-is-me="${isMe}" data-date="${dd.dateStr}" style="display:inline-flex;flex-direction:column;align-items:center;gap:1px;line-height:1;padding:0 1px;border-radius:4px;${clickable ? 'cursor:pointer;' : ''}">${propBadge}${symHtml}</span>`;
        });

        const isActionable = !!cellClickTarget;
        const cellBg = anyConfirmed ? "#a7c7ff"
          : (isToday ? "#e8f0fe"
            : (isActionable ? "#fff"
              : (!dd.isCurrent ? "#e9ecef" : "")));
        const tdData = cellClickTarget
          ? ` data-cell-click="1" data-recruit-id="${cellClickTarget.recruitId}" data-prop-id="${cellClickTarget.propId}" data-prop-name="${this.esc(cellClickTarget.propName || '')}" data-click-mode="${cellClickTarget.clickMode}" data-staff-id="${staff.id}" data-staff-name="${this.esc(staff.name)}" data-staff-email="${this.esc(staff.email || '')}" data-is-me="${isMe}" data-date="${dd.dateStr}"`
          : "";
        const tdCursor = cellClickTarget ? "cursor:pointer;" : "";
        html += `<td class="text-center" data-col-date="${dd.dateStr}" style="background:${cellBg};height:${rowH};vertical-align:middle;padding:1px 2px;white-space:nowrap;min-width:${staffColW};max-width:${staffColW};${tdCursor}"${tdData}>
          <span style="display:inline-flex;flex-wrap:wrap;gap:2px;justify-content:center;align-items:center;">${items.join("")}</span>
        </td>`;
      });

      html += `</tr>`;
    });

    html += `</tbody></table>`;

    // コンテナ更新 — toolbar は container の外 (兄要素) に出して body スクロールに sticky:top:0 で貼り付ける
    container.innerHTML = html;
    // 既存 toolbar 要素を削除して、container の直前に再挿入
    let existingTb = document.getElementById("vCalToolbar");
    if (existingTb) existingTb.remove();
    const tbWrap = document.createElement("div");
    tbWrap.id = "vCalToolbar";
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

    // 右上の年月表示 (floating month バッジ) は縦版では非表示
    const floatBadge = document.getElementById("myCalFloatingMonth");
    if (floatBadge) floatBadge.style.display = "none";

    // 親 render() が出している横移動矢印 (左右) は縦版では非表示
    const edgePrev = document.getElementById("myCalEdgePrev");
    const edgeNext = document.getElementById("myCalEdgeNext");
    if (edgePrev) edgePrev.style.display = "none";
    if (edgeNext) edgeNext.style.display = "none";

    // 縦版用の上下矢印 (上=前月、下=翌月) — container の親 (position:relative の囲み) に挿入
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
          // 右下/右上に置く (中央にあるとツールバーや日付列と被る)
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
        // 再描画時は表示状態だけリセット
        btn.style.display = "none";
      }
      return btn;
    };
    const btnVPrev = ensureVerticalArrow("myCalVEdgePrev", "top", "bi-chevron-up", () => {
      const [y, m] = (this._calMonth || "").split("-").map(Number);
      const d = new Date(y, (m || 1) - 1 - 1, 1);
      this._calMonth = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      const mi = document.getElementById("myCalMonth");
      if (mi) mi.value = this._calMonth;
      this._initialScrollDone = false;
      this.renderCalendar();
    });
    const btnVNext = ensureVerticalArrow("myCalVEdgeNext", "bottom", "bi-chevron-down", () => {
      const [y, m] = (this._calMonth || "").split("-").map(Number);
      const d = new Date(y, (m || 1) - 1 + 1, 1);
      this._calMonth = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      const mi = document.getElementById("myCalMonth");
      if (mi) mi.value = this._calMonth;
      this._initialScrollDone = false;
      this.renderCalendar();
    });

    // 上下矢印: 端到達時のみ表示 (上=scrollTop≒0、下=scrollTop≒max)
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

    // ===== 行高リサイズ (日付列ヘッダ下端のハンドル) =====
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
    // container を sticky に。top はツールバー実 bottom を動的に測って設定（少しズレ防止）
    container.style.setProperty("position", "sticky", "important");
    container.style.setProperty("overflow-y", "auto", "important");
    container.style.setProperty("overflow-x", "auto", "important");
    // 親 page-container/app-main の overflow を visible にして sticky を効かせる
    let parent = container.parentElement;
    while (parent && parent !== document.body) {
      if (parent.id === "pageContainer" || parent.classList?.contains("app-main")) {
        parent.style.setProperty("overflow", "visible", "important");
      }
      parent = parent.parentElement;
    }
    // ツールバー実高さで container.top を動的計算 (即時 + 遅延 + window resize 時)
    const updateContainerTop = () => {
      const tb = document.querySelector(".v-toolbar");
      let topPx = 0;
      if (tb) {
        topPx = Math.round(tb.getBoundingClientRect().height) + 4;
      }
      if (topPx < 30) topPx = 44; // toolbar 未レンダ時のフォールバック
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

    // ===== ヘッダ高さ初期化 (CSS 変数で thead 高さを動的設定) =====
    container.style.setProperty("--v-thead-h", (this._headerH || 170) + "px");

    // ===== ヘッダ高さリサイズ (日付列ヘッダ下端のハンドルをドラッグ) =====
    container.querySelectorAll('.header-resizer').forEach(handle => {
      if (handle.dataset.wired === "1") return;
      handle.dataset.wired = "1";
      const onStart = (startY) => {
        const startH = this._headerH || 170;
        const onMove = (y) => {
          // 下限 20px / 上限 500px — 物件名が見切れても良いので、ほぼ制限なし
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

    // === 旧 edge ボタンの dataset.wired を立てて重複バインドを防止 ===
    if (edgePrev && !edgePrev.dataset.wired) edgePrev.dataset.wired = "1";
    if (edgeNext && !edgeNext.dataset.wired) edgeNext.dataset.wired = "1";
    // (旧 edge ボタンの click ハンドラは縦版では未配線。代わりに btnVPrev/btnVNext を使用)

    // 「自分だけ」トグル
    document.getElementById("btnShowOnlyMe")?.addEventListener("click", () => {
      this._showOnlyMe = !this._showOnlyMe;
      this._saveSettings();
      this.renderCalendar();
    });

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

    // 「表示中物件だけ」フィルタ
    container.querySelectorAll(".staff-filter-btn").forEach(btn => {
      if (btn.dataset.wired === "1") return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", () => {
        const mode = btn.dataset.filter;
        const newVal = (this._staffFilter === mode) ? "all" : mode;
        this._staffFilter = newVal;
        this._saveSettings();
        this.renderCalendar();
      });
    });

    // 物件表示トグル
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
    container.querySelectorAll(".prop-restore").forEach(btn => {
      btn.addEventListener("click", () => {
        const pid = btn.dataset.propId;
        this._propertyVisibility[pid] = true;
        this._saveSettings();
        this.renderCalendar();
      });
    });

    // セル全体タップ (td) → 募集詳細
    const handleCellClick = async (td) => {
      if (this._isInactive) {
        showToast("非アクティブ", this.staffDoc?.inactiveReason || "直近15回の清掃募集について回答がなかったため、非アクティブとなりました。解除する場合はWebアプリ管理者までご連絡ください。", "warning");
        return;
      }
      const dateStr = td.dataset.date;
      if (!dateStr) return;
      let candidates = this.recruitments.filter(r => this._toDateStr(r.checkoutDate) === dateStr);
      const isStaffView = !this.isOwnerView;
      const myAssignedIds = Array.isArray(this.staffDoc?.assignedPropertyIds) ? this.staffDoc.assignedPropertyIds : [];
      if (isStaffView && myAssignedIds.length > 0) {
        candidates = candidates.filter(r => myAssignedIds.includes(r.propertyId));
      }
      if (candidates.length === 0) {
        const directRecruitId = td.dataset.recruitId;
        if (directRecruitId) {
          const direct = this.recruitments.find(r => r.id === directRecruitId);
          if (direct) candidates = [direct];
        }
      }
      if (candidates.length === 0) {
        if (this.isOwnerView) this._showAddPickerForDate(dateStr);
        return;
      }
      if (typeof RecruitmentPage !== "undefined") {
        if (Array.isArray(this.staffList) && this.staffList.length) RecruitmentPage.staffList = this.staffList;
        if (Array.isArray(this.recruitments) && this.recruitments.length) RecruitmentPage.recruitments = this.recruitments;
        if (Array.isArray(this.minpakuProperties) && this.minpakuProperties.length) RecruitmentPage.properties = this.minpakuProperties;
      }
      if (typeof RecruitmentPage !== "undefined" && RecruitmentPage.openDetailModal) {
        try {
          await RecruitmentPage.ensureLoaded();
          if (candidates.length === 1) {
            RecruitmentPage.openDetailModal(candidates[0], { viewMode: this.isOwnerView ? "owner" : "staff" });
          } else {
            this._showDayBookingsListModal(dateStr, candidates);
          }
        } catch (e) {
          showToast("ERROR", e.message || String(e), "error");
        }
      }
    };

    if (!container._cellDelegateBound) {
      container._cellDelegateBound = true;
      container.addEventListener("click", (ev) => {
        const td = ev.target.closest('td[data-cell-click="1"]');
        if (!td) return;
        ev.stopPropagation();
        handleCellClick(td);
      });
    }

    // Webアプリ管理者: 募集ゼロ日セルタップで手動追加
    if (this.isOwnerView) {
      container.querySelectorAll('td[data-owner-add="1"]').forEach(td => {
        td.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const dateStr = td.dataset.date;
          if (!dateStr) return;
          this._showAddPickerForDate(dateStr);
        });
      });
    }

    // 予約バーセルのクリック (cal-date-hd)
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

    // 清掃pillセルのクリック
    container.querySelectorAll(".cal-recruit-cell").forEach(el => {
      el.addEventListener("click", async () => {
        const recruitmentId = el.dataset.recruitmentId;
        if (!recruitmentId) return;
        const recruit = this.recruitments.find(x => x.id === recruitmentId);
        if (!recruit) return;
        if (typeof RecruitmentPage !== "undefined" && RecruitmentPage.openDetailModal) {
          if (typeof RecruitmentPage.ensureLoaded === "function") {
            await RecruitmentPage.ensureLoaded();
          }
          RecruitmentPage.openDetailModal(recruit, { viewMode: isOwnerView ? "owner" : "staff" });
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
        // thead 実高さ (縦書きヘッダで大きくなる) + 余白を引く
        const theadEl = container.querySelector("thead");
        const theadH = theadEl ? theadEl.getBoundingClientRect().height : 90;
        const delta = rowRect.top - containerRect.top - theadH - 10;
        container.scrollTop = Math.max(0, container.scrollTop + delta);
      }
      this._initialScrollDone = true;

      // URL に recruitmentId が含まれている場合の自動モーダル表示
      if (this._pendingOpenId) {
        const pendingId = this._pendingOpenId;
        this._pendingOpenId = null;
        const recruit = this.recruitments.find(r => r.id === pendingId);
        if (recruit && typeof RecruitmentPage !== "undefined" && RecruitmentPage.openDetailModal) {
          (async () => {
            if (typeof RecruitmentPage.ensureLoaded === "function") {
              await RecruitmentPage.ensureLoaded();
            }
            RecruitmentPage.openDetailModal(recruit, { viewMode: isOwnerView ? "owner" : "staff" });
          })();
        }
      }
    }

    // 要対応 / お知らせ描画 (親メソッドを流用)
    if (typeof this.renderToActions_ === "function") this.renderToActions_();

    // FullCalendar 更新 (初期化済みの場合)
    if (this._fcInitialized && typeof this._refreshFullCalendar === "function") {
      this._refreshFullCalendar();
    }
  },
});
