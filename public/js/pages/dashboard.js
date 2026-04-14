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
  guestMap: {},  // CI日→名簿データのマップ

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
    this.initCalendar();
  },

  async loadAllData() {
    try {
      const [recruitSnap, staff, bookingSnap, guestSnap] = await Promise.all([
        db.collection("recruitments").get(),
        API.staff.list(true),
        db.collection("bookings").get(),
        db.collection("guestRegistrations").get(),
      ]);

      // === 募集データの正規化（checkOutDate/checkoutDate両対応 + volunteers統合） ===
      let recruitments = recruitSnap.docs.map(doc => {
        const d = doc.data();
        // フィールド名の揺れを吸収（移行データはcheckOutDate、新規作成はcheckoutDate）
        const coRaw = d.checkoutDate || d.checkOutDate || d.checkOutdate || "";
        const coStr = this.toDateStr(coRaw);
        return {
          id: doc.id,
          ...d,
          checkoutDate: coStr, // 正規化済みの日付文字列
          responses: d.responses || [],
          status: d.status || "募集中",
          selectedStaff: d.selectedStaff || "",
        };
      });

      // volunteers/コレクションの回答データをrecruitmentsに統合
      try {
        const volSnap = await db.collection("volunteers").get();
        if (!volSnap.empty) {
          // recruitIdは旧シートの行番号（"r5"等）またはrecordIndex
          // recruitmentsのbookingRowNumと照合
          const volsByRecruitIdx = {};
          volSnap.docs.forEach(vDoc => {
            const v = vDoc.data();
            const rKey = String(v.recruitId || "").replace(/^r/, "").trim();
            if (!rKey) return;
            if (!volsByRecruitIdx[rKey]) volsByRecruitIdx[rKey] = [];
            // 回答マッピング: ステータス列の値を◎/△/×に変換
            let response = v.status || v.response || "";
            if (response === "◎" || response === "◯" || response === "○" || response === "可能" || response === "OK") response = "◎";
            else if (response === "△" || response === "条件付き" || response === "要相談") response = "△";
            else if (response === "×" || response === "不可" || response === "NG") response = "×";
            volsByRecruitIdx[rKey].push({
              staffName: v.staffName || "",
              staffEmail: v.email || "",
              response: response || "◎",
              memo: v.memo || v.condition || "",
              respondedAt: v.volunteerDate || "",
            });
          });

          // recruitmentsにvolunteers回答をマージ
          recruitments.forEach((r, idx) => {
            if (r.responses && r.responses.length > 0) return; // 既に回答がある場合はスキップ
            // bookingRowNumで照合（旧募集シートの行番号=Index+1）
            const rowNum = r.bookingRowNum || (idx + 1);
            const vols = volsByRecruitIdx[String(rowNum)] || volsByRecruitIdx[String(idx + 1)] || [];
            if (vols.length > 0) {
              r.responses = vols;
            }
          });
          console.log(`[Dashboard] volunteers ${volSnap.size}件をrecruitmentsに統合`);
        }
      } catch (e) {
        console.warn("volunteers読み込みスキップ:", e.message);
      }

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
        const key = `${ci}|${co}`;
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
      const rawBookings = bookingSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(b => b.status !== "cancelled"); // キャンセル済み予約を除外
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

      // 3) migrated_*（旧GASデータ）— 最低優先
      try {
        const migratedSnap = await db.collection("migrated_民泊メイン_フォームの回答_1").get();
        migratedSnap.docs.forEach(d => {
          const data = d.data();
          const ciRaw = data["チェックイン"] || data["チェックイン / Check-in"];
          const coRaw = data["チェックアウト"] || data["チェックアウト / Check-out"];
          if (!ciRaw) return;
          addBooking({
            id: "m_" + d.id,
            guestName: data["お名前"] || data["宿泊者名"] || "",
            checkIn: ciRaw, checkOut: coRaw || "",
            guestCount: Number(data["宿泊人数"]) || Number(data["大人の人数"]) || 1,
            source: (data["予約元"] || data["予約サイト"] || "migrated").toString(),
            bbq: (data["BBQ"] || data["ＢＢＱ"] || "").toString(),
            parking: (data["駐車場"] || "").toString(),
            nationality: (data["国籍"] || "").toString(),
            memo: (data["メモ"] || data["連絡事項"] || "").toString(),
          }, "migrated");
        });
      } catch (e) {
        console.warn("migratedコレクション読み込みスキップ:", e.message);
      }

      const bookings = Array.from(bookingMap.values());

      // guestMap構築（CI日→名簿データ）
      this.guestMap = {};
      guests.forEach(g => {
        const ci = this.toDateStr(g.checkIn);
        if (ci) this.guestMap[ci] = g;
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

      if (r.status === "選定済") {
        actions.push({
          icon: "bi-check2-circle",
          color: "info",
          text: `${rCoDate} — スタッフ選定済み → 確定してください`,
          id: r.id,
          action: "confirm",
        });
      } else if (maru > 0) {
        actions.push({
          icon: "bi-person-plus",
          color: "warning",
          text: `${rCoDate} — ◎${maru}名回答あり → スタッフを選定してください`,
          id: r.id,
          action: "select",
        });
      } else if (!isPast) {
        actions.push({
          icon: "bi-exclamation-triangle",
          color: "danger",
          text: `${rCoDate} — 回答なし！スタッフに連絡してください`,
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
      const g = ci ? this.guestMap[ci] : null;
      if (g && g.bookingSite) {
        const bs = g.bookingSite.toLowerCase();
        if (bs.includes("airbnb")) return "fc-event-airbnb";
        if (bs.includes("booking")) return "fc-event-booking-com";
      }
    }

    return "fc-event-other";
  },

  // 名簿の記入済み判定
  hasGuestRegistration(booking) {
    if (!this.guestMap) return false;
    const ci = this.toDateStr(booking.checkIn);
    const g = this.guestMap[ci];
    if (!g) return false;
    // プレースホルダー名でないなら記入済み
    const name = (g.guestName || "").trim().toLowerCase();
    if (!name || name === "-") return false;
    if (name.includes("airbnb") || name.includes("booking") || name.includes("not available") || name.includes("blocked") || name.includes("closed")) return false;
    return true;
  },

  buildCalendarEvents() {
    const events = [];

    // 同じCO日に複数のrecruitmentがある場合、優先度の高い1件だけ使う
    // 優先度: スタッフ確定済み > 選定済 > 募集中 > それ以外
    const STATUS_PRIORITY = { "スタッフ確定済み": 4, "選定済": 3, "募集中": 2 };
    const recruitByCoDate = {};
    this.recruitments.forEach(r => {
      const coStr = this.toDateStr(r.checkoutDate);
      if (!coStr) return;
      const existing = recruitByCoDate[coStr];
      const newPri = STATUS_PRIORITY[r.status] || 1;
      const existPri = existing ? (STATUS_PRIORITY[existing.status] || 1) : 0;
      if (!existing || newPri > existPri) recruitByCoDate[coStr] = r;
    });

    // === 宿泊イベント（プラットフォーム別色分け + 名簿ステータスドット） ===
    this.bookings.forEach(b => {
      const ci = this.toDateStr(b.checkIn);
      const co = this.toDateStr(b.checkOut);
      if (!ci) return;

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
      const responses = r.responses || [];
      const maru = responses.filter(v => v.response === "◎").length;
      const sankaku = responses.filter(v => v.response === "△").length;
      const totalResp = responses.length;

      let cssClass, title;
      if (r.status === "スタッフ確定済み") {
        cssClass = "fc-event-cleaning-decided";
        title = "🧹 " + (r.selectedStaff || "確定");
      } else if (r.status === "選定済") {
        cssClass = "fc-event-cleaning-selected";
        title = "🧹 " + (r.selectedStaff || "") + "(選定済)";
      } else if (maru > 0) {
        cssClass = "fc-event-cleaning";
        title = "🧹 募集中 ◎" + maru + (sankaku ? " △" + sankaku : "");
      } else if (totalResp > 0) {
        cssClass = "fc-event-cleaning";
        title = "🧹 募集中 (△" + sankaku + " ×" + (totalResp - sankaku) + ")";
      } else {
        cssClass = "fc-event-cleaning-noresponse";
        title = "🧹 募集中（回答なし）";
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

  // === 日付クリック → 募集作成 ===
  async onDateClick(info) {
    const dateStr = info.dateStr;
    // 既にその日の募集があるか
    const existing = this.recruitments.find(r => this.toDateStr(r.checkoutDate) === dateStr);
    if (existing) {
      this.openRecruitmentModal(existing);
      return;
    }
    if (!confirm(`${dateStr} の清掃募集を作成しますか？`)) return;
    try {
      const created = await API.recruitments.create({ checkoutDate: dateStr });
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

    const respondBtns = (s) => r.status === "スタッフ確定済み" ? "" : `
      <div class="btn-group btn-group-sm">
        <button class="btn ${s.response === "◎" ? "btn-success" : "btn-outline-success"} btn-resp" data-r="◎" data-sid="${s.id}" data-sname="${this.esc(s.name)}" data-semail="${this.esc(s.email)}">◎</button>
        <button class="btn ${s.response === "△" ? "btn-warning" : "btn-outline-warning"} btn-resp" data-r="△" data-sid="${s.id}" data-sname="${this.esc(s.name)}" data-semail="${this.esc(s.email)}">△</button>
        <button class="btn ${s.response === "×" ? "btn-danger" : "btn-outline-danger"} btn-resp" data-r="×" data-sid="${s.id}" data-sname="${this.esc(s.name)}" data-semail="${this.esc(s.email)}">×</button>
      </div>
    `;

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
        <thead><tr><th>スタッフ</th><th>回答</th><th></th></tr></thead>
        <tbody>
          ${allEntries.map(s => `
            <tr>
              <td>${this.esc(s.name)}</td>
              <td class="${{" ◎":"text-success fw-bold","△":"text-warning fw-bold","×":"text-danger fw-bold"}[s.response] || "text-muted"}">${s.response}</td>
              <td>${respondBtns(s)}</td>
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

    // 回答ボタンイベント
    modalEl.querySelectorAll(".btn-resp").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          await API.recruitments.respond(r.id, {
            staffId: btn.dataset.sid,
            staffName: btn.dataset.sname,
            staffEmail: btn.dataset.semail,
            response: btn.dataset.r,
          });
          showToast("完了", `${btn.dataset.sname}: ${btn.dataset.r}`, "success");
          modal.hide();
          // リロードして再表示
          this.recruitments = await API.recruitments.list();
          const updated = this.recruitments.find(x => x.id === r.id);
          this.refreshCalendar();
          this.renderStats();
          this.renderTodayActions();
          if (updated) this.openRecruitmentModal(updated);
        } catch (e) { showToast("エラー", e.message, "error"); }
      });
    });

    // 選定ボタン
    const selBtn = modalEl.querySelector("#calBtnSelect");
    if (selBtn) {
      selBtn.addEventListener("click", async () => {
        const selected = [];
        modalEl.querySelectorAll(".staff-sel-cb:checked").forEach(cb => selected.push(cb.value));
        if (!selected.length) {
          if (!confirm("スタッフを全員外して募集中に戻しますか？")) return;
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
        if (!confirm(`${r.selectedStaff} を確定しますか？`)) return;
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
        if (!confirm("募集を再開しますか？")) return;
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
        if (!confirm(`${coDate} の募集を削除しますか？\nこの操作は取り消せません。`)) return;
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

  showBookingModal(b) {
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
    const rosterOk = this.hasGuestRegistration(b);

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

    // CO日の清掃募集を検索
    const recruit = co ? this.recruitments.find(r => this.toDateStr(r.checkoutDate) === co) : null;
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

    // 次の予約情報（同じ物件のCI >= 現在のCO）
    let nextBookingHtml = "";
    if (co) {
      const nextBooking = this.bookings.find(nb =>
        nb.id !== b.id && this.toDateStr(nb.checkIn) === co
      );
      if (nextBooking) {
        nextBookingHtml = `
          <div class="alert alert-info py-2 mt-2 small">
            <strong>次の予約:</strong> ${this.esc(nextBooking.guestName || "-")} / CI: ${this.esc(this.toDateStr(nextBooking.checkIn))} / ${nextBooking.guestCount || "?"}名
          </div>`;
      }
    }

    document.getElementById("calEventTitle").innerHTML = `<i class="bi bi-calendar-event"></i> 予約詳細 ${sourceBadge}`;
    document.getElementById("calEventBody").innerHTML = `
      <div class="d-flex gap-2 mb-3">${rosterBadge}</div>
      <table class="table table-sm table-borderless mb-2">
        <tr><th width="110" class="text-muted">ゲスト名</th><td class="fw-bold">${this.esc(b.guestName || "-")}</td></tr>
        <tr><th class="text-muted">チェックイン</th><td>${this.esc(ci || "-")}</td></tr>
        <tr><th class="text-muted">チェックアウト</th><td>${this.esc(co || "-")}</td></tr>
        <tr><th class="text-muted">宿泊人数</th><td>${b.guestCount || "-"}名${b.guestCountInfants ? ` (乳幼児${b.guestCountInfants})` : ""}</td></tr>
        ${b.nationality ? `<tr><th class="text-muted">国籍</th><td>${this.esc(b.nationality)}</td></tr>` : ""}
        ${b.bbq ? `<tr><th class="text-muted">BBQ</th><td>${this.esc(b.bbq)}</td></tr>` : ""}
        ${b.parking ? `<tr><th class="text-muted">駐車場</th><td>${this.esc(b.parking)}</td></tr>` : ""}
        ${b.notes || b.memo ? `<tr><th class="text-muted">メモ</th><td>${this.esc(b.notes || b.memo)}</td></tr>` : ""}
      </table>

      <div class="border-top pt-2 mt-2">
        <strong class="small text-muted">清掃担当（CO: ${this.esc(co || "-")}）</strong><br>
        ${cleaningHtml}
        ${recruit ? `<button class="btn btn-sm btn-outline-primary ms-2" onclick="DashboardPage.openRecruitmentModal(DashboardPage.recruitments.find(r=>r.id==='${recruit.id}'))"><i class="bi bi-megaphone"></i> 募集詳細</button>` : ""}
      </div>
      ${nextBookingHtml}
    `;
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
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
