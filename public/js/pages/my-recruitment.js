/**
 * スタッフ用募集回答ページ
 * 横スクロールカレンダー（上部に予約バー、スタッフ行に回答状況）
 * セルタップで回答入力
 */
const MyRecruitmentPage = {
  staffId: null,
  staffDoc: null,
  staffList: [],
  recruitments: [],
  bookings: [],

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
        <span>👤 = あなた</span>
      </div>
      <p class="text-muted small mb-2">自分の行のセルをタップして回答できます。日付ヘッダーをタップすると予約詳細を確認できます。</p>
      <div id="myCalContainer" style="overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:8px;border:1px solid var(--border, #e2e8f0);"></div>

      <!-- 回答モーダル -->
      <div class="modal fade" id="responseModal" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered modal-sm">
          <div class="modal-content">
            <div class="modal-header py-2">
              <h6 class="modal-title" id="responseModalTitle">回答</h6>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body text-center">
              <div id="responseModalInfo" class="small text-muted mb-3"></div>
              <div class="d-flex gap-2 justify-content-center">
                <button class="btn btn-success btn-lg resp-btn" data-resp="◎" style="min-width:70px;">◎ OK</button>
                <button class="btn btn-warning btn-lg resp-btn" data-resp="△" style="min-width:70px;">△ 微妙</button>
                <button class="btn btn-danger btn-lg resp-btn" data-resp="×" style="min-width:70px;">× NG</button>
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
              <h6 class="modal-title">予約情報</h6>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body" id="bookingDetailBody"></div>
          </div>
        </div>
      </div>
    `;

    try {
      if (isOwner) {
        this.staffDoc = { name: Auth.currentUser.displayName || Auth.currentUser.email?.split("@")[0] || "オーナー", email: Auth.currentUser.email || "" };
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

      // 回答モーダルのボタン
      document.querySelectorAll(".resp-btn").forEach(btn => {
        btn.addEventListener("click", () => this.submitCurrentResponse(btn.dataset.resp));
      });

      this.renderCalendar();
    } catch (e) {
      console.error("読み込みエラー:", e);
      document.getElementById("myCalContainer").innerHTML = `<div class="alert alert-danger">${e.message}</div>`;
    }
  },

  async loadData() {
    const [recruitSnap, bookingSnap, staffSnap] = await Promise.all([
      db.collection("recruitments").get(),
      db.collection("bookings").get(),
      db.collection("staff").where("active", "==", true).get(),
    ]);

    this.recruitments = recruitSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => r.checkoutDate);
    this.bookings = bookingSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(b => b.status !== "cancelled");
    this.staffList = staffSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
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

    // 全日付
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
      const d = (r.checkoutDate || "").slice(0, 10);
      if (!recruitByDate[d]) recruitByDate[d] = r;
    });

    // 予約マップ（日付→予約リスト、個人情報除外）
    const bookingsByDate = {};
    this.bookings.forEach(b => {
      if (!b.checkIn || !b.checkOut) return;
      const ci = new Date(b.checkIn + "T00:00:00");
      const co = new Date(b.checkOut + "T00:00:00");
      for (let d = new Date(ci); d < co; d.setDate(d.getDate() + 1)) {
        const ds = d.toLocaleDateString("sv-SE");
        if (!bookingsByDate[ds]) bookingsByDate[ds] = [];
        bookingsByDate[ds].push({
          source: (b.source || "").toLowerCase(),
          guestCount: b.guestCount || 0,
          propertyName: b.propertyName || "",
          checkIn: b.checkIn,
          checkOut: b.checkOut,
        });
      }
    });

    const C = {
      headerBg: "#f8f9fa", stickyBg: "#fff", border: "#dee2e6",
      noRecruit: "#f9f9f9", todayBg: "#e8f0fe",
      confirmedBorder: "#dc3545", confirmedBg: "#fff5f5",
      monthSepBg: "#e9ecef",
      symOk: "#198754", symHold: "#cc9a06", symNg: "#dc3545", symNone: "#adb5bd",
      airbnbBg: "rgba(255,90,95,0.2)", bookingBg: "rgba(0,53,128,0.2)", directBg: "rgba(13,110,253,0.2)",
    };

    let html = `<table class="table table-sm mb-0" style="font-size:12px;white-space:nowrap;border-collapse:collapse;min-width:${100 + allDates.length * 36}px;">`;

    // ヘッダー行1: 月ラベル
    html += `<thead><tr><th rowspan="3" class="staff-cal-sticky" style="background:${C.headerBg};min-width:80px;max-width:100px;vertical-align:middle;position:sticky;left:0;z-index:3;">スタッフ</th>`;
    months.forEach(m => {
      const isCurrent = m.month === month && m.year === year;
      html += `<th colspan="${m.days}" class="text-center" style="background:${isCurrent ? C.headerBg : C.monthSepBg};border:1px solid ${C.border};font-size:13px;">${m.month}月</th>`;
    });
    html += "</tr>";

    // ヘッダー行2: 日付+曜日
    html += "<tr>";
    allDates.forEach(dd => {
      const dow = new Date(dd.year, dd.month - 1, dd.day).getDay();
      const isToday = dd.dateStr === todayStr;
      const hasRecruit = !!recruitByDate[dd.dateStr];
      const hasBooking = !!bookingsByDate[dd.dateStr];
      const dowColor = dow === 0 ? "#dc3545" : (dow === 6 ? "#0d6efd" : "");
      const bgColor = isToday ? C.todayBg : (!dd.isCurrent ? C.monthSepBg : (hasRecruit ? C.headerBg : C.noRecruit));
      html += `<th class="text-center${hasBooking ? " cal-date-booking" : ""}" data-cal-date="${dd.dateStr}" style="min-width:34px;padding-top:6px;${dowColor ? "color:" + dowColor + ";" : ""}background:${bgColor};border:1px solid ${C.border};cursor:${hasBooking ? "pointer" : "default"};"><div>${dd.day}</div><div style="font-size:10px;">${dayNames[dow]}</div></th>`;
    });
    html += "</tr>";

    // ヘッダー行3: 予約バー
    html += "<tr>";
    allDates.forEach(dd => {
      const bs = bookingsByDate[dd.dateStr];
      if (bs && bs.length > 0) {
        const b = bs[0];
        let bg = C.directBg;
        if (b.source.includes("airbnb")) bg = C.airbnbBg;
        else if (b.source.includes("booking")) bg = C.bookingBg;
        const label = b.guestCount > 0 ? `${b.guestCount}名` : "予約";
        html += `<th class="text-center" style="background:${bg};border:1px solid ${C.border};font-size:10px;padding:1px;">${label}</th>`;
      } else {
        html += `<th style="border:1px solid ${C.border};background:${!dd.isCurrent ? C.monthSepBg : "#fff"};"></th>`;
      }
    });
    html += "</tr></thead><tbody>";

    // 各スタッフ行
    this.staffList.forEach(staff => {
      const isMe = staff.id === this.staffId;
      const nameBg = isMe ? "#e3f2fd" : C.stickyBg;
      const nameWeight = isMe ? "bold" : "normal";
      html += `<tr><td class="staff-cal-sticky" style="background:${nameBg};font-weight:${nameWeight};border:1px solid ${C.border};border-right:2px solid ${C.border};max-width:100px;overflow:hidden;text-overflow:ellipsis;position:sticky;left:0;z-index:2;">${this.esc(staff.name)}${isMe ? " 👤" : ""}</td>`;

      allDates.forEach(dd => {
        const isToday = dd.dateStr === todayStr;
        const recruit = recruitByDate[dd.dateStr];

        if (!recruit) {
          const bg = isToday ? C.todayBg : (!dd.isCurrent ? C.monthSepBg : C.noRecruit);
          html += `<td class="text-center" style="background:${bg};border:1px solid ${C.border};color:${C.symNone};">-</td>`;
          return;
        }

        // このスタッフの回答
        const responses = recruit.responses || [];
        let resp = "未回答";
        for (const r of responses) {
          if (r.staffId === staff.id || r.staffName === staff.name || (r.staffEmail && staff.email && r.staffEmail.toLowerCase() === staff.email.toLowerCase())) {
            resp = r.response || "未回答";
            break;
          }
        }

        let symbol = "", symColor = "";
        if (resp === "◎") { symbol = "●"; symColor = C.symOk; }
        else if (resp === "△") { symbol = "▲"; symColor = C.symHold; }
        else if (resp === "×") { symbol = "✖"; symColor = C.symNg; }
        else { symbol = "−"; symColor = C.symNone; }

        // 確定済みチェック
        let isConfirmed = false;
        const sel = (recruit.selectedStaff || "").trim();
        if (sel && (recruit.status === "選定済" || recruit.status === "スタッフ確定済み")) {
          isConfirmed = sel.split(/[,、\s]+/).map(s => s.trim()).includes(staff.name);
        }

        const cellBg = isConfirmed ? C.confirmedBg : (isToday ? C.todayBg : (!dd.isCurrent ? C.monthSepBg : ""));
        const cellShadow = isConfirmed ? `box-shadow:inset 0 0 0 2px ${C.confirmedBorder};` : "";
        const canAnswer = isMe && recruit.status === "募集中";

        html += `<td class="text-center${canAnswer ? " cal-answer-cell" : ""}" data-date="${dd.dateStr}" data-staff-id="${staff.id}" style="cursor:${canAnswer ? "pointer" : "default"};border:1px solid ${C.border};${cellShadow}background:${cellBg};color:${symColor};font-weight:bold;">${symbol}</td>`;
      });

      html += "</tr>";
    });

    html += "</tbody></table>";
    container.innerHTML = html;

    // 自分のセルタップ → 回答モーダル
    container.querySelectorAll(".cal-answer-cell").forEach(td => {
      td.addEventListener("click", () => {
        const dateStr = td.dataset.date;
        const recruit = recruitByDate[dateStr];
        if (!recruit) return;
        this._pendingRecruitId = recruit.id;
        this._pendingDate = dateStr;
        document.getElementById("responseModalTitle").textContent = `${dateStr} 回答`;
        const prop = recruit.propertyName || "";
        document.getElementById("responseModalInfo").textContent = prop ? `${dateStr} ${prop}` : dateStr;
        new bootstrap.Modal(document.getElementById("responseModal")).show();
      });
    });

    // 日付ヘッダータップ → 予約詳細（個人情報除外）
    container.querySelectorAll(".cal-date-booking").forEach(th => {
      th.addEventListener("click", () => {
        const dateStr = th.dataset.calDate;
        const bs = bookingsByDate[dateStr];
        if (!bs || !bs.length) return;
        let html = "";
        bs.forEach(b => {
          const src = b.source.includes("airbnb") ? "Airbnb" : (b.source.includes("booking") ? "Booking.com" : "直接予約");
          html += `<div class="mb-2 p-2 border rounded">
            <div><strong>${src}</strong></div>
            <div class="small">CI: ${b.checkIn} → CO: ${b.checkOut}</div>
            ${b.guestCount ? `<div class="small">人数: ${b.guestCount}名</div>` : ""}
            ${b.propertyName ? `<div class="small">物件: ${b.propertyName}</div>` : ""}
          </div>`;
        });
        document.getElementById("bookingDetailBody").innerHTML = html;
        new bootstrap.Modal(document.getElementById("bookingDetailModal")).show();
      });
    });

    // 今日までスクロール
    const todayTh = container.querySelector(`[data-cal-date="${todayStr}"]`);
    if (todayTh) {
      container.scrollLeft = todayTh.offsetLeft - 100;
    }
  },

  _pendingRecruitId: null,
  _pendingDate: null,

  async submitCurrentResponse(response) {
    if (!this._pendingRecruitId) return;
    try {
      const ref = db.collection("recruitments").doc(this._pendingRecruitId);
      const doc = await ref.get();
      if (!doc.exists) throw new Error("募集が見つかりません");
      const data = doc.data();
      const responses = data.responses || [];

      const entry = {
        staffId: this.staffId,
        staffName: this.staffDoc?.name || "不明",
        staffEmail: this.staffDoc?.email || "",
        response,
        memo: "",
        respondedAt: new Date().toISOString(),
      };

      const idx = responses.findIndex(r => r.staffId === this.staffId);
      if (idx >= 0) responses[idx] = entry; else responses.push(entry);

      await ref.update({ responses, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });

      bootstrap.Modal.getInstance(document.getElementById("responseModal"))?.hide();
      showToast("送信完了", `${this._pendingDate} → ${response}`, "success");

      // データ更新して再描画
      const updatedDoc = await ref.get();
      const ri = this.recruitments.findIndex(r => r.id === this._pendingRecruitId);
      if (ri >= 0) this.recruitments[ri] = { id: this._pendingRecruitId, ...updatedDoc.data() };
      this.renderCalendar();
    } catch (e) {
      showToast("エラー", e.message, "error");
    }
  },

  esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; },
};
