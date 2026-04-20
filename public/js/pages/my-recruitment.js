/**
 * スタッフ用 清掃スケジュールページ
 * 横スクロールカレンダー（予約バー + 募集ステータス + スタッフ回答）
 *
 * onSnapshot でリアルタイム更新。複数リスナーは _unsubs[] に積み、
 * detach() で確実に全解除する。
 */
const MyRecruitmentPage = {
  staffId: null,
  staffDoc: null,
  staffList: [],
  recruitments: [],
  bookings: [],
  guestMap: {},

  // onSnapshot の unsubscribe 関数を蓄積する配列
  _unsubs: [],
  // データ到着フラグ（全件揃ったら初回描画）
  _loadedFlags: { recruitments: false, bookings: false, guests: false, staff: false },
  // 初回描画完了フラグ
  _initialRenderDone: false,

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

    // 前回のリスナーを解除
    this.detach();

    // ページ再訪時は必ず「今日」へスクロールするようリセット
    this._initialScrollDone = false;

    container.innerHTML = `
      <div class="page-header">
        <h2><i class="bi bi-calendar-check"></i> 清掃スケジュール</h2>
        <div class="d-flex align-items-center gap-1">
          <button class="btn btn-sm btn-outline-secondary" id="btnMyCalPrev" title="前の月" style="min-width:36px;">◀</button>
          <input type="month" class="form-control form-control-sm" style="width:140px;" id="myCalMonth">
          <button class="btn btn-sm btn-outline-secondary" id="btnMyCalNext" title="次の月" style="min-width:36px;">▶</button>
          <button class="btn btn-sm btn-outline-primary ms-2" id="btnMyCalToday">今日</button>
        </div>
      </div>
      <div class="mb-2">
        <button class="btn btn-sm btn-link text-muted p-0 text-decoration-none" type="button"
          data-bs-toggle="collapse" data-bs-target="#myCalLegend" aria-expanded="false">
          <i class="bi bi-info-circle"></i> 凡例を表示 ▼
        </button>
        <div class="collapse" id="myCalLegend">
          <div class="d-flex flex-wrap gap-3 mt-2 text-muted" style="font-size:13px;">
            <span><span style="background:#ff5a5f;display:inline-block;width:12px;height:12px;border-radius:2px;vertical-align:middle;"></span> Airbnb</span>
            <span><span style="background:#003580;display:inline-block;width:12px;height:12px;border-radius:2px;vertical-align:middle;"></span> Booking.com</span>
            <span><span style="background:#198754;display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:middle;"></span> 名簿提出済み</span>
            <span><span style="background:#dc3545;display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:middle;"></span> 名簿未提出</span>
            <span><span style="display:inline-block;width:12px;height:12px;background:#a7c7ff;border-radius:2px;vertical-align:middle;"></span> 確定済</span>
            <span>👤 あなた</span>
            <span>|</span>
            <span>募集ピル: <span style="background:#198754;color:#fff;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;vertical-align:middle;">清</span> 清掃</span>
            <span><span style="background:#7c3aed;color:#fff;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;vertical-align:middle;">直</span> 直前点検</span>
          </div>
        </div>
      </div>
      <style>
        #myCalContainer .col-resizer { opacity:0; transition:opacity 0.15s; }
        #myCalContainer .col-resizer:hover, #myCalContainer .col-resizer:active { opacity:1; }
        #myCalContainer .sticky-col:hover .col-resizer { opacity:0.5; }
        @media (hover: none) { #myCalContainer .col-resizer { opacity:0.35; } }
        /* セル罫線を1箇所に集約。TDは全て border:0 とし、行 tr / ブロック単位で線を引く */
        #myCalContainer table { border-collapse:separate; border-spacing:0; }
        #myCalContainer table td, #myCalContainer table th { border:0; background-clip:padding-box; }
        /* 日付ヘッダーの下線 */
        #myCalContainer thead th { border-bottom:1px solid #dee2e6; }
        /* sticky 左列の右側セパレータ */
        #myCalContainer .sticky-col { border-right:2px solid #dee2e6; }
        /* 物件ブロック (宿泊+清掃) の下端のみ線: 同一物件内の宿泊段と清掃段の間には線を引かない */
        #myCalContainer tr[data-row-type="recruit"] > td { border-bottom:1px solid #dee2e6; }
        /* スタッフ行の上端に線 (スタッフ同士を区切る) */
        #myCalContainer tr.staff-row > td { border-top:1px solid #e9ecef; }
        /* セクション見出しの下線 */
        #myCalContainer tr.section-header > td { border-bottom:2px solid #adb5bd; }
        /* thead / セクション見出しを縦・横スクロール両方で固定 */
        #myCalContainer thead th { position:sticky; top:0; z-index:6; }
        #myCalContainer thead th.sticky-col { z-index:15; }
        /* セクション見出しは横スクロールでも左端に貼り付けて常時読めるようにする */
        #myCalContainer tr.section-header > td { position:sticky; top:65px; left:0; z-index:8; }
        #myCalContainer tr.section-header > td > .section-content { position:sticky; left:10px; display:inline-block; padding-left:4px; }
      </style>
      <div style="position:relative;">
        <!-- 現在スクロール位置の年月を固定表示するフローティングバッジ -->
        <div id="myCalFloatingMonth" style="position:absolute;top:6px;right:6px;z-index:20;background:rgba(13,110,253,0.92);color:#fff;padding:3px 10px;border-radius:14px;font-size:12px;font-weight:600;pointer-events:none;box-shadow:0 1px 3px rgba(0,0,0,0.15);"></div>
        <div id="myCalContainer" style="position:relative;overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:var(--radius,8px);border:1px solid var(--border,#e2e8f0);"></div>
      </div>

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

      // E: 非アクティブスタッフは回答操作不可、メッセージを最上部に表示
      this._isInactive = !isOwner && this.staffDoc && this.staffDoc.active === false;
      if (this._isInactive) {
        const msg = this.staffDoc.inactiveReason ||
          "直近15回の清掃募集について回答がなかったため、非アクティブとなりました。解除する場合はオーナーまでご連絡ください。";
        const banner = document.createElement("div");
        banner.className = "alert alert-warning mb-3";
        banner.innerHTML = `<i class="bi bi-exclamation-triangle-fill"></i> <strong>非アクティブ状態です</strong><br>${msg.replace(/\n/g, "<br>")}`;
        container.insertBefore(banner, container.querySelector("#myCalContainer"));
      }

      // onSnapshot でリアルタイム監視を開始（初回データ到着で描画）
      await this.subscribeData(isOwner);

      const now = new Date();
      this._calMonth = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
      const monthInput = document.getElementById("myCalMonth");
      monthInput.value = this._calMonth;
      monthInput.addEventListener("change", () => {
        this._calMonth = monthInput.value;
        this._initialScrollDone = false; // 月切替時は「今日」へ再スクロール
        this.renderCalendar();
      });
      const shiftMonth = (delta) => {
        const [y, m] = (this._calMonth || "").split("-").map(Number);
        const d = new Date(y, (m || 1) - 1 + delta, 1);
        this._calMonth = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
        monthInput.value = this._calMonth;
        this._initialScrollDone = false;
        this.renderCalendar();
      };
      document.getElementById("btnMyCalPrev").addEventListener("click", () => shiftMonth(-1));
      document.getElementById("btnMyCalNext").addEventListener("click", () => shiftMonth(1));
      document.getElementById("btnMyCalToday").addEventListener("click", () => {
        const n = new Date();
        this._calMonth = n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0");
        monthInput.value = this._calMonth;
        this._initialScrollDone = false; // 「今日」ボタン押下時は今日へ再スクロール
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

      // renderCalendar() は subscribeData() 内の onSnapshot コールバックが呼ぶ。
      // ここでの直接呼び出しは不要（データ未着状態で描画してしまうのを防ぐ）。
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

  /**
   * 旧 loadData() の代替: onSnapshot 3本 + 物件/スタッフ一覧を並行取得。
   * データ更新のたびに _tryRenderCalendar() を呼び出す。
   * 物件/スタッフ一覧は変動が少ないため get() のまま維持。
   *
   * assignedPropertyIds による絞り込み:
   *   - isOwner=true または assignedPropertyIds 未設定 → 全件取得
   *   - assignedPropertyIds が 1〜10 件 → in 句で絞り込み
   *   - 11件以上 → 全件取得フォールバック (in 演算子の上限)
   */
  async subscribeData(isOwner) {
    // 物件リストとスタッフリストは get() で初回取得（頻繁に変わらない）
    const [minpakuProps, staffSnap] = await Promise.all([
      API.properties.listMinpakuNumbered(),
      db.collection("staff").where("active", "==", true).get(),
    ]);

    // 物件リスト初期化
    this.minpakuProperties = minpakuProps;
    this.propertyMap = {};
    minpakuProps.forEach(p => { this.propertyMap[p.id] = p; });

    // 端末別設定を localStorage から読み込み (スタッフ毎 key)
    this._loadSettings();

    // 物件表示フラグ（初回は全部表示、以降は localStorage の値を維持）
    if (!this._propertyVisibility) this._propertyVisibility = {};
    minpakuProps.forEach(p => {
      if (this._propertyVisibility[p.id] === undefined) this._propertyVisibility[p.id] = true;
    });

    // スタッフ並び: displayOrder 昇順、オーナー(isOwner=true)は最下部に移動
    const allStaff = staffSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const nonOwner = allStaff.filter(s => !s.isOwner).sort((a,b) => (a.displayOrder||0) - (b.displayOrder||0));
    const owner = allStaff.filter(s => s.isOwner).sort((a,b) => (a.displayOrder||0) - (b.displayOrder||0));
    this.staffList = [...nonOwner, ...owner];
    this._loadedFlags.staff = true;

    // assignedPropertyIds の取得（スタッフドキュメントから読み取る）
    const assignedIds = Array.isArray(this.staffDoc?.assignedPropertyIds)
      ? this.staffDoc.assignedPropertyIds
      : (Auth.currentUser?.assignedPropertyIds || []);
    const canFilter = !isOwner && Array.isArray(assignedIds) && assignedIds.length > 0 && assignedIds.length <= 10;

    // --- recruitments onSnapshot ---
    let recruitQuery = db.collection("recruitments");
    if (canFilter) {
      recruitQuery = recruitQuery.where("propertyId", "in", assignedIds);
    }
    const unsubRecruit = recruitQuery.onSnapshot(snap => {
      // checkoutDate 正規化・フィルタ
      this.recruitments = snap.docs.map(d => {
        const raw = d.data();
        const coDate = this._normalizeDate(raw.checkoutDate || raw.checkOutDate || raw.checkOutdate);
        return { id: d.id, ...raw, checkoutDate: coDate };
      }).filter(r => r.checkoutDate);

      this._loadedFlags.recruitments = true;
      this._tryRenderCalendar();
    }, err => {
      console.error("recruitments onSnapshot エラー:", err);
      this._loadedFlags.recruitments = true;
      this._tryRenderCalendar();
    });
    this._unsubs.push(unsubRecruit);

    // --- bookings onSnapshot ---
    let bookingQuery = db.collection("bookings");
    if (canFilter) {
      bookingQuery = bookingQuery.where("propertyId", "in", assignedIds);
    }
    const unsubBooking = bookingQuery.onSnapshot(snap => {
      // キャンセル予約は全て除外（"cancelled" / "canceled" / 日本語）
      this.bookings = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(b => {
        const s = String(b.status || "").toLowerCase();
        return !s.includes("cancel") && b.status !== "キャンセル" && b.status !== "キャンセル済み";
      });

      this._loadedFlags.bookings = true;
      this._tryRenderCalendar();
    }, err => {
      console.error("bookings onSnapshot エラー:", err);
      this._loadedFlags.bookings = true;
      this._tryRenderCalendar();
    });
    this._unsubs.push(unsubBooking);

    // --- guestRegistrations onSnapshot ---
    // NOTE: Firestore web SDK はフィールド単位の select() が非対応のため全フィールド受信。
    // PII（guestName/address/phone/passportNumber 等）はクライアント受信直後に除外して
    // guestMap には最小限フィールドのみ保持することでメモリ内の漏洩範囲を最小化する。
    // 将来的には /api/guest-summary?propertyIds=... を経由して Functions 側で絞り込む方式が理想。
    let guestQuery = db.collection("guestRegistrations");
    if (canFilter) {
      guestQuery = guestQuery.where("propertyId", "in", assignedIds);
    }
    const unsubGuest = guestQuery.onSnapshot(snap => {
      // 名簿マッピング（PII フィールドを除外して最小限フィールドのみ保持）
      this.guestMap = {};
      snap.docs.forEach(d => {
        const g = d.data();
        const ci = g.checkIn;
        if (!ci) return;
        // guestName / address / phone / email / passportNumber 等の PII は保持しない
        this.guestMap[ci] = {
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
        // 受信したドキュメントから PII を明示的に参照解除（GC 補助）
        // d.data() の raw オブジェクトはここでスコープ外になり解放される
      });

      this._loadedFlags.guests = true;
      this._tryRenderCalendar();
    }, err => {
      console.error("guestRegistrations onSnapshot エラー:", err);
      this._loadedFlags.guests = true;
      this._tryRenderCalendar();
    });
    this._unsubs.push(unsubGuest);
  },

  /**
   * 全データが揃ったタイミング、またはデータ更新時に呼ばれる。
   * Bootstrap モーダルが開いている場合は内部データのみ更新し、モーダルは閉じない。
   */
  _tryRenderCalendar() {
    const allLoaded = this._loadedFlags.recruitments
      && this._loadedFlags.bookings
      && this._loadedFlags.guests
      && this._loadedFlags.staff;

    if (!allLoaded) return; // まだ全部揃っていない

    const container = document.getElementById("myCalContainer");
    if (!container) return; // ページ離脱済み

    // Bootstrap モーダルが開いている場合は再描画をスキップ（モーダルを閉じない）
    const openModal = document.querySelector(".modal.show");
    if (openModal) {
      // モーダル閉後に再描画するため、閉じたイベントを一度だけ監視
      if (!this._modalRerenderQueued) {
        this._modalRerenderQueued = true;
        openModal.addEventListener("hidden.bs.modal", () => {
          this._modalRerenderQueued = false;
          this.renderCalendar();
        }, { once: true });
      }
      return;
    }

    this.renderCalendar();
  },

  /** ページ離脱時に全 onSnapshot リスナーを解除 */
  detach() {
    for (const unsub of this._unsubs) {
      try { unsub(); } catch (e) { /* ignore */ }
    }
    this._unsubs = [];
    // フラグリセット（次回 render() 時に初回扱いに戻す）
    this._loadedFlags = { recruitments: false, bookings: false, guests: false, staff: false };
    this._initialRenderDone = false;
    this._modalRerenderQueued = false;
  },

  renderCalendar() {
    const container = document.getElementById("myCalContainer");
    // 再描画前のスクロール位置を保持
    const prevScrollLeft = container ? container.scrollLeft : 0;
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

    // スタイル — 左列幅はセッション間で保持 (物件/スタッフ共通)
    const cellH = "44px";             // スタッフ行の高さ
    const propRowH = "24px";          // 物件の各段 (宿泊/清掃) の高さ (清掃pill高さに合わせる)
    const stickyWN = (this._stickyW || 140);
    const stickyW = stickyWN + "px";
    const colWN = 36;
    const colW = colWN + "px";        // 最小セル幅

    // 予約ソース別の色
    const bookingColor = (src, fallback) => {
      const s = (src || "").toLowerCase();
      if (s.includes("airbnb")) return "#ff5a5f";
      if (s.includes("booking")) return "#003580";
      return fallback;
    };

    // 非表示中の物件一覧 (セクション見出し内に復旧ボタンを出す)
    const hiddenProps = this.minpakuProperties.filter(p => this._propertyVisibility[p.id] === false);

    // border-collapse:separate + border-spacing:0 にしないとセルの境界線がバー (z-index) の前面に描画される
    let html = `<table class="table table-sm table-hover mb-0 align-middle" style="font-size:13px;white-space:nowrap;border-collapse:separate;border-spacing:0;min-width:calc(${stickyW} + ${allDates.length} * ${colW});">`;

    // ===== ヘッダー =====
    html += `<thead class="table-light">`;

    // 行1: 月ラベル (日付TH 内に列幅 ±ボタン埋め込み / sticky で常時表示)
    html += `<tr><th rowspan="2" class="text-center sticky-col" style="position:sticky;left:0;z-index:15;background:#f8f9fa;min-width:${stickyW};max-width:${stickyW};font-size:14px;font-weight:600;vertical-align:middle;padding:6px 10px 6px 4px;">
      日付
      <div class="col-resizer" title="ドラッグで列幅を変更" style="position:absolute;top:0;right:0;width:8px;height:100%;cursor:col-resize;z-index:4;user-select:none;background:repeating-linear-gradient(to bottom, rgba(108,117,125,0.45) 0 4px, transparent 4px 8px);touch-action:none;"></div>
    </th>`;
    months.forEach(m => {
      const cur = m.month === month && m.year === year;
      html += `<th colspan="${m.days}" class="text-center" style="background:${cur ? "#f8f9fa" : "#e9ecef"};font-size:15px;font-weight:600;">${m.year}/${m.month}月</th>`;
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
      html += `<th class="text-center${hasBooking ? " cal-date-hd" : ""}" data-cal-date="${dd.dateStr}" style="min-width:${colW};height:42px;font-size:14px;${dowColor ? "color:" + dowColor + ";" : ""}background:${bg};cursor:${hasBooking ? "pointer" : "default"};vertical-align:middle;"><div style="font-size:14px;font-weight:600;">${dd.day}</div><div style="font-size:12px;">${dayNames[dow]}</div></th>`;
    });
    html += "</tr>";
    html += `</thead><tbody>`;

    // ===== 物件セクション =====
    const visibleProps = this.minpakuProperties.filter(p => this._propertyVisibility[p.id] !== false);
    if (this.minpakuProperties.length > 0) {
      // セクション見出し (非表示物件の復旧ボタンもここに)
      const restoreButtons = hiddenProps.length
        ? hiddenProps.map(p => `<button type="button" class="prop-restore ms-1" data-prop-id="${p.id}" title="${this.esc(p.name)} を再表示" style="border:1px solid #ced4da;background:#fff;border-radius:4px;padding:2px 6px;font-size:12px;cursor:pointer;">
            <span class="badge" style="background:${p._color};color:#fff;">${p._num}</span> <i class="bi bi-eye text-muted"></i>
          </button>`).join("")
        : "";
      html += `<tr class="section-header"><td style="background:#eef5ff;font-weight:bold;font-size:13px;padding:6px 10px;" colspan="${allDates.length + 1}">
        <span class="section-content">
          <i class="bi bi-building"></i> 物件別 宿泊・募集状況
          ${hiddenProps.length ? `<span class="text-muted ms-2" style="font-weight:normal;font-size:11px;">非表示${hiddenProps.length}件:</span>${restoreButtons}` : `<small class="text-muted ms-2">(目のアイコンで表示切替)</small>`}
        </span>
      </td></tr>`;

      // 各物件は常に 2 段 (1段目=宿泊バー / 2段目=清掃募集)。
      // 同日 CI/CO は半セル吸収で同一セル内に並べる (レーン分離なし)。
      // 非表示の物件は描画をスキップ (復旧は見出しの目アイコンボタンから)。
      this.minpakuProperties.forEach(p => {
        const visible = this._propertyVisibility[p.id] !== false;
        if (!visible) return;
        const recruitByD = recruitByPropDate[p.id] || {};
        const rangeStart = allDates[0].dateStr;
        const rangeEnd = allDates[allDates.length - 1].dateStr;
        const propBookings = this.bookings.filter(b =>
          b.propertyId === p.id && b.checkIn && b.checkOut &&
          b.checkIn <= rangeEnd && b.checkOut >= rangeStart
        );
        const fallbackColor = p._color || "#0d6efd";

        // ---- 1段目: 宿泊バー ----
        html += `<tr data-prop-row="${p.id}" data-row-type="stay" style="${visible ? "" : "opacity:0.35;"}">`;
        // 物件名セル (rowspan=2 で清掃段と結合)。右端にドラッグハンドル
        html += `<td rowspan="2" class="fw-medium sticky-col" style="position:sticky;left:0;z-index:10;background:#f9fafb;min-width:${stickyW};max-width:${stickyW};vertical-align:middle;font-size:13px;padding:4px 10px 4px 6px;line-height:1.3;">
          <div style="display:flex;align-items:center;gap:4px;">
            <button type="button" class="prop-toggle" data-prop-id="${p.id}" title="非表示にする" style="flex-shrink:0;padding:2px 4px;border:1px solid #ced4da;background:#fff;border-radius:4px;cursor:pointer;min-width:26px;min-height:26px;line-height:1;">
              <i class="bi bi-eye" style="color:#6c757d;font-size:14px;"></i>
            </button>
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              <span class="badge me-1" style="background:${p._color};color:#fff;">${p._num}</span>${this.esc(p.name)}
            </span>
          </div>
          <div class="col-resizer" title="ドラッグで列幅を変更" style="position:absolute;top:0;right:0;width:8px;height:100%;cursor:col-resize;z-index:4;user-select:none;background:repeating-linear-gradient(to bottom, rgba(108,117,125,0.45) 0 4px, transparent 4px 8px);touch-action:none;"></div>
        </td>`;

        allDates.forEach(dd => {
          if (!visible) {
            html += `<td style="height:${propRowH};background:#f8f9fa;padding:0;"></td>`;
            return;
          }
          const d = dd.dateStr;
          // この日をカバーする予約を検索 (CI / CO / middle を分離)
          let starting = null, ending = null, middle = null;
          for (const b of propBookings) {
            if (b.checkIn === d) starting = b;
            else if (b.checkOut === d) ending = b;
            else if (b.checkIn < d && d < b.checkOut) middle = b;
          }
          const isHdToday = dd.dateStr === todayStr;
          const tdBg = isHdToday ? "#e8f0fe" : (!dd.isCurrent ? "#e9ecef" : "#fff");

          // セグメント描画 (バー高さ = 清掃pillと同じ 20px 固定、上下中央)
          // z-index:2 でセル罫線より前面に表示
          const barTopStyle = "top:50%;transform:translateY(-50%);height:20px;";
          let segs = "";
          if (ending) {
            const c = bookingColor(ending.source, fallbackColor);
            segs += `<div style="position:absolute;left:0;right:50%;${barTopStyle}background:${c};border-top-right-radius:999px;border-bottom-right-radius:999px;z-index:2;"></div>`;
          }
          if (middle) {
            const c = bookingColor(middle.source, fallbackColor);
            segs += `<div style="position:absolute;left:0;right:0;${barTopStyle}background:${c};z-index:2;"></div>`;
          }
          if (starting) {
            const c = bookingColor(starting.source, fallbackColor);
            segs += `<div style="position:absolute;left:50%;right:0;${barTopStyle}background:${c};border-top-left-radius:999px;border-bottom-left-radius:999px;z-index:2;"></div>`;
            // 名簿ドット (CIの右半分、左寄せ)
            const hasGuest = !!this.guestMap[starting.checkIn];
            const dotColor = hasGuest ? "#198754" : "#dc3545";
            const dotTitle = hasGuest ? "名簿提出済み" : "名簿未提出";
            segs += `<span style="position:absolute;left:calc(50% + 4px);top:50%;transform:translateY(-50%);width:9px;height:9px;border-radius:50%;background:${dotColor};border:1.5px solid #fff;z-index:4;" title="${dotTitle}"></span>`;
          }

          // ラベル (宿泊人数) 表示: 連泊なら CI+1 日 (中間セル中央)、1泊なら CI+CO 境界を跨いで中央
          let labelTarget = null;
          if (middle) {
            const ciNext = new Date(middle.checkIn + "T00:00:00");
            ciNext.setDate(ciNext.getDate() + 1);
            if (d === ciNext.toLocaleDateString("sv-SE")) labelTarget = middle;
          } else if (starting) {
            const coD = new Date(starting.checkOut + "T00:00:00");
            const ciD = new Date(starting.checkIn + "T00:00:00");
            const n = Math.round((coD - ciD) / 86400000);
            if (n === 1) labelTarget = starting;
          }
          if (labelTarget) {
            const coD = new Date(labelTarget.checkOut + "T00:00:00");
            const ciD = new Date(labelTarget.checkIn + "T00:00:00");
            const n = Math.round((coD - ciD) / 86400000);
            // 泊数は表示しない。人数のみ
            const txt = labelTarget.guestCount > 0 ? `${labelTarget.guestCount}名` : "";
            // ラベルは「名簿ドットの右隣に左寄せ」で配置。
            // 名簿ドットは CI の右半分左端 = starting セル内 left:50% + 4px、width 9px + border
            // ラベル開始位置 = ドット直後 (約 17-20px 右)
            if (n === 1) {
              // 1泊: CI セル内、50%+18px から右にラベル (CO セル側にはみ出す)
              segs += `<span style="position:absolute;left:calc(50% + 18px);top:50%;transform:translateY(-50%);color:#fff;font-size:13px;font-weight:600;text-align:left;white-space:nowrap;z-index:3;pointer-events:none;">${txt}</span>`;
            } else {
              // 連泊: CI+1 セル内に配置、left:-colW/2 + 18px で名簿ドット直後からラベル開始
              segs += `<span style="position:absolute;left:calc(-${colWN / 2}px + 18px);top:50%;transform:translateY(-50%);color:#fff;font-size:13px;font-weight:600;text-align:left;white-space:nowrap;z-index:3;pointer-events:none;">${txt}</span>`;
            }
          }

          const ref = starting || middle || ending;
          const clickAttr = ref ? ` class="cal-date-hd" data-cal-date="${ref.checkIn}"` : "";
          const cursor = ref ? "cursor:pointer;" : "";
          html += `<td${clickAttr} style="position:relative;height:${propRowH};background:${tdBg};padding:0;overflow:visible;${cursor}">${segs}</td>`;
        });
        html += "</tr>";

        // ---- 2段目: 清掃募集 ----
        html += `<tr data-prop-row="${p.id}" data-row-type="recruit" style="${visible ? "" : "opacity:0.35;"}">`;
        allDates.forEach(dd => {
          if (!visible) {
            html += `<td style="border-left:1px solid #dee2e6;border-right:1px solid #dee2e6;border-bottom:1px solid #dee2e6;height:${propRowH};background:#f8f9fa;padding:0;"></td>`;
            return;
          }
          const r = recruitByD[dd.dateStr];
          const isHdToday = dd.dateStr === todayStr;
          const cellBg = isHdToday ? "#e8f0fe" : (!dd.isCurrent ? "#e9ecef" : "#fff");
          if (r) {
            html += `<td class="text-center" style="height:${propRowH};background:${cellBg};padding:1px;vertical-align:middle;">${this._recruitPill(r)}</td>`;
          } else {
            html += `<td style="height:${propRowH};background:${cellBg};padding:0;"></td>`;
          }
        });
        html += "</tr>";
      });

      // セクション見出し: スタッフ
      html += `<tr class="section-header"><td style="background:#eef5ff;font-weight:bold;font-size:13px;padding:6px 10px;" colspan="${allDates.length + 1}">
        <span class="section-content">
          <i class="bi bi-people"></i> スタッフ別 回答状況
          <button type="button" id="btnShowOnlyMe" class="ms-2" style="border:1px solid ${this._showOnlyMe ? '#0d6efd' : '#ced4da'};background:${this._showOnlyMe ? '#0d6efd' : '#fff'};color:${this._showOnlyMe ? '#fff' : '#495057'};border-radius:4px;padding:2px 10px;font-size:12px;font-weight:600;cursor:pointer;">
            ${this._showOnlyMe ? '✓ ' : ''}自分だけ <i class="bi bi-eye"></i>
          </button>
        </span>
      </td></tr>`;
    }

    // ===== スタッフ行 =====
    const isOwner = Auth?.isOwner?.() === true;
    // 自分の行を一番上に固定: 自分を先頭に、それ以外は元の並び順を維持
    const orderedStaff = [
      ...this.staffList.filter(s => s.id === this.staffId),
      ...this.staffList.filter(s => s.id !== this.staffId),
    ];
    orderedStaff.forEach(staff => {
      const isMe = staff.id === this.staffId;
      // 「自分だけ」モード: 自分以外は描画しない
      if (this._showOnlyMe && !isMe) return;
      const assigned = Array.isArray(staff.assignedPropertyIds) ? staff.assignedPropertyIds : [];
      const hasAssignments = assigned.length > 0;
      html += `<tr class="staff-row"><td class="fw-medium sticky-col" style="position:sticky;left:0;z-index:10;background:${isMe ? "#e3f2fd" : "#fff"};min-width:${stickyW};max-width:${stickyW};height:${cellH};font-size:14px;vertical-align:middle;padding:4px 10px 4px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.3;">
        ${this.esc(staff.name)}${isMe ? " 👤" : ""}${staff.isOwner ? ' <span class="badge bg-info" style="font-size:9px;">OWN</span>' : ""}
        <div class="col-resizer" title="ドラッグで列幅を変更" style="position:absolute;top:0;right:0;width:8px;height:100%;cursor:col-resize;z-index:4;user-select:none;background:repeating-linear-gradient(to bottom, rgba(108,117,125,0.45) 0 4px, transparent 4px 8px);touch-action:none;"></div>
      </td>`;

      allDates.forEach(dd => {
        const isToday = dd.dateStr === todayStr;
        // このスタッフが対象にしうる物件ID群 (オーナー or 担当未設定は全物件)
        const targetPropIds = (staff.isOwner || !hasAssignments)
          ? this.minpakuProperties.map(p => p.id)
          : assigned;

        // この日の該当募集を全て収集 (物件単位)
        const cellRecruits = [];
        for (const pid of targetPropIds) {
          const byD = recruitByPropDate[pid];
          if (byD && byD[dd.dateStr]) {
            cellRecruits.push({ recruit: byD[dd.dateStr], prop: this.propertyMap[pid] });
          }
        }

        if (cellRecruits.length === 0) {
          const bg = isToday ? "#e8f0fe" : (!dd.isCurrent ? "#e9ecef" : "#f9f9f9");
          html += `<td class="text-center" style="background:${bg};color:#adb5bd;height:${cellH};vertical-align:middle;">-</td>`;
          return;
        }

        // 各募集ごとに物件バッジ+回答記号のアイテムを生成
        let anyConfirmed = false;
        const items = cellRecruits.map(({recruit, prop}) => {
          const responses = recruit.responses || [];
          let resp = "未回答";
          for (const r of responses) {
            if (r.staffId === staff.id || r.staffName === staff.name || (r.staffEmail && staff.email && r.staffEmail.toLowerCase() === staff.email.toLowerCase())) {
              resp = r.response || "未回答";
              break;
            }
          }
          let symbol = "−", symColor = "#adb5bd";
          if (resp === "◎") { symbol = "●"; symColor = "#198754"; }
          else if (resp === "△") { symbol = "▲"; symColor = "#cc9a06"; }
          else if (resp === "×") { symbol = "✖"; symColor = "#dc3545"; }

          let confirmed = false;
          const sel = (recruit.selectedStaff || "").trim();
          if (sel && (recruit.status === "選定済" || recruit.status === "スタッフ確定済み")) {
            confirmed = sel.split(/[,、\s]+/).map(s => s.trim()).includes(staff.name);
          }
          if (confirmed) anyConfirmed = true;

          const clickable = (recruit.status === "スタッフ確定済み") ? isOwner : (isMe || isOwner);
          const clickMode = (recruit.status === "スタッフ確定済み") ? "detail" : "respond";
          // 物件番号バッジは回答済みのときのみ表示 (未回答は記号だけ)
          const propBadge = (resp !== "未回答" && prop)
            ? `<span style="color:#fff;background:${prop._color};padding:1px 4px;border-radius:3px;font-size:11px;font-weight:700;">${prop._num}</span>`
            : "";

          // ● だけ Unicode 文字は上下ずれるので CSS 描画円にする (完全な垂直中央揃え)
          // ▲ ✖ は Unicode のまま、− は線
          let symHtml;
          if (symbol === "●") {
            symHtml = `<span style="display:inline-block;width:16px;height:16px;border-radius:50%;background:${symColor};vertical-align:middle;"></span>`;
          } else if (symbol === "▲") {
            symHtml = `<span style="display:inline-block;color:${symColor};font-size:17px;font-weight:bold;line-height:16px;vertical-align:middle;">▲</span>`;
          } else if (symbol === "✖") {
            symHtml = `<span style="display:inline-block;color:${symColor};font-size:17px;font-weight:bold;line-height:16px;vertical-align:middle;">✖</span>`;
          } else {
            symHtml = `<span style="display:inline-block;color:${symColor};font-size:14px;font-weight:bold;line-height:16px;vertical-align:middle;">−</span>`;
          }
          return `<span class="${clickable ? 'cal-cell-item' : ''}" data-recruit-id="${recruit.id}" data-prop-id="${prop ? prop.id : ''}" data-prop-name="${prop ? this.esc(prop.name) : ''}" data-click-mode="${clickMode}" data-staff-id="${staff.id}" data-staff-name="${this.esc(staff.name)}" data-staff-email="${this.esc(staff.email||"")}" data-is-me="${isMe}" data-date="${dd.dateStr}" style="display:inline-flex;align-items:center;gap:3px;line-height:1;padding:1px 3px;border-radius:4px;${clickable ? 'cursor:pointer;' : ''}">${propBadge}${symHtml}</span>`;
        });

        const cellBg = anyConfirmed ? "#a7c7ff" : (isToday ? "#e8f0fe" : (!dd.isCurrent ? "#e9ecef" : ""));
        html += `<td class="text-center" style="background:${cellBg};height:${cellH};vertical-align:middle;padding:2px 3px;white-space:nowrap;">
          <span style="display:inline-flex;flex-wrap:wrap;gap:3px;justify-content:center;align-items:center;">${items.join("")}</span>
        </td>`;
      });
      html += "</tr>";
    });

    html += "</tbody></table>";
    container.innerHTML = html;

    // フローティング月バッジ: スクロール位置の年月を動的に表示
    const floatBadge = document.getElementById("myCalFloatingMonth");
    if (floatBadge) {
      const updateFloatBadge = () => {
        const scrollLeft = container.scrollLeft;
        const stickyOffset = this._stickyW || 140;
        // 列幅 colW を数値で取り直し
        const firstDateTh = container.querySelector('th[data-cal-date]');
        const colWpx = firstDateTh ? firstDateTh.getBoundingClientRect().width : 40;
        // 表示領域の左端から 30px 程度の位置にある日付を判定
        const visibleX = scrollLeft + stickyOffset + 20;
        const colIdx = Math.max(0, Math.floor((visibleX - stickyOffset) / Math.max(1, colWpx)));
        const target = allDates[Math.min(colIdx, allDates.length - 1)];
        if (target) {
          floatBadge.textContent = `${target.year}年${target.month}月`;
        }
      };
      container.addEventListener("scroll", updateFloatBadge, { passive: true });
      // 初回描画時にも一度呼ぶ
      setTimeout(updateFloatBadge, 0);
    }

    // 列幅ドラッグハンドル (PC=マウス / スマホ=タッチ 両対応)
    const applyStickyW = (newW) => {
      container.querySelectorAll('.sticky-col').forEach(td => {
        td.style.minWidth = newW + 'px';
        td.style.maxWidth = newW + 'px';
      });
    };
    container.querySelectorAll('.col-resizer').forEach(handle => {
      const onStart = (startX) => {
        const startW = this._stickyW || 140;
        const onMove = (x) => {
          const newW = Math.max(80, Math.min(360, startW + (x - startX)));
          this._stickyW = newW;
          applyStickyW(newW);
        };
        const mouseMove = (e) => onMove(e.clientX);
        const touchMove = (e) => {
          if (e.touches && e.touches[0]) { e.preventDefault(); onMove(e.touches[0].clientX); }
        };
        const end = () => {
          document.removeEventListener('mousemove', mouseMove);
          document.removeEventListener('mouseup', end);
          document.removeEventListener('touchmove', touchMove);
          document.removeEventListener('touchend', end);
          document.body.style.userSelect = '';
          this._saveSettings(); // ドラッグ終了時に幅を永続化
        };
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', mouseMove);
        document.addEventListener('mouseup', end);
        document.addEventListener('touchmove', touchMove, { passive: false });
        document.addEventListener('touchend', end);
      };
      handle.addEventListener('mousedown', (e) => { e.preventDefault(); onStart(e.clientX); });
      handle.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches[0]) { e.preventDefault(); onStart(e.touches[0].clientX); }
      }, { passive: false });
    });

    // 「自分だけ」トグル
    document.getElementById("btnShowOnlyMe")?.addEventListener("click", () => {
      this._showOnlyMe = !this._showOnlyMe;
      this._saveSettings();
      this.renderCalendar();
    });

    // 物件表示トグル (セル内の目アイコンボタン)
    container.querySelectorAll(".prop-toggle").forEach(btn => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const pid = btn.dataset.propId;
        this._propertyVisibility[pid] = !this._propertyVisibility[pid];
        this._saveSettings();
        this.renderCalendar();
      });
    });

    // 非表示物件の復旧ボタン
    container.querySelectorAll(".prop-restore").forEach(btn => {
      btn.addEventListener("click", () => {
        const pid = btn.dataset.propId;
        this._propertyVisibility[pid] = true;
        this._saveSettings();
        this.renderCalendar();
      });
    });

    // 確定済セル item → オーナーはその場で詳細モーダル表示(ページ遷移なし)
    container.querySelectorAll('.cal-cell-item[data-click-mode="detail"]').forEach(el => {
      el.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const recruitId = el.dataset.recruitId;
        const recruit = this.recruitments.find(r => r.id === recruitId);
        if (!recruit) return;
        if (typeof RecruitmentPage !== "undefined" && RecruitmentPage.openDetailModal) {
          await RecruitmentPage.ensureLoaded();
          RecruitmentPage.openDetailModal(recruit);
        }
      });
    });

    // イベント: item タップ → 回答 or 代理回答(オーナー)
    container.querySelectorAll('.cal-cell-item[data-click-mode="respond"]').forEach(el => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        // 非アクティブスタッフは回答UIを開かない
        if (this._isInactive) {
          showToast("非アクティブ", this.staffDoc?.inactiveReason || "直近15回の清掃募集について回答がなかったため、非アクティブとなりました。解除する場合はオーナーまでご連絡ください。", "warning");
          return;
        }
        const dateStr = el.dataset.date;
        const recruitId = el.dataset.recruitId;
        const recruit = this.recruitments.find(r => r.id === recruitId);
        if (!recruit) return;
        this._pendingRecruitId = recruit.id;
        this._pendingDate = dateStr;
        this._pendingStaffId = el.dataset.staffId;
        this._pendingStaffName = el.dataset.staffName;
        this._pendingStaffEmail = el.dataset.staffEmail;
        this._pendingIsMe = el.dataset.isMe === "true";
        const propName = el.dataset.propName || recruit.propertyName || "";
        const suffix = this._pendingIsMe ? "" : `（${this._pendingStaffName} さんとして代理回答）`;
        document.getElementById("responseModalTitle").textContent = `${this.fmtDate(dateStr)} ${propName} 回答 ${suffix}`;
        document.getElementById("responseModalInfo").textContent = propName ? `${this.fmtDate(dateStr)} / ${propName}` : this.fmtDate(dateStr);
        document.getElementById("triangleReasonArea").classList.add("d-none");
        document.getElementById("triangleReason").value = "";
        // 既存回答がある場合は「取消」ボタン表示
        // staffId / staffName / staffEmail のいずれかで照合 (過去のデータ形式互換)
        const pendingEmail = (this._pendingStaffEmail || "").toLowerCase();
        const existing = (recruit.responses || []).find(r => {
          if (r.staffId && this._pendingStaffId && r.staffId === this._pendingStaffId) return true;
          if (r.staffName && this._pendingStaffName && r.staffName === this._pendingStaffName) return true;
          if (r.staffEmail && pendingEmail && r.staffEmail.toLowerCase() === pendingEmail) return true;
          return false;
        });
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

        // オーナー操作ボタン (オーナー権限がある場合のみ表示)
        // 「スタッフ確定」「募集再開」「募集削除」等のオーナー操作へ切替
        let ownerWrap = document.getElementById("ownerOpsFromResponseWrap");
        if (!ownerWrap) {
          const modalBody = document.querySelector("#responseModal .modal-body");
          modalBody.insertAdjacentHTML("beforeend", `
            <div class="text-center mt-3 border-top pt-3" id="ownerOpsFromResponseWrap">
              <div class="small text-muted mb-2">オーナー操作</div>
              <button type="button" id="btnOwnerOpsFromResponse" class="btn btn-outline-primary btn-sm">
                <i class="bi bi-person-gear"></i> スタッフ確定・募集再開などへ
              </button>
            </div>
          `);
          document.getElementById("btnOwnerOpsFromResponse").addEventListener("click", async () => {
            const recruitId = this._pendingRecruitId;
            // 回答モーダルを閉じて詳細モーダルへ切替
            bootstrap.Modal.getInstance(document.getElementById("responseModal"))?.hide();
            const recruit = this.recruitments.find(r => r.id === recruitId);
            if (!recruit) return;
            if (typeof RecruitmentPage !== "undefined" && RecruitmentPage.openDetailModal) {
              await RecruitmentPage.ensureLoaded();
              RecruitmentPage.openDetailModal(recruit);
            }
          });
          ownerWrap = document.getElementById("ownerOpsFromResponseWrap");
        }
        ownerWrap.style.display = isOwner ? "" : "none";

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

    // 初回描画時のみ「今日」へスクロール。再描画時は元の位置を維持
    if (this._initialScrollDone) {
      container.scrollLeft = prevScrollLeft;
    } else {
      const todayTh = container.querySelector(`[data-cal-date="${todayStr}"]`);
      if (todayTh) {
        // offsetLeft は sticky 状態や ancestor 構造でずれることがあるので
        // getBoundingClientRect ベースで「sticky 左列の直後 ~40px」に今日が来るよう調整
        const thRect = todayTh.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const targetOffset = (this._stickyW || 140) + 40; // sticky列直後から 40px
        const delta = thRect.left - containerRect.left - targetOffset;
        container.scrollLeft = Math.max(0, container.scrollLeft + delta);
      }
      this._initialScrollDone = true;
    }
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

      // 既存エントリは staffId / staffName / staffEmail のいずれかで検出して上書き (過去のデータ形式互換)
      const targetEmailLower = (targetStaffEmail || "").toLowerCase();
      const idx = responses.findIndex(r => {
        if (r.staffId && targetStaffId && r.staffId === targetStaffId) return true;
        if (r.staffName && targetStaffName && r.staffName === targetStaffName) return true;
        if (r.staffEmail && targetEmailLower && r.staffEmail.toLowerCase() === targetEmailLower) return true;
        return false;
      });
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
      const targetEmail = (this._pendingStaffEmail || "").toLowerCase();
      // staffId / staffName / staffEmail のいずれかに一致するエントリを削除 (過去のデータ形式互換)
      const responses = (data.responses || []).filter(r => {
        if (r.staffId && targetStaffId && r.staffId === targetStaffId) return false;
        if (r.staffName && targetStaffName && r.staffName === targetStaffName) return false;
        if (r.staffEmail && targetEmail && r.staffEmail.toLowerCase() === targetEmail) return false;
        return true;
      });
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

  // 募集ピル (物件行内で使用) — ステータスは色で表現、中は「清」or「直」1文字のみ
  // 直前点検は紫系、清掃は緑/黄/オレンジ系で色が異なり一目で区別可能
  // 高さ20px、文字を上下左右完全に中央
  _recruitPill(r) {
    if (!r) return "";
    const isPre = r.workType === "pre_inspection";
    let bg, color;
    if (isPre) {
      // 直前点検: 紫系
      if (r.status === "スタッフ確定済み") { bg = "#7c3aed"; color = "#fff"; }
      else if (r.status === "選定済") { bg = "#c4b5fd"; color = "#1e0a3c"; }
      else if (r.status === "募集中") { bg = "#a78bfa"; color = "#1e0a3c"; }
      else { bg = "#8b5cf6"; color = "#fff"; }
    } else {
      // 清掃: 緑/黄/オレンジ系
      bg = "#adb5bd"; color = "#fff";
      if (r.status === "スタッフ確定済み") { bg = "#198754"; color = "#fff"; }
      else if (r.status === "選定済") { bg = "#ffc107"; color = "#333"; }
      else if (r.status === "募集中") { bg = "#fd7e14"; color = "#fff"; }
    }
    const wtChar = isPre ? "直" : "清";
    return `<span style="display:inline-flex;align-items:center;justify-content:center;height:20px;min-width:30px;padding:0 10px;background:${bg};color:${color};border-radius:999px;font-weight:700;font-size:13px;line-height:1;text-align:center;position:relative;z-index:2;box-sizing:border-box;">${wtChar}</span>`;
  },

  // 端末別設定の localStorage 永続化 (スタッフ毎 key でこの端末にのみ保存)
  _settingsKey() {
    return this.staffId ? `mrCal_${this.staffId}` : null;
  },
  _loadSettings() {
    const key = this._settingsKey();
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.propertyVisibility && typeof s.propertyVisibility === "object") this._propertyVisibility = s.propertyVisibility;
      if (typeof s.showOnlyMe === "boolean") this._showOnlyMe = s.showOnlyMe;
      if (typeof s.stickyW === "number" && s.stickyW >= 80 && s.stickyW <= 400) this._stickyW = s.stickyW;
    } catch (e) { /* ignore */ }
  },
  _saveSettings() {
    const key = this._settingsKey();
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify({
        propertyVisibility: this._propertyVisibility || {},
        showOnlyMe: !!this._showOnlyMe,
        stickyW: this._stickyW || 140,
      }));
    } catch (e) { /* ignore */ }
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
