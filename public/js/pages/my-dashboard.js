/**
 * スタッフ用マイダッシュボード
 * 今日のシフト、今後の予定、未回答募集件数を表示
 */
const MyDashboardPage = {
  async render(container) {
    const staffId = Auth.currentUser?.staffId;
    if (!staffId) {
      container.innerHTML = '<div class="alert alert-warning m-3">スタッフ情報が取得できません。再ログインしてください。</div>';
      return;
    }

    container.innerHTML = `
      <div class="container-fluid px-3 py-3">
        <h5 class="mb-3"><i class="bi bi-house-door"></i> マイページ</h5>
        <div id="myDashContent">
          <div class="text-center py-4">
            <div class="spinner-border spinner-border-sm text-primary"></div>
            <span class="ms-2">読み込み中...</span>
          </div>
        </div>
      </div>
    `;

    try {
      const [todayShifts, upcomingShifts, pendingRecruitments] = await Promise.all([
        this.loadTodayShifts(staffId),
        this.loadUpcomingShifts(staffId),
        this.loadPendingRecruitments(staffId),
      ]);

      const content = document.getElementById("myDashContent");
      content.innerHTML = "";

      // 今日のタスク
      content.innerHTML += `<div class="staff-section-title">今日のタスク</div>`;
      if (todayShifts.length === 0) {
        content.innerHTML += '<div class="card staff-card mb-2"><div class="card-body text-muted">今日の予定はありません</div></div>';
      } else {
        for (const s of todayShifts) {
          content.innerHTML += this.renderShiftCard(s, true);
        }
      }

      // 未回答の募集
      if (pendingRecruitments > 0) {
        content.innerHTML += `
          <div class="staff-section-title">未回答の募集</div>
          <a href="#/my-recruitment" class="card staff-card mb-2 text-decoration-none">
            <div class="card-body d-flex align-items-center justify-content-between">
              <span><i class="bi bi-megaphone text-primary"></i> 回答待ちの募集が <strong>${pendingRecruitments}件</strong> あります</span>
              <i class="bi bi-chevron-right text-muted"></i>
            </div>
          </a>
        `;
      }

      // 今後のシフト
      content.innerHTML += `<div class="staff-section-title">今後の予定（7日間）</div>`;
      if (upcomingShifts.length === 0) {
        content.innerHTML += '<div class="card staff-card mb-2"><div class="card-body text-muted">今後の予定はありません</div></div>';
      } else {
        for (const s of upcomingShifts) {
          content.innerHTML += this.renderShiftCard(s, false);
        }
      }
    } catch (e) {
      console.error("マイダッシュボード読み込みエラー:", e);
      document.getElementById("myDashContent").innerHTML = `
        <div class="alert alert-danger">読み込みエラー: ${e.message}</div>
      `;
    }
  },

  async loadTodayShifts(staffId) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const snap = await db.collection("shifts")
      .where("staffId", "==", staffId)
      .where("date", ">=", today)
      .where("date", "<", tomorrow)
      .get();

    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  async loadUpcomingShifts(staffId) {
    const tomorrow = new Date();
    tomorrow.setHours(0, 0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const weekLater = new Date(tomorrow);
    weekLater.setDate(weekLater.getDate() + 7);

    const snap = await db.collection("shifts")
      .where("staffId", "==", staffId)
      .where("date", ">=", tomorrow)
      .where("date", "<", weekLater)
      .orderBy("date", "asc")
      .get();

    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  async loadPendingRecruitments(staffId) {
    // 「募集中」の募集から、自分が未回答のものをカウント
    const snap = await db.collection("recruitments")
      .where("status", "==", "募集中")
      .get();

    let count = 0;
    for (const doc of snap.docs) {
      const data = doc.data();
      const responses = data.responses || [];
      const myResponse = responses.find(r => r.staffId === staffId);
      if (!myResponse) count++;
    }
    return count;
  },

  renderShiftCard(shift, isToday) {
    const date = shift.date?.toDate ? shift.date.toDate() : new Date(shift.date);
    const dateStr = date.toLocaleDateString("ja-JP", { month: "short", day: "numeric", weekday: "short" });
    const time = shift.startTime || "未定";
    const property = shift.propertyName || shift.propertyId || "";
    const statusMap = {
      unassigned: { label: "未割当", class: "bg-secondary" },
      assigned: { label: "割当済", class: "bg-info" },
      confirmed: { label: "確定", class: "bg-primary" },
      completed: { label: "完了", class: "bg-success" },
      cancelled: { label: "キャンセル", class: "bg-danger" },
    };
    const st = statusMap[shift.status] || { label: shift.status || "不明", class: "bg-secondary" };

    const checklistBtn = isToday && shift.status !== "completed"
      ? `<a href="#/my-checklist/${shift.id}" class="btn btn-sm btn-outline-primary mt-2">
           <i class="bi bi-clipboard-check"></i> チェックリスト開始
         </a>`
      : "";

    return `
      <div class="card staff-card mb-2">
        <div class="card-body">
          <div class="d-flex justify-content-between align-items-start">
            <div>
              <div class="fw-bold">${isToday ? "" : `${dateStr} `}${property}</div>
              <div class="text-muted small"><i class="bi bi-clock"></i> ${time}</div>
            </div>
            <span class="badge ${st.class}">${st.label}</span>
          </div>
          ${checklistBtn}
        </div>
      </div>
    `;
  },
};
