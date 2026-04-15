/**
 * スタッフ用募集回答ページ
 * カレンダーに予約+募集+確定済みを全て表示（個人情報は非表示）
 * リスト表示で募集に回答
 */
const MyRecruitmentPage = {
  staffId: null,
  staffDoc: null,
  recruitments: [],   // 全ステータスの募集
  openRecruits: [],    // 募集中のみ（回答対象）
  bookings: [],        // 予約データ

  async render(container) {
    const isOwner = Auth.isOwner();
    this.staffId = Auth.currentUser?.staffId;
    if (isOwner && !this.staffId) this.staffId = Auth.currentUser.uid;

    if (!this.staffId) {
      container.innerHTML = '<div class="alert alert-warning m-3">スタッフ情報が取得できません。</div>';
      return;
    }

    container.innerHTML = `
      <div class="container-fluid px-3 py-3">
        <h5 class="mb-3"><i class="bi bi-megaphone"></i> 募集回答</h5>

        <!-- 凡例 -->
        <div class="d-flex flex-wrap gap-3 mb-2 small text-muted">
          <span><span style="display:inline-block;width:12px;height:12px;background:#ff5a5f;border-radius:2px;vertical-align:middle;"></span> Airbnb予約</span>
          <span><span style="display:inline-block;width:12px;height:12px;background:#003580;border-radius:2px;vertical-align:middle;"></span> Booking.com予約</span>
          <span><span style="display:inline-block;width:12px;height:12px;background:#ffc107;border-radius:2px;vertical-align:middle;"></span> 募集中</span>
          <span><span style="display:inline-block;width:12px;height:12px;background:#198754;border-radius:2px;vertical-align:middle;"></span> 確定済</span>
          <span>◎=回答OK △=微妙 ×=NG !=未回答</span>
        </div>

        <!-- カレンダー -->
        <div class="card mb-3">
          <div class="card-body p-2">
            <div class="d-flex justify-content-between align-items-center mb-2 px-1">
              <button class="btn btn-sm btn-outline-secondary" id="calPrev"><i class="bi bi-chevron-left"></i></button>
              <strong id="calTitle"></strong>
              <button class="btn btn-sm btn-outline-secondary" id="calNext"><i class="bi bi-chevron-right"></i></button>
            </div>
            <div id="recruitCalendar" style="display:grid;grid-template-columns:repeat(7,1fr);gap:1px;text-align:center;"></div>
          </div>
        </div>

        <!-- 募集リスト（回答対象のみ） -->
        <h6 class="mb-2"><i class="bi bi-megaphone"></i> 回答待ちの募集</h6>
        <div id="recruitmentList">
          <div class="text-center py-4">
            <div class="spinner-border spinner-border-sm text-primary"></div>
          </div>
        </div>
      </div>
    `;

    try {
      if (isOwner) {
        this.staffDoc = {
          name: Auth.currentUser.displayName || Auth.currentUser.email?.split("@")[0] || "オーナー",
          email: Auth.currentUser.email || "",
        };
      } else {
        const staffSnap = await db.collection("staff").doc(this.staffId).get();
        this.staffDoc = staffSnap.exists ? staffSnap.data() : {};
      }

      await this.loadData();
      this._calMonth = new Date();
      this.renderCalendar();

      document.getElementById("calPrev").addEventListener("click", () => {
        this._calMonth.setMonth(this._calMonth.getMonth() - 1);
        this.renderCalendar();
      });
      document.getElementById("calNext").addEventListener("click", () => {
        this._calMonth.setMonth(this._calMonth.getMonth() + 1);
        this.renderCalendar();
      });
    } catch (e) {
      console.error("読み込みエラー:", e);
      document.getElementById("recruitmentList").innerHTML = `
        <div class="alert alert-danger">読み込みエラー: ${e.message}</div>
      `;
    }
  },

  async loadData() {
    // 予約データ（キャンセル除外、個人情報除去）
    const bookingSnap = await db.collection("bookings").get();
    this.bookings = bookingSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(b => b.status !== "cancelled")
      .map(b => ({
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        guestCount: b.guestCount || 0,
        source: (b.source || "").toLowerCase(),
        propertyName: b.propertyName || "",
      }));

    // 全募集データ
    const recruitSnap = await db.collection("recruitments").get();
    this.recruitments = recruitSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(r => r.checkoutDate);

    // 回答対象（募集中のみ）
    this.openRecruits = this.recruitments
      .filter(r => r.status === "募集中")
      .sort((a, b) => (a.checkoutDate || "").localeCompare(b.checkoutDate || ""));

    this.renderList();
  },

  renderCalendar() {
    const cal = document.getElementById("recruitCalendar");
    const title = document.getElementById("calTitle");
    const year = this._calMonth.getFullYear();
    const month = this._calMonth.getMonth();
    title.textContent = `${year}年${month + 1}月`;

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayStr = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD

    // 予約マップ（CI〜CO期間でマーク）
    const bookingDays = {}; // dateStr → { source, count }
    this.bookings.forEach(b => {
      if (!b.checkIn || !b.checkOut) return;
      const ci = new Date(b.checkIn + "T00:00:00");
      const co = new Date(b.checkOut + "T00:00:00");
      for (let d = new Date(ci); d < co; d.setDate(d.getDate() + 1)) {
        const ds = d.toLocaleDateString("sv-SE");
        if (!bookingDays[ds]) bookingDays[ds] = { source: b.source, count: b.guestCount };
      }
    });

    // 募集マップ
    const recruitMap = {};
    this.recruitments.forEach(r => {
      if (r.checkoutDate) recruitMap[r.checkoutDate] = r;
    });

    // 自分の回答マップ
    const myAnswerMap = {};
    this.recruitments.forEach(r => {
      const my = (r.responses || []).find(resp => resp.staffId === this.staffId);
      if (my && r.checkoutDate) myAnswerMap[r.checkoutDate] = my.response;
    });

    let html = "";
    // 曜日ヘッダー
    ["日", "月", "火", "水", "木", "金", "土"].forEach((d, i) => {
      const color = i === 0 ? "color:#dc3545;" : i === 6 ? "color:#0d6efd;" : "";
      html += `<div class="small fw-bold py-1" style="${color}">${d}</div>`;
    });

    // 空白
    for (let i = 0; i < firstDay; i++) html += `<div></div>`;

    // 日付
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const isToday = dateStr === todayStr;
      const booking = bookingDays[dateStr];
      const recruit = recruitMap[dateStr];
      const myAnswer = myAnswerMap[dateStr];

      let bg = "";
      let dots = [];

      // 予約背景
      if (booking) {
        if (booking.source.includes("airbnb")) bg = "background:rgba(255,90,95,0.15);";
        else if (booking.source.includes("booking")) bg = "background:rgba(0,53,128,0.15);";
        else bg = "background:rgba(13,110,253,0.15);";
      }

      // 募集・確定ドット
      if (recruit) {
        if (recruit.status === "スタッフ確定済み") {
          dots.push('<span style="color:#198754;font-size:0.6rem;">●確定</span>');
        } else if (recruit.status === "募集中") {
          if (myAnswer === "◎") dots.push('<span style="color:#198754;font-weight:bold;font-size:0.6rem;">◎</span>');
          else if (myAnswer === "△") dots.push('<span style="color:#cc9a06;font-weight:bold;font-size:0.6rem;">△</span>');
          else if (myAnswer === "×") dots.push('<span style="color:#dc3545;font-weight:bold;font-size:0.6rem;">×</span>');
          else dots.push('<span style="color:#ffc107;font-size:0.6rem;">●募集</span>');
        }
      }

      const todayBorder = isToday ? "border:2px solid #0d6efd;" : "";
      const cursor = recruit && recruit.status === "募集中" ? "cursor:pointer;" : "";

      html += `<div class="py-1 rounded" style="${bg}${todayBorder}${cursor}font-size:0.85rem;" ${recruit && recruit.status === "募集中" ? `data-cal-date="${dateStr}"` : ""}>
        <div>${d}</div>
        ${dots.length ? `<div>${dots.join("")}</div>` : ""}
      </div>`;
    }

    cal.innerHTML = html;

    // 募集中の日付クリック→該当カードにスクロール
    cal.querySelectorAll("[data-cal-date]").forEach(el => {
      el.addEventListener("click", () => {
        const date = el.dataset.calDate;
        const card = document.querySelector(`[data-recruit-date="${date}"]`);
        if (card) {
          card.scrollIntoView({ behavior: "smooth", block: "center" });
          card.style.boxShadow = "0 0 0 3px #0d6efd";
          setTimeout(() => card.style.boxShadow = "", 2000);
        }
      });
    });
  },

  renderList() {
    const listEl = document.getElementById("recruitmentList");

    if (this.openRecruits.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-4 text-muted">
          <i class="bi bi-check-circle" style="font-size:2rem;"></i>
          <p class="mt-2">現在、回答待ちの募集はありません</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = this.openRecruits.map(r => this.renderRecruitmentCard(r)).join("");

    listEl.querySelectorAll(".response-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        this.submitResponse(e.currentTarget.dataset.recruitId, e.currentTarget.dataset.response);
      });
    });
  },

  renderRecruitmentCard(recruitment) {
    const responses = recruitment.responses || [];
    const myResponse = responses.find(r => r.staffId === this.staffId);
    const myAnswer = myResponse?.response || null;

    const date = recruitment.checkoutDate || "";
    let dateDisplay = date;
    if (date) {
      try {
        const d = new Date(date + "T00:00:00");
        const dow = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
        dateDisplay = `${d.getMonth() + 1}/${d.getDate()}(${dow})`;
      } catch (e) { /* フォールバック */ }
    }
    const property = recruitment.propertyName || "";
    const memo = recruitment.memo || "";

    const okCount = responses.filter(r => r.response === "◎" || r.response === "△").length;
    const ngCount = responses.filter(r => r.response === "×").length;

    const buttons = ["◎", "△", "×"].map(resp => {
      const isSelected = myAnswer === resp;
      const colorMap = { "◎": "btn-success", "△": "btn-warning", "×": "btn-danger" };
      const outlineMap = { "◎": "btn-outline-success", "△": "btn-outline-warning", "×": "btn-outline-danger" };
      const labelMap = { "◎": "OK", "△": "微妙", "×": "NG" };
      const btnClass = isSelected ? colorMap[resp] : outlineMap[resp];

      return `
        <button class="btn ${btnClass} response-btn"
                data-recruit-id="${recruitment.id}"
                data-response="${resp}"
                ${isSelected ? 'style="font-weight:bold;box-shadow:0 0 0 3px rgba(0,0,0,0.15);"' : ""}>
          ${resp} ${labelMap[resp]}
        </button>
      `;
    }).join("");

    return `
      <div class="card staff-card mb-3" id="recruit-${recruitment.id}" data-recruit-date="${date}">
        <div class="card-body">
          <div class="d-flex justify-content-between align-items-start mb-2">
            <div>
              <div class="fw-bold">${dateDisplay}</div>
              ${property ? `<div class="text-muted small"><i class="bi bi-geo-alt"></i> ${property}</div>` : ""}
            </div>
            <span class="badge bg-secondary small">回答 ${okCount + ngCount}件</span>
          </div>
          ${memo ? `<div class="text-muted small mb-2"><i class="bi bi-chat-left-text"></i> ${memo}</div>` : ""}
          ${myAnswer ? `<div class="small mb-2 text-primary"><i class="bi bi-check-circle"></i> 回答済み: ${myAnswer}</div>` : ""}
          <div class="response-btn-group d-flex gap-2">
            ${buttons}
          </div>
        </div>
      </div>
    `;
  },

  async submitResponse(recruitmentId, response) {
    try {
      const ref = db.collection("recruitments").doc(recruitmentId);
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
      if (idx >= 0) { responses[idx] = entry; } else { responses.push(entry); }

      await ref.update({
        responses,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      showToast("送信完了", `${response} で回答しました`, "success");

      // データ更新して再描画
      const updatedDoc = await ref.get();
      const ri = this.recruitments.findIndex(r => r.id === recruitmentId);
      if (ri >= 0) this.recruitments[ri] = { id: recruitmentId, ...updatedDoc.data() };
      const oi = this.openRecruits.findIndex(r => r.id === recruitmentId);
      if (oi >= 0) this.openRecruits[oi] = { id: recruitmentId, ...updatedDoc.data() };
      this.renderList();
      this.renderCalendar();

      document.getElementById("recruitmentList").querySelectorAll(".response-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
          this.submitResponse(e.currentTarget.dataset.recruitId, e.currentTarget.dataset.response);
        });
      });
    } catch (e) {
      console.error("回答送信エラー:", e);
      showToast("エラー", `回答の送信に失敗しました: ${e.message}`, "error");
    }
  },
};
