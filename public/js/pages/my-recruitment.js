/**
 * スタッフ用 清掃スケジュールページ
 * 横スクロールカレンダー（予約バー + 募集ステータス + スタッフ回答）
 */
const MyRecruitmentPage = {
  staffId: null,
  staffDoc: null,
  staffList: [],
  recruitments: [],
  bookings: [],
  guestMap: {},

  async render(container) {
    const isOwner = Auth.isOwner();
    this.staffId = Auth.currentUser?.staffId;

    // オーナーの場合: カスタムクレームに staffId が無くても、
    // authUid で staff コレクションから対応するドキュメントIDを解決
    if (isOwner && !this.staffId) {
      try {
        const snap = await db.collection("staff")
          .where("authUid", "==", Auth.currentUser.uid).limit(1).get();
        if (!snap.empty) this.staffId = snap.docs[0].id;
      } catch (e) { /* ignore */ }
    }
    if (isOwner && !this.staffId) this.staffId = Auth.currentUser.uid;

    if (!this.staffId) {
      container.innerHTML = '<div class="alert alert-warning m-3">スタッフ情報が取得できません。</div>';
      return;
    }

    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-calendar-check"></i> 清掃スケジュール</h2>
        <div class="d-flex align-items-center gap-2">
          <input type="month" class="form-control form-control-sm" style="width:150px;" id="myCalMonth">
          <button class="btn btn-sm btn-outline-primary" id="btnMyCalToday">今日</button>
        </div>
      </div>
      <div class="d-flex flex-wrap gap-3 mb-3 text-muted" style="font-size:13px;">
        <span><span style="background:#ff5a5f;display:inline-block;width:12px;height:12px;border-radius:2px;vertical-align:middle;"></span> Airbnb</span>
        <span><span style="background:#003580;display:inline-block;width:12px;height:12px;border-radius:2px;vertical-align:middle;"></span> Booking.com</span>
        <span><span style="background:#198754;display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:middle;"></span> 名簿提出済み</span>
        <span><span style="background:#dc3545;display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:middle;"></span> 名簿未提出</span>
        <span><span style="display:inline-block;width:12px;height:12px;border:2px solid #dc3545;border-radius:2px;vertical-align:middle;"></span> 確定済</span>
        <span>👤 あなた</span>
      </div>
      <div id="myCalContainer" style="overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:var(--radius,8px);border:1px solid var(--border,#e2e8f0);"></div>

      <!-- 回答モーダル -->
      <div class="modal fade" id="responseModal" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header py-2">
              <h6 class="modal-title" id="responseModalTitle">回答</h6>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div id="responseModalInfo" class="small text-muted mb-3 text-center"></div>
              <div class="d-flex gap-2 justify-content-center mb-3">
                <button class="btn btn-success btn-lg resp-btn" data-resp="◎" style="min-width:80px;">◎ OK</button>
                <button class="btn btn-warning btn-lg resp-btn" data-resp="△" style="min-width:80px;">△ 条件付</button>
                <button class="btn btn-danger btn-lg resp-btn" data-resp="×" style="min-width:80px;">× NG</button>
              </div>
              <!-- △選択時の理由入力 -->
              <div id="triangleReasonArea" class="d-none">
                <hr>
                <label class="form-label small fw-bold">△の理由（必須）</label>
                <div class="d-flex flex-wrap gap-2 mb-2">
                  <button class="btn btn-sm btn-outline-secondary reason-preset" data-reason="午後◎">午後◎</button>
                  <button class="btn btn-sm btn-outline-secondary reason-preset" data-reason="午前◎">午前◎</button>
                  <button class="btn btn-sm btn-outline-secondary reason-preset" data-reason="時間調整が必要">時間調整が必要</button>
                  <button class="btn btn-sm btn-outline-secondary reason-preset" data-reason="他の予定次第">他の予定次第</button>
                </div>
                <textarea class="form-control form-control-sm" id="triangleReason" rows="2" placeholder="詳しい理由を入力..."></textarea>
                <button class="btn btn-warning w-100 mt-2" id="btnSubmitTriangle">
                  <i class="bi bi-check-lg"></i> △で回答する
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 予約詳細モーダル -->
      <div class="modal fade" id="bookingDetailModal" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header py-2">
              <h6 class="modal-title">予約詳細</h6>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body" id="bookingDetailBody"></div>
          </div>
        </div>
      </div>
    `;

    try {
      const staffSnap = await db.collection("staff").doc(this.staffId).get();
      this.staffDoc = staffSnap.exists ? staffSnap.data() : (isOwner
        ? { name: Auth.currentUser.displayName || "オーナー", email: Auth.currentUser.email || "" }
        : {});

      await this.loadData();

      const now = new Date();
      this._calMonth = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
      const monthInput = document.getElementById("myCalMonth");
      monthInput.value = this._calMonth;
      monthInput.addEventListener("change", () => { this._calMonth = monthInput.value; this.renderCalendar(); });
      document.getElementById("btnMyCalToday").addEventListener("click", () => {
        const n = new Date();
        this._calMonth = n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0");
        monthInput.value = this._calMonth;
        this.renderCalendar();
      });

      document.querySelectorAll(".resp-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          const resp = btn.dataset.resp;
          if (resp === "△") {
            // △: 理由入力エリアを表示
            document.getElementById("triangleReasonArea").classList.remove("d-none");
            document.getElementById("triangleReason").value = "";
            document.getElementById("triangleReason").focus();
          } else {
            // ◎/×: そのまま送信
            document.getElementById("triangleReasonArea").classList.add("d-none");
            this.submitCurrentResponse(resp, "");
          }
        });
      });

      // △理由プリセット選択
      document.querySelectorAll(".reason-preset").forEach(btn => {
        btn.addEventListener("click", () => {
          document.getElementById("triangleReason").value = btn.dataset.reason;
        });
      });

      // △確定ボタン
      document.getElementById("btnSubmitTriangle").addEventListener("click", () => {
        const reason = document.getElementById("triangleReason").value.trim();
        if (!reason) {
          showToast("入力エラー", "△の理由を入力してください", "error");
          document.getElementById("triangleReason").focus();
          return;
        }
        this.submitCurrentResponse("△", reason);
      });

      this.renderCalendar();
    } catch (e) {
      console.error("読み込みエラー:", e);
      document.getElementById("myCalContainer").innerHTML = `<div class="alert alert-danger">${e.message}</div>`;
    }
  },

  // 日付フィールド名の揺れを正規化
  _normalizeDate(raw) {
    if (!raw) return "";
    if (typeof raw === "string") return raw.slice(0, 10);
    if (raw.toDate) return raw.toDate().toLocaleDateString("sv-SE");
    if (raw instanceof Date) return raw.toLocaleDateString("sv-SE");
    return String(raw).slice(0, 10);
  },

  async loadData() {
    const [recruitSnap, bookingSnap, staffSnap, guestSnap, minpakuProps] = await Promise.all([
      db.collection("recruitments").get(),
      db.collection("bookings").get(),
      db.collection("staff").where("active", "==", true).get(),
      db.collection("guestRegistrations").get(),
      API.properties.listMinpakuNumbered(),
    ]);

    // recruitments: checkOutDate/checkoutDate 両対応
    this.recruitments = recruitSnap.docs.map(d => {
      const raw = d.data();
      const coDate = this._normalizeDate(raw.checkoutDate || raw.checkOutDate || raw.checkOutdate);
      return { id: d.id, ...raw, checkoutDate: coDate };
    }).filter(r => r.checkoutDate);

    // キャンセル予約は全て除外（"cancelled" / "canceled" / 日本語）
    this.bookings = bookingSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(b => {
      const s = String(b.status || "").toLowerCase();
      return !s.includes("cancel") && b.status !== "キャンセル" && b.status !== "キャンセル済み";
    });

    // 物件リスト (番号+色付き)
    this.minpakuProperties = minpakuProps;
    this.propertyMap = {};
    minpakuProps.forEach(p => { this.propertyMap[p.id] = p; });

    // 物件表示フラグ（セッション内保持、初回は全部表示）
    if (!this._propertyVisibility) this._propertyVisibility = {};
    minpakuProps.forEach(p => {
      if (this._propertyVisibility[p.id] === undefined) this._propertyVisibility[p.id] = true;
    });

    // スタッフ並び: displayOrder 昇順だが、オーナー(isOwner=true)は最下部に移動
    const allStaff = staffSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const nonOwner = allStaff.filter(s => !s.isOwner).sort((a,b) => (a.displayOrder||0) - (b.displayOrder||0));
    const owner = allStaff.filter(s => s.isOwner).sort((a,b) => (a.displayOrder||0) - (b.displayOrder||0));
    this.staffList = [...nonOwner, ...owner];

    // 名簿マッピング（個人情報除外）
    this.guestMap = {};
    guestSnap.docs.forEach(d => {
      const g = d.data();
      const ci = g.checkIn;
      if (ci) this.guestMap[ci] = {
        guestCount: g.guestCount || 0,
        guestCountInfants: g.guestCountInfants || 0,
        checkIn: g.checkIn, checkOut: g.checkOut,
        checkInTime: g.checkInTime || "", checkOutTime: g.checkOutTime || "",
        bbq: g.bbq || "", carCount: g.carCount || 0,
        paidParking: g.paidParking || "",
        bedChoice: g.bedChoice || "", nationality: g.nationality || "",
        parking: g.parking || "", transport: g.transport || "",
        vehicleTypes: g.vehicleTypes || [],
      };
    });
  },

  renderCalendar() {
    const container = document.getElementById("myCalContainer");
    const ym = (this._calMonth || "").split("-");
    const year = parseInt(ym[0]) || new Date().getFullYear();
    const month = parseInt(ym[1]) || (new Date().getMonth() + 1);
    const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
    const todayStr = new Date().toLocaleDateString("sv-SE");

    // 前月・当月・翌月
    const months = [];
    for (let mi = -1; mi <= 1; mi++) {
      const mDate = new Date(year, month - 1 + mi, 1);
      months.push({ year: mDate.getFullYear(), month: mDate.getMonth() + 1, days: new Date(mDate.getFullYear(), mDate.getMonth() + 1, 0).getDate() });
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
    const recruitByDate = {};                 // dateStr → recruit (全体、1件目優先)
    const recruitByPropDate = {};             // propId → dateStr → recruit
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
    const bookingsByDate = {};                // dateStr → [booking]
    const bookingsByStart = {};               // checkIn → [booking]
    const bookingsByPropStart = {};           // propId → dateStr(checkIn) → [booking]
    const bookingsByPropDate = {};            // propId → dateStr → [booking]
    const datesInRange = new Set(allDates.map(d => d.dateStr));
    this.bookings.forEach(b => {
      if (!b.checkIn || !b.checkOut) return;
      const pid = b.propertyId || "";
      const ci = new Date(b.checkIn + "T00:00:00");
      const co = new Date(b.checkOut + "T00:00:00");
      const bucket = {
        source: (b.source || "").toLowerCase(), guestCount: b.guestCount || 0,
        propertyName: b.propertyName || "", propertyId: pid,
        checkIn: b.checkIn, checkOut: b.checkOut,
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

    // スタイル（拡大）— stickyW はセッション間で保持
    const cellH = "48px";
    const stickyW = (this._stickyW || 190) + "px";
    const colW = "52px";

    let html = `
      <div class="d-flex align-items-center gap-2 mb-2 small text-muted">
        <span>左列の幅:</span>
        <input type="range" min="130" max="320" step="10" id="myCalStickyW" value="${parseInt(stickyW, 10)}" style="width:200px;">
        <span id="myCalStickyWVal">${stickyW}</span>
      </div>
      <table class="table table-sm table-hover mb-0 align-middle" style="font-size:13px;white-space:nowrap;border-collapse:collapse;min-width:calc(${stickyW} + ${allDates.length} * ${colW});">`;

    // ===== ヘッダー =====
    html += `<thead class="table-light">`;

    // 行1: 月ラベル
    html += `<tr><th rowspan="2" class="text-center" style="position:sticky;left:0;z-index:3;background:#f8f9fa;min-width:${stickyW};max-width:${stickyW};border-right:2px solid #dee2e6;font-size:14px;vertical-align:middle;">日付</th>`;
    months.forEach(m => {
      const cur = m.month === month && m.year === year;
      html += `<th colspan="${m.days}" class="text-center" style="background:${cur ? "#f8f9fa" : "#e9ecef"};border:1px solid #dee2e6;font-size:15px;font-weight:600;">${m.year}/${m.month}月</th>`;
    });
    html += "</tr>";

    // 行2: 日+曜
    html += "<tr>";
    allDates.forEach(dd => {
      const dow = new Date(dd.year, dd.month - 1, dd.day).getDay();
      const isToday = dd.dateStr === todayStr;
      const hasBooking = !!bookingsByDate[dd.dateStr];
      const dowColor = dow === 0 ? "#dc3545" : (dow === 6 ? "#0d6efd" : "");
      const bg = isToday ? "#e8f0fe" : (!dd.isCurrent ? "#e9ecef" : "#f8f9fa");
      html += `<th class="text-center${hasBooking ? " cal-date-hd" : ""}" data-cal-date="${dd.dateStr}" style="min-width:${colW};height:42px;font-size:14px;${dowColor ? "color:" + dowColor + ";" : ""}background:${bg};border:1px solid #dee2e6;cursor:${hasBooking ? "pointer" : "default"};vertical-align:middle;"><div style="font-size:14px;font-weight:600;">${dd.day}</div><div style="font-size:12px;">${dayNames[dow]}</div></th>`;
    });
    html += "</tr>";
    html += `</thead><tbody>`;

    // ===== 物件セクション =====
    const visibleProps = this.minpakuProperties.filter(p => this._propertyVisibility[p.id] !== false);
    if (this.minpakuProperties.length > 0) {
      // セクション見出し
      html += `<tr><td style="position:sticky;left:0;z-index:2;background:#eef5ff;font-weight:bold;font-size:13px;padding:6px 10px;border-right:2px solid #dee2e6;" colspan="${allDates.length + 1}">
        <i class="bi bi-building"></i> 物件別 宿泊・募集状況
        <small class="text-muted ms-2">(目のアイコンで表示切替)</small>
      </td></tr>`;

      // 各物件行
      this.minpakuProperties.forEach(p => {
        const visible = this._propertyVisibility[p.id] !== false;
        const bookStarts = bookingsByPropStart[p.id] || {};
        const bookByDate = bookingsByPropDate[p.id] || {};
        const recruitByD = recruitByPropDate[p.id] || {};

        html += `<tr data-prop-row="${p.id}" style="${visible ? "" : "opacity:0.35;"}">`;
        html += `<td class="fw-medium" style="position:sticky;left:0;z-index:2;background:#f9fafb;min-width:${stickyW};max-width:${stickyW};border-right:2px solid #dee2e6;height:${cellH};vertical-align:middle;font-size:13px;padding:4px 8px;white-space:normal;word-break:break-all;line-height:1.3;">
          <span class="badge me-1" style="background:${p._color};color:#fff;">${p._num}</span>${this.esc(p.name)}
          <button class="btn btn-sm btn-link p-0 ms-1 prop-toggle" data-prop-id="${p.id}" title="${visible ? "非表示にする" : "表示する"}" style="vertical-align:middle;">
            <i class="bi ${visible ? "bi-eye" : "bi-eye-slash"} text-muted"></i>
          </button>
        </td>`;

        if (!visible) {
          // 折り畳み時: 横線のみの薄い行
          for (let i = 0; i < allDates.length; i++) {
            html += `<td style="border:1px solid #dee2e6;height:${cellH};background:#f8f9fa;"></td>`;
          }
        } else {
          // 予約バー: colspan で連泊
          const skipTbl = {};
          for (let i = 0; i < allDates.length; i++) {
            if (skipTbl[i]) continue;
            const dd = allDates[i];
            const starts = bookStarts[dd.dateStr];
            const hasRecruit = !!recruitByD[dd.dateStr];

            if (starts && starts.length) {
              const b = starts[0];
              const ciD = new Date(b.checkIn + "T00:00:00");
              const coD = new Date(b.checkOut + "T00:00:00");
              const nights = Math.max(1, Math.round((coD - ciD) / 86400000));
              const span = Math.min(nights, allDates.length - i);
              for (let k = 1; k < span; k++) skipTbl[i + k] = true;

              let bg = "rgba(13,110,253,0.18)", borderColor = p._color || "#0d6efd";
              if (b.source.includes("airbnb")) bg = "rgba(255,90,95,0.22)";
              else if (b.source.includes("booking")) bg = "rgba(0,53,128,0.22)";
              const countLabel = b.guestCount > 0 ? `${b.guestCount}名` : "";
              const hasGuest = !!this.guestMap[b.checkIn];
              const dotColor = hasGuest ? "#198754" : "#dc3545";
              const dotTitle = hasGuest ? "名簿提出済み" : "名簿未提出";
              // 予約の checkOut 日 (checkOutDate) に募集があるか
              const recCheckOut = recruitByD[b.checkOut];
              const pill = recCheckOut ? this._recruitPill(recCheckOut) : "";

              html += `<td colspan="${span}" class="cal-date-hd" data-cal-date="${b.checkIn}" style="background:${bg};border:1px solid #dee2e6;border-left:4px solid ${borderColor};font-size:13px;height:${cellH};padding:2px 6px;cursor:pointer;text-align:left;vertical-align:middle;white-space:nowrap;overflow:hidden;">
                <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${dotColor};vertical-align:middle;margin-right:5px;" title="${dotTitle}"></span>
                <span style="font-weight:600;">${countLabel}</span>
                ${nights > 1 ? `<span class="text-muted ms-1" style="font-size:11px;">${nights}泊</span>` : ""}
                ${pill ? `<span class="float-end">${pill}</span>` : ""}
              </td>`;
            } else if (hasRecruit) {
              // 予約バー外だが募集が存在（別予約のcheckOut日等）
              const r = recruitByD[dd.dateStr];
              html += `<td class="text-center" style="border:1px solid #dee2e6;height:${cellH};background:${!dd.isCurrent ? "#e9ecef" : "#fff"};vertical-align:middle;padding:2px;">${this._recruitPill(r)}</td>`;
            } else {
              const bgEmpty = !dd.isCurrent ? "#e9ecef" : "#fff";
              html += `<td style="border:1px solid #dee2e6;height:${cellH};background:${bgEmpty};"></td>`;
            }
          }
        }
        html += "</tr>";
      });

      // セクション見出し: スタッフ
      html += `<tr><td style="position:sticky;left:0;z-index:2;background:#eef5ff;font-weight:bold;font-size:13px;padding:6px 10px;border-right:2px solid #dee2e6;" colspan="${allDates.length + 1}">
        <i class="bi bi-people"></i> スタッフ別 回答状況
      </td></tr>`;
    }

    // ===== スタッフ行 =====
    const isOwner = Auth?.isOwner?.() === true;
    this.staffList.forEach(staff => {
      const isMe = staff.id === this.staffId;
      const assigned = Array.isArray(staff.assignedPropertyIds) ? staff.assignedPropertyIds : [];
      const hasAssignments = assigned.length > 0;
      html += `<tr><td class="fw-medium" style="position:sticky;left:0;z-index:2;background:${isMe ? "#e3f2fd" : "#fff"};min-width:${stickyW};max-width:${stickyW};border-right:2px solid #dee2e6;height:${cellH};font-size:14px;vertical-align:middle;padding:4px 8px;white-space:normal;word-break:break-all;line-height:1.3;">
        ${this.esc(staff.name)}${isMe ? " 👤" : ""}${staff.isOwner ? ' <span class="badge bg-info" style="font-size:9px;">OWN</span>' : ""}
      </td>`;

      allDates.forEach(dd => {
        const isToday = dd.dateStr === todayStr;
        // この日、このスタッフの担当物件すべてについて募集を探す
        // オーナーの場合は全物件を対象にする(代理回答できるように)
        const targetPropIds = (staff.isOwner || !hasAssignments) ? null : assigned;
        let recruit = null;
        let recruitProp = null;

        if (targetPropIds === null) {
          // 全物件対象 (オーナー or 担当未設定スタッフ)
          recruit = recruitByDate[dd.dateStr];
          recruitProp = recruit ? this.propertyMap[recruit.propertyId] : null;
        } else {
          for (const pid of targetPropIds) {
            const byD = recruitByPropDate[pid];
            if (byD && byD[dd.dateStr]) {
              recruit = byD[dd.dateStr];
              recruitProp = this.propertyMap[pid];
              break;
            }
          }
        }

        if (!recruit) {
          const bg = isToday ? "#e8f0fe" : (!dd.isCurrent ? "#e9ecef" : "#f9f9f9");
          html += `<td class="text-center" style="background:${bg};border:1px solid #dee2e6;color:#adb5bd;height:${cellH};vertical-align:middle;">-</td>`;
          return;
        }

        const responses = recruit.responses || [];
        let resp = "未回答";
        for (const r of responses) {
          if (r.staffId === staff.id || r.staffName === staff.name || (r.staffEmail && staff.email && r.staffEmail.toLowerCase() === staff.email.toLowerCase())) {
            resp = r.response || "未回答"; break;
          }
        }

        let symbol = "−", symColor = "#adb5bd";
        if (resp === "◎") { symbol = "●"; symColor = "#198754"; }
        else if (resp === "△") { symbol = "▲"; symColor = "#cc9a06"; }
        else if (resp === "×") { symbol = "✖"; symColor = "#dc3545"; }

        let isConfirmed = false;
        const sel = (recruit.selectedStaff || "").trim();
        if (sel && (recruit.status === "選定済" || recruit.status === "スタッフ確定済み")) {
          isConfirmed = sel.split(/[,、\s]+/).map(s => s.trim()).includes(staff.name);
        }

        const cellBg = isConfirmed ? "#fff5f5" : (isToday ? "#e8f0fe" : (!dd.isCurrent ? "#e9ecef" : ""));
        const shadow = isConfirmed ? "box-shadow:inset 0 0 0 2px #dc3545;" : "";
        // 確定済: オーナーはクリックで詳細モーダルへ、スタッフは閲覧のみ
        // 確定前: isMe or オーナーなら回答編集可
        const clickable = (recruit.status === "スタッフ確定済み")
          ? isOwner
          : (isMe || isOwner);
        const clickMode = (recruit.status === "スタッフ確定済み") ? "detail" : "respond";

        // 物件番号+色バッジ (セル左上に小さく)
        const propBadge = recruitProp
          ? `<span style="position:absolute;top:1px;left:2px;background:${recruitProp._color};color:#fff;font-size:9px;padding:0 3px;border-radius:2px;line-height:1.2;">${recruitProp._num}</span>`
          : "";

        html += `<td class="text-center${clickable ? " cal-cell" : ""}" data-date="${dd.dateStr}" data-recruit-id="${recruit.id}" data-click-mode="${clickMode}" data-staff-id="${staff.id}" data-staff-name="${this.esc(staff.name)}" data-staff-email="${this.esc(staff.email||"")}" data-is-me="${isMe}" style="position:relative;cursor:${clickable ? "pointer" : "default"};border:1px solid #dee2e6;${shadow}background:${cellBg};color:${symColor};font-weight:bold;height:${cellH};vertical-align:middle;font-size:18px;">${propBadge}${symbol}</td>`;
      });
      html += "</tr>";
    });

    html += "</tbody></table>";
    container.innerHTML = html;

    // sticky 幅スライダー
    const stickySlider = document.getElementById("myCalStickyW");
    const stickyVal = document.getElementById("myCalStickyWVal");
    if (stickySlider) {
      stickySlider.addEventListener("input", (e) => {
        this._stickyW = parseInt(e.target.value, 10) || 190;
        if (stickyVal) stickyVal.textContent = this._stickyW + "px";
      });
      stickySlider.addEventListener("change", () => this.renderCalendar());
    }

    // 物件表示トグル
    container.querySelectorAll(".prop-toggle").forEach(btn => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const pid = btn.dataset.propId;
        this._propertyVisibility[pid] = !this._propertyVisibility[pid];
        this.renderCalendar();
      });
    });

    // 確定済セル → オーナーはその場で詳細モーダル表示(ページ遷移なし)
    container.querySelectorAll('.cal-cell[data-click-mode="detail"]').forEach(td => {
      td.addEventListener("click", async () => {
        const recruitId = td.dataset.recruitId;
        const recruit = this.recruitments.find(r => r.id === recruitId);
        if (!recruit) return;
        if (typeof RecruitmentPage !== "undefined" && RecruitmentPage.openDetailModal) {
          await RecruitmentPage.ensureLoaded();
          RecruitmentPage.openDetailModal(recruit);
        }
      });
    });

    // イベント: セルタップ → 回答 or 代理回答(オーナー)
    container.querySelectorAll('.cal-cell[data-click-mode="respond"]').forEach(td => {
      td.addEventListener("click", () => {
        const dateStr = td.dataset.date;
        const recruitId = td.dataset.recruitId;
        const recruit = this.recruitments.find(r => r.id === recruitId) || recruitByDate[dateStr];
        if (!recruit) return;
        this._pendingRecruitId = recruit.id;
        this._pendingDate = dateStr;
        this._pendingStaffId = td.dataset.staffId;
        this._pendingStaffName = td.dataset.staffName;
        this._pendingStaffEmail = td.dataset.staffEmail;
        this._pendingIsMe = td.dataset.isMe === "true";
        const suffix = this._pendingIsMe ? "" : `（${this._pendingStaffName} さんとして代理回答）`;
        document.getElementById("responseModalTitle").textContent = `${this.fmtDate(dateStr)} 回答 ${suffix}`;
        document.getElementById("responseModalInfo").textContent = recruit.propertyName ? `${this.fmtDate(dateStr)} ${recruit.propertyName}` : this.fmtDate(dateStr);
        document.getElementById("triangleReasonArea").classList.add("d-none");
        document.getElementById("triangleReason").value = "";
        // 既存回答がある場合は「取消」ボタン表示
        const existing = (recruit.responses || []).find(r =>
          r.staffId === this._pendingStaffId || r.staffName === this._pendingStaffName
        );
        let cancelBtn = document.getElementById("btnCancelMyResponse");
        if (!cancelBtn) {
          const footer = document.querySelector("#responseModal .modal-body");
          footer.insertAdjacentHTML("beforeend", `
            <div class="text-center mt-2"><button type="button" id="btnCancelMyResponse" class="btn btn-outline-secondary btn-sm">回答を取消（未回答に戻す）</button></div>
          `);
          cancelBtn = document.getElementById("btnCancelMyResponse");
          cancelBtn.addEventListener("click", () => this.cancelMyResponse());
        }
        cancelBtn.parentElement.style.display = existing ? "" : "none";
        new bootstrap.Modal(document.getElementById("responseModal")).show();
      });
    });

    // イベント: 日付ヘッダータップ → 予約詳細
    container.querySelectorAll(".cal-date-hd").forEach(th => {
      th.addEventListener("click", () => {
        const dateStr = th.dataset.calDate;
        const bs = bookingsByDate[dateStr];
        if (!bs || !bs.length) return;
        let html = "";
        bs.forEach(b => {
          const src = b.source.includes("airbnb") ? "Airbnb" : (b.source.includes("booking") ? "Booking.com" : "直接予約");
          const guest = this.guestMap[b.checkIn];
          html += `<div class="mb-2 p-2 border rounded">
            <div class="fw-bold mb-1">${src}</div>
            <table class="table table-sm table-borderless small mb-0">
              <tr><th class="text-muted" style="width:35%">CI</th><td>${this.fmtDate(b.checkIn)}${guest?.checkInTime ? " " + guest.checkInTime : ""}</td></tr>
              <tr><th class="text-muted">CO</th><td>${this.fmtDate(b.checkOut)}${guest?.checkOutTime ? " " + guest.checkOutTime : ""}</td></tr>
              <tr><th class="text-muted">大人</th><td>${b.guestCount || "不明"}名${guest?.guestCountInfants ? ` + 乳幼児${guest.guestCountInfants}名` : ""}</td></tr>
              ${b.propertyName ? `<tr><th class="text-muted">物件</th><td>${b.propertyName}</td></tr>` : ""}
              ${guest ? `
                ${guest.nationality ? `<tr><th class="text-muted">国籍</th><td>${guest.nationality}</td></tr>` : ""}
                ${guest.transport ? `<tr><th class="text-muted">交通手段</th><td>${guest.transport}</td></tr>` : ""}
                ${guest.carCount ? `<tr><th class="text-muted">車</th><td>${guest.carCount}台${guest.paidParking ? ` / 有料駐車場: ${guest.paidParking}` : ""}</td></tr>` : ""}
                ${guest.bbq ? `<tr><th class="text-muted">BBQ</th><td>${guest.bbq}</td></tr>` : ""}
                ${guest.bedChoice ? `<tr><th class="text-muted">ベッド</th><td>${guest.bedChoice}</td></tr>` : ""}
              ` : '<tr><td colspan="2" class="text-muted fst-italic">名簿未提出</td></tr>'}
            </table>
          </div>`;
        });
        document.getElementById("bookingDetailBody").innerHTML = html;
        new bootstrap.Modal(document.getElementById("bookingDetailModal")).show();
      });
    });

    // 今日に自動スクロール
    const todayTh = container.querySelector(`[data-cal-date="${todayStr}"]`);
    if (todayTh) container.scrollLeft = todayTh.offsetLeft - 100;
  },

  _pendingRecruitId: null,
  _pendingDate: null,

  async submitCurrentResponse(response, memo) {
    if (!this._pendingRecruitId) return;
    try {
      const ref = db.collection("recruitments").doc(this._pendingRecruitId);
      const doc = await ref.get();
      if (!doc.exists) throw new Error("募集が見つかりません");
      const data = doc.data();
      if (data.status === "スタッフ確定済み") throw new Error("確定済みの募集は回答できません");
      const responses = data.responses || [];

      // 対象スタッフ(自分 or 代理)
      const targetStaffId = this._pendingStaffId || this.staffId;
      const targetStaffName = this._pendingStaffName || this.staffDoc?.name || "不明";
      const targetStaffEmail = this._pendingStaffEmail || this.staffDoc?.email || "";
      const isMe = targetStaffId === this.staffId;

      const entry = {
        staffId: targetStaffId,
        staffName: targetStaffName,
        staffEmail: targetStaffEmail,
        response,
        memo: memo || "",
        respondedAt: new Date().toISOString(),
        proxy: !isMe,  // 代理回答フラグ
      };

      const idx = responses.findIndex(r => r.staffId === targetStaffId);
      if (idx >= 0) responses[idx] = entry; else responses.push(entry);

      await ref.update({ responses, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      bootstrap.Modal.getInstance(document.getElementById("responseModal"))?.hide();
      const suffix = isMe ? "" : `（${targetStaffName} 代理）`;
      showToast("送信完了", `${this.fmtDate(this._pendingDate)} → ${response}${suffix}`, "success");

      const updatedDoc = await ref.get();
      const ri = this.recruitments.findIndex(r => r.id === this._pendingRecruitId);
      if (ri >= 0) this.recruitments[ri] = { id: this._pendingRecruitId, ...updatedDoc.data(), checkoutDate: this.recruitments[ri].checkoutDate };
      this.renderCalendar();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  async cancelMyResponse() {
    if (!this._pendingRecruitId) return;
    try {
      const ref = db.collection("recruitments").doc(this._pendingRecruitId);
      const doc = await ref.get();
      if (!doc.exists) throw new Error("募集が見つかりません");
      const data = doc.data();
      if (data.status === "スタッフ確定済み") throw new Error("確定済みの募集は取消できません");
      const targetStaffId = this._pendingStaffId || this.staffId;
      const targetStaffName = this._pendingStaffName || "";
      const responses = (data.responses || []).filter(r =>
        r.staffId !== targetStaffId && r.staffName !== targetStaffName
      );
      await ref.update({ responses, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      bootstrap.Modal.getInstance(document.getElementById("responseModal"))?.hide();
      showToast("取消完了", `${this.fmtDate(this._pendingDate)} の回答を取り消しました`, "success");
      const updatedDoc = await ref.get();
      const ri = this.recruitments.findIndex(r => r.id === this._pendingRecruitId);
      if (ri >= 0) this.recruitments[ri] = { id: this._pendingRecruitId, ...updatedDoc.data(), checkoutDate: this.recruitments[ri].checkoutDate };
      this.renderCalendar();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  // 募集ピル (物件行内で使用)
  _recruitPill(r) {
    if (!r) return "";
    let label = "", bg = "#f5f5f5", color = "#333";
    if (r.status === "スタッフ確定済み") { label = "確定"; bg = "#198754"; color = "#fff"; }
    else if (r.status === "選定済") { label = "選定"; bg = "#ffc107"; color = "#333"; }
    else if (r.status === "募集中") { label = "募集"; bg = "#fd7e14"; color = "#fff"; }
    else { label = (r.status||"").slice(0,2); }
    const wtChar = r.workType === "pre_inspection" ? "直" : "清";
    const wtColor = r.workType === "pre_inspection" ? "#6f42c1" : "#0d6efd";
    return `<span style="display:inline-flex;align-items:center;gap:2px;font-size:10px;padding:1px 4px;background:${bg};color:${color};border-radius:3px;font-weight:600;">
      <span style="background:${wtColor};color:#fff;padding:0 3px;border-radius:2px;font-size:9px;">${wtChar}</span>${label}
    </span>`;
  },

  esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; },

  fmtDate(dateStr) {
    if (!dateStr) return "-";
    try {
      const d = new Date(dateStr + "T00:00:00");
      const dow = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
      return `${d.getMonth() + 1}/${d.getDate()}(${dow})`;
    } catch (e) { return dateStr; }
  },
};
