/**
 * スタッフ用マイダッシュボード
 * 今日のシフト、今後の予定、未回答募集件数を表示
 * オーナーがアクセスした場合は全データを表示
 */
const MyDashboardPage = {
  async render(container) {
    const isOwner = Auth.isOwner();
    const staffId = Auth.currentUser?.staffId;
    const displayName = Auth.currentUser?.displayName || Auth.currentUser?.email?.split("@")[0] || "オーナー";

    if (!isOwner && !staffId) {
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

    // FCM初期化 + 通知許可バナー表示（非同期でバックグラウンド実行）
    this._initFCMBanner();

    try {
      const [todayShifts, upcomingShifts, pendingRecruitments] = await Promise.all([
        this.loadTodayShifts(staffId, isOwner),
        this.loadUpcomingShifts(staffId, isOwner),
        this.loadPendingRecruitments(staffId, isOwner),
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

  async loadTodayShifts(staffId, isOwner) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    let query = db.collection("shifts").where("date", ">=", today).where("date", "<", tomorrow);
    if (!isOwner && staffId) query = query.where("staffId", "==", staffId);

    const snap = await query.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  async loadUpcomingShifts(staffId, isOwner) {
    const tomorrow = new Date();
    tomorrow.setHours(0, 0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const weekLater = new Date(tomorrow);
    weekLater.setDate(weekLater.getDate() + 7);

    let query = db.collection("shifts").where("date", ">=", tomorrow).where("date", "<", weekLater).orderBy("date", "asc");
    if (!isOwner && staffId) query = query.where("staffId", "==", staffId);

    const snap = await query.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  async loadPendingRecruitments(staffId, isOwner) {
    const snap = await db.collection("recruitments")
      .where("status", "==", "募集中")
      .get();

    if (isOwner) return snap.size; // オーナーは全件表示

    let count = 0;
    for (const doc of snap.docs) {
      const data = doc.data();
      const responses = data.responses || [];
      const myResponse = responses.find(r => r.staffId === staffId);
      if (!myResponse) count++;
    }
    return count;
  },

  /**
   * FCM初期化 + 通知許可バナー表示
   * 許可済みなら何もしない、未許可なら控えめなバナーを表示
   */
  async _initFCMBanner() {
    if (typeof FCMClient === "undefined") return;

    await FCMClient.init();
    const status = FCMClient.getPermissionStatus();

    // すでに許可済みの場合はトークンを(再)保存して終了
    if (status === "granted") {
      FCMClient.requestAndSave().catch(() => {});
      return;
    }

    // 拒否済みの場合はバナー表示不要
    if (status === "denied") return;

    // 未決定(default)→ 控えめなバナーを表示
    const container = document.getElementById("myDashContent");
    if (!container) return;

    const bannerId = "fcmPermissionBanner";
    if (document.getElementById(bannerId)) return; // 重複防止

    const banner = document.createElement("div");
    banner.id = bannerId;
    banner.className = "alert alert-info d-flex align-items-center gap-2 mb-3 py-2";
    banner.innerHTML = `
      <i class="bi bi-bell fs-5 flex-shrink-0"></i>
      <div class="flex-grow-1 small">清掃スケジュールなどをプッシュ通知で受け取れます</div>
      <button class="btn btn-sm btn-primary" id="btnEnableFCM">通知をオンにする</button>
      <button class="btn btn-sm btn-outline-secondary" id="btnDismissFCM">後で</button>
    `;
    container.insertAdjacentElement("afterbegin", banner);

    document.getElementById("btnEnableFCM").addEventListener("click", async () => {
      banner.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>許可リクエスト中...';
      const result = await FCMClient.requestAndSave();
      if (result.success) {
        banner.className = "alert alert-success d-flex align-items-center gap-2 mb-3 py-2";
        banner.innerHTML = '<i class="bi bi-check-circle-fill"></i> プッシュ通知を有効にしました';
        setTimeout(() => banner.remove(), 3000);
      } else {
        banner.className = "alert alert-warning d-flex align-items-center gap-2 mb-3 py-2";
        banner.innerHTML = `<i class="bi bi-exclamation-triangle"></i> 通知の許可に失敗しました: ${result.error || ""}`;
        setTimeout(() => banner.remove(), 4000);
      }
    });

    document.getElementById("btnDismissFCM").addEventListener("click", () => banner.remove());
  },

  renderShiftCard(shift, isToday) {
    const date = shift.date?.toDate ? shift.date.toDate() : new Date(shift.date);
    const dateStr = date.toLocaleDateString("ja-JP", { month: "short", day: "numeric", weekday: "short" });
    const time = shift.startTime || "未定";
    const property = shift.propertyName || shift.propertyId || "";
    const staffName = shift.staffName || "";
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

    // オーナー表示時はスタッフ名も表示
    const staffLabel = Auth.isOwner() && staffName ? `<span class="text-muted small ms-2">担当: ${staffName}</span>` : "";

    // 今後の予定 (未来) カードはクリックでチェックリスト詳細へ遷移 (事前確認用)
    // 今日カードは既存の「チェックリスト開始」ボタンに任せる (a in a 回避)
    const linkable = !isToday && shift.id && shift.status !== "cancelled";
    const cardInner = `
      <div class="card staff-card mb-2" ${linkable ? 'style="cursor:pointer;"' : ""}>
        <div class="card-body">
          <div class="d-flex justify-content-between align-items-start">
            <div>
              <div class="fw-bold">${isToday ? "" : `${dateStr} `}${property}${staffLabel}</div>
              <div class="text-muted small"><i class="bi bi-clock"></i> ${time}</div>
            </div>
            <span class="badge ${st.class}">${st.label}</span>
          </div>
          ${checklistBtn}
          ${linkable ? `<div class="small text-muted mt-1"><i class="bi bi-arrow-right-circle"></i> タップでチェックリストを事前確認</div>` : ""}
        </div>
      </div>
    `;
    return linkable
      ? `<a href="#/my-checklist/${shift.id}" class="text-decoration-none text-reset d-block">${cardInner}</a>`
      : cardInner;
  },
};
