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
      <div class="d-flex flex-wrap gap-3 mb-3 small text-muted">
        <span><span style="background:#ff5a5f;display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:middle;"></span> Airbnb</span>
        <span><span style="background:#003580;display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:middle;"></span> Booking.com</span>
        <span style="margin-left:8px;"><span style="color:#198754;font-weight:bold;">●</span> ◎</span>
        <span><span style="color:#cc9a06;font-weight:bold;">▲</span> △</span>
        <span><span style="color:#dc3545;font-weight:bold;">✖</span> ×</span>
        <span><span style="color:#adb5bd;">−</span> 未回答</span>
        <span><span style="display:inline-block;width:10px;height:10px;border:2px solid #dc3545;border-radius:2px;vertical-align:middle;"></span> 確定済</span>
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
      if (isOwner) {
        this.staffDoc = { name: "オーナー", email: Auth.currentUser.email || "" };
      } else {
        const staffSnap = await db.collection("staff").doc(this.staffId).get();
        this.staffDoc = staffSnap.exists ? staffSnap.data() : {};
      }

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
    const [recruitSnap, bookingSnap, staffSnap, guestSnap] = await Promise.all([
      db.collection("recruitments").get(),
      db.collection("bookings").get(),
      db.collection("staff").where("active", "==", true).get(),
      db.collection("guestRegistrations").get(),
    ]);

    // recruitments: checkOutDate/checkoutDate 両対応
    this.recruitments = recruitSnap.docs.map(d => {
      const raw = d.data();
      const coDate = this._normalizeDate(raw.checkoutDate || raw.checkOutDate || raw.checkOutdate);
      return { id: d.id, ...raw, checkoutDate: coDate };
    }).filter(r => r.checkoutDate);

    this.bookings = bookingSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(b => b.status !== "cancelled");

    this.staffList = staffSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));

    // オーナーをリスト先頭に追加
    if (Auth.isOwner() && !this.staffList.some(s => s.id === this.staffId)) {
      this.staffList.unshift({ id: this.staffId, name: "オーナー", email: this.staffDoc?.email || "", displayOrder: -1 });
    }

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

    // 募集マップ
    const recruitByDate = {};
    this.recruitments.forEach(r => {
      if (r.status === "キャンセル済み") return;
      const d = r.checkoutDate;
      if (d && !recruitByDate[d]) recruitByDate[d] = r;
    });

    // 予約マップ
    const bookingsByDate = {};
    this.bookings.forEach(b => {
      if (!b.checkIn || !b.checkOut) return;
      const ci = new Date(b.checkIn + "T00:00:00");
      const co = new Date(b.checkOut + "T00:00:00");
      for (let d = new Date(ci); d < co; d.setDate(d.getDate() + 1)) {
        const ds = d.toLocaleDateString("sv-SE");
        if (!bookingsByDate[ds]) bookingsByDate[ds] = [];
        bookingsByDate[ds].push({
          source: (b.source || "").toLowerCase(), guestCount: b.guestCount || 0,
          propertyName: b.propertyName || "", checkIn: b.checkIn, checkOut: b.checkOut,
        });
      }
    });

    // スタイル
    const cellH = "38px";
    const stickyW = "90px";
    const colW = "36px";

    let html = `<table class="table table-sm table-hover mb-0 align-middle" style="font-size:12px;white-space:nowrap;border-collapse:collapse;min-width:calc(${stickyW} + ${allDates.length} * ${colW});">`;

    // ===== ヘッダー =====
    html += `<thead class="table-light">`;

    // 行1: 月ラベル
    html += `<tr><th rowspan="4" class="text-center" style="position:sticky;left:0;z-index:3;background:#f8f9fa;min-width:${stickyW};max-width:${stickyW};border-right:2px solid #dee2e6;">スタッフ</th>`;
    months.forEach(m => {
      const cur = m.month === month && m.year === year;
      html += `<th colspan="${m.days}" class="text-center" style="background:${cur ? "#f8f9fa" : "#e9ecef"};border:1px solid #dee2e6;font-size:13px;">${m.year}/${m.month}月</th>`;
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
      html += `<th class="text-center${hasBooking ? " cal-date-hd" : ""}" data-cal-date="${dd.dateStr}" style="min-width:${colW};height:${cellH};${dowColor ? "color:" + dowColor + ";" : ""}background:${bg};border:1px solid #dee2e6;cursor:${hasBooking ? "pointer" : "default"};"><div>${dd.day}</div><div style="font-size:9px;">${dayNames[dow]}</div></th>`;
    });
    html += "</tr>";

    // 行3: 予約バー
    html += "<tr>";
    allDates.forEach(dd => {
      const bs = bookingsByDate[dd.dateStr];
      if (bs && bs.length) {
        const b = bs[0];
        let bg = "rgba(13,110,253,0.15)";
        if (b.source.includes("airbnb")) bg = "rgba(255,90,95,0.2)";
        else if (b.source.includes("booking")) bg = "rgba(0,53,128,0.2)";
        const label = b.guestCount > 0 ? `${b.guestCount}名` : "●";
        html += `<th class="text-center" style="background:${bg};border:1px solid #dee2e6;font-size:10px;height:22px;padding:0;">${label}</th>`;
      } else {
        html += `<th style="border:1px solid #dee2e6;height:22px;background:${!dd.isCurrent ? "#e9ecef" : "#fff"};"></th>`;
      }
    });
    html += "</tr>";

    // 行4: 募集ステータス
    html += "<tr>";
    allDates.forEach(dd => {
      const r = recruitByDate[dd.dateStr];
      if (r) {
        let label = "", bg = "";
        if (r.status === "スタッフ確定済み") { label = "確定"; bg = "#d4edda"; }
        else if (r.status === "選定済") { label = "選定"; bg = "#fff3cd"; }
        else if (r.status === "募集中") { label = "募集"; bg = "#ffc107"; }
        else { label = r.status?.slice(0, 2) || ""; bg = "#f5f5f5"; }
        html += `<th class="text-center" style="background:${bg};border:1px solid #dee2e6;font-size:9px;height:20px;padding:0;font-weight:bold;">${label}</th>`;
      } else {
        html += `<th style="border:1px solid #dee2e6;height:20px;background:${!dd.isCurrent ? "#e9ecef" : "#f9f9f9"};"></th>`;
      }
    });
    html += "</tr></thead><tbody>";

    // ===== スタッフ行 =====
    this.staffList.forEach(staff => {
      const isMe = staff.id === this.staffId;
      html += `<tr><td class="fw-medium" style="position:sticky;left:0;z-index:2;background:${isMe ? "#e3f2fd" : "#fff"};min-width:${stickyW};max-width:${stickyW};border-right:2px solid #dee2e6;overflow:hidden;text-overflow:ellipsis;height:${cellH};">${this.esc(staff.name)}${isMe ? " 👤" : ""}</td>`;

      allDates.forEach(dd => {
        const isToday = dd.dateStr === todayStr;
        const recruit = recruitByDate[dd.dateStr];

        if (!recruit) {
          const bg = isToday ? "#e8f0fe" : (!dd.isCurrent ? "#e9ecef" : "#f9f9f9");
          html += `<td class="text-center" style="background:${bg};border:1px solid #dee2e6;color:#adb5bd;height:${cellH};">-</td>`;
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
        const canAnswer = isMe && recruit.status === "募集中";

        html += `<td class="text-center${canAnswer ? " cal-cell" : ""}" data-date="${dd.dateStr}" data-staff="${staff.id}" style="cursor:${canAnswer ? "pointer" : "default"};border:1px solid #dee2e6;${shadow}background:${cellBg};color:${symColor};font-weight:bold;height:${cellH};">${symbol}</td>`;
      });
      html += "</tr>";
    });

    html += "</tbody></table>";
    container.innerHTML = html;

    // イベント: 自分のセルタップ → 回答
    container.querySelectorAll(".cal-cell").forEach(td => {
      td.addEventListener("click", () => {
        const dateStr = td.dataset.date;
        const recruit = recruitByDate[dateStr];
        if (!recruit) return;
        this._pendingRecruitId = recruit.id;
        this._pendingDate = dateStr;
        document.getElementById("responseModalTitle").textContent = `${this.fmtDate(dateStr)} 回答`;
        document.getElementById("responseModalInfo").textContent = recruit.propertyName ? `${this.fmtDate(dateStr)} ${recruit.propertyName}` : this.fmtDate(dateStr);
        document.getElementById("triangleReasonArea").classList.add("d-none");
        document.getElementById("triangleReason").value = "";
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
      const responses = data.responses || [];

      const entry = {
        staffId: this.staffId, staffName: this.staffDoc?.name || "不明",
        staffEmail: this.staffDoc?.email || "", response,
        memo: memo || "", respondedAt: new Date().toISOString(),
      };

      const idx = responses.findIndex(r => r.staffId === this.staffId);
      if (idx >= 0) responses[idx] = entry; else responses.push(entry);

      await ref.update({ responses, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      bootstrap.Modal.getInstance(document.getElementById("responseModal"))?.hide();
      showToast("送信完了", `${this.fmtDate(this._pendingDate)} → ${response}`, "success");

      const updatedDoc = await ref.get();
      const ri = this.recruitments.findIndex(r => r.id === this._pendingRecruitId);
      if (ri >= 0) this.recruitments[ri] = { id: this._pendingRecruitId, ...updatedDoc.data(), checkoutDate: this.recruitments[ri].checkoutDate };
      this.renderCalendar();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
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
