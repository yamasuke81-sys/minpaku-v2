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
    const authIsOwner = Auth.isOwner();
    const authIsSubOwner = Auth.isSubOwner();
    // ビューモード判定: #/schedule → owner ビュー、#/my-recruitment → staff ビュー
    const _hash = (location.hash || "").split("?")[0];
    const isScheduleRoute = _hash === "#/schedule" || _hash.startsWith("#/schedule/");
    this._viewMode = isScheduleRoute ? "owner" : "staff";
    // Webアプリ管理者ビュー: オーナー本人 or サブオーナー (サブオーナーは自物件のみ代理操作可)
    this.isOwnerView = this._viewMode === "owner" && (authIsOwner || authIsSubOwner);
    // サブオーナー判定 + 所有物件IDリスト (代理操作可否の絞り込みに使用)
    this._isSubOwnerView = this.isOwnerView && !authIsOwner && authIsSubOwner;
    this._ownedPropertyIds = this._isSubOwnerView
      ? (Array.isArray(Auth.currentUser?.ownedPropertyIds) ? Auth.currentUser.ownedPropertyIds : [])
      : [];
    // 既存コード互換 (staffId 解決/非アクティブ判定など) 用のローカル変数
    const isOwner = authIsOwner || authIsSubOwner;
    this.staffId = Auth.currentUser?.staffId;

    // Webアプリ管理者の場合: カスタムクレームに staffId が無くても、
    // authUid で staff コレクションから対応するドキュメントIDを解決
    if (isOwner && !this.staffId) {
      try {
        const snap = await db.collection("staff")
          .where("authUid", "==", Auth.currentUser.uid).limit(1).get();
        if (!snap.empty) this.staffId = snap.docs[0].id;
      } catch (e) { /* ignore */ }
    }
    if (isOwner && !this.staffId) this.staffId = Auth.currentUser.uid;

    // 管理者が viewAsStaff (特定スタッフ視点) で閲覧中なら staffId を上書き
    this._viewAsStaffId = (typeof App !== "undefined" && App.getViewAsStaffId) ? App.getViewAsStaffId() : null;
    if (this._viewAsStaffId) {
      this.staffId = this._viewAsStaffId;
    }

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
        <h2><i class="bi bi-calendar-check"></i> ${this._viewMode === "owner" ? "予約・清掃スケジュール" : "清掃スケジュール"}</h2>
        <div class="d-flex align-items-center gap-1 flex-wrap">
          <button class="btn btn-sm" id="btnGoLatestChecklist"
            style="background:#ffc107;color:#000;font-weight:600;border:1px solid #ffc107;padding:4px 10px;"
            title="直近の清掃チェックリストを開く">
            <i class="bi bi-clipboard-check"></i>
          </button>
          <button class="btn btn-sm btn-outline-secondary ms-2" id="btnMyCalPrev" title="前の月" style="min-width:36px;">◀</button>
          <input type="month" class="form-control form-control-sm" style="width:140px;" id="myCalMonth">
          <button class="btn btn-sm btn-outline-secondary" id="btnMyCalNext" title="次の月" style="min-width:36px;">▶</button>
          <button class="btn btn-sm btn-outline-primary ms-2" id="btnMyCalToday">今日</button>
        </div>
      </div>
      <!-- 要対応 / お知らせセクション -->
      <div id="myRecToActions" class="mb-3"></div>

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
            <span>募集ピル:
              <span style="background:#fd7e14;color:#fff;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;vertical-align:middle;">清</span>募集中
              <span style="background:#ffc107;color:#333;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;vertical-align:middle;">清</span>選定済
              <span style="background:#198754;color:#fff;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;vertical-align:middle;">清</span>確定済 = 清掃
            </span>
            <span>
              <span style="background:#a78bfa;color:#1e0a3c;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;vertical-align:middle;">直</span>募集中
              <span style="background:#c4b5fd;color:#1e0a3c;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;vertical-align:middle;">直</span>選定済
              <span style="background:#7c3aed;color:#fff;display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;vertical-align:middle;">直</span>確定済 = 直前点検
            </span>
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
        /* 列 hover: 同じ日付の全セルを薄くハイライト */
        #myCalContainer .col-hover { box-shadow: inset 0 0 0 9999px rgba(13,110,253,0.07); }
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
        #myCalContainer tr.section-header > td > .section-content { position:sticky; left:10px; display:inline-flex; flex-wrap:wrap; align-items:center; gap:4px; padding-left:4px; max-width:calc(100vw - 30px); }
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

      <!-- フルカレンダー (月表示) 折りたたみ -->
      <div class="mt-4">
        <button class="btn btn-sm btn-outline-secondary" type="button"
          data-bs-toggle="collapse" data-bs-target="#myRecFullCalendar" aria-expanded="false">
          <i class="bi bi-calendar3"></i> フルカレンダー (月表示) ▼
        </button>
        <div class="collapse mt-2" id="myRecFullCalendar">
          <div class="card">
            <div class="card-body p-2">
              <!-- 物件フィルタ (共通コンポーネント) -->
              <div id="propertyFilterHost-myrec-fullcal" class="mb-2"></div>
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
                <span><span class="cal-legend" style="background:#7c3aed"></span>🔍直前点検（確定）</span>
                <span><span class="cal-legend" style="background:#a78bfa"></span>🔍直前点検（募集中）</span>
                <span>|</span>
                <span><span class="event-status-dot dot-roster-ok" style="display:inline-block"></span>名簿済</span>
                <span><span class="event-status-dot dot-roster-ng" style="display:inline-block"></span>名簿未</span>
              </div>
              <div id="myRecFullCalendarBody"></div>
            </div>
          </div>
        </div>
      </div>

    `;

    try {
      const staffSnap = await db.collection("staff").doc(this.staffId).get();
      this.staffDoc = staffSnap.exists ? staffSnap.data() : (isOwner
        ? { name: Auth.currentUser.displayName || "Webアプリ管理者", email: Auth.currentUser.email || "" }
        : {});

      // E: 非アクティブスタッフは回答操作不可、メッセージを最上部に表示
      this._isInactive = !isOwner && this.staffDoc && this.staffDoc.active === false;
      if (this._isInactive) {
        const msg = this.staffDoc.inactiveReason ||
          "直近15回の清掃募集について回答がなかったため、非アクティブとなりました。解除する場合はWebアプリ管理者までご連絡ください。";
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

      // D: 清掃チェックリストボタン → 物件選択モーダル → 選択物件の直近確定済シフトの checklist を開く
      document.getElementById("btnGoLatestChecklist").addEventListener("click", () => {
        this._openPropertyPickerForChecklist();
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

      // FullCalendar 折りたたみ: 初回展開時に lazy 初期化
      const fcCollapse = document.getElementById("myRecFullCalendar");
      if (fcCollapse) {
        fcCollapse.addEventListener("shown.bs.collapse", () => {
          if (this._fcInitialized) {
            this._refreshFullCalendar();
            return;
          }
          this._initFullCalendar();
        }, { once: false });
      }

      // renderCalendar() は subscribeData() 内の onSnapshot コールバックが呼ぶ。
      // ここでの直接呼び出しは不要（データ未着状態で描画してしまうのを防ぐ）。
    } catch (e) {
      console.error("読み込みエラー:", e);
      document.getElementById("myCalContainer").innerHTML = `<div class="alert alert-danger">${e.message}</div>`;
    }
  },

  /**
   * bookings + guestRegistrations をマージして this.bookings にセット
   * dashboard.js の addBooking ロジックを移植 (CI+CO 複合キー + ソース優先度)
   */
  _mergeBookingSources() {
    const rawBookings = this._rawBookings || [];
    const rawGuests = this._rawGuestRegs || [];
    const toDateStr = (v) => this._toDateStr(v);

    const SOURCE_PRIORITY = { beds24: 40, booking: 30, bookings: 30, direct: 20, manual: 20, guest_form: 15, "名簿": 10, migrated: 5, "": 0 };
    const getSourcePriority = (src) => {
      if (!src) return 0;
      const s = String(src).toLowerCase();
      for (const [k, val] of Object.entries(SOURCE_PRIORITY)) {
        if (s.includes(k)) return val;
      }
      return 1;
    };
    const isPlaceholder = (name) => {
      if (!name) return true;
      const n = String(name).trim().toLowerCase();
      return !n || n === "-" || n.includes("airbnb") || n.includes("booking.com") ||
        n.includes("not available") || n.includes("blocked") || n.includes("closed") || n.includes("reserved");
    };

    const bookingMap = new Map(); // key: "CI|CO" → merged
    const addBooking = (b, sourceType) => {
      const ci = toDateStr(b.checkIn);
      const co = toDateStr(b.checkOut);
      if (!ci) return;
      // propertyId を key に含めて物件別に独立保持 (同日 CI/CO の異なる物件が 1件にマージされる問題を修正)
      const pid = b.propertyId || "_nopid_";
      const key = `${pid}|${ci}|${co}`;
      const existing = bookingMap.get(key);
      if (!existing) {
        bookingMap.set(key, { ...b, checkIn: ci, checkOut: co, _sourceType: sourceType, _sources: [sourceType] });
        return;
      }
      existing._sources.push(sourceType);
      const newPri = getSourcePriority(b.source || b.bookingSite || sourceType);
      const existPri = getSourcePriority(existing.source || existing._sourceType);
      if (!isPlaceholder(b.guestName) && (isPlaceholder(existing.guestName) || newPri > existPri)) {
        existing.guestName = b.guestName;
      }
      if ((b.guestCount || 0) > (existing.guestCount || 0)) existing.guestCount = b.guestCount;
      if (newPri > existPri && b.source) existing.source = b.source;
      if (b.bookingSite && !existing.bookingSite) existing.bookingSite = b.bookingSite;
      ["nationality", "bbq", "parking", "memo", "phone", "email", "icalUrl", "syncSource",
       "beds24Source", "beds24BookingId", "propertyId", "propertyName",
       "emailMessageId", "emailThreadId", "emailSubject", "emailVerifiedAt"].forEach(f => {
        if (b[f] && !existing[f]) existing[f] = b[f];
      });
    };

    // 1) bookings コレクション - 最優先
    rawBookings.forEach(b => addBooking(b, "bookings"));
    // 2) guestRegistrations - 補完 (bookings 側に無い予約を拾う)
    rawGuests.forEach(g => addBooking({
      id: "g_" + g.id,
      guestName: g.guestName || "",
      checkIn: g.checkIn, checkOut: g.checkOut,
      guestCount: g.guestCount || 0,
      source: g.bookingSite || g.source || "名簿",
      propertyId: g.propertyId || "",
      nationality: g.nationality || "",
      bbq: g.bbq || "", parking: g.parking || "",
      memo: g.memo || "",
    }, "guestRegistrations"));

    this.bookings = Array.from(bookingMap.values());
  },

  // YYYY-MM-DD 文字列化 (string / Date / Firestore Timestamp 対応、JST)
  _toDateStr(val) {
    if (!val) return "";
    if (typeof val === "string") {
      const m = val.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
      if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
      return val.slice(0, 10);
    }
    const d = val.toDate ? val.toDate() : new Date(val);
    if (isNaN(d.getTime())) return "";
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return jst.toISOString().slice(0, 10);
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

    // 物件オーナー視点での絞り込み (impersonation または サブオーナー本人ログイン)
    // A = オーナーが owned の物件
    // X = A のいずれかを担当するスタッフ
    // B = X が担当している別の物件 (A に含まれない物件も含む)
    // 表示物件 = A ∪ B、表示スタッフ = X
    let impersonatedAllowedProps = null;
    let impersonatedAllowedStaff = null;
    // viewAsStaff (特定スタッフ視点) が選ばれている場合は impersonating 絞込を無効化し、
    // そのスタッフ自身の assignedPropertyIds で絞る (下の canFilter ロジックに任せる)
    const isImpersonating = (typeof App !== "undefined" && App.impersonating && App.impersonatingData) && !this._viewAsStaffId;
    const isSubOwnerSelf = this._isSubOwnerView === true && !this._viewAsStaffId;
    if (isImpersonating || isSubOwnerSelf) {
      const ownerOwnedIds = isImpersonating
        ? (App.impersonatingData.ownedPropertyIds || [])
        : (this._ownedPropertyIds || []);
      const ownedA = new Set(ownerOwnedIds);
      // 全 active staff から X を抽出
      const allActiveStaff = staffSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const staffX = allActiveStaff.filter(s => {
        const assigned = Array.isArray(s.assignedPropertyIds) ? s.assignedPropertyIds : [];
        return assigned.some(pid => ownedA.has(pid));
      });
      impersonatedAllowedStaff = new Set(staffX.map(s => s.id));
      // B = X が担当している全ての物件 ID の和集合
      const unionB = new Set(ownedA);
      staffX.forEach(s => (s.assignedPropertyIds || []).forEach(pid => unionB.add(pid)));
      impersonatedAllowedProps = unionB;
    }

    // 物件リスト初期化
    this.minpakuProperties = impersonatedAllowedProps
      ? minpakuProps.filter(p => impersonatedAllowedProps.has(p.id))
      : minpakuProps;
    this.propertyMap = {};
    this.minpakuProperties.forEach(p => { this.propertyMap[p.id] = p; });

    // 通知既読状態を取得 (ユーザー別 userNotificationStatus/{uid})
    await this._loadReadIds();

    // 端末別設定を localStorage から読み込み (スタッフ毎 key)
    this._loadSettings();

    // 物件表示フラグ（初回は全部表示、以降は localStorage の値を維持）
    if (!this._propertyVisibility) this._propertyVisibility = {};
    this.minpakuProperties.forEach(p => {
      if (this._propertyVisibility[p.id] === undefined) this._propertyVisibility[p.id] = true;
    });

    // スタッフ並び: displayOrder 昇順、Webアプリ管理者(isOwner=true)は最下部に移動
    let allStaff = staffSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    // impersonation: 対象スタッフ X のみに絞り込み
    if (impersonatedAllowedStaff) {
      allStaff = allStaff.filter(s => impersonatedAllowedStaff.has(s.id));
    }
    const nonOwner = allStaff.filter(s => !s.isOwner).sort((a,b) => (a.displayOrder||0) - (b.displayOrder||0));
    const owner = allStaff.filter(s => s.isOwner).sort((a,b) => (a.displayOrder||0) - (b.displayOrder||0));
    this.staffList = [...nonOwner, ...owner];
    this._loadedFlags.staff = true;

    // assignedPropertyIds の取得（スタッフドキュメントから読み取る）
    const assignedIds = Array.isArray(this.staffDoc?.assignedPropertyIds)
      ? this.staffDoc.assignedPropertyIds
      : (Auth.currentUser?.assignedPropertyIds || []);
    // viewAsStaff 中は管理者/物件オーナーでも当該スタッフの assignedPropertyIds で絞る
    const canFilter = (!isOwner || !!this._viewAsStaffId) && Array.isArray(assignedIds) && assignedIds.length > 0 && assignedIds.length <= 10;

    // --- recruitments onSnapshot ---
    let recruitQuery = db.collection("recruitments");
    if (canFilter) {
      recruitQuery = recruitQuery.where("propertyId", "in", assignedIds);
    }
    const unsubRecruit = recruitQuery.onSnapshot(snap => {
      // 全件 (キャンセル含む) を保持 → お知らせセクションで使用
      this._rawRecruitmentsAll = snap.docs.map(d => {
        const raw = d.data();
        const coDate = this._normalizeDate(raw.checkoutDate || raw.checkOutDate || raw.checkOutdate);
        return { id: d.id, ...raw, checkoutDate: coDate };
      });
      // checkoutDate 正規化・フィルタ (キャンセル除外、画面表示用)
      this.recruitments = snap.docs.map(d => {
        const raw = d.data();
        const coDate = this._normalizeDate(raw.checkoutDate || raw.checkOutDate || raw.checkOutdate);
        return { id: d.id, ...raw, checkoutDate: coDate };
      }).filter(r => r.checkoutDate);
      // impersonation: 表示物件セットに含まれるもののみ
      if (impersonatedAllowedProps) {
        this._rawRecruitmentsAll = this._rawRecruitmentsAll.filter(r => impersonatedAllowedProps.has(r.propertyId));
        this.recruitments = this.recruitments.filter(r => impersonatedAllowedProps.has(r.propertyId));
      }

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
      // キャンセル + 保留中(pendingApproval=true) を除外
      // 保留中は Airbnb 予約承認待ちなど (確定後に再 ingest される)
      this._rawBookings = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(b => {
        const s = String(b.status || "").toLowerCase();
        if (s.includes("cancel") || b.status === "キャンセル" || b.status === "キャンセル済み") return false;
        if (b.pendingApproval === true) return false;
        return true;
      });
      // impersonation: 表示物件セットに含まれるもののみ
      if (impersonatedAllowedProps) {
        this._rawBookings = this._rawBookings.filter(b => impersonatedAllowedProps.has(b.propertyId));
      }
      this._mergeBookingSources();

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
      const isOwnerView = this.isOwnerView;
      // 生データ保持 (マージ用): Webアプリ管理者時のみ PII 含む、スタッフ時は最小限フィールド
      this._rawGuestRegs = snap.docs.map(d => {
        const g = d.data();
        if (isOwnerView) {
          return { id: d.id, ...g };
        }
        return {
          id: d.id,
          guestCount: g.guestCount || 0,
          guestCountInfants: g.guestCountInfants || 0,
          checkIn: g.checkIn, checkOut: g.checkOut,
          propertyId: g.propertyId || "",
          checkInTime: g.checkInTime || "", checkOutTime: g.checkOutTime || "",
          bbq: g.bbq || "", carCount: g.carCount || 0,
          paidParking: g.paidParking || "",
          bedChoice: g.bedChoice || "", nationality: g.nationality || "",
          parking: g.parking || "", transport: g.transport || "",
          vehicleTypes: g.vehicleTypes || [],
          bookingSite: g.bookingSite || "", source: g.source || "",
        };
      });
      // impersonation: 表示物件セットに含まれるもののみ
      if (impersonatedAllowedProps) {
        this._rawGuestRegs = this._rawGuestRegs.filter(g => impersonatedAllowedProps.has(g.propertyId));
      }

      // guestMap 構築 (画面表示用)
      this.guestMap = {};
      snap.docs.forEach(d => {
        const g = d.data();
        const ci = g.checkIn;
        if (!ci) return;
        const entry = {
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
        // Webアプリ管理者時は予約詳細モーダルで使う PII も含める
        if (isOwnerView) {
          Object.assign(entry, {
            guestName: g.guestName || "",
            address: g.address || "",
            phone: g.phone || "", phone2: g.phone2 || "",
            email: g.email || "",
            passportNumber: g.passportNumber || "",
            purpose: g.purpose || "",
            memo: g.memo || "",
            emergencyName: g.emergencyName || "",
            emergencyPhone: g.emergencyPhone || "",
            previousStay: g.previousStay || "",
            nextStay: g.nextStay || "",
            noiseAgree: g.noiseAgree || false,
            guests: g.guests || [],
            allGuests: g.allGuests || [],
            parkingAllocation: g.parkingAllocation || [],
            passportPhotoUrl: g.passportPhotoUrl || "",
          });
        }
        if (g.propertyId) this.guestMap[`${g.propertyId}_${ci}`] = entry;
        this.guestMap[ci] = entry;
      });

      this._mergeBookingSources();

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
    this._rawBookings = null;
    this._rawGuestRegs = null;
    this._rawRecruitmentsAll = null;
    if (this._fc) {
      try { this._fc.destroy(); } catch (e) { /* ignore */ }
      this._fc = null;
    }
    this._fcInitialized = false;
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
        id: b.id,
        source: (b.source || "").toLowerCase(), guestCount: b.guestCount || 0,
        propertyName: b.propertyName || "", propertyId: pid,
        checkIn: b.checkIn, checkOut: b.checkOut,
        // メール照合情報 (予約詳細モーダルで「照合メール」行を出すため)
        emailMessageId: b.emailMessageId || null,
        emailThreadId: b.emailThreadId || null,
        emailSubject: b.emailSubject || null,
        emailVerifiedAt: b.emailVerifiedAt || null,
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
    // src だけでなく booking 全体 (b) を受け取って bookingSite / guestName / notes も判定材料にする
    // (gas_form_sync など source が中立な値の予約でも色を正しく出すため)
    const bookingColor = (bOrSrc, fallback) => {
      const b = (bOrSrc && typeof bOrSrc === "object") ? bOrSrc : null;
      const haystack = b
        ? `${b.source || ""} ${b.bookingSite || ""} ${b.guestName || ""} ${b.notes || ""}`.toLowerCase()
        : String(bOrSrc || "").toLowerCase();
      if (haystack.includes("airbnb")) return "#ff5a5f";
      if (haystack.includes("booking")) return "#003580";
      return fallback;
    };

    // スタッフビューでは assignedPropertyIds に含まれる物件のみを閲覧対象にする。
    // Webアプリ管理者ビュー (#/schedule) では全民泊物件を対象。
    const myAssigned = Array.isArray(this.staffDoc?.assignedPropertyIds)
      ? this.staffDoc.assignedPropertyIds
      : [];
    const displayProperties = this.isOwnerView
      ? this.minpakuProperties
      : this.minpakuProperties.filter(p => myAssigned.includes(p.id));

    // 非表示中の物件一覧 (セクション見出し内に復旧ボタンを出す)
    const hiddenProps = displayProperties.filter(p => this._propertyVisibility[p.id] === false);

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
      // 日付ヘッダーはタップ無効 (物件行の各セルで予約を特定して開くため、ヘッダーは装飾のみ)
      html += `<th class="text-center" data-cal-date="${dd.dateStr}" data-col-date="${dd.dateStr}" style="min-width:${colW};height:42px;font-size:14px;${dowColor ? "color:" + dowColor + ";" : ""}background:${bg};vertical-align:middle;"><div style="font-size:14px;font-weight:600;">${dd.day}</div><div style="font-size:12px;">${dayNames[dow]}</div></th>`;
    });
    html += "</tr>";
    html += `</thead><tbody>`;

    // ===== 物件セクション =====
    const visibleProps = displayProperties.filter(p => this._propertyVisibility[p.id] !== false);
    if (displayProperties.length > 0) {
      // セクション見出し (非表示物件の復旧ボタンもここに)
      const restoreButtons = hiddenProps.length
        ? hiddenProps.map(p => `<button type="button" class="prop-restore ms-1" data-prop-id="${p.id}" title="${this.esc(p.name)} を再表示" style="border:1px solid #ced4da;background:#fff;border-radius:4px;padding:2px 6px;font-size:12px;cursor:pointer;">
            <span class="badge" style="background:${p._color};color:#fff;">${p._num}</span> <i class="bi bi-eye text-muted"></i>
          </button>`).join("")
        : "";
      // 「自物件だけ」: サブオーナー視点 (オーナー画面 + impersonating or sub_owner) のみ表示
      // スタッフ画面 (_viewMode === "staff") では非表示
      const isSubOwnerContext = this._viewMode === "owner" &&
        (this._isSubOwnerView || (typeof App !== "undefined" && App.impersonating && App.impersonatingData));
      const myPropFilterBtn = isSubOwnerContext
        ? (() => {
            const active = this._propFilter === "myProp";
            return `<button type="button" id="btnPropMyOnly" class="ms-2" style="border:1px solid ${active ? '#0d6efd' : '#ced4da'};background:${active ? '#0d6efd' : '#fff'};color:${active ? '#fff' : '#495057'};border-radius:4px;padding:2px 10px;font-size:12px;font-weight:600;cursor:pointer;">${active ? '✓ ' : ''}自物件だけ <i class="bi bi-house-door"></i></button>`;
          })()
        : "";
      html += `<tr class="section-header"><td style="background:#eef5ff;font-weight:bold;font-size:13px;padding:6px 10px;" colspan="${allDates.length + 1}">
        <span class="section-content">
          <i class="bi bi-building"></i> 物件名
          ${myPropFilterBtn}
          ${hiddenProps.length ? `<span class="text-muted ms-2" style="font-weight:normal;font-size:11px;">非表示${hiddenProps.length}件:</span>${restoreButtons}` : `<small class="text-muted ms-2">(目のアイコンで表示切替)</small>`}
        </span>
      </td></tr>`;

      // 各物件は常に 2 段 (1段目=宿泊バー / 2段目=清掃募集)。
      // 同日 CI/CO は半セル吸収で同一セル内に並べる (レーン分離なし)。
      // 非表示の物件は描画をスキップ (復旧は見出しの目アイコンボタンから)。
      // スタッフビューは displayProperties が担当物件のみに絞られている。
      displayProperties.forEach(p => {
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
            html += `<td data-col-date="${dd.dateStr}" style="height:${propRowH};background:#f8f9fa;padding:0;"></td>`;
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
          // pointer-events:none で内部要素のタップを td 全体に確実にバブルさせる
          const barTopStyle = "top:50%;transform:translateY(-50%);height:20px;pointer-events:none;";
          let segs = "";
          if (ending) {
            const c = bookingColor(ending, fallbackColor);
            segs += `<div style="position:absolute;left:0;right:50%;${barTopStyle}background:${c};border-top-right-radius:999px;border-bottom-right-radius:999px;z-index:2;"></div>`;
          }
          if (middle) {
            const c = bookingColor(middle, fallbackColor);
            segs += `<div style="position:absolute;left:0;right:0;${barTopStyle}background:${c};z-index:2;"></div>`;
          }
          if (starting) {
            const c = bookingColor(starting, fallbackColor);
            segs += `<div style="position:absolute;left:50%;right:0;${barTopStyle}background:${c};border-top-left-radius:999px;border-bottom-left-radius:999px;z-index:2;"></div>`;
            // 名簿ドット判定 — placeholder予約と他物件名簿の誤マッチを防ぐ
            const isPlaceholder = (n) => {
              const s = String(n || "").toLowerCase().trim();
              return !s || /^(reserved|not available|airbnb|booking|airbnb予約|booking\.com予約|\(no name\))/i.test(s);
            };
            // (1) 予約自体がプレースホルダー名 (Reserved 等) なら名簿未記入扱い
            // (2) 物件IDがあれば propertyId+CI の複合キーで照合、無ければ CI 単独
            // (3) guestRegistration 側もプレースホルダー名なら未記入扱い
            let hasGuest = false;
            if (!isPlaceholder(starting.guestName)) {
              const key = starting.propertyId
                ? `${starting.propertyId}_${starting.checkIn}`
                : starting.checkIn;
              const g = this.guestMap[key];
              if (g && !isPlaceholder(g.guestName)) hasGuest = true;
            }
            const dotColor = hasGuest ? "#198754" : "#dc3545";
            const dotTitle = hasGuest ? "名簿提出済み" : "名簿未提出";
            segs += `<span style="position:absolute;left:calc(50% + 4px);top:50%;transform:translateY(-50%);width:9px;height:9px;border-radius:50%;background:${dotColor};border:1.5px solid #fff;z-index:4;pointer-events:none;" title="${dotTitle}"></span>`;
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
          // data-booking-id にセル対象予約の ID を埋め込むことで、同日複数物件の予約が
          // ある時も「タップしたセルの物件」の予約が開くようにする (bs[0] に頼らない)
          const clickAttr = ref ? ` class="cal-date-hd" data-cal-date="${ref.checkIn}" data-booking-id="${this.esc(ref.id)}"` : "";
          const cursor = ref ? "cursor:pointer;" : "";
          html += `<td${clickAttr} data-col-date="${dd.dateStr}" style="position:relative;height:${propRowH};background:${tdBg};padding:0;overflow:visible;${cursor}">${segs}</td>`;
        });
        html += "</tr>";

        // ---- 2段目: 清掃募集 ----
        html += `<tr data-prop-row="${p.id}" data-row-type="recruit" style="${visible ? "" : "opacity:0.35;"}">`;
        allDates.forEach(dd => {
          if (!visible) {
            html += `<td data-col-date="${dd.dateStr}" style="border-left:1px solid #dee2e6;border-right:1px solid #dee2e6;border-bottom:1px solid #dee2e6;height:${propRowH};background:#f8f9fa;padding:0;"></td>`;
            return;
          }
          const r = recruitByD[dd.dateStr];
          const isHdToday = dd.dateStr === todayStr;
          const cellBg = isHdToday ? "#e8f0fe" : (!dd.isCurrent ? "#e9ecef" : "#fff");
          if (r) {
            // 清掃 / 直前点検 バーをタップしたら「募集詳細モーダル」を開く
            // (予約詳細モーダルは予約バー / 日付セル側で開く)
            html += `<td class="text-center cal-recruit-cell" data-recruitment-id="${this.esc(r.id)}" data-col-date="${dd.dateStr}" style="height:${propRowH};background:${cellBg};padding:1px;vertical-align:middle;cursor:pointer;">${this._recruitPill(r)}</td>`;
          } else {
            html += `<td data-col-date="${dd.dateStr}" style="height:${propRowH};background:${cellBg};padding:0;"></td>`;
          }
        });
        html += "</tr>";
      });

      // セクション見出し: スタッフ
      // 「自分だけ」: 純粋管理者 (impersonate/viewAsStaff なし) では不要、それ以外は表示
      const isPureOwner = this.isOwnerView && !this._isSubOwnerView
        && !(typeof App !== "undefined" && App.impersonating && App.impersonatingData)
        && !this._viewAsStaffId;
      const showSelfBtn = !isPureOwner;
      const selfBtnHtml = showSelfBtn
        ? `<button type="button" id="btnShowOnlyMe" class="ms-2" style="border:1px solid ${this._showOnlyMe ? '#0d6efd' : '#ced4da'};background:${this._showOnlyMe ? '#0d6efd' : '#fff'};color:${this._showOnlyMe ? '#fff' : '#495057'};border-radius:4px;padding:2px 10px;font-size:12px;font-weight:600;cursor:pointer;">${this._showOnlyMe ? '✓ ' : ''}自分だけ <i class="bi bi-eye"></i></button>`
        : "";
      // 「表示中物件だけ」: 全モードで表示 (スタッフセクション)
      const visiblePropActive = this._staffFilter === "visibleProp";
      const visiblePropBtnHtml = `<button type="button" class="ms-1 staff-filter-btn" data-filter="visibleProp" style="border:1px solid ${visiblePropActive ? '#0d6efd' : '#ced4da'};background:${visiblePropActive ? '#0d6efd' : '#fff'};color:${visiblePropActive ? '#fff' : '#495057'};border-radius:4px;padding:2px 10px;font-size:12px;font-weight:600;cursor:pointer;">${visiblePropActive ? '✓ ' : ''}表示中物件だけ <i class="bi bi-eye-fill"></i></button>`;
      html += `<tr class="section-header"><td style="background:#eef5ff;font-weight:bold;font-size:13px;padding:6px 10px;" colspan="${allDates.length + 1}">
        <span class="section-content">
          <i class="bi bi-people"></i> スタッフ
          ${selfBtnHtml}
          ${visiblePropBtnHtml}
        </span>
      </td></tr>`;
    }

    // 自物件 ID セット (オーナー=全物件, サブオーナー=ownedPropertyIds, スタッフ=staffDoc.assignedPropertyIds)
    const myPropIdsSet = (() => {
      if (this._isSubOwnerView) {
        return new Set(this._ownedPropertyIds || []);
      }
      if (this.isOwnerView) {
        return new Set(this.minpakuProperties.map(p => p.id));
      }
      const a = Array.isArray(this.staffDoc?.assignedPropertyIds) ? this.staffDoc.assignedPropertyIds : [];
      return new Set(a);
    })();

    // ===== スタッフ行 =====
    const isOwner = this.isOwnerView === true;
    // スタッフビューでは「自分と担当物件が重なる他スタッフ」+「自分自身」+「メインWebアプリ管理者」のみ表示。
    // Webアプリ管理者ビューでは全スタッフを表示。
    const myAssignedForStaff = Array.isArray(this.staffDoc?.assignedPropertyIds)
      ? this.staffDoc.assignedPropertyIds
      : [];
    // 現在表示中(目アイコンで非表示にされていない) の物件のみで担当判定
    const visiblePropIds = new Set(
      displayProperties
        .filter(p => this._propertyVisibility[p.id] !== false)
        .map(p => p.id)
    );
    const visibleStaffList = isOwner
      ? this.staffList
      : this.staffList.filter(s => {
          if (s.id === this.staffId) return true;     // 自分は必ず表示
          if (s.isOwner) return true;                   // メインWebアプリ管理者行は残す
          const theirAssigned = Array.isArray(s.assignedPropertyIds) ? s.assignedPropertyIds : [];
          // 表示中の物件のいずれかを担当しているスタッフのみ表示
          return theirAssigned.some(pid => visiblePropIds.has(pid));
        });
    // 自分の行を一番上に固定: 自分を先頭に、それ以外は元の並び順を維持
    const orderedStaff = [
      ...visibleStaffList.filter(s => s.id === this.staffId),
      ...visibleStaffList.filter(s => s.id !== this.staffId),
    ];
    orderedStaff.forEach(staff => {
      const isMe = staff.id === this.staffId;
      // 「自分だけ」モード: 自分以外は描画しない
      if (this._showOnlyMe && !isMe) return;
      // 「自物件だけ / 表示中物件だけ」フィルタ (自分自身は常に表示)
      if (!isMe && this._staffFilter && this._staffFilter !== "all") {
        const theirAssigned = Array.isArray(staff.assignedPropertyIds) ? staff.assignedPropertyIds : [];
        const filterSet = this._staffFilter === "myProp" ? myPropIdsSet : visiblePropIds;
        if (theirAssigned.length === 0 || !theirAssigned.some(pid => filterSet.has(pid))) return;
      }
      const assigned = Array.isArray(staff.assignedPropertyIds) ? staff.assignedPropertyIds : [];
      const hasAssignments = assigned.length > 0;
      html += `<tr class="staff-row"><td class="fw-medium sticky-col" style="position:sticky;left:0;z-index:10;background:${isMe ? "#e3f2fd" : "#fff"};min-width:${stickyW};max-width:${stickyW};height:${cellH};font-size:14px;vertical-align:middle;padding:4px 10px 4px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.3;">
        ${this.esc(staff.name)}${isMe ? " 👤" : ""}${staff.isOwner ? ' <span class="badge bg-info" style="font-size:9px;">OWN</span>' : ""}
        <div class="col-resizer" title="ドラッグで列幅を変更" style="position:absolute;top:0;right:0;width:8px;height:100%;cursor:col-resize;z-index:4;user-select:none;background:repeating-linear-gradient(to bottom, rgba(108,117,125,0.45) 0 4px, transparent 4px 8px);touch-action:none;"></div>
      </td>`;

      allDates.forEach(dd => {
        const isToday = dd.dateStr === todayStr;
        // このスタッフが対象にしうる物件ID群
        // - 担当物件が設定されていればそれで絞る (isOwner=true のWebアプリ管理者/代理スタッフも含む)
        // - 未設定の場合は全物件 (新規スタッフなど)
        const targetPropIds = hasAssignments
          ? assigned
          : this.minpakuProperties.map(p => p.id);

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
          // Webアプリ管理者は募集ゼロ日でもセルタップで手動追加ダイアログを開けるように data-owner-add="1" 付与
          const ownerAddAttr = isOwner
            ? ` data-owner-add="1" data-date="${dd.dateStr}" style="background:${bg};color:#adb5bd;height:${cellH};vertical-align:middle;cursor:pointer;"`
            : ` style="background:${bg};color:#adb5bd;height:${cellH};vertical-align:middle;"`;
          html += `<td class="text-center"${ownerAddAttr}>-</td>`;
          return;
        }

        // 各募集ごとに物件バッジ+回答記号のアイテムを生成
        let anyConfirmed = false;
        // セル全体タップ用に、代表となる clickable 募集を 1 件選ぶ
        let cellClickTarget = null; // { recruit, prop, clickMode }
        const items = cellRecruits.map(({recruit, prop}) => {
          const responses = recruit.responses || [];
          let resp = "未回答";
          // 照合は staffId 優先、無ければ staffName 一致のみ。
          // メール一致は同一メールを複数スタッフで共有しているケースで誤検知するため使わない。
          for (const r of responses) {
            const idMatch = r.staffId && staff.id && r.staffId === staff.id;
            const nameMatch = !r.staffId && r.staffName && staff.name && r.staffName === staff.name;
            if (idMatch || nameMatch) {
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

          // スタッフ確定済み × 回答あり × 選ばれなかった → 記号を濃いグレーに
          // (○/△/× いずれも 落選表示として灰色化)
          const isFinalized = recruit.status === "スタッフ確定済み";
          if (isFinalized && resp !== "未回答" && !confirmed) {
            symColor = "#495057"; // 濃いめのグレー (Bootstrap gray-700)
          }

          // 確定済み: Webアプリ管理者 or 自分の行 (確定されていなくても詳細閲覧は可能) → 常にクリック可能
          // 募集中/選定済: 自分の行 or Webアプリ管理者 → クリック可能
          // サブオーナーは所有物件 (ownedPropertyIds) の募集のみ代理操作可能
          const isOwnedByMe = !this._isSubOwnerView || (prop && this._ownedPropertyIds.includes(prop.id));
          const clickable = isMe || (isOwner && isOwnedByMe);
          const clickMode = (recruit.status === "スタッフ確定済み") ? "detail" : "respond";
          if (clickable && !cellClickTarget) {
            cellClickTarget = { recruitId: recruit.id, propId: prop ? prop.id : "", propName: prop ? prop.name : "", clickMode };
          }
          // 物件番号バッジは回答済みのときのみ表示 (未回答は記号だけ)
          const propBadge = (resp !== "未回答" && prop)
            ? `<span style="color:#fff;background:${prop._color};padding:1px 4px;border-radius:3px;font-size:11px;font-weight:700;">${prop._num}</span>`
            : "";

          // ● だけ Unicode 文字は上下ずれるので CSS 描画円にする (完全な垂直中央揃え)
          // ▲ ✖ は Unicode のまま、− は線
          let symHtml;
          // △ 回答の理由 (memo) を探す
          let triangleReason = "";
          let triangleStaffName = "";
          if (symbol === "▲") {
            for (const r of responses) {
              const idMatch = r.staffId && staff.id && r.staffId === staff.id;
              const nameMatch = !r.staffId && r.staffName && staff.name && r.staffName === staff.name;
              if (idMatch || nameMatch) {
                triangleReason = r.memo || "";
                triangleStaffName = r.staffName || staff.name || "";
                break;
              }
            }
          }
          if (symbol === "●") {
            symHtml = `<span style="display:inline-block;width:16px;height:16px;border-radius:50%;background:${symColor};vertical-align:middle;"></span>`;
          } else if (symbol === "▲") {
            // △マーク: ポップアップは廃止 (理由は募集詳細モーダル内で展開表示)
            symHtml = `<span style="display:inline-block;color:${symColor};font-size:17px;font-weight:bold;line-height:16px;vertical-align:middle;">▲</span>`;
          } else if (symbol === "✖") {
            symHtml = `<span style="display:inline-block;color:${symColor};font-size:17px;font-weight:bold;line-height:16px;vertical-align:middle;">✖</span>`;
          } else {
            symHtml = `<span style="display:inline-block;color:${symColor};font-size:14px;font-weight:bold;line-height:16px;vertical-align:middle;">−</span>`;
          }
          return `<span class="${clickable ? 'cal-cell-item' : ''}" data-recruit-id="${recruit.id}" data-prop-id="${prop ? prop.id : ''}" data-prop-name="${prop ? this.esc(prop.name) : ''}" data-click-mode="${clickMode}" data-staff-id="${staff.id}" data-staff-name="${this.esc(staff.name)}" data-staff-email="${this.esc(staff.email||"")}" data-is-me="${isMe}" data-date="${dd.dateStr}" style="display:inline-flex;align-items:center;gap:3px;line-height:1;padding:1px 3px;border-radius:4px;${clickable ? 'cursor:pointer;' : ''}">${propBadge}${symHtml}</span>`;
        });

        // 回答可能セル (自分が行動可能) は他月でも白背景に
        // cellClickTarget が存在する = そのスタッフ行で回答/詳細表示が可能
        const isActionable = !!cellClickTarget;
        const cellBg = anyConfirmed ? "#a7c7ff"
          : (isToday ? "#e8f0fe"
            : (isActionable ? "#fff"
              : (!dd.isCurrent ? "#e9ecef" : "")));
        // セル全体クリック: 内部アイテム (.cal-cell-item) と同じ挙動を td に付与
        const tdData = cellClickTarget
          ? ` data-cell-click="1" data-recruit-id="${cellClickTarget.recruitId}" data-prop-id="${cellClickTarget.propId}" data-prop-name="${this.esc(cellClickTarget.propName || "")}" data-click-mode="${cellClickTarget.clickMode}" data-staff-id="${staff.id}" data-staff-name="${this.esc(staff.name)}" data-staff-email="${this.esc(staff.email||"")}" data-is-me="${isMe}" data-date="${dd.dateStr}"`
          : "";
        const tdCursor = cellClickTarget ? "cursor:pointer;" : "";
        html += `<td class="text-center" data-col-date="${dd.dateStr}" style="background:${cellBg};height:${cellH};vertical-align:middle;padding:2px 3px;white-space:nowrap;${tdCursor}"${tdData}>
          <span style="display:inline-flex;flex-wrap:wrap;gap:3px;justify-content:center;align-items:center;">${items.join("")}</span>
        </td>`;
      });
      html += "</tr>";
    });

    html += "</tbody></table>";
    container.innerHTML = html;

    // 列 hover: 同じ日付のセル全体を薄くハイライト (PC での操作性向上)
    if (!container._colHoverBound) {
      container._colHoverBound = true;
      container.addEventListener("mouseover", (ev) => {
        const cell = ev.target.closest("[data-col-date]");
        const key = cell ? cell.dataset.colDate : null;
        if (container._lastHoverCol === key) return;
        container.querySelectorAll(".col-hover").forEach(el => el.classList.remove("col-hover"));
        if (key) {
          container.querySelectorAll(`[data-col-date="${key}"]`).forEach(el => el.classList.add("col-hover"));
        }
        container._lastHoverCol = key;
      });
      container.addEventListener("mouseleave", () => {
        container.querySelectorAll(".col-hover").forEach(el => el.classList.remove("col-hover"));
        container._lastHoverCol = null;
      });
    }

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

    // 物件名セクションの「自物件だけ」ボタン (サブオーナー視点のみ表示)
    // トグル: 押すと自物件のみ ON / もう一度押すと押す前の表示状態に戻す
    document.getElementById("btnPropMyOnly")?.addEventListener("click", () => {
      if (this._propFilter === "myProp") {
        // 解除: backup から復元
        if (this._propertyVisibilityBackup) {
          this._propertyVisibility = { ...this._propertyVisibilityBackup };
        }
        this._propFilter = "all";
        this._propertyVisibilityBackup = null;
      } else {
        // 適用: 現在状態をbackupしてから自物件のみ ON
        this._propertyVisibilityBackup = { ...(this._propertyVisibility || {}) };
        const ownedIds = (typeof App !== "undefined" && App.impersonating && App.impersonatingData)
          ? new Set(App.impersonatingData.ownedPropertyIds || [])
          : new Set(this._ownedPropertyIds || []);
        const newVis = {};
        this.minpakuProperties.forEach(p => { newVis[p.id] = ownedIds.has(p.id); });
        if (!Object.values(newVis).some(v => v)) return; // 全物件 OFF 回避
        this._propertyVisibility = newVis;
        this._propFilter = "myProp";
      }
      this._saveSettings();
      this.renderCalendar();
    });

    // 「表示中物件だけ」フィルタ (スタッフセクション、staff-filter-btn 共通)
    // 多重バインド防止: dataset.wired でガード (renderCalendar 二重呼出時にトグルが相殺されるバグ対策)
    container.querySelectorAll(".staff-filter-btn").forEach(btn => {
      if (btn.dataset.wired === "1") return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", () => {
        const mode = btn.dataset.filter;
        const newVal = (this._staffFilter === mode) ? "all" : mode;
        console.log("[staffFilter]", this._staffFilter, "→", newVal);
        this._staffFilter = newVal;
        this._saveSettings();
        this.renderCalendar();
      });
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

    // セル全体タップ (td) → その日の募集物件リスト中間モーダル or 詳細モーダル
    // スタッフビュー: 自分の assignedPropertyIds で絞り込み
    // Webアプリ管理者ビュー: 全募集対象
    // 1件のみ (+スタッフ単一担当) の場合は中間モーダルをスキップして直接詳細
    const handleCellClick = async (td) => {
      // 非アクティブスタッフは回答UIを開かない
      if (this._isInactive) {
        showToast("非アクティブ", this.staffDoc?.inactiveReason || "直近15回の清掃募集について回答がなかったため、非アクティブとなりました。解除する場合はWebアプリ管理者までご連絡ください。", "warning");
        return;
      }
      const dateStr = td.dataset.date;
      if (!dateStr) return;

      // その日の募集を日付で絞り込む
      let candidates = this.recruitments.filter(r => this._toDateStr(r.checkoutDate) === dateStr);

      const isStaffView = !this.isOwnerView;
      const myAssignedIds = Array.isArray(this.staffDoc?.assignedPropertyIds) ? this.staffDoc.assignedPropertyIds : [];

      if (isStaffView && myAssignedIds.length > 0) {
        // 担当物件で絞り込み (未設定なら全物件扱い)
        // 担当外の物件は選択肢に出さない (filtered.length === 0 でも絞る)
        candidates = candidates.filter(r => myAssignedIds.includes(r.propertyId));
      }

      // フォールバック: 候補が空でセルに直接 recruitId が付いている場合はそれを採用
      if (candidates.length === 0) {
        const directRecruitId = td.dataset.recruitId;
        if (directRecruitId) {
          const direct = this.recruitments.find(r => r.id === directRecruitId);
          if (direct) candidates = [direct];
        }
      }

      if (candidates.length === 0) {
        if (this.isOwnerView) this._showAddPickerForDate(dateStr);
        return;
      }

      // 既に読み込み済みのデータを共有して権限エラー回避
      if (typeof RecruitmentPage !== "undefined") {
        if (Array.isArray(this.staffList) && this.staffList.length) RecruitmentPage.staffList = this.staffList;
        if (Array.isArray(this.recruitments) && this.recruitments.length) RecruitmentPage.recruitments = this.recruitments;
        if (Array.isArray(this.minpakuProperties) && this.minpakuProperties.length) RecruitmentPage.properties = this.minpakuProperties;
      }

      // 1件 → 直接モーダル / 2件以上 → 中間モーダル (物件選択)
      if (typeof RecruitmentPage !== "undefined" && RecruitmentPage.openDetailModal) {
        try {
          await RecruitmentPage.ensureLoaded();
          if (candidates.length === 1) {
            RecruitmentPage.openDetailModal(candidates[0], { viewMode: this.isOwnerView ? "owner" : "staff" });
          } else {
            this._showDayBookingsListModal(dateStr, candidates);
          }
        } catch (e) {
          showToast("ERROR", e.message || String(e), "error");
        }
      }
    };
    // セルクリックは container 全体への delegation 一本に統一 (個別 listener より確実)
    const cellTds = container.querySelectorAll('td[data-cell-click="1"]');
    if (!container._cellDelegateBound) {
      container._cellDelegateBound = true;
      container.addEventListener("click", (ev) => {
        const td = ev.target.closest('td[data-cell-click="1"]');
        if (!td) return;
        ev.stopPropagation();
        handleCellClick(td);
      });
    }

    // Webアプリ管理者: 募集ゼロ日セルタップで手動追加ダイアログ
    if (this.isOwnerView) {
      container.querySelectorAll('td[data-owner-add="1"]').forEach(td => {
        td.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const dateStr = td.dataset.date;
          if (!dateStr) return;
          this._showAddPickerForDate(dateStr);
        });
      });
    }

    // 旧: .cal-cell-item 個別ハンドラ (td ハンドラに統合済み)。下の未使用コードは残置
    if (false) {
      container.querySelectorAll('.cal-cell-item').forEach(el => {
        el.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const recruitId = el.dataset.recruitId;
        const recruit = this.recruitments.find(r => r.id === recruitId);
        if (!recruit) return;
        if (typeof RecruitmentPage !== "undefined" && RecruitmentPage.openDetailModal) {
          await RecruitmentPage.ensureLoaded();
          RecruitmentPage.openDetailModal(recruit, { viewMode: this.isOwnerView ? "owner" : "staff" });
        }
        return; // 以下の旧 responseModal ロジックは実行しない
        // eslint-disable-next-line no-unreachable
        const dateStr = el.dataset.date;
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

        // Webアプリ管理者操作ボタン (Webアプリ管理者権限がある場合のみ表示)
        // 「スタッフ確定」「募集再開」「募集削除」等のWebアプリ管理者操作へ切替
        let ownerWrap = document.getElementById("ownerOpsFromResponseWrap");
        if (!ownerWrap) {
          const modalBody = document.querySelector("#responseModal .modal-body");
          modalBody.insertAdjacentHTML("beforeend", `
            <div class="text-center mt-3 border-top pt-3" id="ownerOpsFromResponseWrap">
              <div class="small text-muted mb-2">Webアプリ管理者操作</div>
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
              RecruitmentPage.openDetailModal(recruit, { viewMode: this.isOwnerView ? "owner" : "staff" });
            }
          });
          ownerWrap = document.getElementById("ownerOpsFromResponseWrap");
        }
        ownerWrap.style.display = isOwner ? "" : "none";

        new bootstrap.Modal(document.getElementById("responseModal")).show();
      });
      });
    }

    // イベント: 日付ヘッダー / 物件行セルのタップ → 予約詳細
    // 物件行セルの場合は data-booking-id で特定の予約を直接開く (同日複数物件で誤爆防止)
    // 日付ヘッダー (th) には data-booking-id が無いので従来通り bookingsByDate の先頭を使う
    const isOwnerView = this.isOwnerView;
    container.querySelectorAll(".cal-date-hd").forEach(el => {
      el.addEventListener("click", () => {
        // 物件行セル由来 (data-booking-id あり) のみ反応。
        // 日付ヘッダー (th) 由来 = bookingId なし → 複数施設で曖昧なため無反応にする。
        const bookingId = el.dataset.bookingId;
        if (!bookingId) return;
        const targetBooking = this.bookings.find(x => x.id === bookingId)
          || (this._rawBookings && this._rawBookings.find(x => x.id === bookingId))
          || null;
        if (!targetBooking) return;

        if (typeof DashboardPage !== "undefined" && DashboardPage.showBookingModal) {
          DashboardPage.showBookingModal(targetBooking, {
            bookings: this.bookings,
            recruitments: this.recruitments,
            guestMap: this.guestMap,
            properties: this.minpakuProperties || [],
            viewMode: isOwnerView ? "owner" : "staff",
            onGuestCountSaved: () => this.renderCalendar && this.renderCalendar(),
          });
        }
      });
    });

    // 清掃 / 直前点検 バーのタップ → 募集詳細モーダル
    container.querySelectorAll(".cal-recruit-cell").forEach(el => {
      el.addEventListener("click", async () => {
        const recruitmentId = el.dataset.recruitmentId;
        if (!recruitmentId) return;
        const recruit = this.recruitments.find(x => x.id === recruitmentId);
        if (!recruit) return;
        if (typeof RecruitmentPage !== "undefined" && RecruitmentPage.openDetailModal) {
          if (typeof RecruitmentPage.ensureLoaded === "function") {
            await RecruitmentPage.ensureLoaded();
          }
          RecruitmentPage.openDetailModal(recruit, { viewMode: isOwnerView ? "owner" : "staff" });
        }
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

    // 要対応 / お知らせ描画
    this.renderToActions_();

    // FullCalendar が既に初期化済みならデータを更新
    if (this._fcInitialized) this._refreshFullCalendar();
  },

  /**
   * 画面上部の要対応リスト (Webアプリ管理者向け) + お知らせ (全員向け) を描画
   * - Webアプリ管理者向け: 3日以内の募集中(回答状況)、選定済(要確定)、回答なし警告
   * - 全員向け: 新規募集 / スタッフ確定 / 清掃消滅 の 24h 以内のお知らせ
   */
  renderToActions_() {
    const host = document.getElementById("myRecToActions");
    if (!host) return;
    const isOwner = this.isOwnerView;

    const today = new Date().toISOString().slice(0, 10);
    const soonD = new Date();
    soonD.setDate(soonD.getDate() + 3);
    const soonStr = soonD.toISOString().slice(0, 10);
    const now = Date.now();
    const H24 = 24 * 3600 * 1000;

    // サブオーナー視点 (本人 or impersonate中) は「自分の所有物件」のみ通知対象
    // (this.recruitments には共有スタッフ経由で他オーナー物件も入っているため再フィルタが必要)
    const isImpersonatingSubOwner = (typeof App !== "undefined" && App.impersonating
      && App.impersonatingData && Array.isArray(App.impersonatingData.ownedPropertyIds));
    const isSubOwnerSelf = this._isSubOwnerView === true && !this._viewAsStaffId;
    let ownedOnlyIds = null;
    if (isImpersonatingSubOwner) {
      ownedOnlyIds = new Set(App.impersonatingData.ownedPropertyIds || []);
    } else if (isSubOwnerSelf) {
      ownedOnlyIds = new Set(this._ownedPropertyIds || []);
    }
    const inOwnedScope = (r) => !ownedOnlyIds || ownedOnlyIds.has(r.propertyId);

    // タイムスタンプ正規化 (Firestore Timestamp / Date / number / string を ms に)
    const toMs = (v) => {
      if (!v) return 0;
      if (typeof v === "number") return v;
      if (v.toMillis) return v.toMillis();
      if (v.toDate) return v.toDate().getTime();
      const d = new Date(v);
      return isNaN(d.getTime()) ? 0 : d.getTime();
    };

    // --- A. Webアプリ管理者向け要対応 ---
    const ownerItems = [];
    if (isOwner) {
      this.recruitments.forEach(r => {
        if (!inOwnedScope(r)) return;
        if (r.status !== "募集中" && r.status !== "選定済") return;
        const coDate = r.checkoutDate;
        if (!coDate || coDate > soonStr) return;
        const responses = r.responses || [];
        const maru = responses.filter(v => v.response === "◎").length;
        const isPast = coDate < today;
        const propName = r.propertyName || this.propertyMap?.[r.propertyId]?.name || "";
        const label = propName ? `${coDate} ${propName}` : coDate;
        // タイムスタンプ: 選定済→updatedAt, 回答あり→最新回答時刻, 回答なし→createdAt
        const updatedMs = toMs(r.updatedAt);
        const createdMs = toMs(r.createdAt);
        const lastRespMs = responses.reduce((m, v) => Math.max(m, toMs(v.respondedAt)), 0);
        if (r.status === "選定済") {
          ownerItems.push({ icon: "bi-check2-circle", color: "info", text: `${label} — スタッフ選定済み → 確定してください`, id: r.id, notifId: `action-recruit-selected-${r.id}`, sortMs: updatedMs || createdMs });
        } else if (maru > 0) {
          ownerItems.push({ icon: "bi-person-plus", color: "warning", text: `${label} — ◎${maru}名回答あり → スタッフを選定してください`, id: r.id, notifId: `action-recruit-pending-${r.id}`, sortMs: lastRespMs || updatedMs || createdMs });
        } else if (!isPast) {
          ownerItems.push({ icon: "bi-exclamation-triangle", color: "danger", text: `${label} — 回答なし！スタッフに連絡してください`, id: r.id, notifId: `action-no-response-${r.id}`, sortMs: createdMs });
        }
      });

      // 回答変更要望 (Task 8): 確定済み募集でも changeRequests があれば要対応に表示
      this.recruitments.forEach(r => {
        if (!inOwnedScope(r)) return;
        const reqs = Array.isArray(r.changeRequests) ? r.changeRequests : [];
        if (!reqs.length) return;
        const propName = r.propertyName || this.propertyMap?.[r.propertyId]?.name || "";
        const coDisp = r.checkoutDate && typeof formatDateFull === "function" ? formatDateFull(r.checkoutDate) : (r.checkoutDate || "");
        reqs.forEach(cr => {
          if (!cr || !cr.staffId) return;
          const name = cr.staffName || "スタッフ";
          const reason = cr.reason || "";
          ownerItems.push({
            icon: "bi-arrow-repeat",
            color: "warning",
            text: `${name} さんが ${coDisp}${propName ? " " + propName : ""} の回答変更を希望: ${reason}`,
            id: r.id,
            notifId: `action-change-request-${r.id}-${cr.staffId}`,
            sortMs: toMs(cr.requestedAt) || toMs(cr.createdAt) || toMs(r.updatedAt),
          });
        });
      });
      // 新しい順にソート
      ownerItems.sort((a, b) => (b.sortMs || 0) - (a.sortMs || 0));
    }

    // --- B. 全員向けお知らせ (24h 以内) ---
    const staffItems = [];
    this.recruitments.forEach(r => {
      if (!inOwnedScope(r)) return;
      const propName = r.propertyName || this.propertyMap?.[r.propertyId]?.name || "";
      const coRaw = r.checkoutDate || "";
      const co = coRaw && typeof formatDateFull === "function" ? formatDateFull(coRaw) : coRaw;
      const createdMs = toMs(r.createdAt);
      const updatedMs = toMs(r.updatedAt);
      // 新規募集 (createdAt が 24h 以内)
      if (createdMs && (now - createdMs) < H24 && r.status === "募集中") {
        staffItems.push({
          sortMs: createdMs, icon: "bi-megaphone", color: "primary",
          text: `清掃募集開始しました: ${co}${propName ? " " + propName : ""}`,
          notifId: `news-recruit-started-${r.id}`,
        });
      }
      // スタッフ確定 (updatedAt が 24h 以内かつ status=スタッフ確定済み)
      if (r.status === "スタッフ確定済み" && updatedMs && (now - updatedMs) < H24) {
        const who = r.selectedStaff || "";
        staffItems.push({
          sortMs: updatedMs, icon: "bi-person-check-fill", color: "success",
          text: `スタッフ確定: ${co}${propName ? " " + propName : ""}${who ? " → " + who : ""}`,
          notifId: `news-staff-confirmed-${r.id}`,
        });
      }
    });
    // 予約キャンセルで清掃消滅: bookings 側に cancelled は除外済みなので追跡困難
    // → recruitments で status=cancelled かつ updatedAt が 24h 以内のものを拾う
    (this._rawBookings || []).forEach(() => {}); // 予約 cancel 情報はデータ源がフィルタ済で取得不可。recruitments 側で代替
    // recruitments 再スキャン: cancel/期限切れ 状態への遷移
    // 注: this.recruitments は既にフィルタ済。cancelled は除外されているため、生の Firestore snapshot からの情報が無い
    // → 代替として this._rawRecruitmentsAll (無ければスキップ)
    (this._rawRecruitmentsAll || []).forEach(r => {
      if (!inOwnedScope(r)) return;
      const s = String(r.status || "");
      if (!["cancelled", "キャンセル", "キャンセル済み"].includes(s)) return;
      const updatedMs = toMs(r.updatedAt);
      if (!updatedMs || (now - updatedMs) >= H24) return;
      const propName = r.propertyName || this.propertyMap?.[r.propertyId]?.name || "";
      const coRaw = r.checkoutDate || r.checkOutDate || "";
      const co = coRaw && typeof formatDateFull === "function" ? formatDateFull(coRaw) : coRaw;
      staffItems.push({
        sortMs: updatedMs, icon: "bi-x-circle", color: "secondary",
        text: `予約キャンセル: ${co}${propName ? " " + propName : ""} の清掃がなくなりました`,
        notifId: `news-booking-cancelled-${r.id}`,
      });
    });
    staffItems.sort((a, b) => b.sortMs - a.sortMs);

    // --- レンダリング ---
    const readIds = this._readIds || {};
    const isRead = (nid) => !!(nid && readIds[nid]);
    // 既読アイテムは UI から非表示 (Firestore データは保持)
    const visibleOwnerItems = ownerItems.filter(a => !isRead(a.notifId));
    const visibleStaffItems = staffItems.filter(a => !isRead(a.notifId));

    // タイムスタンプを "YYYY/MM/DD HH:MM" 標準形式で表示
    const fmtTs = (ms) => {
      if (!ms) return "";
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    let html = "";
    if (isOwner && visibleOwnerItems.length > 0) {
      html += `
        <div class="card border-warning mb-2">
          <div class="card-header bg-warning bg-opacity-10 py-2 d-flex align-items-center">
            <strong><i class="bi bi-bell"></i> 要対応（${visibleOwnerItems.length}件）</strong>
            <button type="button" class="btn btn-sm btn-outline-secondary ms-auto notif-read-all" data-section="owner">全既読</button>
          </div>
          <div class="list-group list-group-flush">
            ${visibleOwnerItems.map(a => `
              <div class="list-group-item d-flex align-items-center py-2" data-notif-row="${this.esc(a.notifId)}">
                <button class="btn btn-link text-start p-0 flex-grow-1 d-flex align-items-center text-decoration-none to-action-item small"
                  data-id="${this.esc(a.id)}">
                  <i class="bi ${a.icon} text-${a.color} me-2"></i>
                  <span class="text-body">${this.esc(a.text)}</span>
                  ${a.sortMs ? `<span class="text-muted ms-2" style="font-size:0.75rem; white-space:nowrap;">${fmtTs(a.sortMs)}</span>` : ""}
                  <i class="bi bi-chevron-right ms-2"></i>
                </button>
                <button type="button" class="btn btn-outline-secondary btn-sm ms-2 notif-read-btn" data-notif-id="${this.esc(a.notifId)}" title="既読にする"><i class="bi bi-check-lg"></i></button>
              </div>
            `).join("")}
          </div>
        </div>`;
    }
    if (visibleStaffItems.length > 0) {
      html += `
        <div class="card border-info">
          <div class="card-header bg-info bg-opacity-10 py-2 d-flex align-items-center">
            <strong><i class="bi bi-info-circle"></i> お知らせ（${visibleStaffItems.length}件）</strong>
            <button type="button" class="btn btn-sm btn-outline-secondary ms-auto notif-read-all" data-section="staff">全既読</button>
          </div>
          <div class="list-group list-group-flush">
            ${visibleStaffItems.map(a => `
              <div class="list-group-item d-flex align-items-center py-2 small" data-notif-row="${this.esc(a.notifId)}">
                <i class="bi ${a.icon} text-${a.color} me-2"></i>
                <span class="flex-grow-1">${this.esc(a.text)}</span>
                ${a.sortMs ? `<span class="text-muted ms-2" style="font-size:0.75rem; white-space:nowrap;">${fmtTs(a.sortMs)}</span>` : ""}
                <button type="button" class="btn btn-outline-secondary btn-sm ms-2 notif-read-btn" data-notif-id="${this.esc(a.notifId)}" title="既読にする"><i class="bi bi-check-lg"></i></button>
              </div>
            `).join("")}
          </div>
        </div>`;
    }
    host.innerHTML = html;

    // 要対応アイテム → 対応する募集詳細モーダルを開く
    host.querySelectorAll(".to-action-item").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const r = this.recruitments.find(x => x.id === id);
        if (!r) return;
        if (typeof RecruitmentPage !== "undefined" && RecruitmentPage.openDetailModal) {
          if (RecruitmentPage.ensureLoaded) await RecruitmentPage.ensureLoaded();
          RecruitmentPage.openDetailModal(r, { viewMode: this.isOwnerView ? "owner" : "staff" });
        } else if (typeof DashboardPage !== "undefined" && DashboardPage.openRecruitmentModal) {
          DashboardPage.openRecruitmentModal(r);
        }
      });
    });

    // 既読ボタン (個別) — 押下即行で該当行を DOM から remove + Firestore 書き込み
    host.querySelectorAll(".notif-read-btn").forEach(btn => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const nid = btn.dataset.notifId;
        if (!nid) return;
        btn.disabled = true;
        // 即時 DOM 除去
        const row = host.querySelector(`[data-notif-row="${CSS.escape(nid)}"]`);
        if (row) row.remove();
        await this._markAsRead([nid]);
        this.renderToActions_();
      });
    });

    // 全既読ボタン — 該当セクションのカードごと即時除去
    host.querySelectorAll(".notif-read-all").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const section = btn.dataset.section;
        const targets = section === "owner" ? visibleOwnerItems : visibleStaffItems;
        const ids = targets.map(a => a.notifId).filter(Boolean);
        if (ids.length === 0) return;
        // 即時 DOM 除去 (カード単位)
        const card = btn.closest(".card");
        if (card) card.remove();
        await this._markAsRead(ids);
        this.renderToActions_();
      });
    });
  },

  /**
   * 通知既読 ID 一覧を Firestore から取得
   * userNotificationStatus/{uid} doc: { readIds: { [notifId]: Timestamp } }
   */
  async _loadReadIds() {
    // 既存値を保持したまま Firestore から再取得 (Firestore 取得待ちの間に
    // 既読アイテムが「未読」として復活するのを防ぐ)
    if (!this._readIds) this._readIds = {};
    try {
      const uid = (typeof firebase !== "undefined" && firebase.auth().currentUser?.uid)
        || Auth.currentUser?.uid;
      if (!uid) return;
      // localStorage から即時復元 (オフライン時も既読維持)
      try {
        const cached = localStorage.getItem(`userNotificationStatus_${uid}`);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed && typeof parsed === "object") {
            this._readIds = { ...parsed, ...this._readIds };
          }
        }
      } catch (_) {}
      const doc = await db.collection("userNotificationStatus").doc(uid).get();
      if (doc.exists) {
        const remote = doc.data().readIds || {};
        // remote と local をマージ (どちらかで既読なら既読扱い)
        this._readIds = { ...remote, ...this._readIds };
        try {
          localStorage.setItem(`userNotificationStatus_${uid}`, JSON.stringify(this._readIds));
        } catch (_) {}
      }
    } catch (e) {
      console.warn("[my-recruitment] _loadReadIds 失敗", e);
    }
  },

  /**
   * 通知 ID 配列を既読としてマーク (userNotificationStatus/{uid} に書き込み)
   */
  async _markAsRead(notifIds) {
    if (!notifIds || notifIds.length === 0) return;
    try {
      const uid = (typeof firebase !== "undefined" && firebase.auth().currentUser?.uid)
        || Auth.currentUser?.uid;
      if (!uid) return;
      const now = firebase.firestore.FieldValue.serverTimestamp();
      const nowLocal = new Date();
      // ドット記法で個別 readIds フィールドのみ追記
      // set(merge:true) は readIds ネスト全体を置換するため update() を使う
      // ドキュメント未存在時のみ set(merge) で初期化してから update
      const ref = db.collection("userNotificationStatus").doc(uid);
      const patch = {};
      notifIds.forEach(id => {
        patch[`readIds.${id}`] = now;
        if (!this._readIds) this._readIds = {};
        this._readIds[id] = nowLocal; // ローカル即時反映
      });
      await ref.set({ readIds: {} }, { merge: true }); // ドキュメント存在保証
      await ref.update(patch); // フィールド単位追記
      // localStorage にも即時キャッシュ (次回ロードまでの間も既読維持)
      try {
        localStorage.setItem(`userNotificationStatus_${uid}`, JSON.stringify(this._readIds));
      } catch (_) {}
    } catch (e) {
      console.error("[my-recruitment] _markAsRead 失敗", e);
      showToast("エラー", "既読の保存に失敗しました", "error");
    }
  },

  /**
   * FullCalendar (月表示) 初期化 - 折りたたみ内に予約+募集を表示
   * DashboardPage の buildCalendarEvents を参考に、シンプル版を my-recruitment 側に持つ
   */
  _initFullCalendar() {
    const el = document.getElementById("myRecFullCalendarBody");
    if (!el || typeof FullCalendar === "undefined") return;
    // 物件フィルタを描画 (選択変更で FullCalendar 再構築)
    if (typeof PropertyFilter !== "undefined" && this.minpakuProperties) {
      PropertyFilter.render({
        containerId: "propertyFilterHost-myrec-fullcal",
        tabKey: "myrec-fullcal",
        properties: this.minpakuProperties,
        onChange: (ids) => {
          this._fullCalSelectedPropIds = ids;
          this._refreshFullCalendar();
        },
      });
      this._fullCalSelectedPropIds = PropertyFilter.getSelectedIds("myrec-fullcal", this.minpakuProperties);
    }
    this._fc = new FullCalendar.Calendar(el, {
      initialView: "dayGridMonth",
      locale: "ja",
      headerToolbar: { left: "prev,next today", center: "title", right: "dayGridMonth,listWeek" },
      height: "auto",
      dayMaxEvents: 4,
      eventDisplay: "block",
      eventOrder: "order",
      events: this._buildFullCalendarEvents(),
      eventClick: (info) => {
        const { type, data } = info.event.extendedProps;
        if (type === "booking" && typeof DashboardPage !== "undefined" && DashboardPage.showBookingModal) {
          const full = this.bookings.find(x => x.id === data.id) || data;
          DashboardPage.showBookingModal(full, {
            bookings: this.bookings,
            recruitments: this.recruitments,
            guestMap: this.guestMap,
            viewMode: this.isOwnerView ? "owner" : "staff",
            onGuestCountSaved: () => this._refreshFullCalendar(),
          });
        } else if (type === "recruitment") {
          if (typeof RecruitmentPage !== "undefined" && RecruitmentPage.openDetailModal) {
            const _vm = this.isOwnerView ? "owner" : "staff";
            (async () => {
              if (RecruitmentPage.ensureLoaded) await RecruitmentPage.ensureLoaded();
              RecruitmentPage.openDetailModal(data, { viewMode: _vm });
            })();
          } else if (typeof DashboardPage !== "undefined" && DashboardPage.openRecruitmentModal) {
            DashboardPage.openRecruitmentModal(data);
          }
        }
      },
    });
    this._fc.render();
    this._fcInitialized = true;
  },

  _refreshFullCalendar() {
    if (!this._fc) return;
    this._fc.removeAllEvents();
    this._fc.addEventSource(this._buildFullCalendarEvents());
  },

  _buildFullCalendarEvents() {
    const events = [];
    // 物件フィルタ適用 (未設定時は全表示)
    const selectedIds = this._fullCalSelectedPropIds;
    const passFilter = (pid) => {
      if (!selectedIds || selectedIds.length === 0) return !pid || true;
      if (!pid) return true; // propertyId 欠損は表示
      return selectedIds.includes(pid);
    };
    const platformClass = (b) => {
      const s = `${b.source || ""} ${b.bookingSite || ""} ${b._sourceType || ""}`.toLowerCase();
      if (s.includes("airbnb")) return "fc-event-airbnb";
      if (s.includes("booking")) return "fc-event-booking-com";
      return "fc-event-direct";
    };

    // 宿泊イベント
    (this.bookings || []).forEach(b => {
      const ci = b.checkIn;
      const co = b.checkOut;
      if (!ci) return;
      if (!passFilter(b.propertyId)) return;
      const guestCount = b.guestCount ? `(${b.guestCount}名)` : "";
      events.push({
        id: "b_" + b.id,
        title: (b.guestName || "予約") + " " + guestCount,
        start: ci,
        end: co || ci,
        allDay: true,
        order: 1,
        classNames: [platformClass(b)],
        borderColor: "transparent",
        extendedProps: { type: "booking", data: b },
      });
    });

    // 募集イベント: 同 CO 日+workType で優先度の高い1件のみ
    const STATUS_PRIORITY = { "スタッフ確定済み": 4, "選定済": 3, "募集中": 2 };
    const recruitByKey = {};
    (this.recruitments || []).forEach(r => {
      const co = r.checkoutDate;
      if (!co) return;
      const s = String(r.status || "");
      if (["キャンセル", "キャンセル済み", "期限切れ", "cancelled"].includes(s)) return;
      if (!passFilter(r.propertyId)) return;
      const wt = r.workType === "pre_inspection" ? "pre" : "clean";
      const key = co + "_" + wt;
      const existing = recruitByKey[key];
      const newPri = STATUS_PRIORITY[r.status] || 1;
      const existPri = existing ? (STATUS_PRIORITY[existing.status] || 1) : 0;
      if (!existing || newPri > existPri) recruitByKey[key] = r;
    });
    Object.values(recruitByKey).forEach(r => {
      const co = r.checkoutDate;
      const responses = r.responses || [];
      const maru = responses.filter(v => v.response === "◎").length;
      const sankaku = responses.filter(v => v.response === "△").length;
      const totalResp = responses.length;
      const isPre = r.workType === "pre_inspection";
      const wtPrefix = isPre ? "[直] " : "[清] ";
      const wtIcon = isPre ? "🔍 " : "🧹 ";
      const cssBase = isPre ? "fc-event-pre-inspection" : "fc-event-cleaning";
      let cssClass, title;
      if (r.status === "スタッフ確定済み") {
        cssClass = cssBase + "-decided";
        title = wtPrefix + wtIcon + (r.selectedStaff || "確定");
      } else if (r.status === "選定済") {
        cssClass = cssBase + "-selected";
        title = wtPrefix + wtIcon + (r.selectedStaff || "") + "(選定済)";
      } else if (maru > 0) {
        cssClass = cssBase;
        title = wtPrefix + wtIcon + "募集中 ◎" + maru + (sankaku ? " △" + sankaku : "");
      } else if (totalResp > 0) {
        cssClass = cssBase;
        title = wtPrefix + wtIcon + "募集中 (△" + sankaku + " ×" + (totalResp - sankaku) + ")";
      } else {
        cssClass = cssBase + "-noresponse";
        title = wtPrefix + wtIcon + "募集中（回答なし）";
      }
      events.push({
        id: "r_" + r.id,
        title, start: co, allDay: true, order: 0,
        classNames: [cssClass], borderColor: "transparent",
        extendedProps: { type: "recruitment", data: r },
      });
    });
    return events;
  },

  _pendingRecruitId: null,
  _pendingDate: null,

  async submitCurrentResponse(response, memo) {
    if (!this._pendingRecruitId) return;
    // viewAsStaff 中は他人の名義で書き込みになるため確認
    if (this._viewAsStaffId) {
      const ok = await showConfirm(
        `「${this.staffDoc?.name || this._viewAsStaffId}」さんとして回答(${response})を書き込みます。よろしいですか？`,
        { title: "他スタッフとして書き込み", okLabel: "書き込む", okClass: "btn-warning" }
      );
      if (!ok) return;
    }
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
      if (typeof s.staffFilter === "string" && ["all","myProp","visibleProp"].includes(s.staffFilter)) this._staffFilter = s.staffFilter;
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
        staffFilter: this._staffFilter || "all",
        stickyW: this._stickyW || 140,
      }));
    } catch (e) { /* ignore */ }
  },

  esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; },

  // その日の募集物件リスト中間モーダル
  // candidates: 既にフィルタ済の recruitments 配列
  _showDayBookingsListModal(dateStr, candidates) {
    const viewMode = this.isOwnerView ? "owner" : "staff";
    const title = (typeof formatDateFull === "function" ? formatDateFull(dateStr) : dateStr) + " の募集";

    // status ラベル整形 (本 v2 で使用されている日本語ステータスをそのまま表示)
    const statusBadge = (st) => {
      const s = String(st || "");
      if (s === "スタッフ確定済み") return '<span class="badge bg-success">確定済</span>';
      if (s === "選定済") return '<span class="badge bg-info text-dark">選定済</span>';
      if (s === "募集中") return '<span class="badge bg-warning text-dark">募集中</span>';
      return `<span class="badge bg-secondary">${this.esc(s || "-")}</span>`;
    };

    // 物件番号順に整列
    const items = candidates.map(r => {
      const prop = this.propertyMap?.[r.propertyId];
      const num = prop && typeof prop._num === "number" ? prop._num : 999;
      const color = prop?._color || "#6c757d";
      const name = prop?.name || r.propertyName || "(物件不明)";
      return { r, num, color, name };
    }).sort((a, b) => a.num - b.num);

    const listHtml = items.map(({ r, num, color, name }) => {
      const numBadge = num < 999
        ? `<span style="color:#fff;background:${color};padding:2px 7px;border-radius:4px;font-size:13px;font-weight:700;margin-right:8px;">${num}</span>`
        : "";
      return `
        <button type="button" class="list-group-item list-group-item-action d-flex align-items-center gap-2 day-bk-item" data-recruit-id="${this.esc(r.id)}">
          ${numBadge}
          <span class="flex-grow-1 text-start">${this.esc(name)}</span>
          ${statusBadge(r.status)}
        </button>`;
    }).join("");

    // Webアプリ管理者向け追加ボタン
    const ownerAddHtml = this.isOwnerView ? `
      <hr>
      <div class="d-grid gap-2">
        <button id="btnAddBooking" type="button" class="btn btn-outline-primary">
          <i class="bi bi-plus-circle"></i> 予約を手動追加
        </button>
        <button id="btnAddRecruitment" type="button" class="btn btn-outline-primary">
          <i class="bi bi-plus-circle"></i> 作業を手動募集
        </button>
      </div>` : "";

    // モーダル DOM を動的生成 (既存なら削除)
    const modalId = "dayBookingsListModal";
    document.getElementById(modalId)?.remove();
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div class="modal fade" id="${modalId}" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-calendar-event"></i> ${this.esc(title)}</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="small text-muted mb-2">物件を選択すると募集詳細を開きます</div>
              <div class="list-group">${listHtml}</div>
              ${ownerAddHtml}
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(wrap.firstElementChild);

    const modalEl = document.getElementById(modalId);
    const modal = new bootstrap.Modal(modalEl);
    modalEl.querySelectorAll(".day-bk-item").forEach(btn => {
      btn.addEventListener("click", async () => {
        const rid = btn.dataset.recruitId;
        const r = candidates.find(x => x.id === rid);
        if (!r) return;
        modal.hide();
        // hide の transition 後に詳細モーダルを開く (モーダル重ね描画対策)
        setTimeout(async () => {
          if (typeof RecruitmentPage !== "undefined" && RecruitmentPage.openDetailModal) {
            await RecruitmentPage.ensureLoaded();
            RecruitmentPage.openDetailModal(r, { viewMode });
          }
        }, 180);
      });
    });
    // Webアプリ管理者: 予約/募集 手動追加
    if (this.isOwnerView) {
      modalEl.querySelector("#btnAddBooking")?.addEventListener("click", () => {
        modal.hide();
        setTimeout(() => this._openAddBookingModal(dateStr), 180);
      });
      modalEl.querySelector("#btnAddRecruitment")?.addEventListener("click", () => {
        modal.hide();
        setTimeout(() => this._openAddRecruitmentModal(dateStr), 180);
      });
    }
    modalEl.addEventListener("hidden.bs.modal", () => modalEl.remove(), { once: true });
    modal.show();
  },

  // 既存募集なし日のWebアプリ管理者向け選択ダイアログ
  _showAddPickerForDate(dateStr) {
    const title = (typeof formatDateFull === "function" ? formatDateFull(dateStr) : dateStr) + " に追加しますか?";
    const modalId = "addPickerModal_" + Date.now().toString(36);
    const html = `
      <div class="modal fade" id="${modalId}" tabindex="-1">
        <div class="modal-dialog modal-sm modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header py-2">
              <h6 class="modal-title"><i class="bi bi-plus-square"></i> ${this.esc(title)}</h6>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="d-grid gap-2">
                <button type="button" id="pickAddBooking" class="btn btn-outline-primary">
                  <i class="bi bi-calendar-plus"></i> 予約を追加
                </button>
                <button type="button" id="pickAddRecruitment" class="btn btn-outline-primary">
                  <i class="bi bi-megaphone"></i> 作業を募集
                </button>
                <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">キャンセル</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
    const modalEl = document.getElementById(modalId);
    const modal = new bootstrap.Modal(modalEl);
    modalEl.querySelector("#pickAddBooking").addEventListener("click", () => {
      modal.hide();
      setTimeout(() => this._openAddBookingModal(dateStr), 180);
    });
    modalEl.querySelector("#pickAddRecruitment").addEventListener("click", () => {
      modal.hide();
      setTimeout(() => this._openAddRecruitmentModal(dateStr), 180);
    });
    modalEl.addEventListener("hidden.bs.modal", () => modalEl.remove(), { once: true });
    modal.show();
  },

  // アクティブ物件リストを取得 (displayOrder 順)
  // サブオーナーは所有物件 (ownedPropertyIds) のみ返す → 予約/募集追加ダイアログで自物件のみ選択可能
  _getActiveProperties() {
    let props = (this.minpakuProperties || []).filter(p => p.active !== false);
    if (this._isSubOwnerView) {
      props = props.filter(p => this._ownedPropertyIds.includes(p.id));
    }
    return props.sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
  },

  // 日付文字列 (YYYY-MM-DD) の翌日
  _nextDayStr(dateStr) {
    try {
      const d = new Date(dateStr + "T00:00:00");
      d.setDate(d.getDate() + 1);
      return d.toISOString().slice(0, 10);
    } catch (e) { return dateStr; }
  },

  // 予約手動追加モーダル
  _openAddBookingModal(dateStr) {
    const props = this._getActiveProperties();
    if (!props.length) {
      showAlert("登録された物件がありません。", { title: "エラー" });
      return;
    }
    const nextDay = this._nextDayStr(dateStr);
    const modalId = "addBookingModal_" + Date.now().toString(36);
    const propOpts = props.map(p => `<option value="${this.esc(p.id)}">${this.esc(p.name)}</option>`).join("");
    const html = `
      <div class="modal fade" id="${modalId}" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-calendar-plus"></i> 予約を手動追加</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="mb-2">
                <label class="form-label small mb-1">物件 <span class="text-danger">*</span></label>
                <select id="addBkProperty" class="form-select form-select-sm">${propOpts}</select>
              </div>
              <div class="mb-2">
                <label class="form-label small mb-1">ゲスト名 <span class="text-danger">*</span></label>
                <input type="text" id="addBkGuestName" class="form-control form-control-sm">
              </div>
              <div class="mb-2">
                <label class="form-label small mb-1">予約元</label>
                <select id="addBkSource" class="form-select form-select-sm">
                  <option value="manual" selected>手動追加</option>
                  <option value="airbnb">Airbnb</option>
                  <option value="booking">Booking.com</option>
                  <option value="direct">直接予約</option>
                  <option value="その他">その他</option>
                </select>
              </div>
              <div class="row g-2 mb-2">
                <div class="col-6">
                  <label class="form-label small mb-1">チェックイン日</label>
                  <input type="date" id="addBkCheckIn" class="form-control form-control-sm" value="${this.esc(dateStr)}">
                </div>
                <div class="col-6">
                  <label class="form-label small mb-1">CI 時刻</label>
                  <input type="time" id="addBkCheckInTime" class="form-control form-control-sm">
                </div>
              </div>
              <div class="row g-2 mb-2">
                <div class="col-6">
                  <label class="form-label small mb-1">チェックアウト日</label>
                  <input type="date" id="addBkCheckOut" class="form-control form-control-sm" value="${this.esc(nextDay)}">
                </div>
                <div class="col-6">
                  <label class="form-label small mb-1">CO 時刻</label>
                  <input type="time" id="addBkCheckOutTime" class="form-control form-control-sm">
                </div>
              </div>
              <div class="mb-2">
                <label class="form-label small mb-1">宿泊人数</label>
                <input type="number" id="addBkGuestCount" class="form-control form-control-sm" min="1" value="1">
              </div>
              <div class="mb-2">
                <label class="form-label small mb-1">メモ</label>
                <textarea id="addBkNotes" class="form-control form-control-sm" rows="2"></textarea>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">キャンセル</button>
              <button type="button" id="addBkSave" class="btn btn-primary btn-sm">
                <i class="bi bi-save"></i> 追加
              </button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
    const modalEl = document.getElementById(modalId);
    const modal = new bootstrap.Modal(modalEl);
    // CI 変更時に CO を翌日に
    modalEl.querySelector("#addBkCheckIn").addEventListener("change", (ev) => {
      const coInput = modalEl.querySelector("#addBkCheckOut");
      if (!coInput.dataset.touched) {
        coInput.value = this._nextDayStr(ev.target.value);
      }
    });
    modalEl.querySelector("#addBkCheckOut").addEventListener("input", (ev) => {
      ev.target.dataset.touched = "1";
    });

    modalEl.querySelector("#addBkSave").addEventListener("click", async () => {
      const propertyId = modalEl.querySelector("#addBkProperty").value;
      const guestName = modalEl.querySelector("#addBkGuestName").value.trim();
      const source = modalEl.querySelector("#addBkSource").value;
      const checkIn = modalEl.querySelector("#addBkCheckIn").value;
      const checkInTime = modalEl.querySelector("#addBkCheckInTime").value;
      const checkOut = modalEl.querySelector("#addBkCheckOut").value;
      const checkOutTime = modalEl.querySelector("#addBkCheckOutTime").value;
      const guestCount = parseInt(modalEl.querySelector("#addBkGuestCount").value, 10) || 1;
      const notes = modalEl.querySelector("#addBkNotes").value.trim();

      if (!propertyId || !guestName || !checkIn || !checkOut) {
        showAlert("物件・ゲスト名・チェックイン/アウト日は必須です。", { title: "入力エラー" });
        return;
      }
      if (checkOut <= checkIn) {
        showAlert("チェックアウト日はチェックイン日より後に設定してください。", { title: "入力エラー" });
        return;
      }
      const prop = props.find(p => p.id === propertyId);
      const propertyName = prop?.name || "";
      const saveBtn = modalEl.querySelector("#addBkSave");
      saveBtn.disabled = true;
      try {
        // 同一物件・同期間の手動予約重複チェック (iCal 由来は対象外)
        const bSnap = await db.collection("bookings")
          .where("propertyId", "==", propertyId)
          .get();
        const hasConflict = bSnap.docs.some(d => {
          const x = d.data();
          const isManual = x.manualOverride === true || /manual/i.test(String(x.source || ""));
          if (!isManual) return false;
          if (x.status === "cancelled") return false;
          const existCi = typeof x.checkIn === "string"
            ? x.checkIn
            : (x.checkIn?.toDate?.().toISOString().slice(0, 10));
          const existCo = typeof x.checkOut === "string"
            ? x.checkOut
            : (x.checkOut?.toDate?.().toISOString().slice(0, 10));
          if (!existCi || !existCo) return false;
          // 日程重複: existCi < newCo かつ newCi < existCo
          return existCi < checkOut && checkIn < existCo;
        });
        if (hasConflict) {
          await showAlert("この物件には既に同期間の手動予約が登録されています。編集または削除してから追加してください。", { title: "重複エラー" });
          saveBtn.disabled = false;
          return;
        }
        const payload = {
          propertyId,
          propertyName,
          guestName,
          guestCount,
          checkIn,            // YYYY-MM-DD 文字列 (既存の bookings と同形式)
          checkOut,
          source: source || "manual",
          status: "confirmed",
          manualOverride: true,
          manualOverrideReason: "手動追加",
          notes: notes || null,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        };
        if (checkInTime) payload.checkInTime = checkInTime;
        if (checkOutTime) payload.checkOutTime = checkOutTime;
        await db.collection("bookings").add(payload);
        modal.hide();
        showAlert("予約を追加しました。既存トリガーが清掃シフト・募集を自動生成します。", { title: "完了" });
      } catch (e) {
        console.error("[addBooking] 保存エラー:", e);
        showAlert(`保存に失敗しました: ${e.message}`, { title: "エラー" });
        saveBtn.disabled = false;
      }
    });
    modalEl.addEventListener("hidden.bs.modal", () => modalEl.remove(), { once: true });
    modal.show();
  },

  // 作業募集手動作成モーダル
  _openAddRecruitmentModal(dateStr) {
    const props = this._getActiveProperties();
    if (!props.length) {
      showAlert("登録された物件がありません。", { title: "エラー" });
      return;
    }
    const modalId = "addRecruitModal_" + Date.now().toString(36);
    const propOpts = props.map(p => `<option value="${this.esc(p.id)}">${this.esc(p.name)}</option>`).join("");
    const html = `
      <div class="modal fade" id="${modalId}" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-megaphone"></i> 作業を手動募集</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="mb-2">
                <label class="form-label small mb-1">物件 <span class="text-danger">*</span></label>
                <select id="addRcProperty" class="form-select form-select-sm">${propOpts}</select>
              </div>
              <div class="mb-2">
                <label class="form-label small mb-1">作業種別</label>
                <select id="addRcWorkType" class="form-select form-select-sm">
                  <option value="cleaning_by_count" selected>通常清掃</option>
                  <option value="pre_inspection">直前点検</option>
                </select>
              </div>
              <div class="mb-2">
                <label class="form-label small mb-1">日付 <span class="text-danger">*</span></label>
                <input type="date" id="addRcDate" class="form-control form-control-sm" value="${this.esc(dateStr)}">
                <div class="form-text small">通常清掃: チェックアウト日 / 直前点検: チェックイン日</div>
              </div>
              <div class="mb-2">
                <label class="form-label small mb-1">必要人数</label>
                <input type="number" id="addRcRequired" class="form-control form-control-sm" min="1" value="1">
              </div>
              <div class="mb-2">
                <label class="form-label small mb-1">メモ</label>
                <textarea id="addRcMemo" class="form-control form-control-sm" rows="2"></textarea>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">キャンセル</button>
              <button type="button" id="addRcSave" class="btn btn-primary btn-sm">
                <i class="bi bi-save"></i> 募集作成
              </button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
    const modalEl = document.getElementById(modalId);
    const modal = new bootstrap.Modal(modalEl);

    // 物件/作業種別変更時に必要人数のデフォルトを追従
    const propSel = modalEl.querySelector("#addRcProperty");
    const wtSel = modalEl.querySelector("#addRcWorkType");
    const reqInput = modalEl.querySelector("#addRcRequired");
    const updateRequiredDefault = () => {
      if (reqInput.dataset.touched) return;
      const prop = props.find(p => p.id === propSel.value);
      if (!prop) return;
      if (wtSel.value === "pre_inspection") {
        reqInput.value = prop.inspection?.requiredCount || 1;
      } else {
        reqInput.value = prop.cleaningRequiredCount || 1;
      }
    };
    propSel.addEventListener("change", updateRequiredDefault);
    wtSel.addEventListener("change", updateRequiredDefault);
    reqInput.addEventListener("input", (ev) => { ev.target.dataset.touched = "1"; });
    updateRequiredDefault();

    modalEl.querySelector("#addRcSave").addEventListener("click", async () => {
      const propertyId = propSel.value;
      const workType = wtSel.value;
      const dateVal = modalEl.querySelector("#addRcDate").value;
      const requiredCount = parseInt(reqInput.value, 10) || 1;
      const memo = modalEl.querySelector("#addRcMemo").value.trim();
      if (!propertyId || !dateVal) {
        showAlert("物件と日付は必須です。", { title: "入力エラー" });
        return;
      }
      const prop = props.find(p => p.id === propertyId);
      const propertyName = prop?.name || "";
      const saveBtn = modalEl.querySelector("#addRcSave");
      saveBtn.disabled = true;
      try {
        // 同一物件・同日付の手動募集重複チェック
        const rSnap = await db.collection("recruitments")
          .where("propertyId", "==", propertyId)
          .where("checkoutDate", "==", dateVal)
          .get();
        const hasConflict = rSnap.docs.some(d => {
          const x = d.data();
          if (x.manualCreated !== true) return false;
          const st = String(x.status || "");
          if (st === "cancelled" || st === "キャンセル") return false;
          return true;
        });
        if (hasConflict) {
          await showAlert("この物件には既に同日付の手動募集が登録されています。編集または削除してから追加してください。", { title: "重複エラー" });
          saveBtn.disabled = false;
          return;
        }
        await db.collection("recruitments").add({
          propertyId,
          propertyName,
          workType,
          checkoutDate: dateVal,  // 通常清掃: CO日 / 直前点検: CI日 (既存仕様踏襲)
          bookingId: null,
          manualCreated: true,
          requiredCount,
          memo: memo || "",
          status: "募集中",
          selectedStaffIds: [],
          selectedStaff: "",
          responses: [],
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        modal.hide();
        showAlert("募集を作成しました。", { title: "完了" });
      } catch (e) {
        console.error("[addRecruitment] 保存エラー:", e);
        showAlert(`保存に失敗しました: ${e.message}`, { title: "エラー" });
        saveBtn.disabled = false;
      }
    });
    modalEl.addEventListener("hidden.bs.modal", () => modalEl.remove(), { once: true });
    modal.show();
  },

  // D: 物件選択モーダルを開き、選択物件の直近確定済シフトの checklist を開く
  //   - Webアプリ管理者ビュー: 民泊全物件
  //   - スタッフビュー: 自分の担当物件 (staff.assignedPropertyIds) のみ
  async _openPropertyPickerForChecklist() {
    try {
      // 民泊物件リストをベースにする (清掃チェックリストは民泊のみ対象)
      let props = Array.isArray(this.minpakuProperties) && this.minpakuProperties.length
        ? [...this.minpakuProperties]
        : [];
      if (!props.length) {
        const raw = await API.properties.list(true);
        props = (raw || []).filter(p => p.active !== false && (p.type === "minpaku" || !p.type));
      }
      // スタッフビューなら担当物件のみに絞り込み
      if (!this.isOwnerView) {
        const myAssigned = Array.isArray(this.staffDoc?.assignedPropertyIds)
          ? this.staffDoc.assignedPropertyIds : [];
        props = props.filter(p => myAssigned.includes(p.id));
      }
      // 物件番号 (_num / propertyNumber) の昇順でソート (未設定は末尾)
      props = props.sort((a, b) => {
        const an = a._num != null ? a._num : (a.propertyNumber != null ? a.propertyNumber : 9999);
        const bn = b._num != null ? b._num : (b.propertyNumber != null ? b.propertyNumber : 9999);
        if (an !== bn) return an - bn;
        return (a.displayOrder || 0) - (b.displayOrder || 0);
      });
      if (!props.length) {
        showToast("物件なし", this.isOwnerView ? "登録された民泊物件がありません" : "あなたが担当している物件がありません", "warning");
        return;
      }
      // モーダル構築
      const modalId = "checklistPropPicker_" + Date.now().toString(36);
      const html = `
        <div class="modal fade" id="${modalId}" tabindex="-1">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-header py-2">
                <h6 class="modal-title"><i class="bi bi-house-door"></i> 物件を選択</h6>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
              </div>
              <div class="modal-body">
                <div class="small text-muted mb-2">チェックリストを開く物件を選んでください</div>
                <div class="list-group">
                  ${props.map(p => {
                    const num = p._num != null ? p._num : (p.propertyNumber != null ? p.propertyNumber : "");
                    const color = p._color || p.color || "#6c757d";
                    const badge = num !== ""
                      ? `<span class="badge me-2" style="background:${this.esc(color)};color:#fff;min-width:24px;">${this.esc(String(num))}</span>`
                      : "";
                    return `
                      <button type="button" class="list-group-item list-group-item-action pick-prop d-flex align-items-center"
                        data-prop-id="${this.esc(p.id)}">
                        ${badge}${this.esc(p.name)}
                      </button>
                    `;
                  }).join("")}
                </div>
              </div>
            </div>
          </div>
        </div>`;
      document.body.insertAdjacentHTML("beforeend", html);
      const modalEl = document.getElementById(modalId);
      const modal = new bootstrap.Modal(modalEl);
      modalEl.addEventListener("hidden.bs.modal", () => modalEl.remove());
      modalEl.querySelectorAll(".pick-prop").forEach(btn => {
        btn.addEventListener("click", async () => {
          const pid = btn.dataset.propId;
          modal.hide();
          await this._goChecklistForProperty(pid);
        });
      });
      modal.show();
    } catch (e) {
      showToast("エラー", `物件一覧取得失敗: ${e.message}`, "error");
    }
  },

  // 物件IDから本日以降の直近シフトを特定し、その checklist を開く
  // 仕様: スタッフ未確定でも OK、過去にはフォールバックしない (過去を開いても意味がないため)
  async _goChecklistForProperty(propertyId) {
    try {
      const todayMid = new Date(); todayMid.setHours(0, 0, 0, 0);
      const todayMs = todayMid.getTime();
      const toMs = (d) => {
        if (!d) return 0;
        if (d.toDate) return d.toDate().getTime();
        if (d instanceof Date) return d.getTime();
        return new Date(d).getTime();
      };

      // checklists を直接 query (スタッフは shifts を read 不可のため)
      const clSnap = await db.collection("checklists")
        .where("propertyId", "==", propertyId).get();
      // 本日以降の checkoutDate に絞って最古 (= 最も近い未来) を選ぶ
      const future = clSnap.docs
        .map(d => ({ id: d.id, data: d.data(), _ms: toMs(d.data().checkoutDate) }))
        .filter(x => x._ms >= todayMs)
        .sort((a, b) => a._ms - b._ms);

      const cl = future[0];
      if (!cl) {
        showToast("シフトなし", "本日以降のチェックリストが見つかりません", "warning");
        location.hash = `#/my-checklist`;
        return;
      }
      const shiftId = cl.data.shiftId;
      if (!shiftId) {
        showToast("情報", "シフトID未紐付け。一覧へ遷移します", "info");
        location.hash = `#/my-checklist`;
        return;
      }
      // my-checklist 画面のルートは #/my-checklist/:shiftId (shiftId から checklist を逆引き)
      location.hash = `#/my-checklist/${shiftId}`;
    } catch (e) {
      showToast("エラー", `チェックリスト遷移失敗: ${e.message}`, "error");
    }
  },

  fmtDate(dateStr) {
    if (!dateStr) return "-";
    try {
      const d = new Date(dateStr + "T00:00:00");
      const dow = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
      return `${d.getMonth() + 1}/${d.getDate()}(${dow})`;
    } catch (e) { return dateStr; }
  },
};
