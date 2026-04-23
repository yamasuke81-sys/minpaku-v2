/**
 * スタッフ用マイダッシュボード
 * 今日のシフト、今後の予定、未回答募集件数を表示
 * Webアプリ管理者がアクセスした場合は全データを表示
 *
 * onSnapshot でリアルタイム更新。複数リスナーは _unsubs[] に積み、
 * detach() で確実に全解除する。
 */
const MyDashboardPage = {
  // onSnapshot の unsubscribe 関数を蓄積する配列
  _unsubs: [],

  // キャッシュ
  _todayShifts: null,
  _upcomingShifts: null,
  _pendingCount: null,
  _loadedFlags: { today: false, upcoming: false, pending: false },

  async render(container) {
    const isOwner = Auth.isOwner();
    const staffId = Auth.currentUser?.staffId;
    const displayName = Auth.currentUser?.displayName || Auth.currentUser?.email?.split("@")[0] || "Webアプリ管理者";

    if (!isOwner && !staffId) {
      container.innerHTML = '<div class="alert alert-warning m-3">スタッフ情報が取得できません。再ログインしてください。</div>';
      return;
    }

    // 前回のリスナーを念のため解除
    this.detach();

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

    // キャッシュ初期化
    this._todayShifts = null;
    this._upcomingShifts = null;
    this._pendingCount = null;
    this._loadedFlags = { today: false, upcoming: false, pending: false };

    // onSnapshot 3本を並行登録
    this._subscribeToday(staffId, isOwner);
    this._subscribeUpcoming(staffId, isOwner);
    this._subscribePending(staffId, isOwner);
  },

  /** 今日のシフトを onSnapshot で監視 */
  _subscribeToday(staffId, isOwner) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    let query = db.collection("shifts").where("date", ">=", today).where("date", "<", tomorrow);
    if (!isOwner && staffId) query = query.where("staffId", "==", staffId);

    const unsub = query.onSnapshot(snap => {
      this._todayShifts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      this._loadedFlags.today = true;
      this._tryRender();
    }, err => {
      console.error("今日のシフト取得エラー:", err);
      this._todayShifts = [];
      this._loadedFlags.today = true;
      this._tryRender();
    });

    this._unsubs.push(unsub);
  },

  /** 今後7日のシフトを onSnapshot で監視 */
  _subscribeUpcoming(staffId, isOwner) {
    const tomorrow = new Date();
    tomorrow.setHours(0, 0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const weekLater = new Date(tomorrow);
    weekLater.setDate(weekLater.getDate() + 7);

    let query = db.collection("shifts")
      .where("date", ">=", tomorrow)
      .where("date", "<", weekLater)
      .orderBy("date", "asc");
    if (!isOwner && staffId) query = query.where("staffId", "==", staffId);

    const unsub = query.onSnapshot(snap => {
      this._upcomingShifts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      this._loadedFlags.upcoming = true;
      this._tryRender();
    }, err => {
      console.error("今後のシフト取得エラー:", err);
      this._upcomingShifts = [];
      this._loadedFlags.upcoming = true;
      this._tryRender();
    });

    this._unsubs.push(unsub);
  },

  /**
   * 未回答募集を onSnapshot で監視。
   * スタッフの場合は assignedPropertyIds に絞り込み。
   * Firestore の `in` 演算子は最大10件のため、10件超は全件取得フォールバック。
   * Webアプリ管理者 / assignedPropertyIds 未設定の場合も全件取得。
   */
  _subscribePending(staffId, isOwner) {
    const isOwnerFlag = isOwner;
    const assignedIds = Auth.currentUser?.assignedPropertyIds || [];

    // 絞り込み可否の判定
    const canFilter = !isOwnerFlag && staffId && Array.isArray(assignedIds) && assignedIds.length > 0 && assignedIds.length <= 10;

    let query = db.collection("recruitments").where("status", "==", "募集中");
    if (canFilter) {
      query = query.where("propertyId", "in", assignedIds);
    }

    const unsub = query.onSnapshot(snap => {
      if (isOwnerFlag) {
        this._pendingCount = snap.size;
      } else {
        let count = 0;
        for (const doc of snap.docs) {
          const data = doc.data();
          const responses = data.responses || [];
          const myResponse = responses.find(r => r.staffId === staffId);
          if (!myResponse) count++;
        }
        this._pendingCount = count;
      }
      this._loadedFlags.pending = true;
      this._tryRender();
    }, err => {
      console.error("未回答募集取得エラー:", err);
      this._pendingCount = 0;
      this._loadedFlags.pending = true;
      this._tryRender();
    });

    this._unsubs.push(unsub);
  },

  /** 全データが揃ったら画面を再描画 */
  _tryRender() {
    if (!this._loadedFlags.today || !this._loadedFlags.upcoming || !this._loadedFlags.pending) {
      return; // まだ全部揃っていない
    }

    const content = document.getElementById("myDashContent");
    if (!content) return; // ページ離脱済み

    content.innerHTML = "";

    const todayShifts = this._todayShifts || [];
    const upcomingShifts = this._upcomingShifts || [];
    const pendingRecruitments = this._pendingCount || 0;

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
  },

  /** ページ離脱時に全 onSnapshot リスナーを解除 */
  detach() {
    for (const unsub of this._unsubs) {
      try { unsub(); } catch (e) { /* ignore */ }
    }
    this._unsubs = [];
  },

  /**
   * FCM初期化 + 通知許可バナー表示
   * FCM は現時点で導入保留 (iOS PWA制約で導入負担大)。将来再有効化可能なようコードは残す。
   */
  async _initFCMBanner() {
    // FCM バナーは現時点で非表示
    return;
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

    // Webアプリ管理者表示時はスタッフ名も表示
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
