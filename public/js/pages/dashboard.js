/**
 * ダッシュボードページ
 * 統計カード + 今日のアクション + カレンダー（予約・清掃・募集ステータス）
 * カレンダーから直接: 募集作成・回答入力・スタッフ選定・確定まで完結
 */
const DashboardPage = {
  calendar: null,
  bookings: [],
  recruitments: [],
  staffList: [],
  guestMap: {},             // CI日→名簿データのマップ
  properties: [],           // 物件一覧（active=true）
  propertyFilter: {},       // 後方互換のために残す {propertyId: boolean}
  selectedPropertyIds: [],  // 共通コンポーネントとの橋渡し

  async render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-speedometer2"></i> ダッシュボード</h2>
      </div>

      <!-- 統計カード -->
      <div class="row g-3 mb-3">
        <div class="col-6 col-md-3">
          <div class="card card-stat primary">
            <div class="card-body py-2">
              <div class="text-muted small">今日の清掃</div>
              <div class="fs-3 fw-bold" id="statTodayShifts">-</div>
            </div>
          </div>
        </div>
        <div class="col-6 col-md-3">
          <div class="card card-stat success">
            <div class="card-body py-2">
              <div class="text-muted small">今月の予約</div>
              <div class="fs-3 fw-bold" id="statMonthBookings">-</div>
            </div>
          </div>
        </div>
        <div class="col-6 col-md-3">
          <div class="card card-stat warning">
            <div class="card-body py-2">
              <div class="text-muted small">募集中</div>
              <div class="fs-3 fw-bold" id="statRecruiting">-</div>
            </div>
          </div>
        </div>
        <div class="col-6 col-md-3">
          <div class="card card-stat danger">
            <div class="card-body py-2">
              <div class="text-muted small">稼働スタッフ</div>
              <div class="fs-3 fw-bold" id="statActiveStaff">-</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 今日のアクション -->
      <div id="todayActions" class="mb-3"></div>

      <!-- 物件フィルタ (共通コンポーネント) -->
      <div id="propertyFilterHost-dashboard"></div>

      <!-- 凡例 -->
      <div class="d-flex flex-wrap gap-3 mb-2 small text-muted">
        <span><span class="cal-legend" style="background:#FF5A5F"></span>Airbnb</span>
        <span><span class="cal-legend" style="background:#003580"></span>Booking.com</span>
        <span><span class="cal-legend" style="background:#0d6efd"></span>直接予約</span>
        <span>|</span>
        <span><span class="cal-legend" style="background:#198754"></span>🧹確定</span>
        <span><span class="cal-legend" style="background:#ffc107"></span>🧹募集中</span>
        <span><span class="cal-legend" style="background:#dc3545"></span>🧹回答なし</span>
        <span>|</span>
        <span><span class="cal-legend" style="background:#7c3aed"></span>🔍直前点検（確定）</span>
        <span><span class="cal-legend" style="background:#a78bfa"></span>🔍直前点検（募集中）</span>
        <span>|</span>
        <span><span class="event-status-dot dot-roster-ok" style="display:inline-block"></span>名簿済</span>
        <span><span class="event-status-dot dot-roster-ng" style="display:inline-block"></span>名簿未</span>
        <span class="ms-auto"><i class="bi bi-plus-circle"></i> 日付クリック=募集作成</span>
      </div>

      <!-- カレンダー -->
      <div class="card">
        <div class="card-body p-2">
          <div id="dashboardCalendar"></div>
        </div>
      </div>
    `;

    await this.loadAllData();
    this.renderStats();
    this.renderTodayActions();

    // 共通物件フィルタコンポーネントを描画
    PropertyFilter.render({
      containerId: "propertyFilterHost-dashboard",
      tabKey: "dashboard",
      properties: this.properties,
      onChange: (ids) => {
        this.selectedPropertyIds = ids;
        // propertyFilter マップも同期
        this.properties.forEach(p => {
          this.propertyFilter[p.id] = ids.includes(p.id);
        });
        this.refreshCalendar();
      },
    });

    this.initCalendar();
    // FCM初期化 + 通知許可バナー（バックグラウンド実行）
    this._initFCMBanner();
  },

  /**
   * FCM初期化 + Webアプリ管理者向け通知許可バナー表示
   * FCM は現時点で導入保留 (iOS PWA制約で導入負担大)。将来再有効化可能なようコードは残す。
   */
  async _initFCMBanner() {
    // FCM バナーは現時点で非表示
    return;
  },

  async loadAllData() {
    try {
      const [recruitSnap, staff, bookingSnap, guestSnap, propSnap] = await Promise.all([
        db.collection("recruitments").get(),
        API.staff.list(true),
        db.collection("bookings").get(),
        db.collection("guestRegistrations").get(),
        db.collection("properties").where("active", "==", true).get(),
      ]);

      // === 募集データの正規化（checkOutDate/checkoutDate両対応） ===
      const RECRUIT_EXCLUDE_STATUS = ["キャンセル", "キャンセル済み", "期限切れ", "cancelled"];
      let recruitments = recruitSnap.docs.map(doc => {
        const d = doc.data();
        const coRaw = d.checkoutDate || d.checkOutDate || d.checkOutdate || "";
        const coStr = this.toDateStr(coRaw);
        return {
          id: doc.id,
          ...d,
          checkoutDate: coStr,
          responses: d.responses || [],
          status: d.status || "募集中",
          selectedStaff: d.selectedStaff || "",
        };
      }).filter(r => !RECRUIT_EXCLUDE_STATUS.includes(r.status));

      // === 予約データの統合（CI+COキーでマージ、ソース優先度付き） ===
      // 優先度: beds24 > bookings > guestRegistrations > migrated
      // 同じCI+COの予約は1つに統合し、詳細情報は全ソースからマージ
      const bookingMap = new Map(); // key: "CI|CO" → merged booking object

      // ソース優先度（高い方が勝つ）
      const SOURCE_PRIORITY = { beds24: 40, booking: 30, bookings: 30, direct: 20, manual: 20, guest_form: 15, "名簿": 10, migrated: 5, "": 0 };
      const getSourcePriority = (src) => {
        if (!src) return 0;
        const s = src.toLowerCase();
        for (const [key, val] of Object.entries(SOURCE_PRIORITY)) {
          if (s.includes(key)) return val;
        }
        return 1;
      };

      // プレースホルダ名判定
      const isPlaceholder = (name) => {
        if (!name) return true;
        const n = name.trim().toLowerCase();
        return !n || n === "-" || n.includes("airbnb") || n.includes("booking.com") ||
          n.includes("not available") || n.includes("blocked") || n.includes("closed") || n.includes("reserved");
      };

      // 予約をマップに追加（既存があればマージ）
      const addBooking = (b, sourceType) => {
        const ci = this.toDateStr(b.checkIn);
        const co = this.toDateStr(b.checkOut);
        if (!ci) return;
        // propertyId を key に含めて物件別に独立保持 (異なる物件の同日予約がマージされる問題を修正)
        const pid = b.propertyId || "_nopid_";
        const key = `${pid}|${ci}|${co}`;
        const existing = bookingMap.get(key);

        if (!existing) {
          bookingMap.set(key, { ...b, checkIn: ci, checkOut: co, _sourceType: sourceType, _sources: [sourceType] });
          return;
        }

        // マージ: 実名優先、詳細情報は空でない方を採用
        existing._sources.push(sourceType);
        const newPriority = getSourcePriority(b.source || b.bookingSite || sourceType);
        const existPriority = getSourcePriority(existing.source || existing._sourceType);

        // ゲスト名: 実名 > プレースホルダ、同格ならソース優先度
        if (!isPlaceholder(b.guestName) && (isPlaceholder(existing.guestName) || newPriority > existPriority)) {
          existing.guestName = b.guestName;
        }
        // 人数: 0より大きい方
        if ((b.guestCount || 0) > (existing.guestCount || 0)) existing.guestCount = b.guestCount;
        // ソース: 高優先度のものを採用
        if (newPriority > existPriority && b.source) existing.source = b.source;
        if (b.bookingSite && !existing.bookingSite) existing.bookingSite = b.bookingSite;
        // 空でないフィールドを補完
        ["nationality", "bbq", "parking", "memo", "phone", "email", "icalUrl", "syncSource", "beds24Source", "beds24BookingId"].forEach(f => {
          if (b[f] && !existing[f]) existing[f] = b[f];
        });
      };

      // 1) bookings/ コレクション（iCal同期 or BEDS24）— 最優先
      // pendingApproval=true (Airbnb 予約承認待ち) も除外: 確定後に再 ingest される
      const rawBookings = bookingSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(b => b.status !== "cancelled" && b.pendingApproval !== true);
      rawBookings.forEach(b => addBooking(b, "bookings"));

      // 2) guestRegistrations/（名簿フォーム）— 補完
      const guests = guestSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      guests.forEach(g => addBooking({
        id: "g_" + g.id,
        guestName: g.guestName || "",
        checkIn: g.checkIn, checkOut: g.checkOut,
        guestCount: g.guestCount || 0,
        source: g.bookingSite || g.source || "名簿",
        nationality: g.nationality || "",
        bbq: g.bbq || "", parking: g.parking || "",
        memo: g.memo || "",
      }, "guestRegistrations"));

      const bookings = Array.from(bookingMap.values());

      // guestMap構築（"{propertyId}_{CI日}" → 名簿データ）
      // 複数物件が同一CI日を持つ場合に混在しないよう複合キーを使用
      this.guestMap = {};
      guests.forEach(g => {
        const ci = this.toDateStr(g.checkIn);
        if (!ci) return;
        // propertyId がある場合は複合キー、ない場合は CI日のみ (後方互換)
        const key = g.propertyId ? `${g.propertyId}_${ci}` : ci;
        this.guestMap[key] = g;
      });

      // 物件一覧を displayOrder 昇順でセット
      this.properties = propSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.displayOrder ?? 99) - (b.displayOrder ?? 99));

      // 共通コンポーネントから選択状態を取得して propertyFilter マップに変換
      this.selectedPropertyIds = PropertyFilter.getSelectedIds("dashboard", this.properties);
      this.propertyFilter = {};
      this.properties.forEach(p => {
        this.propertyFilter[p.id] = this.selectedPropertyIds.includes(p.id);
      });

      this.bookings = bookings;
      this.recruitments = recruitments;
      this.staffList = staff;
      console.log(`[Dashboard] データ読み込み完了: bookings=${bookings.length}(統合後), recruitments=${recruitments.length}, staff=${staff.length}, guests=${guests.length}`);
      // 全予約のソース情報一覧（デバッグ用）
      console.table(bookings.map(b => ({
        CI: b.checkIn, CO: b.checkOut, 名前: b.guestName,
        source: b.source || "", bookingSite: b.bookingSite || "",
        _sourceType: b._sourceType || "", _sources: (b._sources||[]).join(","),
        色: this.getPlatformClass(b),
      })));
      console.log("[Dashboard] recruitments先頭5件:", recruitments.slice(0, 5).map(r => ({ id: r.id, co: r.checkoutDate, status: r.status, respCount: (r.responses||[]).length, selected: r.selectedStaff })));
    } catch (e) {
      console.error("データ読み込みエラー:", e);
    }
  },

  renderStats() {
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);

    const todayClean = this.recruitments.filter(r => this.toDateStr(r.checkoutDate) === today).length;
    const monthBookings = Math.max(
      this.bookings.filter(b => (this.toDateStr(b.checkIn) || "").startsWith(month)).length,
      this.recruitments.filter(r => (this.toDateStr(r.checkoutDate) || "").startsWith(month)).length
    );
    const recruiting = this.recruitments.filter(r => r.status === "募集中").length;

    document.getElementById("statTodayShifts").textContent = todayClean;
    document.getElementById("statMonthBookings").textContent = monthBookings;
    document.getElementById("statRecruiting").textContent = recruiting;
    document.getElementById("statActiveStaff").textContent = this.staffList.length;
  },

  // === 今日のアクション（要対応アイテムを表示） ===
  renderTodayActions() {
    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date();
    soon.setDate(soon.getDate() + 3);
    const soonStr = soon.toISOString().slice(0, 10);

    const actions = [];

    // 3日以内の募集中（スタッフ未確定）
    this.recruitments.forEach(r => {
      if (r.status !== "募集中" && r.status !== "選定済") return;
      const rCoDate = this.toDateStr(r.checkoutDate);
      if (!rCoDate || rCoDate > soonStr) return;
      const responses = r.responses || [];
      const maru = responses.filter(v => v.response === "◎").length;
      const isPast = rCoDate < today;
      const rCoLabel = (typeof formatDateFull === "function") ? formatDateFull(rCoDate) : rCoDate;

      if (r.status === "選定済") {
        actions.push({
          icon: "bi-check2-circle",
          color: "info",
          text: `${rCoLabel} — スタッフ選定済み → 確定してください`,
          id: r.id,
          action: "confirm",
        });
      } else if (maru > 0) {
        actions.push({
          icon: "bi-person-plus",
          color: "warning",
          text: `${rCoLabel} — ◎${maru}名回答あり → スタッフを選定してください`,
          id: r.id,
          action: "select",
        });
      } else if (!isPast) {
        actions.push({
          icon: "bi-exclamation-triangle",
          color: "danger",
          text: `${rCoLabel} — 回答なし！スタッフに連絡してください`,
          id: r.id,
          action: "detail",
        });
      }
    });

    const container = document.getElementById("todayActions");
    if (!actions.length) {
      container.innerHTML = "";
      return;
    }

    container.innerHTML = `
      <div class="card border-warning">
        <div class="card-header bg-warning bg-opacity-10 py-2">
          <strong><i class="bi bi-bell"></i> 要対応（${actions.length}件）</strong>
        </div>
        <div class="list-group list-group-flush">
          ${actions.map(a => `
            <button class="list-group-item list-group-item-action d-flex align-items-center action-item"
              data-id="${a.id}" data-action="${a.action}">
              <i class="bi ${a.icon} text-${a.color} me-2 fs-5"></i>
              <span>${this.esc(a.text)}</span>
              <i class="bi bi-chevron-right ms-auto"></i>
            </button>
          `).join("")}
        </div>
      </div>
    `;

    container.querySelectorAll(".action-item").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const r = this.recruitments.find(x => x.id === id);
        if (r) this.openRecruitmentModal(r);
      });
    });
  },

  initCalendar() {
    const calendarEl = document.getElementById("dashboardCalendar");
    if (!calendarEl) return;

    this.calendar = new FullCalendar.Calendar(calendarEl, {
      initialView: "dayGridMonth",
      locale: "ja",
      headerToolbar: {
        left: "prev,next today",
        center: "title",
        right: "dayGridMonth,listWeek",
      },
      height: "auto",
      events: this.buildCalendarEvents(),
      eventClick: (info) => this.onEventClick(info),
      dateClick: (info) => this.onDateClick(info),
      dayMaxEvents: 4,
      eventDisplay: "block",
      eventOrder: "order",

      // ステータスドットを動的注入
      eventDidMount: (info) => {
        const el = info.el;
        const props = info.event.extendedProps;
        const titleEl = el.querySelector(".fc-event-title") || el.querySelector(".fc-list-event-title");
        if (!titleEl) return;

        // 予約イベント → 名簿ステータスドット
        if (props.type === "booking") {
          const dotClass = props.rosterAnswered ? "dot-roster-ok" : "dot-roster-ng";
          const dotTitle = props.rosterAnswered ? "名簿記入済み" : "名簿未記入";
          const dot = document.createElement("span");
          dot.className = `event-status-dot ${dotClass}`;
          dot.title = dotTitle;
          titleEl.prepend(dot);

          // ソース名をツールチップに追加
          if (props.source) {
            el.title = `${props.source} / ${props.rosterAnswered ? "名簿済" : "名簿未"}`;
          }
        }

        // 清掃イベント → ツールチップ
        if (props.type === "recruitment") {
          const d = props.data;
          const responses = d.responses || [];
          const names = responses.map(r => `${r.staffName || "?"}:${r.response}`).join(", ");
          el.title = names || "回答なし";
        }
      },
    });
    this.calendar.render();
  },

  // 予約ソースから色クラスを判定（複数フィールドから総合判断）
  getPlatformClass(booking) {
    if (!booking) return "fc-event-other";
    // 全フィールドを文字列化して結合（null/undefined/数値も安全に処理）
    const toStr = (v) => (v == null ? "" : String(v));
    const fields = [
      toStr(booking.source), toStr(booking.bookingSite), toStr(booking.beds24Source),
      toStr(booking.guestName), toStr(booking._sourceType),
      toStr(booking.icalUrl), toStr(booking.syncSource),
    ].join(" ").toLowerCase();

    if (fields.includes("airbnb")) return "fc-event-airbnb";
    if (fields.includes("booking.com") || fields.includes("booking com") || fields.includes("bookingcom")) return "fc-event-booking-com";
    if (fields.includes("beds24")) return "fc-event-direct";
    if (fields.includes("direct") || fields.includes("手動") || fields.includes("manual")) return "fc-event-direct";

    // sourceが不明な場合、guestMap（名簿）のbookingSiteで補完
    if (this.guestMap) {
      const ci = this.toDateStr(booking.checkIn);
      // 複合キー優先、フォールバックで CI日のみ
      const g = ci ? (this.guestMap[`${booking.propertyId}_${ci}`] || this.guestMap[ci]) : null;
      if (g && g.bookingSite) {
        const bs = g.bookingSite.toLowerCase();
        if (bs.includes("airbnb")) return "fc-event-airbnb";
        if (bs.includes("booking")) return "fc-event-booking-com";
      }
    }

    return "fc-event-other";
  },

  // プレースホルダーゲスト名判定（iCal ブロック・予約サイト自動入力）
  _isPlaceholderName(name) {
    if (!name) return true;
    const n = name.trim().toLowerCase();
    return !n || n === "-" ||
      n.includes("airbnb") || n.includes("booking.com") || n.includes("booking") ||
      n.includes("not available") || n.includes("blocked") || n.includes("closed") ||
      n === "reserved" || n.startsWith("reserved");
  },

  // 名簿の記入済み判定
  hasGuestRegistration(booking, guestMap) {
    // 予約自体がプレースホルダーなら名簿未記入扱い（カレンダー・詳細ともに統一）
    if (this._isPlaceholderName(booking.guestName)) return false;

    const gm = guestMap || this.guestMap;
    if (!gm) return false;
    const ci = this.toDateStr(booking.checkIn);
    if (!ci) return false;
    // 複合キー (propertyId + CI) で厳密に照合。
    // CI 単独キーへの fallback は別物件の同日名簿を誤って拾うため撤去。
    // propertyId 未設定の古い名簿は CI 単独キーで取るが、その guest 側も propertyId を持たない場合に限る。
    let g = null;
    if (booking.propertyId) {
      g = gm[`${booking.propertyId}_${ci}`] || null;
    } else {
      const cand = gm[ci];
      if (cand && !cand.propertyId) g = cand;
    }
    if (!g) return false;
    // guestRegistrations 側の名前もプレースホルダーなら未記入扱い
    if (this._isPlaceholderName(g.guestName)) return false;
    return true;
  },

  buildCalendarEvents() {
    const events = [];

    // 同じCO日・workType に複数のrecruitmentがある場合、優先度の高い1件だけ使う
    // キー: "{日付}_{workType}" — 清掃と直前点検は別枠で管理して重複排除
    // 優先度: スタッフ確定済み > 選定済 > 募集中 > それ以外
    const STATUS_PRIORITY = { "スタッフ確定済み": 4, "選定済": 3, "募集中": 2 };
    const recruitByCoDate = {};
    this.recruitments.forEach(r => {
      const coStr = this.toDateStr(r.checkoutDate);
      if (!coStr) return;
      // workType が pre_inspection の場合は別キーで管理
      const wt = r.workType === "pre_inspection" ? "pre" : "clean";
      const key = coStr + "_" + wt;
      const existing = recruitByCoDate[key];
      const newPri = STATUS_PRIORITY[r.status] || 1;
      const existPri = existing ? (STATUS_PRIORITY[existing.status] || 1) : 0;
      if (!existing || newPri > existPri) recruitByCoDate[key] = r;
    });

    // === 宿泊イベント（プラットフォーム別色分け + 名簿ステータスドット） ===
    this.bookings.forEach(b => {
      const ci = this.toDateStr(b.checkIn);
      const co = this.toDateStr(b.checkOut);
      if (!ci) return;
      // 物件フィルタ: propertyId が設定されていてフィルタ OFF の場合はスキップ
      if (b.propertyId && this.propertyFilter[b.propertyId] === false) return;

      const platformClass = this.getPlatformClass(b);
      const rosterOk = this.hasGuestRegistration(b);
      const guestCount = b.guestCount ? `(${b.guestCount}名)` : "";
      const title = (b.guestName || "予約") + " " + guestCount;

      // CO日に募集があるか → 清掃担当の名前を取得
      const recruit = co ? recruitByCoDate[co] : null;
      const cleaningInfo = recruit && recruit.status === "スタッフ確定済み" ? recruit.selectedStaff : "";

      events.push({
        id: "b_" + b.id,
        title: title,
        start: ci,
        end: co || ci,
        allDay: true,
        order: 1,
        classNames: [platformClass],
        borderColor: "transparent",
        extendedProps: {
          type: "booking",
          data: b,
          rosterAnswered: rosterOk,
          cleaningStaff: cleaningInfo,
          source: b.source || b.bookingSite || "",
        },
      });
    });

    // === 清掃/募集イベント（同日重複は除外済みのrecruitByCoDateを使用） ===
    Object.values(recruitByCoDate).forEach(r => {
      const coStr = this.toDateStr(r.checkoutDate);
      if (!coStr) return;
      // 物件フィルタ: propertyId が設定されていてフィルタ OFF の場合はスキップ
      if (r.propertyId && this.propertyFilter[r.propertyId] === false) return;
      const responses = r.responses || [];
      const maru = responses.filter(v => v.response === "◎").length;
      const sankaku = responses.filter(v => v.response === "△").length;
      const totalResp = responses.length;

      const isPre = r.workType === "pre_inspection";
      const wtPrefix = isPre ? "[直] " : "[清] ";
      const wtIcon = isPre ? "🔍 " : "🧹 ";
      // 直前点検は紫系クラス、清掃は既存の緑/黄/赤系クラスを使用
      const cssBase = isPre ? "fc-event-pre-inspection" : "fc-event-cleaning";
      let cssClass, title;
      if (r.status === "スタッフ確定済み") {
        cssClass = cssBase + "-decided";
        title = wtPrefix + wtIcon + (r.selectedStaff || "確定");
      } else if (r.status === "選定済") {
        cssClass = cssBase + "-selected";
        title = wtPrefix + wtIcon + (r.selectedStaff || "") + "(選定済)";
      } else if (maru > 0) {
        cssClass = cssBase;
        title = wtPrefix + wtIcon + "募集中 ◎" + maru + (sankaku ? " △" + sankaku : "");
      } else if (totalResp > 0) {
        cssClass = cssBase;
        title = wtPrefix + wtIcon + "募集中 (△" + sankaku + " ×" + (totalResp - sankaku) + ")";
      } else {
        cssClass = cssBase + "-noresponse";
        title = wtPrefix + wtIcon + "募集中（回答なし）";
      }

      events.push({
        id: "r_" + r.id,
        title: title,
        start: coStr,
        allDay: true,
        order: 0,
        classNames: [cssClass],
        borderColor: "transparent",
        extendedProps: {
          type: "recruitment",
          data: r,
          recruitStatus: r.status,
          responseCount: totalResp,
          maruCount: maru,
        },
      });
    });

    return events;
  },

  // === 日付クリック → 物件選択 → 募集作成 ===
  async onDateClick(info) {
    const dateStr = info.dateStr;
    // 既にその日の募集があるか（複数物件対応: 同日複数募集があれば最初の1件を開く）
    const existing = this.recruitments.find(r => this.toDateStr(r.checkoutDate) === dateStr);
    if (existing) {
      this.openRecruitmentModal(existing);
      return;
    }

    // 物件選択
    const activeProps = this.properties.filter(p => p.active !== false);
    let propertyId, propertyName;

    if (activeProps.length === 0) {
      await showAlert("有効な物件がありません。物件管理画面で物件を追加してください。");
      return;
    } else if (activeProps.length === 1) {
      // 1件のみなら自動選択
      propertyId = activeProps[0].id;
      propertyName = activeProps[0].name;
    } else {
      // 複数ある場合はラジオボタンで選択
      const radioHtml = activeProps.map((p, i) => `
        <div class="form-check">
          <input class="form-check-input" type="radio" name="propSelect" id="propOpt${i}" value="${p.id}" ${i === 0 ? "checked" : ""}>
          <label class="form-check-label" for="propOpt${i}">${this.esc(p.name)}</label>
        </div>
      `).join("");

      // Bootstrap モーダルで物件選択
      const ok = await this._showPropertySelectModal(dateStr, radioHtml);
      if (!ok) return; // キャンセル
      const checkedInput = document.querySelector('input[name="propSelect"]:checked');
      if (!checkedInput) return;
      propertyId = checkedInput.value;
      const selected = activeProps.find(p => p.id === propertyId);
      propertyName = selected ? selected.name : "";
    }

    const confirmed = await showConfirm(`${dateStr} (${propertyName}) の清掃募集を作成しますか？`, { title: "募集作成", okLabel: "作成" });
    if (!confirmed) return;

    try {
      const created = await API.recruitments.create({ checkoutDate: dateStr, propertyId, propertyName });
      showToast("完了", `${dateStr} の募集を作成しました`, "success");
      // リロード
      this.recruitments = await API.recruitments.list();
      this.calendar.removeAllEvents();
      this.calendar.addEventSource(this.buildCalendarEvents());
      this.renderStats();
      this.renderTodayActions();
      // 作成した募集を開く
      this.openRecruitmentModal({ ...created, responses: [] });
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  // 物件選択用モーダル（Promise<boolean>）
  _showPropertySelectModal(dateStr, radioHtml) {
    return new Promise((resolve) => {
      const modalId = "dashPropSelectModal";
      let el = document.getElementById(modalId);
      if (!el) {
        const div = document.createElement("div");
        div.innerHTML = `
          <div class="modal fade" id="${modalId}" tabindex="-1">
            <div class="modal-dialog modal-dialog-centered">
              <div class="modal-content">
                <div class="modal-header py-2">
                  <h6 class="modal-title" id="${modalId}Title">物件を選択</h6>
                  <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                </div>
                <div class="modal-body" id="${modalId}Body"></div>
                <div class="modal-footer py-2">
                  <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">キャンセル</button>
                  <button type="button" class="btn btn-primary btn-sm" id="${modalId}Ok">選択</button>
                </div>
              </div>
            </div>
          </div>`;
        document.body.appendChild(div.firstElementChild);
        el = document.getElementById(modalId);
      }

      document.getElementById(`${modalId}Title`).textContent = `物件を選択（${dateStr}）`;
      document.getElementById(`${modalId}Body`).innerHTML = radioHtml;

      const modal = bootstrap.Modal.getOrCreateInstance(el);
      let resolved = false;

      const okBtn = document.getElementById(`${modalId}Ok`);
      const onOk = () => { resolved = true; modal.hide(); resolve(true); };
      okBtn.replaceWith(okBtn.cloneNode(true)); // 旧イベント除去
      document.getElementById(`${modalId}Ok`).addEventListener("click", onOk, { once: true });

      el.addEventListener("hidden.bs.modal", () => { if (!resolved) resolve(false); }, { once: true });
      modal.show();
    });
  },

  onEventClick(info) {
    const { type, data } = info.event.extendedProps;
    if (type === "recruitment") {
      this.openRecruitmentModal(data);
    } else if (type === "booking") {
      this.showBookingModal(data);
    }
  },

  // === 募集詳細モーダル（回答・選定・確定まで完結） ===
  openRecruitmentModal(r) {
    const responses = r.responses || [];
    const maru = responses.filter(v => v.response === "◎");
    const sankaku = responses.filter(v => v.response === "△");
    const batsu = responses.filter(v => v.response === "×");

    const statusBadge = {
      "募集中": '<span class="badge bg-primary">募集中</span>',
      "選定済": '<span class="badge bg-warning text-dark">選定済</span>',
      "スタッフ確定済み": '<span class="badge bg-success">確定済み</span>',
    }[r.status] || `<span class="badge bg-secondary">${this.esc(r.status)}</span>`;

    // 回答マップ — staffId, staffEmail, staffName の全てで引けるようにする
    const responseByKey = {};
    responses.forEach(v => {
      if (v.staffId) responseByKey["id:" + v.staffId] = v;
      if (v.staffEmail) responseByKey["email:" + v.staffEmail.toLowerCase().trim()] = v;
      if (v.staffName) responseByKey["name:" + v.staffName.trim()] = v;
      // 旧GASデータ互換: 名前だけで入っている場合
      const nameKey = (v.staffName || v["スタッフ名"] || "").trim();
      if (nameKey) responseByKey["name:" + nameKey] = v;
    });

    // 全スタッフの回答状況
    const allEntries = this.staffList.map(s => {
      // 複数キーで検索（staffId優先 → email → 名前）
      const v = responseByKey["id:" + s.id]
        || (s.email ? responseByKey["email:" + s.email.toLowerCase().trim()] : null)
        || responseByKey["name:" + s.name.trim()]
        || null;
      return { name: s.name, email: s.email, id: s.id, response: v?.response || "未回答", memo: v?.memo || "" };
    });

    // staffListにないがresponsesにあるエントリも追加（旧データの名前不一致対応）
    responses.forEach(v => {
      const nameOrEmail = v.staffName || v.staffEmail || "";
      const alreadyMatched = allEntries.some(e =>
        e.response !== "未回答" && (
          (v.staffId && e.id === v.staffId) ||
          (v.staffEmail && e.email?.toLowerCase() === v.staffEmail.toLowerCase()) ||
          (v.staffName && e.name === v.staffName)
        )
      );
      if (!alreadyMatched && nameOrEmail) {
        allEntries.push({ name: v.staffName || v.staffEmail, email: v.staffEmail || "", id: v.staffId || "", response: v.response, memo: v.memo || "" });
      }
    });

    // 回答状況はバッジで表示のみ（代理回答は不可。各スタッフが清掃スケジュールページから回答する）
    const respondBadge = (s) => {
      if (s.response === "◎") return '<span class="badge bg-success">◎</span>';
      if (s.response === "△") return '<span class="badge bg-warning text-dark">△</span>';
      if (s.response === "×") return '<span class="badge bg-danger">×</span>';
      return '<span class="badge bg-secondary">未回答</span>';
    };

    const candidates = allEntries.filter(s => s.response === "◎" || s.response === "△");
    const currentSelected = (r.selectedStaff || "").split(",").map(s => s.trim()).filter(Boolean);
    const selectorHtml = candidates.length > 0 ? `
      <div class="mt-3 border-top pt-3">
        <strong>スタッフ選定</strong>
        <div class="mt-2">
          ${candidates.map(c => `
            <div class="form-check form-check-inline">
              <input class="form-check-input staff-sel-cb" type="checkbox" value="${this.esc(c.name)}"
                ${currentSelected.includes(c.name) ? "checked" : ""}>
              <label class="form-check-label">${this.esc(c.name)} <span class="badge ${c.response === "◎" ? "bg-success" : "bg-warning text-dark"}">${c.response}</span></label>
            </div>
          `).join("")}
        </div>
        <button class="btn btn-primary btn-sm mt-2" id="calBtnSelect">
          <i class="bi bi-person-check"></i> 選定
        </button>
        ${r.selectedStaff ? `
          <button class="btn btn-success btn-sm mt-2 ms-1" id="calBtnConfirm">
            <i class="bi bi-check-circle"></i> 確定
          </button>
        ` : ""}
      </div>
    ` : '<p class="text-muted small mt-3">◎/△の回答がないため選定できません</p>';

    const reopenBtn = r.status === "スタッフ確定済み" ? `
      <button class="btn btn-outline-primary btn-sm mt-2" id="calBtnReopen">
        <i class="bi bi-arrow-counterclockwise"></i> 募集再開
      </button>
    ` : "";

    // モーダルがなければ作成、あれば再利用
    let modalEl = document.getElementById("calendarEventModal");
    if (!modalEl) {
      const div = document.createElement("div");
      div.innerHTML = `
        <div class="modal fade" id="calendarEventModal" tabindex="-1">
          <div class="modal-dialog"><div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title" id="calEventTitle"></h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body" id="calEventBody"></div>
          </div></div>
        </div>`;
      document.body.appendChild(div.firstElementChild);
      modalEl = document.getElementById("calendarEventModal");
    }

    document.getElementById("calEventTitle").innerHTML =
      `清掃 ${this.toDateStr(r.checkoutDate)} ${statusBadge}`;
    document.getElementById("calEventBody").innerHTML = `
      ${r.selectedStaff ? `<div class="mb-2"><i class="bi bi-person-check text-success"></i> <strong>${this.esc(r.selectedStaff)}</strong></div>` : ""}
      <div class="d-flex gap-1 mb-2">
        ${maru.length ? `<span class="badge bg-success">◎${maru.length}</span>` : ""}
        ${sankaku.length ? `<span class="badge bg-warning text-dark">△${sankaku.length}</span>` : ""}
        ${batsu.length ? `<span class="badge bg-danger">×${batsu.length}</span>` : ""}
      </div>
      <table class="table table-sm mb-0">
        <thead><tr><th>スタッフ</th><th>回答</th></tr></thead>
        <tbody>
          ${allEntries.map(s => `
            <tr>
              <td>${this.esc(s.name)}</td>
              <td>${respondBadge(s)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      ${selectorHtml}
      ${reopenBtn}
      <hr class="mt-3">
      <button class="btn btn-outline-danger btn-sm" id="calBtnDelete">
        <i class="bi bi-trash"></i> この募集を削除
      </button>
    `;

    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();

    // 選定ボタン
    const selBtn = modalEl.querySelector("#calBtnSelect");
    if (selBtn) {
      selBtn.addEventListener("click", async () => {
        const selected = [];
        modalEl.querySelectorAll(".staff-sel-cb:checked").forEach(cb => selected.push(cb.value));
        if (!selected.length) {
          const ok = await showConfirm("スタッフを全員外して募集中に戻しますか？");
          if (!ok) return;
        }
        try {
          await API.recruitments.selectStaff(r.id, selected.join(","));
          const msg = selected.length ? `${selected.join(",")} を選定` : "スタッフを解除し、募集中に戻しました";
          showToast("完了", msg, "success");
          modal.hide();
          this.recruitments = await API.recruitments.list();
          this.refreshCalendar();
          this.renderStats();
          this.renderTodayActions();
          const updated = this.recruitments.find(x => x.id === r.id);
          if (updated) this.openRecruitmentModal(updated);
        } catch (e) { showToast("エラー", e.message, "error"); }
      });
    }

    // 確定ボタン
    const confBtn = modalEl.querySelector("#calBtnConfirm");
    if (confBtn) {
      confBtn.addEventListener("click", async () => {
        if (!await showConfirm(`${r.selectedStaff} を確定しますか？`, { title: "確定", okLabel: "確定する" })) return;
        try {
          await API.recruitments.confirm(r.id);
          showToast("完了", "スタッフ確定しました", "success");
          modal.hide();
          this.recruitments = await API.recruitments.list();
          this.refreshCalendar();
          this.renderStats();
          this.renderTodayActions();
        } catch (e) { showToast("エラー", e.message, "error"); }
      });
    }

    // 再開ボタン
    const reopenBtnEl = modalEl.querySelector("#calBtnReopen");
    if (reopenBtnEl) {
      reopenBtnEl.addEventListener("click", async () => {
        if (!await showConfirm("募集を再開しますか？", { title: "募集再開", okLabel: "再開" })) return;
        try {
          await API.recruitments.reopen(r.id);
          showToast("完了", "募集を再開しました", "success");
          modal.hide();
          this.recruitments = await API.recruitments.list();
          this.refreshCalendar();
          this.renderStats();
          this.renderTodayActions();
        } catch (e) { showToast("エラー", e.message, "error"); }
      });
    }

    // 削除ボタン
    const deleteBtn = modalEl.querySelector("#calBtnDelete");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", async () => {
        const coDate = this.toDateStr(r.checkoutDate);
        if (!await showConfirm(`${coDate} の募集を削除しますか？この操作は取り消せません。`, { title: "削除確認", okLabel: "削除" })) return;
        try {
          await db.collection("recruitments").doc(r.id).delete();
          showToast("完了", `${coDate} の募集を削除しました`, "success");
          modal.hide();
          // データを再読み込み
          const snap = await db.collection("recruitments").get();
          this.recruitments = snap.docs.map(doc => {
            const d = doc.data();
            const coRaw = d.checkoutDate || d.checkOutDate || "";
            return { id: doc.id, ...d, checkoutDate: this.toDateStr(coRaw), responses: d.responses || [] };
          });
          this.refreshCalendar();
          this.renderStats();
          this.renderTodayActions();
        } catch (e) { showToast("エラー", e.message, "error"); }
      });
    }
  },

  showBookingModal(b, ctx = {}) {
    // ctx で外部 (my-recruitment など) からデータを注入可能。省略時は DashboardPage 自身の state を使う
    const bookings = ctx.bookings || this.bookings || [];
    const recruitments = ctx.recruitments || this.recruitments || [];
    const guestMap = ctx.guestMap || this.guestMap || {};
    const onGuestCountSaved = ctx.onGuestCountSaved || (() => this.refreshCalendar && this.refreshCalendar());
    // viewMode: "owner"(デフォルト) | "staff"
    // staff 指定時は PII (住所/電話/メール/旅券/前後泊/緊急連絡先/パスポート写真/照合メール) を非表示にし
    // 宿泊人数編集 UI を読み取り表示へ差し替える。同行者表の住所/旅券番号列も省略。
    const viewMode = ctx.viewMode || "owner";
    const isStaffView = viewMode === "staff";

    let modalEl = document.getElementById("calendarEventModal");
    if (!modalEl) {
      const div = document.createElement("div");
      div.innerHTML = `<div class="modal fade" id="calendarEventModal" tabindex="-1"><div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h5 class="modal-title" id="calEventTitle"></h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body" id="calEventBody"></div></div></div></div>`;
      document.body.appendChild(div.firstElementChild);
      modalEl = document.getElementById("calendarEventModal");
    }

    const ci = this.toDateStr(b.checkIn);
    const co = this.toDateStr(b.checkOut);
    const source = b.source || b.bookingSite || "";
    const rosterOk = this.hasGuestRegistration(b, guestMap);

    // ソースバッジ
    const sourceBadge = source.toLowerCase().includes("airbnb")
      ? '<span class="badge" style="background:#FF5A5F;color:#fff">Airbnb</span>'
      : source.toLowerCase().includes("booking")
        ? '<span class="badge" style="background:#003580;color:#fff">Booking.com</span>'
        : source ? `<span class="badge bg-secondary">${this.esc(source)}</span>` : "";

    // 名簿バッジ
    const rosterBadge = rosterOk
      ? '<span class="badge bg-success"><i class="bi bi-check-circle"></i> 名簿記入済み</span>'
      : '<span class="badge bg-danger"><i class="bi bi-exclamation-circle"></i> 名簿未記入</span>';

    // GAS版インポートボタン (Webアプリ管理者のみ・CI日が確定している場合)
    const isOwnerForBtn = (typeof Auth !== "undefined") && Auth?.isOwner?.();
    const gasImportBtn = (isOwnerForBtn && !isStaffView && ci)
      ? `<button type="button" class="btn btn-outline-info btn-sm py-0 px-2" id="btnGasImportForBooking"
           data-ci="${this.esc(ci)}" data-pid="${this.esc(b.propertyId || "")}"
           style="font-size:0.75rem;" title="GAS版スプレッドシートから ${this.esc(ci)} の宿泊者名簿を取り込み">
           <i class="bi bi-cloud-download"></i> GAS版から取り込み
         </button>
         <span id="gasImportStatusInline" class="small ms-1"></span>`
      : "";

    // CO日の清掃募集を検索 (propertyId 必須: 同日他物件の募集と混ざらないように)
    const recruit = co
      ? recruitments.find(r =>
          this.toDateStr(r.checkoutDate) === co
          && r.propertyId === b.propertyId
          && (r.workType || "cleaning_by_count") !== "pre_inspection"
        )
      : null;
    let cleaningHtml = '<span class="text-muted">募集なし</span>';
    if (recruit) {
      if (recruit.status === "スタッフ確定済み") {
        cleaningHtml = `<span class="badge bg-success"><i class="bi bi-person-check"></i> ${this.esc(recruit.selectedStaff)}</span>`;
      } else if (recruit.status === "選定済") {
        cleaningHtml = `<span class="badge bg-info text-dark"><i class="bi bi-person"></i> ${this.esc(recruit.selectedStaff)}（選定済）</span>`;
      } else {
        const resp = recruit.responses || [];
        const m = resp.filter(v => v.response === "◎").length;
        cleaningHtml = `<span class="badge bg-warning text-dark">募集中</span>`;
        if (m > 0) cleaningHtml += ` <span class="badge bg-success">◎${m}</span>`;
        if (resp.length === 0) cleaningHtml = `<span class="badge bg-danger">募集中（回答なし）</span>`;
      }
    }

    // 照合メール情報 (Webアプリ管理者限定 + viewMode=staff では更に非表示)
    // クリックでモーダルを閉じ、アプリ内「メール照合」画面の該当行にフォーカス遷移
    const isOwnerView = (typeof Auth !== "undefined") && Auth?.isOwner?.();
    let gmailRow = "";
    if (isOwnerView && !isStaffView) {
      if (b.emailMessageId || b.emailThreadId || b.emailSubject) {
        const verifiedStr = b.emailVerifiedAt ? (typeof formatDateFull === "function" ? formatDateFull(b.emailVerifiedAt) : this.toDateStr(b.emailVerifiedAt)) : "";
        const subjectText = b.emailSubject ? this.esc(b.emailSubject) : "(件名未取得)";
        const focusId = b.emailMessageId || "";
        gmailRow = `<tr><th class="text-muted">照合メール</th><td>
          <a href="javascript:void(0)" class="small d-block ev-focus-link"
             data-ev-focus-id="${this.esc(focusId)}" style="text-decoration:none">
            <i class="bi bi-envelope-check text-success"></i> ${subjectText}
            ${verifiedStr ? `<span class="text-muted ms-1">/ ${this.esc(verifiedStr)}</span>` : ""}
          </a>
          <small class="text-muted">タップで「メール照合」画面へ</small>
        </td></tr>`;
      } else {
        gmailRow = `<tr><th class="text-muted">照合メール</th><td>
          <small class="text-muted"><i class="bi bi-envelope-slash"></i> 未照合</small>
        </td></tr>`;
      }
    }

    // 名簿データ取得 (複合キー or CIキー の両方を試す)
    const guestKey1 = b.propertyId && ci ? `${b.propertyId}_${ci}` : null;
    const guestData = (guestKey1 && guestMap[guestKey1]) || (ci && guestMap[ci]) || {};
    // 値表示ヘルパ: 空なら "-"
    const v = (val) => {
      if (val === null || val === undefined || val === "") return "-";
      return this.esc(String(val));
    };
    // URL linkify 版 (エスケープ済み→リンク化)
    const vl = (val) => {
      if (val === null || val === undefined || val === "") return "-";
      const escaped = this.esc(String(val));
      return (typeof linkifyUrls === "function") ? linkifyUrls(escaped) : escaped;
    };
    // 日付ヘルパ: YYYY年M月D日(曜) 形式
    const vd = (val) => {
      if (!val) return "-";
      return (typeof formatDateFull === "function") ? formatDateFull(val) : this.esc(String(val));
    };
    // BBQ (true/false/"Yes"/"No" 等) → ◎×−
    const vb = (val) => (typeof bbqToSymbol === "function") ? bbqToSymbol(val) : v(val);
    // 代表者年齢 (allGuests[0].age)
    const repAge = guestData.allGuests?.[0]?.age || "";
    // 駐車場割当テキスト
    const parkingAllocText = (guestData.parkingAllocation || []).map(a =>
      `${a.index}台目(${this.esc(a.vehicleType || "")}) → ${this.esc(a.spot || "")}`
    ).join("<br>") || "-";
    // 車種
    const vehicleTypes = Array.isArray(guestData.vehicleTypes) && guestData.vehicleTypes.length
      ? guestData.vehicleTypes.map(x => this.esc(x)).join(", ") : "-";
    // 同意バッジ
    const noiseBadge = guestData.noiseAgree
      ? '<span class="badge bg-success">同意済</span>'
      : '<span class="badge bg-danger">未同意</span>';
    // 同行者
    const companions = guestData.guests || [];
    const companionsHtml = companions.length > 0 ? `
      <hr>
      <h6 class="mb-2"><i class="bi bi-people"></i> 同行者（${companions.length}名）</h6>
      <div class="table-responsive">
        <table class="table table-sm table-bordered mb-0">
          <thead class="table-light"><tr>
            <th>氏名</th>
            <th>年齢</th>
            ${isStaffView ? "" : "<th>住所</th>"}
            <th>国籍</th>
            ${isStaffView ? "" : "<th>旅券番号</th>"}
          </tr></thead>
          <tbody>
            ${companions.map(c => `<tr>
              <td>${this.esc(c.name || "-")}</td>
              <td>${this.esc(c.age || "-")}</td>
              ${isStaffView ? "" : `<td>${this.esc(c.address || "-")}</td>`}
              <td>${this.esc(c.nationality || "日本")}</td>
              ${isStaffView ? "" : `<td>${this.esc(c.passportNumber || "-")}</td>`}
            </tr>`).join("")}
          </tbody>
        </table>
      </div>` : "";
    // パスポート写真
    const passportPhotos = [];
    if (guestData.passportPhotoUrl) passportPhotos.push({ name: guestData.guestName || "代表者", url: guestData.passportPhotoUrl });
    companions.forEach(c => { if (c.passportPhotoUrl) passportPhotos.push({ name: c.name || "同行者", url: c.passportPhotoUrl }); });
    const passportHtml = passportPhotos.length > 0 ? `
      <hr>
      <h6 class="mb-2"><i class="bi bi-image"></i> パスポート写真</h6>
      <div class="d-flex flex-wrap gap-2">
        ${passportPhotos.map(p => `<a href="${this.esc(p.url)}" target="_blank" rel="noopener" class="text-center">
          <img src="${this.esc(p.url)}" alt="${this.esc(p.name)}" style="max-width:140px;max-height:110px;border-radius:6px;border:1px solid #dee2e6;">
          <small class="d-block text-muted">${this.esc(p.name)}</small>
        </a>`).join("")}
      </div>` : "";

    // nextBookingBlock は募集詳細モーダルに移植したため予約詳細モーダルでは表示しない

    // 物件オブジェクト取得 (ctx.properties 優先, 次に this.properties)
    const prop =
      ((ctx.properties && ctx.properties.find && ctx.properties.find(p => p.id === b.propertyId)) || null) ||
      ((this.properties || []).find(p => p.id === b.propertyId)) ||
      {};
    // 物件名バッジ: b.propertyName → 未設定なら prop.name → 空
    const propNameForTitle = b.propertyName || prop.name || "";
    // 番号バッジ (prop.propertyNumber + prop.color) — シャープ無し、数字のみ
    const propNumberBadge = (prop.propertyNumber !== undefined && prop.propertyNumber !== null && prop.propertyNumber !== "")
      ? `<span style="display:inline-block;background:${this.esc(prop.color || "#6c757d")};color:#fff;padding:2px 8px;border-radius:4px;margin-right:4px;font-weight:600;font-size:0.85em;">${this.esc(String(prop.propertyNumber))}</span>`
      : "";
    const propNameBadge = propNameForTitle
      ? `<span class="badge bg-light text-dark border ms-2" style="font-weight:500;">${propNumberBadge}${this.esc(propNameForTitle)}</span>`
      : "";
    document.getElementById("calEventTitle").innerHTML = `<i class="bi bi-calendar-event"></i> 予約詳細 ${propNameBadge} ${sourceBadge}`;

    // 宿泊者名簿 表示/非表示判定
    // 保存先まとめ:
    //   A) 固定項目 (bbq/bedChoice/transport/carCount/paidParking など facility):
    //      formSectionConfig[section].fieldHidden[fieldId] = true
    //   B) 標準項目オーバーライド (g-address/g-phone/purpose 等):
    //      formFieldConfig.overrides[fieldId].hidden = true
    //   C) セクション全体非表示:
    //      formSectionConfig[section].hidden = true
    //   D) 独自フォーム (customFormEnabled=true) の追加カスタム項目:
    //      customFormFields[] に hidden=true、または存在しない
    const fieldOverrides = (prop.formFieldConfig && prop.formFieldConfig.overrides) || {};
    const secCfg = prop.formSectionConfig || {};
    const useCustomForm = prop.customFormEnabled === true && Array.isArray(prop.customFormFields) && prop.customFormFields.length > 0;
    // customFormFields を id → field のマップに展開
    // ※ customFormFields は「カスタム追加項目」を保持するもので、固定項目 (bbq 等) は
    //   含まれない。固定項目の非表示は formSectionConfig.fieldHidden で制御される。
    const customMap = {};
    if (useCustomForm) {
      prop.customFormFields.forEach(f => {
        if (f && f.id) customMap[f.id] = f;
      });
    }
    // 固定項目 ID 一覧（customFormFields に出ていなくても非表示扱いにしないため）
    const FIXED_FIELD_IDS = new Set([
      "checkOut","checkOutTime","guestCount","guestCountInfants","bookingSite",
      "transport","taxiAgree","carCount","neighborAgree","paidParking",
      "bbq","bbqRule1","bbqRule2","bbqRule3","bbqRule4","bbqRule5","bedChoice",
      "purpose","previousStay","nextStay",
      "emergencyName","emergencyPhone",
      "noiseAgree","houseRuleAgree",
    ]);
    const isFieldVisible = (fieldId, sectionId) => {
      // 1. セクション全体が非表示なら非表示
      if (sectionId && secCfg[sectionId] && secCfg[sectionId].hidden === true) return false;
      // 2. 固定項目の個別非表示 (formSectionConfig[sec].fieldHidden[fid])
      if (sectionId && fieldId) {
        const fh = secCfg[sectionId] && secCfg[sectionId].fieldHidden;
        if (fh && fh[fieldId] === true) return false;
      }
      // 3. 標準項目オーバーライド (formFieldConfig.overrides)
      if (fieldId && fieldOverrides[fieldId] && fieldOverrides[fieldId].hidden === true) return false;
      // 4. 独自フォーム使用時のカスタム項目チェック
      //    - 固定項目は customFormFields に無くても表示維持
      //    - カスタム項目は配列に存在しない / hidden=true なら非表示
      if (useCustomForm && fieldId && !FIXED_FIELD_IDS.has(fieldId)) {
        const f = customMap[fieldId];
        if (!f) return false;
        if (f.hidden === true) return false;
      }
      return true;
    };
    const isSectionVisible = (sectionId) => !(secCfg[sectionId] && secCfg[sectionId].hidden === true);
    // フィールド行ヘルパ: visible なら html を返す, それ以外は ""
    const fRow = (fieldId, sectionId, html) => isFieldVisible(fieldId, sectionId) ? html : "";
    // staff & visibility 両方を満たす場合のみ表示
    const fRowStaff = (fieldId, sectionId, html) => (isStaffView ? "" : fRow(fieldId, sectionId, html));
    document.getElementById("calEventBody").innerHTML = `
      <div class="d-flex gap-2 mb-3 flex-wrap align-items-center">${rosterBadge}${gasImportBtn}</div>

      <h6 class="mb-2 text-primary">基本情報</h6>
      <table class="table table-sm table-borderless mb-2">
        ${isStaffView ? "" : `<tr><th width="110" class="text-muted">ゲスト名</th><td class="fw-bold">${v(b.guestName)}</td></tr>`}
        <tr><th width="110" class="text-muted">チェックイン</th><td>${vd(ci)} <strong>${this.esc(guestData.checkInTime || "--:--")}</strong></td></tr>
        <tr><th class="text-muted">チェックアウト</th><td>${vd(co)} <strong>${this.esc(guestData.checkOutTime || "--:--")}</strong></td></tr>
        <tr><th class="text-muted">宿泊人数</th><td>
          ${isStaffView
            ? `${b.guestCount ? this.esc(String(b.guestCount)) + "名" : "-"}`
            : `<div class="input-group input-group-sm" style="width:170px;">
                <input type="number" class="form-control" id="editGuestCount" value="${b.guestCount || 0}" min="1">
                <button class="btn btn-outline-primary" id="btnSaveGuestCount" data-booking-id="${b.id}">保存</button>
              </div>`
          }
          ${guestData.guestCountInfants ? `<small class="text-muted">乳幼児${this.esc(String(guestData.guestCountInfants))}名</small>` : ""}
        </td></tr>
      </table>

      ${(() => {
        // 代表者情報セクション (国籍/年齢=companions, 他=companions/survey)
        // 電話番号: phone と phone2 を両方表示する場合は「/」連結、片方のみなら片方
        const phoneCombined = [guestData.phone, guestData.phone2].filter(Boolean).join(" / ");
        // 注: 代表者の連絡情報 (氏名/電話番号/メール 等) は予約管理上必須なので
        //     物件のフォーム表示設定 (isFieldVisible) に関係なく**常に表示**する。
        //     スタッフ視点では isStaffView の判定で個別に隠す。
        const rows = [
          `<tr><th width="110" class="text-muted">国籍</th><td>${v(guestData.nationality || b.nationality)}</td></tr>`,
          `<tr><th width="110" class="text-muted">年齢</th><td>${v(repAge)}</td></tr>`,
          isStaffView ? "" : `<tr><th width="110" class="text-muted">住所</th><td>${v(guestData.address)}</td></tr>`,
          isStaffView ? "" : `<tr><th width="110" class="text-muted">電話番号</th><td>${v(phoneCombined)}</td></tr>`,
          isStaffView ? "" : `<tr><th width="110" class="text-muted">メール</th><td>${v(guestData.email)}</td></tr>`,
          isStaffView ? "" : `<tr><th width="110" class="text-muted">旅券番号</th><td>${v(guestData.passportNumber)}</td></tr>`,
          `<tr><th width="110" class="text-muted">旅の目的</th><td>${v(guestData.purpose)}</td></tr>`,
        ].filter(Boolean).join("");
        return rows ? `<h6 class="mb-2 text-primary">代表者情報</h6><table class="table table-sm table-borderless mb-2">${rows}</table>` : "";
      })()}

      ${(() => {
        // 宿泊情報セクション (BBQ/ベッド数 = facility)
        const rows = [
          fRow("bbq", "facility", `<tr><th width="110" class="text-muted">BBQ</th><td>${vb(guestData.bbq)}</td></tr>`),
          fRow("bedChoice", "facility", `<tr><th class="text-muted">ベッド数（2名宿泊時）</th><td>${v(guestData.bedChoice)}</td></tr>`),
        ].filter(Boolean).join("");
        return rows ? `<h6 class="mb-2 text-primary">宿泊情報</h6><table class="table table-sm table-borderless mb-2">${rows}</table>` : "";
      })()}

      ${(() => {
        // 交通・駐車場セクション (facility)
        const transportVisible = isFieldVisible("transport", "facility");
        const rows = [
          fRow("transport", "facility", `<tr><th width="110" class="text-muted">交通手段</th><td>${v(guestData.transport)}</td></tr>`),
          fRow("carCount", "facility", `<tr><th class="text-muted">車台数</th><td>${guestData.carCount ? this.esc(String(guestData.carCount)) + "台" : "-"}</td></tr>`),
          // 車種 / 駐車場割当 は transport が表示の場合のみ
          transportVisible ? `<tr><th class="text-muted">車種</th><td>${vehicleTypes}</td></tr>` : "",
          transportVisible ? `<tr><th class="text-muted">駐車場割当</th><td>${parkingAllocText}</td></tr>` : "",
          fRow("paidParking", "facility", `<tr><th class="text-muted">有料駐車場</th><td>${v(guestData.paidParking)}</td></tr>`),
        ].filter(Boolean).join("");
        return rows ? `<h6 class="mb-2 text-primary">交通・駐車場</h6><table class="table table-sm table-borderless mb-2">${rows}</table>` : "";
      })()}

      ${isStaffView ? "" : (() => {
        // 緊急連絡先セクション (emergency)
        const rows = [
          fRow("emergencyName", "emergency", `<tr><th width="110" class="text-muted">氏名</th><td>${v(guestData.emergencyName)}</td></tr>`),
          fRow("emergencyPhone", "emergency", `<tr><th class="text-muted">電話番号</th><td>${v(guestData.emergencyPhone)}</td></tr>`),
        ].filter(Boolean).join("");
        return rows ? `<h6 class="mb-2 text-primary">緊急連絡先</h6><table class="table table-sm table-borderless mb-2">${rows}</table>` : "";
      })()}

      ${isStaffView ? "" : (() => {
        // 前後泊セクション (survey)
        const rows = [
          fRow("previousStay", "survey", `<tr><th width="110" class="text-muted">前泊地</th><td>${vl(guestData.previousStay)}</td></tr>`),
          fRow("nextStay", "survey", `<tr><th class="text-muted">後泊地</th><td>${vl(guestData.nextStay)}</td></tr>`),
        ].filter(Boolean).join("");
        return rows ? `<h6 class="mb-2 text-primary">前後泊</h6><table class="table table-sm table-borderless mb-2">${rows}</table>` : "";
      })()}

      ${isStaffView ? "" : (() => {
        // 同意状況セクション (agreement)
        const rows = [
          fRow("noiseAgree", "agreement", `<tr><th width="110" class="text-muted">騒音ルール</th><td>${noiseBadge}</td></tr>`),
        ].filter(Boolean).join("");
        return rows ? `<h6 class="mb-2 text-primary">同意状況</h6><table class="table table-sm table-borderless mb-2">${rows}</table>` : "";
      })()}

      ${companionsHtml}
      ${isStaffView ? "" : passportHtml}

      ${gmailRow ? `<hr><table class="table table-sm table-borderless mb-0">${gmailRow}</table>` : ""}

      <hr>
      <div>
        <strong class="small text-muted">清掃担当（CO: ${vd(co)}）</strong><br>
        ${cleaningHtml}
        ${recruit ? `<button class="btn btn-sm btn-outline-primary ms-2" id="calBtnOpenRecruit"><i class="bi bi-megaphone"></i> 募集詳細</button>` : ""}
      </div>
      ${(() => {
        // 手動予約の削除ボタン (Webアプリ管理者視点のみ)
        const isManualBk = b.manualOverride === true || /manual/i.test(String(b.source || ""));
        if (!isManualBk || isStaffView) return "";
        return `
          <hr>
          <div class="text-end">
            <button class="btn btn-outline-danger btn-sm" id="calBtnDeleteManualBooking" data-booking-id="${this.esc(b.id)}">
              <i class="bi bi-trash"></i> この予約を削除
            </button>
          </div>
        `;
      })()}
    `;
    bootstrap.Modal.getOrCreateInstance(modalEl).show();

    // 手動予約の削除ボタン
    const btnDelManual = document.getElementById("calBtnDeleteManualBooking");
    if (btnDelManual) {
      btnDelManual.addEventListener("click", async () => {
        const bookingId = btnDelManual.dataset.bookingId;
        if (!bookingId) return;
        const guestLabel = b.guestName || "(ゲスト名なし)";
        const ok = await showConfirm(
          `この予約を削除します。\n\nゲスト: ${guestLabel}\nCI: ${ci} / CO: ${co}\n\n紐付く清掃募集・シフト・チェックリストも削除されます。よろしいですか?`,
          { title: "予約を削除", okLabel: "削除", okClass: "btn-danger" }
        );
        if (!ok) return;
        btnDelManual.disabled = true;
        btnDelManual.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 削除中...';
        try {
          const db = firebase.firestore();
          // 1) shifts (bookingId 一致) → 紐付く checklists も削除
          const shiftSnap = await db.collection("shifts").where("bookingId", "==", bookingId).get();
          for (const s of shiftSnap.docs) {
            const clSnap = await db.collection("checklists").where("shiftId", "==", s.id).get();
            for (const c of clSnap.docs) await c.ref.delete();
            await s.ref.delete();
          }
          // 2) recruitments (bookingId 一致)
          const recSnap = await db.collection("recruitments").where("bookingId", "==", bookingId).get();
          for (const r of recSnap.docs) {
            await r.ref.delete();
          }
          // 3) bookings 本体
          await db.collection("bookings").doc(bookingId).delete();

          // ローカルキャッシュからも除去
          if (this.bookings) {
            const idx = this.bookings.findIndex(x => x.id === bookingId);
            if (idx !== -1) this.bookings.splice(idx, 1);
          }
          if (this.refreshCalendar) this.refreshCalendar();

          const modalInst = bootstrap.Modal.getInstance(modalEl);
          if (modalInst) modalInst.hide();
          await showAlert("予約を削除しました");
        } catch (e) {
          console.error("手動予約削除エラー:", e);
          btnDelManual.disabled = false;
          btnDelManual.innerHTML = '<i class="bi bi-trash"></i> この予約を削除';
          await showAlert("削除に失敗しました: " + (e.message || e));
        }
      });
    }

    // 募集詳細ボタン: ctx 注入された recruitments から検索して openRecruitmentModal
    const btnOpenRecruit = document.getElementById("calBtnOpenRecruit");
    if (btnOpenRecruit && recruit) {
      btnOpenRecruit.addEventListener("click", () => {
        const r = recruitments.find(x => x.id === recruit.id) || recruit;
        // RecruitmentPage 側のモーダルを優先、なければ DashboardPage のものを使う
        if (typeof RecruitmentPage !== "undefined" && RecruitmentPage.openDetailModal) {
          const modalInst = bootstrap.Modal.getInstance(modalEl);
          if (modalInst) modalInst.hide();
          (async () => {
            if (RecruitmentPage.ensureLoaded) await RecruitmentPage.ensureLoaded();
            RecruitmentPage.openDetailModal(r, { viewMode });
          })();
        } else if (this.openRecruitmentModal) {
          this.openRecruitmentModal(r);
        }
      });
    }

    // 照合メールリンク: モーダルを閉じてから #/email-verification?id=... へ遷移
    document.querySelectorAll("#calEventBody .ev-focus-link").forEach((a) => {
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        const fid = a.dataset.evFocusId || "";
        const modalInst = bootstrap.Modal.getInstance(modalEl);
        if (modalInst) modalInst.hide();
        setTimeout(() => {
          location.hash = fid ? `#/email-verification?id=${encodeURIComponent(fid)}` : "#/email-verification";
        }, 180);
      });
    });

    // GAS版インポートボタン (該当 CI 日の宿泊者名簿を取り込み)
    // 注: GAS版スプレッドシートには同一CI日に複数行 (iCal連携の予約行 + 宿泊者入力行) が
    //     混在しうるため、取り込み件数だけでは「名簿未回答」を判定できない。
    //     取り込み後に guestRegistrations を直接照会し、プレースホルダー名 (Reserved/Airbnb/Booking 等)
    //     でない実名の行が存在するかで判定する。
    const btnGasImport = document.getElementById("btnGasImportForBooking");
    if (btnGasImport) {
      btnGasImport.addEventListener("click", async () => {
        const ciDate = btnGasImport.dataset.ci;
        const pidForImport = btnGasImport.dataset.pid || "";
        const statusEl = document.getElementById("gasImportStatusInline");
        if (!ciDate) {
          if (statusEl) statusEl.innerHTML = `<span class="text-danger">CI日が不明です</span>`;
          return;
        }
        const dbi = firebase.firestore();
        // settings/notifications から GAS Web App URL/Secret を取得
        let gasUrl = "", gasSecret = "";
        try {
          const sDoc = await dbi.collection("settings").doc("notifications").get();
          if (sDoc.exists) {
            const sd = sDoc.data();
            gasUrl = sd.gasSyncWebAppUrl || "";
            gasSecret = sd.gasSecret || "";
          }
        } catch (_) {}
        if (!gasUrl) {
          if (statusEl) statusEl.innerHTML = `<span class="text-danger">GAS Web App URL 未設定 (宿泊者名簿画面で設定)</span>`;
          return;
        }
        btnGasImport.disabled = true;
        const origHtml = btnGasImport.innerHTML;
        btnGasImport.innerHTML = `<span class="spinner-border spinner-border-sm"></span> 取得中...`;
        if (statusEl) statusEl.innerHTML = "";
        try {
          const params = new URLSearchParams({ from: ciDate, to: ciDate, secret: gasSecret });
          const res = await fetch(`${gasUrl}?${params.toString()}`);
          const text = await res.text();
          let data;
          try { data = JSON.parse(text); } catch { data = { message: text }; }
          if (data.error) {
            if (statusEl) statusEl.innerHTML = `<span class="text-danger">エラー: ${this.esc(String(data.error))}</span>`;
            return;
          }

          // 取り込み完了後、guestRegistrations を直接照会して名簿の「実データ行」があるか判定
          // GAS版の buildCalendarEvents (index.html:2939) と同じロジックを踏襲:
          //   - 同一CI日の複数行をマージ対象とし、プレースホルダー名以外を実回答とみなす
          //   - プレースホルダー判定は GAS版と同じ厳密一致パターン
          //     /^(Not available|Reserved|CLOSED|Blocked|Airbnb(予約)?|Booking\.com(予約)?|Rakuten|楽天)$/i
          //   (v2 既存の _isPlaceholderName は部分一致で緩いためここでは使わない)
          const isGasPlaceholder = (name) => {
            if (!name) return true;
            return /^(Not available|Reserved|CLOSED|Blocked|Airbnb(予約)?|Booking\.com(予約)?|Rakuten|楽天)$/i
              .test(String(name).trim());
          };

          // 書き込みが Firestore に伝播するまで少し待つ
          await new Promise(r => setTimeout(r, 1200));
          let grSnap;
          try {
            const baseQ = dbi.collection("guestRegistrations").where("checkIn", "==", ciDate);
            grSnap = pidForImport
              ? await baseQ.where("propertyId", "==", pidForImport).get()
              : await baseQ.get();
          } catch (qe) {
            console.warn("guestRegistrations 照会失敗:", qe);
            grSnap = null;
          }

          // 同一CI日の複数行から実名ドキュメントを優先採用 (GAS版マージ思想)
          // 実名 (プレースホルダーでない) のドキュメントが1件でもあれば「回答済」
          let realRecord = null;
          let placeholderCount = 0;
          if (grSnap && !grSnap.empty) {
            for (const d of grSnap.docs) {
              const g = d.data();
              if (!g || !g.guestName) continue;
              if (isGasPlaceholder(g.guestName)) {
                placeholderCount++;
                continue;
              }
              // 実名: 最初に見つかったものを採用 (GAS版も先勝ちでマージ)
              realRecord = g;
              break;
            }
          }

          if (!realRecord) {
            const detail = placeholderCount > 0
              ? ` (iCal由来の${placeholderCount}行のみ、宿泊者の名簿入力なし)`
              : " (GAS版に該当行なし)";
            if (statusEl) statusEl.innerHTML = `<span class="text-warning"><i class="bi bi-hourglass-split"></i> まだ未回答${this.esc(detail)}</span>`;
            return;
          }

          if (statusEl) statusEl.innerHTML = `<span class="text-success"><i class="bi bi-check-circle"></i> 取り込み完了 (${this.esc(realRecord.guestName)})</span>`;
          // モーダルを閉じてカレンダーを再描画 (取り込んだ名簿を反映)
          setTimeout(() => {
            const modalInst = bootstrap.Modal.getInstance(modalEl);
            if (modalInst) modalInst.hide();
            if (typeof onGuestCountSaved === "function") onGuestCountSaved();
          }, 1200);
        } catch (e) {
          if (statusEl) statusEl.innerHTML = `<span class="text-danger">通信失敗: ${this.esc(e.message)}</span>`;
        } finally {
          btnGasImport.disabled = false;
          btnGasImport.innerHTML = origHtml;
        }
      });
    }

    // 人数保存ボタンのイベントハンドラ
    const btnSave = document.getElementById("btnSaveGuestCount");
    if (btnSave) {
      btnSave.addEventListener("click", async () => {
        const bookingId = btnSave.dataset.bookingId;
        const newCount = parseInt(document.getElementById("editGuestCount").value, 10);
        if (!bookingId || isNaN(newCount) || newCount < 1) {
          showToast("エラー", "無効な人数です", "error");
          return;
        }
        try {
          const db = firebase.firestore();
          if (bookingId.startsWith("g_")) {
            // guestRegistrationsコレクションを更新
            const realId = bookingId.slice(2);
            await db.collection("guestRegistrations").doc(realId).update({ guestCount: newCount });
          } else {
            // lastManualEditAt: onBookingChange 側で手動編集を識別して booking_change 通知を抑止する
            await db.collection("bookings").doc(bookingId).update({
              guestCount: newCount,
              lastManualEditAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
          }
          // キャッシュを更新 (注入された bookings と、念のため DashboardPage 自身の bookings の双方)
          const idx = bookings.findIndex(bk => bk.id === bookingId);
          if (idx !== -1) bookings[idx].guestCount = newCount;
          if (this.bookings && this.bookings !== bookings) {
            const idx2 = this.bookings.findIndex(bk => bk.id === bookingId);
            if (idx2 !== -1) this.bookings[idx2].guestCount = newCount;
          }
          onGuestCountSaved(newCount, bookingId);
          showToast("完了", "人数を更新しました", "success");
        } catch (e) {
          showToast("エラー", e.message, "error");
        }
      });
    }
  },

  refreshCalendar() {
    if (!this.calendar) return;
    this.calendar.removeAllEvents();
    this.calendar.addEventSource(this.buildCalendarEvents());
  },

  toDateStr(val) {
    if (!val) return "";
    if (typeof val === "string") {
      const m = val.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
      if (m) return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
      return val;
    }
    // Firestore Timestamp型やDate型 → JST（Asia/Tokyo）でYYYY-MM-DD
    const d = val.toDate ? val.toDate() : new Date(val);
    if (isNaN(d.getTime())) return "";
    // UTCではなくJSTで日付を取得（タイムゾーンずれ防止）
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return jst.toISOString().slice(0, 10);
  },

  esc(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  },
};
