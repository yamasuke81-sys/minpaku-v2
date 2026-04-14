/**
 * スタッフ用募集回答ページ
 * カレンダー表示 + リスト表示で募集に回答
 * オーナーも自分の名前で回答可能
 */
const MyRecruitmentPage = {
  staffId: null,
  staffDoc: null,
  recruitments: [],

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

        <!-- 募集リスト -->
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

      await this.loadRecruitments();
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
      console.error("募集読み込みエラー:", e);
      document.getElementById("recruitmentList").innerHTML = `
        <div class="alert alert-danger">読み込みエラー: ${e.message}</div>
      `;
    }
  },

  async loadRecruitments() {
    const snap = await db.collection("recruitments")
      .where("status", "==", "募集中")
      .get();

    this.recruitments = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(r => r.checkoutDate) // 日付なしの募集は除外
      .sort((a, b) => (a.checkoutDate || "").localeCompare(b.checkoutDate || ""));

    this.renderList();
  },

  renderCalendar() {
    const cal = document.getElementById("recruitCalendar");
    const title = document.getElementById("calTitle");
    const year = this._calMonth.getFullYear();
    const month = this._calMonth.getMonth();
    title.textContent = `${year}年${month + 1}月`;

    const firstDay = new Date(year, month, 1).getDay(); // 0=日
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date().toISOString().slice(0, 10);

    // 募集日マップ
    const recruitMap = {};
    this.recruitments.forEach(r => {
      if (r.checkoutDate) {
        if (!recruitMap[r.checkoutDate]) recruitMap[r.checkoutDate] = [];
        recruitMap[r.checkoutDate].push(r);
      }
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
      const isToday = dateStr === today;
      const hasRecruit = !!recruitMap[dateStr];
      const myAnswer = myAnswerMap[dateStr];

      let bg = "";
      let badge = "";
      if (hasRecruit) {
        if (myAnswer === "◎") { bg = "background:#d4edda;"; badge = "◎"; }
        else if (myAnswer === "△") { bg = "background:#fff3cd;"; badge = "△"; }
        else if (myAnswer === "×") { bg = "background:#f8d7da;"; badge = "×"; }
        else { bg = "background:#cfe2ff;"; badge = "!"; }
      }
      const todayBorder = isToday ? "border:2px solid #0d6efd;" : "";
      const cursor = hasRecruit ? "cursor:pointer;" : "";

      html += `<div class="py-1 rounded" style="${bg}${todayBorder}${cursor}font-size:0.85rem;" ${hasRecruit ? `data-cal-date="${dateStr}"` : ""}>
        <div>${d}</div>
        ${badge ? `<div style="font-size:0.65rem;font-weight:bold;">${badge}</div>` : ""}
      </div>`;
    }

    cal.innerHTML = html;

    // カレンダー日付クリック→該当募集にスクロール
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

    if (this.recruitments.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-5 text-muted">
          <i class="bi bi-check-circle" style="font-size:2rem;"></i>
          <p class="mt-2">現在、募集中の案件はありません</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = this.recruitments.map(r => this.renderRecruitmentCard(r)).join("");

    listEl.querySelectorAll(".response-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const recruitId = e.currentTarget.dataset.recruitId;
        const response = e.currentTarget.dataset.response;
        this.submitResponse(recruitId, response);
      });
    });
  },

  renderRecruitmentCard(recruitment) {
    const responses = recruitment.responses || [];
    const myResponse = responses.find(r => r.staffId === this.staffId);
    const myAnswer = myResponse?.response || null;

    const date = recruitment.checkoutDate || "";
    // 日付をわかりやすく表示
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
      const responseData = {
        staffId: this.staffId,
        staffName: this.staffDoc?.name || "不明",
        staffEmail: this.staffDoc?.email || "",
        response,
        memo: "",
      };

      const ref = db.collection("recruitments").doc(recruitmentId);
      const doc = await ref.get();
      if (!doc.exists) throw new Error("募集が見つかりません");
      const data = doc.data();
      const responses = data.responses || [];

      const idx = responses.findIndex(r => r.staffId === this.staffId);
      const entry = { ...responseData, respondedAt: new Date().toISOString() };
      if (idx >= 0) { responses[idx] = entry; } else { responses.push(entry); }

      await ref.update({
        responses,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      showToast("送信完了", `${response} で回答しました`, "success");

      // データ更新してリスト＋カレンダー再描画
      const updatedDoc = await ref.get();
      const ri = this.recruitments.findIndex(r => r.id === recruitmentId);
      if (ri >= 0) this.recruitments[ri] = { id: recruitmentId, ...updatedDoc.data() };
      this.renderList();
      this.renderCalendar();

      // 新しいボタンにイベント再設定
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
